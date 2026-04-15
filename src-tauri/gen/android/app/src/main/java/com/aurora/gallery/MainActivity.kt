package com.aurora.gallery

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

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
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
