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
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
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
    requestMediaPermissions()
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
      folders.put(folder)
    }

    val result = JSONObject().apply {
      put("images", images)
      put("folders", folders)
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
}
