//! 安卓端局域网共享服务端的 Tauri 命令层。
//! 负责服务端生命周期管理，以及 Kotlin 前台服务（保活通知）的启停。
//!
//! 服务端实例存放在全局 OnceLock 中（而非 Tauri State），
//! 使通知栏"停止共享"按钮（Kotlin → JNI extern fn）也能访问并停止服务端。

use std::sync::Arc;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;

use crate::android::server::{
    get_android_local_ip, AndroidLanServerConfig, AndroidLanServerInfo,
    AndroidLanServerStatus, LanShareServer,
};

static ANDROID_LAN_SHARE_SERVER: OnceLock<Arc<RwLock<Option<LanShareServer>>>> =
    OnceLock::new();
static LAN_SERVER_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

fn server_global() -> &'static Arc<RwLock<Option<LanShareServer>>> {
    ANDROID_LAN_SHARE_SERVER.get_or_init(|| Arc::new(RwLock::new(None)))
}

/// 通过 JNI 启动 Kotlin 前台服务（局域网共享保活通知）。
async fn start_foreground_service(port: u16, ip: &str) -> Result<(), String> {
    let port_i32 = port as i32;
    let ip_string = ip.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let activity = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
            .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
        let activity_obj =
            unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };
        let j_ip = env
            .new_string(&ip_string)
            .map_err(|e| format!("Failed to create ip string: {:?}", e))?;
        env.call_method(
            &activity_obj,
            "startLanShareService",
            "(ILjava/lang/String;)V",
            &[
                jni::objects::JValue::Int(port_i32),
                jni::objects::JValue::Object(&j_ip),
            ],
        )
        .map_err(|e| format!("Failed to call startLanShareService: {:?}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {:?}", e))?
}

/// 通过 JNI 停止 Kotlin 前台服务。
async fn stop_foreground_service() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let activity = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
            .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
        let activity_obj =
            unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };
        env.call_method(&activity_obj, "stopLanShareService", "()V", &[])
            .map_err(|e| format!("Failed to call stopLanShareService: {:?}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {:?}", e))?
}

#[tauri::command]
pub async fn lan_share_android_start(
    config: AndroidLanServerConfig,
    app: AppHandle,
) -> Result<AndroidLanServerInfo, String> {
    log::info!("[LAN Share Android] 收到启动命令 - 端口: {}", config.port);

    let server_arc = server_global();
    {
        let server_guard = server_arc.read().await;
        if let Some(server) = server_guard.as_ref() {
            if server.is_running() {
                // 幂等：已在运行时返回当前信息（更新配置后直接复用），
                // 避免"Server is already running"错误打断融合自动开启流程。
                log::info!("[LAN Share Android] 服务器已在运行中，返回当前信息");
                server.update_config(config).await;
                let status = server.get_status().await;
                return Ok(AndroidLanServerInfo {
                    url: status
                        .local_ip
                        .clone()
                        .map(|ip| format!("http://{}:{}", ip, status.port))
                        .unwrap_or_else(|| format!("http://127.0.0.1:{}", status.port)),
                    port: status.port,
                    local_ip: status.local_ip.unwrap_or_else(|| "127.0.0.1".to_string()),
                });
            }
        }
    }

    let mut server_guard = server_arc.write().await;
    if let Some(server) = server_guard.as_mut() {
        if server.is_running() {
            server.update_config(config).await;
            let status = server.get_status().await;
            return Ok(AndroidLanServerInfo {
                url: status
                    .local_ip
                    .clone()
                    .map(|ip| format!("http://{}:{}", ip, status.port))
                    .unwrap_or_else(|| format!("http://127.0.0.1:{}", status.port)),
                port: status.port,
                local_ip: status.local_ip.unwrap_or_else(|| "127.0.0.1".to_string()),
            });
        }
    }

    let cache_dir = app
        .path()
        .cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;
    let _ = std::fs::create_dir_all(&cache_dir);

    let mut server = LanShareServer::new(cache_dir);
    let info = server.start(config, app.clone()).await?;
    *server_guard = Some(server);
    drop(server_guard);

    let _ = LAN_SERVER_APP_HANDLE.set(app.clone());

    // 启动前台服务保活通知（失败不影响服务端运行，仅记录告警）
    if let Err(e) = start_foreground_service(info.port, &info.local_ip).await {
        log::warn!("[LAN Share Android] 前台服务启动失败: {}", e);
    }

    let _ = app.emit("lan-share-android-status-changed", ());

    log::info!("[LAN Share Android] 启动成功 - URL: {}", info.url);
    Ok(info)
}

#[tauri::command]
pub async fn lan_share_android_stop(app: AppHandle) -> Result<(), String> {
    log::info!("[LAN Share Android] 收到停止命令");
    let server_arc = server_global();
    let mut server_guard = server_arc.write().await;
    if let Some(server) = server_guard.as_mut() {
        server.stop().await;
    }
    *server_guard = None;
    drop(server_guard);

    if let Err(e) = stop_foreground_service().await {
        log::warn!("[LAN Share Android] 前台服务停止失败: {}", e);
    }
    let _ = app.emit("lan-share-android-status-changed", ());
    Ok(())
}

/// 供 JNI（通知栏"停止共享"）等非 async 上下文调用：
/// 通过 async runtime 异步停止服务端并通知前端。
fn stop_server_internal() {
    let server_arc = server_global();
    let server = server_arc.clone();
    tauri::async_runtime::spawn(async move {
        let mut guard = server.write().await;
        if let Some(s) = guard.as_mut() {
            s.stop().await;
        }
        *guard = None;
        if let Some(app) = LAN_SERVER_APP_HANDLE.get() {
            let _ = app.emit("lan-share-android-status-changed", ());
        }
    });
}

#[tauri::command]
pub async fn lan_share_android_get_status() -> Result<AndroidLanServerStatus, String> {
    let server_arc = server_global();
    let server_guard = server_arc.read().await;
    if let Some(server) = server_guard.as_ref() {
        Ok(server.get_status().await)
    } else {
        Ok(AndroidLanServerStatus {
            is_running: false,
            port: 8080,
            local_ip: get_android_local_ip(),
            device_count: 0,
        })
    }
}

#[tauri::command]
pub async fn lan_share_android_get_devices() -> Result<Vec<crate::lan_share::ConnectedDevice>, String> {
    let server_arc = server_global();
    let server_guard = server_arc.read().await;
    if let Some(server) = server_guard.as_ref() {
        Ok(server.get_devices().await)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn lan_share_android_update_config(
    config: AndroidLanServerConfig,
) -> Result<(), String> {
    log::info!("[LAN Share Android] 更新配置 - 端口: {}", config.port);
    let server_arc = server_global();
    let server_guard = server_arc.read().await;
    if let Some(server) = server_guard.as_ref() {
        server.update_config(config).await;
    } else {
        log::warn!("[LAN Share Android] 配置更新忽略 - 服务器未运行");
    }
    Ok(())
}

/// 由 Kotlin LanShareService 通知栏"停止共享"按钮调用。
/// 此函数运行在任意 Java 线程上，停止动作通过 async runtime 异步执行。
#[no_mangle]
pub extern "C" fn Java_com_aurora_gallery_LanShareService_nativeStopLanShare(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) {
    log::info!("[LAN Share Android] 通知栏触发停止共享");
    stop_server_internal();
}
