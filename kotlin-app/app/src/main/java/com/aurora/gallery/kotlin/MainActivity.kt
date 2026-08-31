package com.aurora.gallery.kotlin

import android.Manifest
import android.content.ContentUris
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.aurora_core.Folder
import uniffi.aurora_core.Image
import uniffi.aurora_core.MediaImage
import uniffi.aurora_core.initDb
import uniffi.aurora_core.listFolders
import uniffi.aurora_core.listImages
import uniffi.aurora_core.upsertMediaImages
import java.io.File

class MainActivity : ComponentActivity() {

    private val folders = mutableStateOf<List<Folder>>(emptyList())
    private val currentFolder = mutableStateOf<Folder?>(null)
    private val images = mutableStateOf<List<Image>>(emptyList())
    private val scanning = mutableStateOf(false)
    private lateinit var thumbnailLoader: ThumbnailLoader

    private val requestPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) startScan()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 初始化 Rust 数据库（filesDir 下）
        val dbFile = File(filesDir, "aurora.db")
        initDb(dbFile.absolutePath)
        thumbnailLoader = ThumbnailLoader(this)

        setContent {
            MaterialTheme {
                App(
                    folders = folders.value,
                    currentFolder = currentFolder.value,
                    images = images.value,
                    scanning = scanning.value,
                    thumbnailLoader = thumbnailLoader,
                    onFolderClick = { openFolder(it) },
                    onBack = { currentFolder.value = null },
                )
            }
        }

        requestMediaPermissionIfNeeded()
    }

    private fun requestMediaPermissionIfNeeded() {
        val permission = if (Build.VERSION.SDK_INT >= 33) {
            Manifest.permission.READ_MEDIA_IMAGES
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
            startScan()
        } else {
            requestPermission.launch(permission)
        }
    }

    private fun startScan() {
        lifecycleScope.launch {
            scanning.value = true
            try {
                val result = withContext(Dispatchers.IO) {
                    val imgs = scanMediaStore()
                    upsertMediaImages(imgs)
                    listFolders()
                }
                folders.value = result
            } catch (_: Exception) {
                // 扫描/入库失败时保持空列表（M1 阶段 1 简单容错）
            } finally {
                scanning.value = false
            }
        }
    }

    private fun openFolder(folder: Folder) {
        currentFolder.value = folder
        lifecycleScope.launch {
            val imgs = withContext(Dispatchers.IO) { listImages(folder.id) }
            images.value = imgs
        }
    }

    private fun scanMediaStore(): List<MediaImage> {
        val result = mutableListOf<MediaImage>()
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATA,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.BUCKET_ID,
            MediaStore.Images.Media.BUCKET_DISPLAY_NAME,
        )
        contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            null,
            null,
            "${MediaStore.Images.Media.DATE_MODIFIED} DESC"
        )?.use { c ->
            val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val nameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
            val dataCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATA)
            val sizeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            val addedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val modifiedCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
            val widthCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
            val heightCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)
            val mimeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            val bucketIdCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_ID)
            val bucketNameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.BUCKET_DISPLAY_NAME)

            while (c.moveToNext()) {
                val id = c.getLong(idCol)
                result.add(
                    MediaImage(
                        id = id,
                        contentUri = ContentUris.withAppendedId(
                            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id
                        ).toString(),
                        path = c.getString(dataCol) ?: "",
                        name = c.getString(nameCol) ?: "",
                        size = c.getLong(sizeCol),
                        dateAdded = c.getLong(addedCol),
                        dateModified = c.getLong(modifiedCol),
                        width = if (c.isNull(widthCol)) null else c.getInt(widthCol),
                        height = if (c.isNull(heightCol)) null else c.getInt(heightCol),
                        mimeType = c.getString(mimeCol) ?: "",
                        bucketId = c.getLong(bucketIdCol).toString(),
                        bucketName = c.getString(bucketNameCol) ?: "",
                    )
                )
            }
        }
        return result
    }
}

@Composable
fun App(
    folders: List<Folder>,
    currentFolder: Folder?,
    images: List<Image>,
    scanning: Boolean,
    thumbnailLoader: ThumbnailLoader,
    onFolderClick: (Folder) -> Unit,
    onBack: () -> Unit,
) {
    if (scanning) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("扫描中…")
        }
        return
    }

    if (currentFolder == null) {
        LazyColumn(Modifier.fillMaxSize()) {
            items(folders) { folder ->
                Text(
                    text = folder.name,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onFolderClick(folder) }
                        .padding(horizontal = 16.dp, vertical = 16.dp),
                )
            }
        }
    } else {
        Column(Modifier.fillMaxSize()) {
            Text(
                text = "← ${currentFolder.name}（${images.size} 张）",
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onBack() }
                    .padding(16.dp),
            )
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 120.dp),
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(images) { img ->
                    MediaThumbnail(
                        contentUri = img.contentUri,
                        contentDescription = img.name,
                        loader = thumbnailLoader,
                        modifier = Modifier
                            .fillMaxWidth()
                            .aspectRatio(1f),
                    )
                }
            }
        }
    }
}
