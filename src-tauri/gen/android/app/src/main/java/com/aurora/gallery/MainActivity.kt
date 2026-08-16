package com.aurora.gallery

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.view.WindowInsetsController
import android.graphics.Color
import android.graphics.PixelFormat
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.net.wifi.WifiManager
import android.util.DisplayMetrics
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject
import androidx.activity.OnBackPressedCallback

class MainActivity : TauriActivity() {
  private val previewSemaphore = Semaphore(1)
  private val memoryPressureLow = AtomicBoolean(false)
  private val memoryPressureCritical = AtomicBoolean(false)

  private var nativeGalleryView: NativeGalleryView? = null
  private var lanToken: String? = null

  private val componentCallbacks = object : ComponentCallbacks2 {
    override fun onTrimMemory(level: Int) {
      when {
        level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> {
          memoryPressureLow.set(true)
        }
        level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> {
          memoryPressureCritical.set(true)
          memoryPressureLow.set(true)
        }
        level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE -> {
          memoryPressureCritical.set(true)
          memoryPressureLow.set(true)
        }
      }
    }
    override fun onLowMemory() {
      memoryPressureCritical.set(true)
      memoryPressureLow.set(true)
    }
    override fun onConfigurationChanged(newConfig: Configuration) {}
  }

  private val permissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { permissions ->
    val allGranted = permissions.all { it.value }
    if (allGranted) {
      notifyPermissionResultWithRetry("granted")
      requestAllFilesAccessIfNeeded()
    } else {
      val permanentlyDenied = permissions.any { (perm, granted) ->
        !granted && !shouldShowRequestPermissionRationale(perm)
      }
      if (permanentlyDenied) {
        notifyPermissionResultWithRetry("denied_permanently")
      } else {
        notifyPermissionResultWithRetry("denied")
      }
      requestAllFilesAccessIfNeeded()
    }
  }

  private val permissionPrefs by lazy {
    getSharedPreferences("aurora_permissions", MODE_PRIVATE)
  }

  private val cameraPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { granted ->
    markCameraRequested()
    if (granted) {
      notifyPermissionResultWithRetry("granted")
    } else {
      if (!shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
        notifyPermissionResultWithRetry("denied_permanently")
      } else {
        notifyPermissionResultWithRetry("denied")
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val splashScreen = installSplashScreen()
    super.onCreate(savedInstanceState)
    splashScreen.setKeepOnScreenCondition { false }
    // 启动期间沉浸式全屏，避免系统状态栏破坏启动界面；主界面加载完成后由前端通知退出沉浸。
    WindowCompat.setDecorFitsSystemWindows(window, false)
    enterStartupImmersive()
    requestMediaPermissions()
    setupBackPressedHandler()
    registerComponentCallbacks(componentCallbacks)
    ColorExtractionService.createChannel(this)
    setupNativeGalleryView()
  }

  private fun enterStartupImmersive() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val controller = window.insetsController
      controller?.let {
        it.hide(android.view.WindowInsets.Type.statusBars())
        it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      }
    } else {
      @Suppress("DEPRECATION")
      window.decorView.systemUiVisibility = (
        View.SYSTEM_UI_FLAG_FULLSCREEN
          or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
          or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
      )
    }
    window.statusBarColor = Color.TRANSPARENT
  }

  override fun onDestroy() {
    nativeGalleryView?.let { view ->
      if (view.isAttachedToWindow) {
        try {
          windowManager.removeView(view)
        } catch (e: Exception) {
          android.util.Log.e("AuroraNativeViewer", "removeView in onDestroy failed", e)
        }
      }
      view.destroy()
    }
    super.onDestroy()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val orientationStr = if (newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait"
    android.util.Log.i("AuroraConfig", "onConfigurationChanged: orientation=$orientationStr screenWidthDp=${newConfig.screenWidthDp} screenHeightDp=${newConfig.screenHeightDp}")
    nativeGalleryView?.let { view ->
      if (view.isAttachedToWindow && view.visibility == View.VISIBLE) {
        // TYPE_APPLICATION_PANEL 窗口在 Activity 处理 configChanges 时可能不会自动 resize，
        // 通过 updateViewLayout 强制 WindowManager 以新屏幕尺寸重新测量窗口，
        // 随后 NativeGalleryView.onSizeChanged 会被触发，内部完成 primaryView 宽度更新。
        try {
          val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
          )
          params.token = window.decorView.windowToken
          windowManager.updateViewLayout(view, params)
          android.util.Log.i("AuroraConfig", "updateViewLayout called for nativeGalleryView")
        } catch (e: Exception) {
          android.util.Log.e("AuroraConfig", "updateViewLayout failed", e)
        }
        view.handleRotation()
      }
    }
  }

  private fun setupNativeGalleryView() {
    val view = NativeGalleryView(this)
    view.visibility = View.GONE
    view.listener = object : NativeGalleryView.Listener {
      override fun onClose() {
        runOnUiThread {
          view.close()
          if (view.isAttachedToWindow) {
            windowManager.removeView(view)
          }
          evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onClose)window.__androidViewerBridge.onClose();")
        }
      }
      override fun onNavigate(index: Int) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onNavigate)window.__androidViewerBridge.onNavigate($index);")
      }
      override fun onMore(fileId: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onMore)window.__androidViewerBridge.onMore('${escapeJsString(fileId)}');")
      }
      override fun onDelete(fileId: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onDelete)window.__androidViewerBridge.onDelete('${escapeJsString(fileId)}');")
      }
      override fun onCopyToFolder(fileId: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onCopyToFolder)window.__androidViewerBridge.onCopyToFolder('${escapeJsString(fileId)}');")
      }
      override fun onMoveToFolder(fileId: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onMoveToFolder)window.__androidViewerBridge.onMoveToFolder('${escapeJsString(fileId)}');")
      }
      override fun onEditTags(fileId: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onEditTags)window.__androidViewerBridge.onEditTags('${escapeJsString(fileId)}');")
      }
      override fun onLongPress(fileId: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onLongPress)window.__androidViewerBridge.onLongPress('${escapeJsString(fileId)}');")
      }
      override fun onImmersiveToggle(immersive: Boolean) {
        setImmersiveMode(immersive)
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onImmersiveToggle)window.__androidViewerBridge.onImmersiveToggle($immersive);")
      }
      override fun onUpdateFile(fileId: String, updatesJson: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onUpdateFile)window.__androidViewerBridge.onUpdateFile('${escapeJsString(fileId)}','${escapeJsString(updatesJson)}');")
      }
      override fun onColorSearch(colorHex: String) {
        android.util.Log.i("AuroraNativeViewer", "onColorSearch: $colorHex")
        runOnUiThread {
          // 先关闭原生查看器（清理 NativeGalleryView）
          nativeGalleryView?.let { view ->
            view.close()
            if (view.isAttachedToWindow) {
              windowManager.removeView(view)
            }
          }
          // 通知前端关闭查看器并清理状态
          evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onClose)window.__androidViewerBridge.onClose();")
          // 触发颜色搜索
          evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onColorSearch)window.__androidViewerBridge.onColorSearch('${escapeJsString(colorHex)}');")
        }
      }
      override fun onExtractPalette(fileId: String, filePath: String) {
        android.util.Log.i("AuroraNativeViewer", "onExtractPalette: $fileId")
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onExtractPalette)window.__androidViewerBridge.onExtractPalette('${escapeJsString(fileId)}','${escapeJsString(filePath)}');")
      }
      override fun onShare(filePath: String) {
        shareImage(filePath)
      }
      override fun onUpdateSlideshowConfig(configJson: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onUpdateSlideshowConfig)window.__androidViewerBridge.onUpdateSlideshowConfig('${escapeJsString(configJson)}');")
      }
      override fun onFolderPickerConfirm(fileId: String, targetFolderId: String, type: String) {
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onFolderPickerConfirm)window.__androidViewerBridge.onFolderPickerConfirm('${escapeJsString(fileId)}','${escapeJsString(targetFolderId)}','${escapeJsString(type)}');")
      }
    }
    nativeGalleryView = view
  }

  /** 由 Tauri 命令 android_show_folder_picker 调用，显示原生文件夹选择弹窗。 */
  fun showFolderPicker(type: String, fileId: String, folderTreeJson: String) {
    runOnUiThread {
      nativeGalleryView?.showFolderPickerDialog(type, fileId, folderTreeJson)
    }
  }

  private fun escapeJsString(s: String): String {
    return s.replace("\\", "\\\\").replace("'", "\\'").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r")
  }

  private fun evaluateJs(script: String) {
    try {
      val webView = findWebView(window.decorView)
      webView?.post {
        webView.evaluateJavascript(script, null)
      }
    } catch (e: Exception) {
      android.util.Log.e("AuroraNativeViewer", "evaluateJs failed", e)
    }
  }

  private fun applyInitialStatusBarStyle() {
    val currentNightMode = resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK
    val isDark = currentNightMode == android.content.res.Configuration.UI_MODE_NIGHT_YES
    setStatusBarStyle(isDark)
  }

  private fun setupBackPressedHandler() {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        android.util.Log.i("AuroraBack", "handleOnBackPressed triggered, nativeGalleryView=$nativeGalleryView")
        // 优先：如果原生查看器抽屉打开，先收起抽屉
        val ngv = nativeGalleryView
        if (ngv != null && ngv.isOpen()) {
          android.util.Log.i("AuroraBack", "NativeViewer isOpen=true, isSlideshowPlaying=${ngv.isSlideshowPlaying()}, isDrawerOpen=${ngv.isDrawerOpen()}")
          // 优先：幻灯片正在播放 → 停止幻灯片
          if (ngv.isSlideshowPlaying()) {
            android.util.Log.i("AuroraBack", "Stopping slideshow via back press")
            ngv.setSlideshow(false)
            return
          }
          if (ngv.isDrawerOpen()) {
            android.util.Log.i("AuroraBack", "Closing drawer via back press")
            ngv.closeDrawer()
            return
          }
          // 查看器打开但抽屉未打开 → 关闭查看器
          android.util.Log.i("AuroraBack", "Closing native viewer via back press")
          closeNativeViewer()
          evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onClose)window.__androidViewerBridge.onClose();")
          return
        }
        android.util.Log.i("AuroraBack", "Falling through to WebView back press")
        val webView = findWebView(window.decorView)
        if (webView != null) {
          webView.evaluateJavascript(
            "window.dispatchEvent(new Event('android-back-press'));",
            null
          )
        } else {
          finish()
        }
      }
    })
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    android.util.Log.d("AuroraDelete", "Delete permission result: request=$requestCode, result=$resultCode")
  }

  private fun getRequiredPermissions(): Array<String> {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
      )
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
      )
    } else {
      arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }
  }

  private fun requestMediaPermissions() {
    val needed = getRequiredPermissions().filter {
      ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }
    if (needed.isNotEmpty()) {
      permissionLauncher.launch(needed.toTypedArray())
    } else {
      notifyPermissionResultWithRetry("granted")
      requestAllFilesAccessIfNeeded()
    }
  }

  fun checkMediaPermissions(): String {
    val perms = getRequiredPermissions()
    val fullAccess = perms.filter {
      it == Manifest.permission.READ_MEDIA_IMAGES || it == Manifest.permission.READ_EXTERNAL_STORAGE
    }.all {
      ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }
    if (fullAccess) return "granted"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val partialAccess = ContextCompat.checkSelfPermission(
        this, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
      ) == PackageManager.PERMISSION_GRANTED
      if (partialAccess) return "granted_partial"
    }
    return "denied"
  }

  fun isExternalStorageManager(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      android.os.Environment.isExternalStorageManager()
    } else {
      true
    }
  }

  private fun markCameraRequested() {
    permissionPrefs.edit().putBoolean("camera_requested", true).apply()
  }

  private fun hasRequestedCameraBefore(): Boolean {
    return permissionPrefs.getBoolean("camera_requested", false)
  }

  fun checkCameraPermission(): String {
    val granted = ContextCompat.checkSelfPermission(
      this, Manifest.permission.CAMERA
    ) == PackageManager.PERMISSION_GRANTED
    if (granted) return "granted"
    if (hasRequestedCameraBefore() &&
      !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)
    ) {
      return "denied_permanently"
    }
    return "denied"
  }

  override fun onWebViewCreate(webView: android.webkit.WebView) {
    webView.webChromeClient = object : android.webkit.WebChromeClient() {
      override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
        runOnUiThread {
          val resources = request.resources
          val granted = resources.filter { resource ->
            when (resource) {
              android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
                ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
              }
              else -> true
            }
          }
          if (granted.size == resources.size) {
            request.grant(resources)
          } else {
            request.deny()
          }
        }
      }
    }
  }

  fun requestCameraPermission() {
    val granted = ContextCompat.checkSelfPermission(
      this, Manifest.permission.CAMERA
    ) == PackageManager.PERMISSION_GRANTED
    if (granted) {
      notifyPermissionResultWithRetry("granted")
      return
    }
    try {
      cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    } catch (_: Exception) {
      notifyPermissionResultWithRetry("denied")
    }
  }

  private fun requestAllFilesAccessIfNeeded() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      if (!android.os.Environment.isExternalStorageManager()) {
        try {
          val intent = Intent(
            android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            android.net.Uri.parse("package:$packageName")
          )
          startActivity(intent)
        } catch (e: Exception) {
          try {
            val intent = Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
            startActivity(intent)
          } catch (e2: Exception) {
            android.util.Log.e("AuroraPermission", "Failed to open all files access settings", e2)
          }
        }
      }
    }
  }

  fun requestAllFilesAccess() {
    requestAllFilesAccessIfNeeded()
  }

  fun scanAllAsJson(sinceTimestamp: Long): String {
    val images = JSONArray()
    val folderMap = HashMap<Long, JSONObject>()

    val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val projection = arrayOf(
      MediaStore.Images.Media._ID,
      MediaStore.Images.Media.DATA,
      MediaStore.Images.Media.DISPLAY_NAME,
      MediaStore.Images.Media.SIZE,
      MediaStore.Images.Media.WIDTH,
      MediaStore.Images.Media.HEIGHT,
      MediaStore.Images.Media.DATE_ADDED,
      MediaStore.Images.Media.DATE_MODIFIED,
      MediaStore.Images.Media.MIME_TYPE,
      MediaStore.Images.Media.BUCKET_ID,
      MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
    )

    var selection: String? = null
    var selectionArgs: Array<String>? = null
    if (sinceTimestamp > 0) {
      selection = "${MediaStore.Images.Media.DATE_MODIFIED} > ?"
      selectionArgs = arrayOf(sinceTimestamp.toString())
    }

    val sortOrder = "${MediaStore.Images.Media.DATE_MODIFIED} DESC"

    val cursor = contentResolver.query(uri, projection, selection, selectionArgs, sortOrder)

    cursor?.use {
      val colId = it.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
      val colData = it.getColumnIndexOrThrow(MediaStore.Images.Media.DATA)
      val colName = it.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
      val colSize = it.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
      val colWidth = it.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
      val colHeight = it.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)
      val colDateAdded = it.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
      val colDate = it.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
      val colMime = it.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
      val colBucketId = it.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
      val colBucketName = it.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)

      while (it.moveToNext()) {
        val id = it.getLong(colId)
        val path = it.getString(colData) ?: ""
        val name = it.getString(colName) ?: ""
        val size = it.getLong(colSize)
        val width = it.getInt(colWidth)
        val height = it.getInt(colHeight)
        val dateAdded = it.getLong(colDateAdded)
        val dateModified = it.getLong(colDate)
        val mimeType = it.getString(colMime) ?: ""
        val bucketId = it.getLong(colBucketId)
        val bucketName = it.getString(colBucketName) ?: ""

        val contentUri = "content://media/external/images/media/$id"

        val imgObj = JSONObject().apply {
          put("id", id)
          put("path", path)
          put("content_uri", contentUri)
          put("name", name)
          put("size", size)
          put("width", if (width > 0) width else JSONObject.NULL)
          put("height", if (height > 0) height else JSONObject.NULL)
          put("date_added", dateAdded)
          put("date_modified", dateModified)
          put("mime_type", mimeType)
        }

        val imgCacheFilename = "sys_${id}_q80.jpg"
        val imgCacheFile = File(cacheDir, imgCacheFilename)
        if (imgCacheFile.exists()) {
          imgObj.put("thumbnail_path", imgCacheFile.absolutePath)
        }

        images.put(imgObj)

        val folderPath = if (path.isNotEmpty()) {
          val lastSlash = path.lastIndexOf('/')
          if (lastSlash > 0) path.substring(0, lastSlash) else path
        } else ""

        val existing = folderMap[bucketId]
        if (existing == null) {
          folderMap[bucketId] = JSONObject().apply {
            put("id", bucketId)
            put("name", bucketName)
            put("path", folderPath)
            put("image_count", 1)
            put("cover_image_path", if (path.isNotEmpty()) path else JSONObject.NULL)
            put("cover_image_id", id)
            put("cover_image_width", if (width > 0) width else JSONObject.NULL)
            put("cover_image_height", if (height > 0) height else JSONObject.NULL)
            put("max_date_modified", dateModified)
          }
        } else {
          existing.put("image_count", existing.getInt("image_count") + 1)
          if (dateModified > existing.getLong("max_date_modified")) {
            existing.put("max_date_modified", dateModified)
            existing.put("cover_image_path", if (path.isNotEmpty()) path else JSONObject.NULL)
            existing.put("cover_image_id", id)
            existing.put("cover_image_width", if (width > 0) width else JSONObject.NULL)
            existing.put("cover_image_height", if (height > 0) height else JSONObject.NULL)
          }
        }
      }
    }

    val folders = JSONArray()
    folderMap.values.forEach { folder ->
      folder.remove("max_date_modified")

      val coverId = folder.optLong("cover_image_id", -1)
      if (coverId > 0) {
        val cacheFilename = "sys_${coverId}_q80.jpg"
        val cacheFile = File(cacheDir, cacheFilename)
        if (cacheFile.exists()) {
          folder.put("cover_thumbnail_path", cacheFile.absolutePath)
        } else {
          try {
            val thumbnail = MediaStore.Images.Thumbnails.getThumbnail(
              contentResolver, coverId, MediaStore.Images.Thumbnails.MINI_KIND, null
            )
            if (thumbnail != null) {
              val fos = FileOutputStream(cacheFile)
              thumbnail.compress(Bitmap.CompressFormat.JPEG, 80, fos)
              fos.flush()
              fos.close()
              thumbnail.recycle()
              folder.put("cover_thumbnail_path", cacheFile.absolutePath)
            } else {
              folder.put("cover_thumbnail_path", JSONObject.NULL)
            }
          } catch (e: Exception) {
            folder.put("cover_thumbnail_path", JSONObject.NULL)
          }
        }
      } else {
        folder.put("cover_thumbnail_path", JSONObject.NULL)
      }

      folders.put(folder)
    }

    val result = JSONObject().apply {
      put("images", images)
      put("folders", folders)
    }

    return result.toString()
  }

  fun batchGetThumbnailPaths(imageIds: String): String {
    val ids = imageIds.split(",").mapNotNull { it.trim().toLongOrNull() }
    val result = JSONArray()
    val cacheDir = this.cacheDir

    for (id in ids) {
      try {
        val cacheFilename = "sys_${id}_q80.jpg"
        val cacheFile = File(cacheDir, cacheFilename)

        if (cacheFile.exists()) {
          val opts = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
          android.graphics.BitmapFactory.decodeFile(cacheFile.absolutePath, opts)
          result.put(JSONObject().apply {
            put("id", id)
            put("thumbnailPath", cacheFile.absolutePath)
            put("width", opts.outWidth)
            put("height", opts.outHeight)
          })
          continue
        }

        val thumbnail = MediaStore.Images.Thumbnails.getThumbnail(
          contentResolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null
        )

        if (thumbnail != null) {
          val bmpWidth = thumbnail.width
          val bmpHeight = thumbnail.height

          val fos = FileOutputStream(cacheFile)
          thumbnail.compress(Bitmap.CompressFormat.JPEG, 80, fos)
          fos.flush()
          fos.close()
          thumbnail.recycle()

          result.put(JSONObject().apply {
            put("id", id)
            put("thumbnailPath", cacheFile.absolutePath)
            put("width", bmpWidth)
            put("height", bmpHeight)
          })
        } else {
          result.put(JSONObject().apply {
            put("id", id)
            put("thumbnailPath", JSONObject.NULL)
          })
        }
      } catch (e: Exception) {
        result.put(JSONObject().apply {
          put("id", id)
          put("thumbnailPath", JSONObject.NULL)
          put("error", e.message ?: "unknown")
        })
      }
    }

    return result.toString()
  }

  private fun notifyPermissionResultWithRetry(result: String, retryCount: Int = 0) {
    try {
      val webView = findWebView(window.decorView)
      if (webView != null) {
        webView.post {
          webView.evaluateJavascript(
            "if(window.__onAndroidPermissionResult) window.__onAndroidPermissionResult('$result')",
            null
          )
        }
      } else if (retryCount < 20) {
        Handler(Looper.getMainLooper()).postDelayed({
          notifyPermissionResultWithRetry(result, retryCount + 1)
        }, 500)
      }
    } catch (_: Exception) {
      if (retryCount < 20) {
        Handler(Looper.getMainLooper()).postDelayed({
          notifyPermissionResultWithRetry(result, retryCount + 1)
        }, 500)
      }
    }
  }

  fun getScreenMaxDimension(): Int {
    val displayMetrics = resources.displayMetrics
    val maxScreenDim = maxOf(displayMetrics.widthPixels, displayMetrics.heightPixels)
    return (maxScreenDim * 1.5).toInt().coerceIn(1080, 2560)
  }

  fun generateImagePreview(imagePath: String, cacheDir: String, maxDimension: Int): String {
    val result = JSONObject()
    try {
      if (memoryPressureCritical.get()) {
        result.put("previewPath", imagePath)
        result.put("originalWidth", 0)
        result.put("originalHeight", 0)
        result.put("isDownsampled", false)
        result.put("isAnimatedWebp", false)
        result.put("memoryPressure", true)
        return result.toString()
      }

      previewSemaphore.acquire()
      try {
        return generateImagePreviewInternal(imagePath, cacheDir, maxDimension)
      } finally {
        previewSemaphore.release()
      }
    } catch (e: Exception) {
      result.put("error", e.message ?: "unknown")
      result.put("previewPath", imagePath)
    }
    return result.toString()
  }

  private fun generateImagePreviewInternal(imagePath: String, cacheDir: String, maxDimension: Int): String {
    val result = JSONObject()
    val sourceFile = File(imagePath)
    if (!sourceFile.exists()) {
      result.put("error", "File not found: $imagePath")
      return result.toString()
    }

    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(imagePath, options)
    val originalWidth = options.outWidth
    val originalHeight = options.outHeight

    if (originalWidth <= 0 || originalHeight <= 0) {
      result.put("previewPath", imagePath)
      result.put("originalWidth", 0)
      result.put("originalHeight", 0)
      result.put("isDownsampled", false)
      result.put("isAnimatedWebp", false)
      return result.toString()
    }

    val isAnimatedWebp = isAnimatedWebp(imagePath)
    val effectiveMaxDim = if (maxDimension <= 0) getScreenMaxDimension() else maxDimension

    val needsDownsample = originalWidth > effectiveMaxDim || originalHeight > effectiveMaxDim

    if (isAnimatedWebp) {
      result.put("previewPath", imagePath)
      result.put("originalWidth", originalWidth)
      result.put("originalHeight", originalHeight)
      result.put("isDownsampled", false)
      result.put("isAnimatedWebp", true)
      return result.toString()
    }

    if (!needsDownsample) {
      result.put("previewPath", imagePath)
      result.put("originalWidth", originalWidth)
      result.put("originalHeight", originalHeight)
      result.put("isDownsampled", false)
      result.put("isAnimatedWebp", false)
      return result.toString()
    }

    val size = sourceFile.length().toString() + "-" + sourceFile.lastModified() + "-" + imagePath.hashCode()
    val hash = Integer.toHexString(size.hashCode()).take(16)
    val previewFile = File(cacheDir, "nprev_$hash.jpg")

    if (previewFile.exists()) {
      result.put("previewPath", previewFile.absolutePath)
      result.put("originalWidth", originalWidth)
      result.put("originalHeight", originalHeight)
      result.put("isDownsampled", needsDownsample)
      result.put("isAnimatedWebp", isAnimatedWebp)
      return result.toString()
    }

    val decodeOptions = BitmapFactory.Options()
    if (needsDownsample) {
      var inSampleSize = 1
      val maxDim = maxOf(originalWidth, originalHeight)
      while (maxDim / (inSampleSize * 2) >= effectiveMaxDim) {
        inSampleSize *= 2
      }
      decodeOptions.inSampleSize = inSampleSize
    }

    val bitmap = BitmapFactory.decodeFile(imagePath, decodeOptions)
    if (bitmap == null) {
      result.put("previewPath", imagePath)
      result.put("originalWidth", originalWidth)
      result.put("originalHeight", originalHeight)
      result.put("isDownsampled", false)
      result.put("isAnimatedWebp", isAnimatedWebp)
      return result.toString()
    }

    var finalBitmap = bitmap
    if (needsDownsample && (bitmap.width > effectiveMaxDim || bitmap.height > effectiveMaxDim)) {
      val ratio = minOf(
        effectiveMaxDim.toFloat() / bitmap.width,
        effectiveMaxDim.toFloat() / bitmap.height
      )
      val newWidth = (bitmap.width * ratio).toInt()
      val newHeight = (bitmap.height * ratio).toInt()
      finalBitmap = Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true)
      if (finalBitmap !== bitmap) {
        bitmap.recycle()
      }
    }

    try {
      val fos = FileOutputStream(previewFile)
      finalBitmap.compress(Bitmap.CompressFormat.JPEG, 85, fos)
      fos.flush()
      fos.close()
    } catch (e: Exception) {
      result.put("previewPath", imagePath)
      result.put("originalWidth", originalWidth)
      result.put("originalHeight", originalHeight)
      result.put("isDownsampled", false)
      result.put("isAnimatedWebp", isAnimatedWebp)
      finalBitmap.recycle()
      return result.toString()
    }
    finalBitmap.recycle()

    memoryPressureLow.set(false)
    memoryPressureCritical.set(false)

    result.put("previewPath", previewFile.absolutePath)
    result.put("originalWidth", originalWidth)
    result.put("originalHeight", originalHeight)
    result.put("isDownsampled", needsDownsample)
    result.put("isAnimatedWebp", isAnimatedWebp)
    return result.toString()
  }

  private fun isAnimatedWebp(path: String): Boolean {
    try {
      val file = File(path)
      if (!file.exists() || file.length() < 21) return false
      if (!path.lowercase().endsWith(".webp") && !path.lowercase().endsWith(".gif")) return false
      if (path.lowercase().endsWith(".gif")) return true

      val bytes = file.inputStream().use { it.readNBytes(21) }
      if (bytes.size < 21) return false
      if (!bytes.sliceArray(0..3).contentEquals(byteArrayOf(0x52, 0x49, 0x46, 0x46))) return false
      if (!bytes.sliceArray(8..11).contentEquals(byteArrayOf(0x57, 0x45, 0x42, 0x50))) return false
      val chunkType = bytes.sliceArray(12..15)
      if (chunkType.contentEquals(byteArrayOf(0x56, 0x50, 0x38, 0x20))) return false
      if (chunkType.contentEquals(byteArrayOf(0x56, 0x50, 0x38, 0x4C))) return false
      if (chunkType.contentEquals(byteArrayOf(0x56, 0x50, 0x38, 0x58))) {
        val flags = bytes[20]
        return (flags.toInt() and 0x02) != 0
      }
      return false
    } catch (_: Exception) {
      return false
    }
  }

  private val thumbnailSemaphore = Semaphore(4)

  fun generateThumbnail(imagePath: String, cacheDir: String): String {
    val result = JSONObject()
    try {
      thumbnailSemaphore.acquire()
      try {
        return generateThumbnailInternal(imagePath, cacheDir)
      } finally {
        thumbnailSemaphore.release()
      }
    } catch (e: Exception) {
      result.put("error", e.message ?: "unknown")
    }
    return result.toString()
  }

  private fun generateThumbnailInternal(imagePath: String, cacheDir: String): String {
    val result = JSONObject()
    try {
      val sourceFile = File(imagePath)
      if (!sourceFile.exists()) {
        result.put("error", "File not found")
        return result.toString()
      }

      val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(imagePath, options)
      val originalWidth = options.outWidth
      val originalHeight = options.outHeight

      if (originalWidth <= 0 || originalHeight <= 0) {
        result.put("error", "Cannot decode image dimensions")
        return result.toString()
      }

      val size = sourceFile.length().toString() + "-" + sourceFile.lastModified() + "-" + imagePath.hashCode()
      val hash = Integer.toHexString(size.hashCode()).take(16)

      val hasAlpha = options.outMimeType?.contains("png", true) == true ||
                     options.outMimeType?.contains("webp", true) == true ||
                     options.outMimeType?.contains("gif", true) == true

      val targetSize = 256
      var inSampleSize = 1
      val maxDim = maxOf(originalWidth, originalHeight)
      while (maxDim / (inSampleSize * 2) >= targetSize * 2) {
        inSampleSize *= 2
      }

      val decodeOptions = BitmapFactory.Options().apply {
        this.inSampleSize = inSampleSize
      }

      val bitmap = BitmapFactory.decodeFile(imagePath, decodeOptions)
      if (bitmap == null) {
        result.put("error", "Failed to decode bitmap")
        return result.toString()
      }

      val (dstWidth, dstHeight) = computeThumbnailSize(bitmap.width, bitmap.height, targetSize)

      val finalBitmap = if (bitmap.width != dstWidth || bitmap.height != dstHeight) {
        val scaled = Bitmap.createScaledBitmap(bitmap, dstWidth, dstHeight, true)
        if (scaled !== bitmap) bitmap.recycle()
        scaled
      } else {
        bitmap
      }

      val hasActualAlpha = hasAlpha && finalBitmap.hasAlpha()
      val ext = if (hasActualAlpha) "webp" else "jpg"
      val cacheFilename = "${hash}_q85.$ext"
      val cacheFile = File(cacheDir, cacheFilename)

      if (cacheFile.exists()) {
        result.put("thumbnailPath", cacheFile.absolutePath)
        result.put("width", originalWidth)
        result.put("height", originalHeight)
        finalBitmap.recycle()
        return result.toString()
      }

      if (!cacheDir.startsWith("/")) {
        val dir = File(cacheDir)
        if (!dir.exists()) dir.mkdirs()
      }

      try {
        val fos = FileOutputStream(cacheFile)
        if (hasActualAlpha) {
          finalBitmap.compress(Bitmap.CompressFormat.WEBP, 85, fos)
        } else {
          finalBitmap.compress(Bitmap.CompressFormat.JPEG, 85, fos)
        }
        fos.flush()
        fos.close()
      } catch (e: Exception) {
        result.put("error", "Failed to write cache: ${e.message}")
        finalBitmap.recycle()
        return result.toString()
      }
      finalBitmap.recycle()

      result.put("thumbnailPath", cacheFile.absolutePath)
      result.put("width", originalWidth)
      result.put("height", originalHeight)
    } catch (e: Exception) {
      result.put("error", e.message ?: "unknown")
    }
    return result.toString()
  }

  private fun computeThumbnailSize(width: Int, height: Int, targetSize: Int): Pair<Int, Int> {
    return if (width < height) {
      val ratio = height.toFloat() / width.toFloat()
      Pair(targetSize, (targetSize.toFloat() * ratio).toInt())
    } else {
      val ratio = width.toFloat() / height.toFloat()
      Pair((targetSize.toFloat() * ratio).toInt(), targetSize)
    }
  }

  private fun findWebView(root: View): WebView? {
    if (root is WebView) return root
    if (root is ViewGroup) {
      val stack = mutableListOf<View>(root)
      while (stack.isNotEmpty()) {
        val view = stack.removeAt(stack.lastIndex)
        if (view is WebView) return view
        if (view is ViewGroup) {
          for (i in 0 until view.childCount) {
            stack.add(view.getChildAt(i))
          }
        }
      }
    }
    return null
  }

  fun showExtractionNotification(title: String, current: Int, total: Int) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        requestPostNotificationPermission()
      }
    }
    val intent = Intent(this, ColorExtractionService::class.java).apply {
      action = ColorExtractionService.ACTION_START
      putExtra(ColorExtractionService.EXTRA_TITLE, title)
      putExtra(ColorExtractionService.EXTRA_CURRENT, current)
      putExtra(ColorExtractionService.EXTRA_TOTAL, total)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(intent)
    } else {
      startService(intent)
    }
  }

  fun updateExtractionNotification(current: Int, total: Int, isPaused: Boolean) {
    ColorExtractionService.updateProgress(current, total, isPaused)
    ColorExtractionService.notifyUpdate(this)
  }

  fun hideExtractionNotification() {
    val intent = Intent(this, ColorExtractionService::class.java).apply {
      action = ColorExtractionService.ACTION_STOP
    }
    startService(intent)
  }

  private var notificationPermissionLauncher: (() -> Unit)? = null

  private fun requestPostNotificationPermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        try {
          permissionLauncher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
        } catch (_: Exception) {}
      }
    }
  }

  // ===== 局域网共享服务端（桌面端连接安卓端） =====

  /** 由 Rust lan_share_android_start 调用：启动局域网共享前台服务。 */
  fun startLanShareService(port: Int, ip: String) {
    android.util.Log.i("LanShareService", "startLanShareService called: port=$port ip=$ip")
    LanShareService.createChannel(this)
    requestPostNotificationPermission()
    val effectiveIp = if (ip.isNotEmpty() && ip != "127.0.0.1") ip else getLocalIpAddress()
    val intent = Intent(this, LanShareService::class.java).apply {
      action = LanShareService.ACTION_START
      putExtra(LanShareService.EXTRA_PORT, port)
      putExtra(LanShareService.EXTRA_IP, effectiveIp)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(intent)
    } else {
      startService(intent)
    }
  }

  /** 由 Rust lan_share_android_stop 调用：停止局域网共享前台服务。 */
  fun stopLanShareService() {
    android.util.Log.i("LanShareService", "stopLanShareService called")
    val intent = Intent(this, LanShareService::class.java).apply {
      action = LanShareService.ACTION_STOP
    }
    startService(intent)
  }

  /** 获取本机局域网 IP（Wi-Fi）。返回空串表示获取失败。 */
  @Suppress("DEPRECATION")
  fun getLocalIpAddress(): String {
    try {
      val wifiManager = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
      val ip = wifiManager.connectionInfo?.ipAddress ?: 0
      android.util.Log.i("LanShareService", "getLocalIpAddress: wifiManager ip=$ip")
      if (ip > 0) {
        val ipStr = String.format(
          java.util.Locale.US,
          "%d.%d.%d.%d",
          ip and 0xff,
          (ip shr 8) and 0xff,
          (ip shr 16) and 0xff,
          (ip shr 24) and 0xff
        )
        android.util.Log.i("LanShareService", "getLocalIpAddress: wifiManager result=$ipStr")
        return ipStr
      }
    } catch (e: Exception) {
      android.util.Log.w("LanShareService", "getLocalIpAddress wifi failed: ${e.message}")
    }
    // 回退：遍历网络接口（ConnectivityManager linkProperties）
    try {
      val connectivityManager = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
      for (network in connectivityManager.allNetworks) {
        val caps = connectivityManager.getNetworkCapabilities(network) ?: continue
        if (!caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) continue
        val linkProps = connectivityManager.getLinkProperties(network) ?: continue
        for (addr in linkProps.linkAddresses) {
          val host = addr.address
          if (!host.isLoopbackAddress && host is java.net.Inet4Address) {
            val ipStr = host.hostAddress ?: ""
            android.util.Log.i("LanShareService", "getLocalIpAddress: connectivity result=$ipStr")
            return ipStr
          }
        }
      }
    } catch (e: Exception) {
      android.util.Log.w("LanShareService", "getLocalIpAddress connectivity failed: ${e.message}")
    }
    android.util.Log.w("LanShareService", "getLocalIpAddress: all attempts failed, returning empty")
    return ""
  }

  fun setStatusBarStyle(isDark: Boolean) {
    runOnUiThread {
      val window = this.window
      // 如果当前仍处于启动沉浸状态，先退出沉浸并显示状态栏，确保颜色生效
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val controller = window.insetsController
        controller?.show(android.view.WindowInsets.Type.statusBars())
        if (isDark) {
          controller?.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS)
        } else {
          controller?.setSystemBarsAppearance(
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
          )
        }
      } else {
        @Suppress("DEPRECATION")
        val decorView = window.decorView
        @Suppress("DEPRECATION")
        var systemUiVisibility = decorView.systemUiVisibility
        systemUiVisibility = systemUiVisibility and View.SYSTEM_UI_FLAG_FULLSCREEN.inv()
        systemUiVisibility = systemUiVisibility and View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY.inv()
        systemUiVisibility = if (isDark) {
          systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
        } else {
          systemUiVisibility or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        }
        decorView.systemUiVisibility = systemUiVisibility
      }
      window.statusBarColor = if (isDark) Color.parseColor("#1a1a1a") else Color.parseColor("#e5e5e5")
    }
  }

  fun setImmersiveMode(immersive: Boolean) {
    runOnUiThread {
      val window = this.window
      if (immersive) {
        WindowCompat.setDecorFitsSystemWindows(window, false)
      } else {
        WindowCompat.setDecorFitsSystemWindows(window, true)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val controller = window.insetsController
        if (controller != null) {
          if (immersive) {
            controller.hide(android.view.WindowInsets.Type.systemBars())
            controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          } else {
            controller.show(android.view.WindowInsets.Type.systemBars())
          }
        }
      } else {
        @Suppress("DEPRECATION")
        val decorView = window.decorView
        if (immersive) {
          decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
          )
        } else {
          decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        }
      }
      if (immersive) {
        window.statusBarColor = Color.TRANSPARENT
      } else {
        applyInitialStatusBarStyle()
      }
    }
  }

  fun shareImage(imagePath: String) {
    runOnUiThread {
      try {
        val file = File(imagePath)
        if (!file.exists()) {
          android.util.Log.e("AuroraShare", "File not found: $imagePath")
          return@runOnUiThread
        }

        val uri = androidx.core.content.FileProvider.getUriForFile(
          this,
          "${packageName}.fileprovider",
          file
        )

        android.util.Log.d("AuroraShare", "Sharing: $imagePath → $uri")

        val shareIntent = Intent(Intent.ACTION_SEND).apply {
          type = "image/*"
          putExtra(Intent.EXTRA_STREAM, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        startActivity(Intent.createChooser(shareIntent, null))
      } catch (e: Exception) {
        android.util.Log.e("AuroraShare", "Failed to share: $imagePath", e)
      }
    }
  }

  fun shareImages(imagePathsJson: String) {
    runOnUiThread {
      try {
        val paths = org.json.JSONArray(imagePathsJson)
        val uris = java.util.ArrayList<android.net.Uri>()
        for (i in 0 until paths.length()) {
          val file = java.io.File(paths.getString(i))
          if (file.exists()) {
            val uri = androidx.core.content.FileProvider.getUriForFile(
              this, "${packageName}.fileprovider", file
            )
            uris.add(uri)
          }
        }
        if (uris.isEmpty()) {
          android.util.Log.e("AuroraShare", "No valid files to share")
          return@runOnUiThread
        }

        val shareIntent = if (uris.size == 1) {
          Intent(Intent.ACTION_SEND).apply {
            type = "image/*"
            putExtra(Intent.EXTRA_STREAM, uris[0])
          }
        } else {
          Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            type = "image/*"
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
          }
        }
        shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        android.util.Log.d("AuroraShare", "Sharing ${uris.size} images")

        startActivity(Intent.createChooser(shareIntent, null))
      } catch (e: Exception) {
        android.util.Log.e("AuroraShare", "Failed to share images", e)
      }
    }
  }

  fun deleteMediaByIds(jsonIds: String): String {
    try {
      val ids = org.json.JSONArray(jsonIds)
      var deletedCount = 0
      var failedCount = 0

      for (i in 0 until ids.length()) {
        val id = ids.getLong(i)
        val uri = android.content.ContentUris.withAppendedId(
          android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
        )
        try {
          val rowsDeleted = contentResolver.delete(uri, null, null)
          if (rowsDeleted > 0) {
            deletedCount++
            val cacheFilename = "sys_${id}_q80.jpg"
            val cacheFile = java.io.File(cacheDir, cacheFilename)
            if (cacheFile.exists()) {
              cacheFile.delete()
            }
          } else {
            failedCount++
          }
        } catch (e: android.app.RecoverableSecurityException) {
          android.util.Log.d("AuroraDelete", "RecoverableSecurityException for $id, requesting user consent")
          runOnUiThread {
            try {
              startIntentSenderForResult(
                e.userAction.actionIntent.intentSender,
                10001 + (deletedCount + failedCount),
                null, 0, 0, 0, null
              )
            } catch (e2: Exception) {
              android.util.Log.e("AuroraDelete", "Failed to start recovery intent", e2)
            }
          }
          failedCount++
        } catch (e: Exception) {
          android.util.Log.e("AuroraDelete", "Delete failed for $id", e)
          failedCount++
        }
      }

      val result = org.json.JSONObject().apply {
        put("deleted", deletedCount)
        put("failed", failedCount)
      }
      return result.toString()
    } catch (e: Exception) {
      android.util.Log.e("AuroraDelete", "Failed to delete media", e)
      val result = org.json.JSONObject().apply {
        put("deleted", 0)
        put("failed", -1)
        put("error", e.message ?: "unknown")
      }
      return result.toString()
    }
  }

  // ===== Native Gallery Viewer =====

  fun openNativeViewer(imagesJson: String, startIndex: Int, optionsJson: String) {
    android.util.Log.i("AuroraNativeViewer", "openNativeViewer called: startIndex=$startIndex, imagesJson.length=${imagesJson.length}")
    runOnUiThread {
      try {
        val arr = JSONArray(imagesJson)
        android.util.Log.i("AuroraNativeViewer", "parsed ${arr.length()} images")
        val items = ArrayList<NativeGalleryView.ImageItem>(arr.length())
        for (i in 0 until arr.length()) {
          val o = arr.getJSONObject(i)
          val isLan = o.optBoolean("isLan", false)
          val path = o.optString("path", "")
          val remotePath = o.optString("remotePath", "")
          val resolvedPath = if (isLan) {
            // LAN: path 字段已是完整 HTTP URL（前端已用 lanClientApi.getImageUrl 构造）
            path
          } else {
            path
          }
          val thumbUrl = o.optString("thumbnailUrl", "").ifEmpty { null }
          // 元数据字段
          val tagsList = mutableListOf<String>()
          val tagsArr = o.optJSONArray("tags")
          if (tagsArr != null) {
            for (t in 0 until tagsArr.length()) tagsList.add(tagsArr.optString(t))
          }
          val paletteList = mutableListOf<String>()
          val paletteArr = o.optJSONArray("palette")
          if (paletteArr != null) {
            for (c in 0 until paletteArr.length()) paletteList.add(paletteArr.optString(c))
          }
          val aiTagsList = mutableListOf<String>()
          val aiObjectsList = mutableListOf<String>()
          o.optJSONObject("aiData")?.let { ai ->
            val at = ai.optJSONArray("tags")
            if (at != null) for (t in 0 until at.length()) aiTagsList.add(at.optString(t))
            val ao = ai.optJSONArray("objects")
            if (ao != null) for (t in 0 until ao.length()) aiObjectsList.add(ao.optString(t))
          }
          items.add(NativeGalleryView.ImageItem(
            path = resolvedPath,
            fileId = o.optString("fileId", ""),
            name = o.optString("name", ""),
            width = o.optInt("width", 0),
            height = o.optInt("height", 0),
            isLan = isLan,
            thumbnailUrl = thumbUrl,
            contentUri = o.optString("contentUri", ""),
            size = o.optLong("size", 0),
            format = o.optString("format", ""),
            createdAt = o.optString("createdAt", ""),
            updatedAt = o.optString("updatedAt", ""),
            tags = tagsList,
            description = o.optString("description", ""),
            sourceUrl = o.optString("sourceUrl", ""),
            palette = paletteList,
            aiTags = aiTagsList,
            aiDescription = o.optJSONObject("aiData")?.optString("description", "") ?: "",
            aiSceneCategory = o.optJSONObject("aiData")?.optString("sceneCategory", "") ?: "",
            aiObjects = aiObjectsList,
            parentName = o.optString("parentName", ""),
          ))
        }
        val options = if (optionsJson.isNotEmpty()) JSONObject(optionsJson) else null
        val view = nativeGalleryView
        if (view == null) {
          android.util.Log.e("AuroraNativeViewer", "nativeGalleryView is null, cannot open")
          evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onClose)window.__androidViewerBridge.onClose();")
          return@runOnUiThread
        }
        if (!view.isAttachedToWindow) {
          val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
          )
          params.token = window.decorView.windowToken
          windowManager.addView(view, params)
          android.util.Log.i("AuroraNativeViewer", "view added to WindowManager, isAttachedToWindow=${view.isAttachedToWindow}")
        }
        view.open(items, startIndex, options)
        android.util.Log.i("AuroraNativeViewer", "view.open() completed, isAttachedToWindow=${view.isAttachedToWindow}, visibility=${view.visibility}")
      } catch (e: Exception) {
        android.util.Log.e("AuroraNativeViewer", "openNativeViewer failed", e)
        evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onClose)window.__androidViewerBridge.onClose();")
      }
    }
  }

  fun closeNativeViewer() {
    runOnUiThread {
      nativeGalleryView?.let { view ->
        view.close()
        if (view.isAttachedToWindow) {
          windowManager.removeView(view)
        }
      }
    }
  }

  fun closeNativeDrawer() {
    runOnUiThread {
      nativeGalleryView?.let { view ->
        if (view.isDrawerOpen()) {
          // 抽屉打开 → 收起抽屉
          view.closeDrawer()
        } else if (view.isOpen()) {
          // 抽屉未打开但查看器打开 → 关闭查看器
          view.close()
          if (view.isAttachedToWindow) {
            windowManager.removeView(view)
          }
          evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onClose)window.__androidViewerBridge.onClose();")
        }
      }
    }
  }

  fun updateNativeItem(fileId: String, updatesJson: String) {
    runOnUiThread {
      try {
        val updates = JSONObject(updatesJson)
        nativeGalleryView?.updateItem(fileId, updates)
      } catch (e: Exception) {
        android.util.Log.e("AuroraNativeViewer", "updateNativeItem parse error", e)
      }
    }
  }

  fun nativeViewerNavigate(direction: String) {
    runOnUiThread {
      when (direction) {
        "prev" -> nativeGalleryView?.navigate(-1)
        "next" -> nativeGalleryView?.navigate(1)
        "random" -> {
          val view = nativeGalleryView ?: return@runOnUiThread
          // 简单随机：跳到任意位置
          val total = view.childCount
          // 通过反射或公开 API 获取图片数量；这里复用 navigate 1 多次
          // 实际随机逻辑由前端控制（前端知道完整列表），这里不实现 random
          nativeGalleryView?.navigate(1)
        }
      }
    }
  }

  fun nativeViewerSetSlideshow(enabled: Boolean) {
    runOnUiThread {
      nativeGalleryView?.setSlideshow(enabled)
    }
  }

  fun nativeViewerSetRotation(degrees: Int) {
    runOnUiThread {
      nativeGalleryView?.setRotation(degrees)
    }
  }

  fun nativeViewerSetLanToken(token: String) {
    lanToken = token
    // Coil 默认会复用 connection pool；token 通过 URL query 传递（前端已构造），
    // 这里仅存储以备未来需要 header 鉴权时使用
  }
}
