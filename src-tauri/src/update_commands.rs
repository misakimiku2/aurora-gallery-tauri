use crate::updater;
use crate::update_downloader;

#[tauri::command]
pub async fn check_for_updates_command(github_token: Option<String>) -> Result<updater::UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    let owner = "misakimiku2";
    let repo = "aurora-gallery-tauri";
    
    let token = github_token.as_deref();
    
    updater::check_for_updates(current_version, owner, repo, token).await
}

#[tauri::command]
pub async fn start_update_download(
    installer_url: String,
    version: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let downloader = update_downloader::get_downloader();
    downloader.start_download(&installer_url, &version, app_handle).await
}

#[tauri::command]
pub fn pause_update_download() -> Result<(), String> {
    let downloader = update_downloader::get_downloader();
    downloader.pause_download()
}

#[tauri::command]
pub async fn resume_update_download(app_handle: tauri::AppHandle) -> Result<(), String> {
    let downloader = update_downloader::get_downloader();
    downloader.resume_download(app_handle).await
}

#[tauri::command]
pub fn cancel_update_download() -> Result<(), String> {
    let downloader = update_downloader::get_downloader();
    downloader.cancel_download()
}

#[tauri::command]
pub fn get_update_download_progress() -> Result<update_downloader::DownloadProgress, String> {
    let downloader = update_downloader::get_downloader();
    downloader.get_progress()
}

#[tauri::command]
pub fn install_update() -> Result<(), String> {
    let downloader = update_downloader::get_downloader();
    downloader.install_update()
}

#[tauri::command]
pub fn open_update_download_folder() -> Result<(), String> {
    let downloader = update_downloader::get_downloader();
    downloader.open_download_folder()
}
