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
import android.webkit.WebView
import android.view.WindowInsetsController
import android.graphics.Color
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
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
    } else {
      val permanentlyDenied = permissions.any { (perm, granted) ->
        !granted && !shouldShowRequestPermissionRationale(perm)
      }
      if (permanentlyDenied) {
        notifyPermissionResultWithRetry("denied_permanently")
      } else {
        notifyPermissionResultWithRetry("denied")
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    val splashScreen = installSplashScreen()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    splashScreen.setKeepOnScreenCondition { false }
    applyInitialStatusBarStyle()
    requestMediaPermissions()
    setupBackPressedHandler()
    registerComponentCallbacks(componentCallbacks)
    ColorExtractionService.createChannel(this)
  }

  private fun applyInitialStatusBarStyle() {
    val currentNightMode = resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK
    val isDark = currentNightMode == android.content.res.Configuration.UI_MODE_NIGHT_YES
    setStatusBarStyle(isDark)
  }

  private fun setupBackPressedHandler() {
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
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

  fun setStatusBarStyle(isDark: Boolean) {
    runOnUiThread {
      val window = this.window
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val controller = window.insetsController
        if (controller != null) {
          if (isDark) {
            controller.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS)
          } else {
            controller.setSystemBarsAppearance(
              WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
              WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
            )
          }
        }
      } else {
        val decorView = window.decorView
        var systemUiVisibility = decorView.systemUiVisibility
        systemUiVisibility = if (isDark) {
          systemUiVisibility and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
        } else {
          systemUiVisibility or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        }
        decorView.systemUiVisibility = systemUiVisibility
      }
      window.statusBarColor = if (isDark) Color.parseColor("#171717") else Color.parseColor("#E5E5E5")
    }
  }

  fun setImmersiveMode(immersive: Boolean) {
    runOnUiThread {
      val window = this.window
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
}
