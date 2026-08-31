package com.aurora.gallery.kotlin

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import uniffi.ffi_poc.Folder
import uniffi.ffi_poc.init
import uniffi.ffi_poc.listFolders
import uniffi.ffi_poc.listImages

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 把 assets 里的 poc-data.db 拷到 filesDir，并初始化 Rust 侧数据库路径
        val dbFile = java.io.File(filesDir, "poc-data.db")
        if (!dbFile.exists()) {
            assets.open("poc-data.db").use { input ->
                dbFile.outputStream().use { output -> input.copyTo(output) }
            }
        }
        init(dbFile.absolutePath)

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    App()
                }
            }
        }
    }
}

@Composable
fun App() {
    var currentFolder by remember { mutableStateOf<Folder?>(null) }

    if (currentFolder == null) {
        val folders = remember { listFolders() }
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            items(folders) { folder ->
                Text(
                    text = folder.name,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { currentFolder = folder }
                        .padding(horizontal = 16.dp, vertical = 16.dp),
                )
            }
        }
    } else {
        val folder = currentFolder!!
        val images = remember(folder.id) { listImages(folder.id) }
        LazyColumn(modifier = Modifier.fillMaxSize()) {
            item {
                Text(
                    text = "← ${folder.name}（${images.size} 张）",
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { currentFolder = null }
                        .padding(16.dp),
                )
            }
            items(images) { img ->
                Text(
                    text = img.name,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
        }
    }
}
