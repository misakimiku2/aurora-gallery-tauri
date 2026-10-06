import java.util.Properties

// Release 签名走根目录 keystore.properties（不进 git，见 .gitignore）：文件缺失时
// release 构建退回未签名（与旧版行为一致），dev 机无需 keystore 也能出 debug 包
val keystoreProperties = Properties()
val hasReleaseSigning = rootProject.file("keystore.properties").exists()
if (hasReleaseSigning) {
    rootProject.file("keystore.properties").inputStream().use { keystoreProperties.load(it) }
}

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.aurora.gallery.kotlin"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.aurora.gallery.kotlin"
        minSdk = 24
        targetSdk = 36
        versionCode = 5
        versionName = "2.2.1"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.15"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.9.2")
    // by viewModels 委托（GalleryViewModel）与 viewModelScope
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.6")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    // RecyclerView + GridLayoutManager（网格滑动用原生 View 体系，对齐系统相册性能基线）
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    // M3 查看器：ZoomableImageView 继承 AppCompatImageView（矢量 drawable 在低版本上的兼容路径）
    implementation("androidx.appcompat:appcompat:1.6.1")
    // UniFFI 生成的 Kotlin 绑定运行时依赖（JNA 加载 .so）
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    // 缩略图加载（支持 content:// MediaStore URI）
    implementation("io.coil-kt:coil-compose:2.7.0")
    // M3 查看器：GifDecoder / ImageDecoderDecoder（动画 GIF 与动画 WebP）
    implementation("io.coil-kt:coil-gif:2.7.0")
    // M6a 0.7 spike（D33）：LAN 客户端 HTTP 栈。显式声明、版本对齐 Coil 2.7 的传递依赖
    // （coil 用的就是 okhttp 4.12，不另引新版本），阶段 3 LanClient 以此为底
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // M6a 0.7 spike（D33）：扫码。自带 zxing core（编码/解码都齐）；其 CaptureActivity
    // 需要 appcompat 主题（上面已依赖 appcompat 1.6.1）。minSdk 24 与本 app 对齐
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // M6a 阶段 7：对等服务端 HTTP 引擎（D30a Kotlin 原生 10 端点；单 jar 无传递依赖，APK 增量阶段 8 记录）
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    // M5 1.1：装箱/视口/几何纯函数的 JVM 单测（对拍 React 同输入同输出）
    testImplementation("junit:junit:4.13.2")
}
