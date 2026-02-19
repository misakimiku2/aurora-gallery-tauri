#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};

mod color_extractor;
mod color_db;
mod color_worker;
mod db;
mod color_search;
mod thumbnail;
mod updater;
mod update_downloader;
mod clip;

mod file_types;
mod image_utils;
mod scanner;
mod file_operations;
mod clip_commands;
mod db_commands;
mod system_commands;
mod window_commands;
mod color_commands;
mod update_commands;

use crate::thumbnail::{get_thumbnail, get_thumbnails_batch, save_remote_thumbnail, generate_drag_preview};
use crate::color_search::{search_by_palette, search_by_color};
use crate::file_types::SavedWindowState;
use crate::window_commands::{get_window_state_path, get_initial_db_paths, save_window_state};
use db::AppDbPool;

fn main() {
    
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build()
        )
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            db_commands::save_user_data,
            db_commands::load_user_data,
            search_by_palette,
            search_by_color,
            scanner::scan_directory,
            file_operations::db_copy_file_metadata,
            scanner::force_rescan,
            color_commands::add_pending_files_to_db,
            system_commands::get_default_paths,
            get_thumbnail,
            get_thumbnails_batch,
            save_remote_thumbnail,
            image_utils::get_avif_preview,
            image_utils::get_jxl_preview,
            generate_drag_preview,
            system_commands::read_file_as_base64,
            file_operations::ensure_directory,
            file_operations::file_exists,
            system_commands::open_path,
            file_operations::create_folder,
            file_operations::rename_file,
            file_operations::delete_file,
            file_operations::copy_file,
            file_operations::copy_image_colors,
            file_operations::move_file,
            file_operations::write_file_from_bytes,
            file_operations::scan_file,
            window_commands::hide_window,
            window_commands::show_window,
            window_commands::set_window_min_size,
            window_commands::exit_app,
            color_commands::get_dominant_colors,
            color_worker::pause_color_extraction,
            color_worker::resume_color_extraction,
            db_commands::force_wal_checkpoint,
            db_commands::get_wal_info,
            db_commands::db_get_all_people,
            db_commands::db_upsert_person,
            db_commands::db_delete_person,
            db_commands::db_update_person_avatar,
            db_commands::db_get_all_topics,
            db_commands::db_upsert_topic,
            db_commands::db_delete_topic,
            db_commands::db_upsert_file_metadata,
            file_operations::db_copy_file_metadata,
            db_commands::switch_root_database,
            file_operations::copy_image_to_clipboard,
            db_commands::get_color_db_stats,
            db_commands::get_color_db_error_files,
            db_commands::retry_color_extraction,
            db_commands::delete_color_db_error_files,
            update_commands::check_for_updates_command,
            system_commands::open_external_link,
            update_commands::start_update_download,
            update_commands::pause_update_download,
            update_commands::resume_update_download,
            update_commands::cancel_update_download,
            update_commands::get_update_download_progress,
            update_commands::install_update,
            update_commands::open_update_download_folder,
            system_commands::proxy_http_request,
            clip_commands::clip_search_by_text,
            clip_commands::clip_search_by_image,
            clip_commands::clip_generate_embedding,
            clip_commands::clip_get_embedding_status,
            clip_commands::clip_load_model,
            clip_commands::clip_unload_model,
            clip_commands::clip_is_model_loaded,
            clip_commands::clip_get_embedding_count,
            clip_commands::clip_get_model_status,
            clip_commands::clip_delete_model,
            clip_commands::clip_open_model_folder,
            clip_commands::clip_generate_embeddings_batch,
            clip_commands::clip_cancel_embedding_generation,
            clip_commands::clip_pause_embedding_generation,
            clip_commands::clip_resume_embedding_generation,
            clip_commands::clip_update_config,
            clip_commands::get_all_image_files
        ])
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            
            let app_handle = app.handle().clone();
            
            let tray_icon = app.default_window_icon()
                .cloned()
                .ok_or_else(|| {
                    eprintln!("Warning: No default window icon found, tray icon may not display correctly");
                    "No default window icon"
                });
            
            let tray = TrayIconBuilder::new()
                .tooltip("Aurora Gallery")
                .icon(match tray_icon {
                    Ok(icon) => icon,
                    Err(_) => {
                        return Ok(());
                    }
                })
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |_tray, event| {
                    match event {
                        TrayIconEvent::DoubleClick { .. } => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            
            app.manage(Some(tray));
            
            let (db_path, app_db_path) = get_initial_db_paths(app.handle());
            
            let pool = match color_db::ColorDbPool::new(&db_path) {
        Ok(pool_instance) => {
            {
                let mut conn = pool_instance.get_connection();
                if let Err(e) = color_db::init_db(&mut conn) {
                    eprintln!("Failed to initialize color database: {}", e);
                }
                
                if let Err(e) = color_db::reset_processing_to_pending(&mut conn) {
                    eprintln!("Failed to reset processing files to pending: {}", e);
                }
            }
            if let Err(e) = pool_instance.ensure_cache_initialized_async() {
                eprintln!("Failed to start background color cache preheat: {}", e);
            }

            if let Err(e) = pool_instance.get_db_file_sizes() {
                eprintln!("Failed to get database file sizes: {}", e);
            }
            pool_instance
        },
        Err(e) => {
            eprintln!("Failed to create color database connection pool: {}", e);
            panic!("Failed to create color database connection pool: {}", e);
        }
    };
            
            let pool_arc = Arc::new(pool);
            app.manage(pool_arc.clone());

            let app_db_pool = match AppDbPool::new(&app_db_path) {
                Ok(pool) => {
                    {
                        let conn = pool.get_connection();
                        if let Err(e) = db::init_db(&conn) {
                             eprintln!("Failed to initialize app database: {}", e);
                        }
                    }
                    pool
                },
                Err(e) => {
                    panic!("Failed to create app database pool: {}", e);
                }
            };
            app.manage(app_db_pool);
            
            let batch_size = 50;
            let app_handle_new = app.handle().clone();
            let app_handle_arc = Arc::new(app_handle_new);

            let cache_root = {
                let home = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .ok();
                
                home.map(|h| {
                    if cfg!(windows) {
                        Path::new(&h).join("AppData").join("Local").join("Aurora").join("Cache")
                    } else if cfg!(target_os = "macos") {
                        Path::new(&h).join("Library").join("Application Support").join("Aurora").join("Cache")
                    } else {
                        Path::new(&h).join(".local").join("share").join("aurora").join("cache")
                    }
                })
            };
            
            let clip_cache_root = cache_root.clone().unwrap_or_else(|| {
                let home = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .unwrap_or_else(|_| ".".to_string());
                Path::new(&home).join(".aurora_cache")
            });
            
            tauri::async_runtime::spawn(async move {
                if let Err(e) = clip::init_clip_manager(clip_cache_root).await {
                    eprintln!("Failed to initialize CLIP manager: {}", e);
                } else {
                    log::info!("CLIP manager initialized successfully");
                }
            });
            
            tauri::async_runtime::spawn(async move {
                color_worker::color_extraction_worker(
                    pool_arc,
                    batch_size,
                    Some(app_handle_arc),
                    cache_root
                ).await;
            });
            
            if let Some(window) = app.get_webview_window("main") {
                let app_handle_for_state = app.handle();
                let path = get_window_state_path(app_handle_for_state);
                let mut state_restored = false;
                if path.exists() {
                    if let Ok(json) = fs::read_to_string(&path) {
                        if let Ok(state) = serde_json::from_str::<SavedWindowState>(&json) {
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: state.width, height: state.height }));
                            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: state.x, y: state.y }));
                            if state.maximized {
                                let _ = window.maximize();
                            }
                            state_restored = true;
                        }
                    }
                }

                if !state_restored {
                    let _ = window.center();
                }
                let _ = window.show();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                save_window_state(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
