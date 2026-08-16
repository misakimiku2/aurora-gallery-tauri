//! MediaStore 查询封装：为安卓端 HTTP 服务端提供文件夹列表、文件夹浏览、
//! 缩略图与原图读取能力。所有 JNI 调用都在调用线程上 attach JVM 后执行，
//! handler 通过 spawn_blocking 调用本模块，避免阻塞 tokio worker。

use jni::objects::{JObject, JValue};
use jni::JNIEnv;

use crate::android::{AndroidImageInfo, AndroidScanAllResult};
use crate::lan_share::BrowseItem;

/// 附加当前线程到 JVM 并执行闭包。适用于任意线程（包括 tokio spawn_blocking 线程）。
/// 闭包要求 env 与 activity 使用同一生命周期（与 MediaStore 查询函数签名一致）。
fn with_jni_env<T>(
    f: impl for<'a> FnOnce(&mut JNIEnv<'a>, &JObject<'a>) -> Result<T, String>,
) -> Result<T, String> {
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };
    f(&mut env, &activity_obj)
}

/// 判断图片是否位于外部存储根目录（不属于任何相册文件夹）。
fn is_root_level_image(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    match path.rfind('/') {
        Some(idx) => {
            let parent = &path[..idx];
            parent == "/storage/emulated/0" || parent == "/sdcard"
        }
        None => false,
    }
}

fn mime_type_of(info: &AndroidImageInfo) -> String {
    if !info.mime_type.is_empty() && info.mime_type.starts_with("image/") {
        return info.mime_type.clone();
    }
    let name_lower = info.name.to_lowercase();
    if name_lower.ends_with(".png") {
        "image/png".to_string()
    } else if name_lower.ends_with(".gif") {
        "image/gif".to_string()
    } else if name_lower.ends_with(".webp") {
        "image/webp".to_string()
    } else if name_lower.ends_with(".bmp") {
        "image/bmp".to_string()
    } else {
        "image/jpeg".to_string()
    }
}

fn image_to_browse_item(info: &AndroidImageInfo) -> BrowseItem {
    BrowseItem {
        name: info.name.clone(),
        path: info.id.to_string(),
        item_type: "image".to_string(),
        size: if info.size > 0 { Some(info.size as u64) } else { None },
        thumbnail: Some(format!("/api/thumbnail?path={}&size=256", info.id)),
        preview_images: None,
        width: info.width.filter(|w| *w > 0).map(|w| w as u32),
        height: info.height.filter(|h| *h > 0).map(|h| h as u32),
        modified_at: if info.date_modified > 0 {
            Some(info.date_modified)
        } else {
            None
        },
        palette: None,
    }
}

/// 全量扫描：所有含图文件夹（按 BUCKET_ID 分组，扁平列表）+ 根目录散落图片。
pub fn scan_all() -> Result<(Vec<BrowseItem>, Vec<BrowseItem>), String> {
    let result: AndroidScanAllResult = with_jni_env(|env, activity| {
        crate::android::scan_device_all(env, activity)
    })?;

    let images = result.images;
    let mut folders: Vec<BrowseItem> = Vec::new();
    let mut root_images: Vec<BrowseItem> = Vec::new();

    // 文件夹封面：AndroidFolderInfo.cover_image_id 指向该文件夹最新图片
    use std::collections::HashMap;
    let mut cover_meta: HashMap<i64, &AndroidImageInfo> = HashMap::new();
    for f in &result.folders {
        if let Some(cover_id) = f.cover_image_id {
            if let Some(img) = images.iter().find(|i| i.id == cover_id) {
                cover_meta.insert(f.id, img);
            }
        }
    }

    for f in &result.folders {
        let cover = cover_meta.get(&f.id).copied();
        let preview_images = f.cover_image_id.map(|cid| vec![cid.to_string()]);
        folders.push(BrowseItem {
            name: f.name.clone(),
            path: f.id.to_string(),
            item_type: "folder".to_string(),
            size: Some(f.image_count.max(0) as u64),
            thumbnail: None,
            preview_images,
            width: cover.and_then(|c| c.width).filter(|w| *w > 0).map(|w| w as u32),
            height: cover.and_then(|c| c.height).filter(|h| *h > 0).map(|h| h as u32),
            modified_at: cover.and_then(|c| {
                if c.date_modified > 0 {
                    Some(c.date_modified)
                } else {
                    None
                }
            }),
            palette: None,
        });
    }
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    for img in &images {
        if is_root_level_image(&img.path) {
            root_images.push(image_to_browse_item(img));
        }
    }
    root_images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    log::info!(
        "[LAN Share Android] scan_all: {} 个文件夹, {} 张根目录图片",
        folders.len(),
        root_images.len()
    );
    Ok((folders, root_images))
}

/// 查询 MediaStore 图片表。selection_args 统一以字符串传递（SQLite 会自动
/// 处理数字列与字符串字面量的比较）。
fn query_images(
    selection: Option<&str>,
    selection_args: &[String],
) -> Result<Vec<AndroidImageInfo>, String> {
    with_jni_env(|env, activity| {
        env.ensure_local_capacity(256)
            .map_err(|e| format!("Failed to ensure local capacity: {:?}", e))?;
        let content_resolver = env
            .call_method(
                activity,
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )
            .map_err(|e| format!("Failed to get content resolver: {:?}", e))?
            .l()
            .map_err(|e| format!("Failed to convert: {:?}", e))?;

        let media_class = env
            .find_class("android/provider/MediaStore$Images$Media")
            .map_err(|e| format!("Failed to find class: {:?}", e))?;
        let uri = env
            .get_static_field(media_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
            .map_err(|e| format!("Failed to get field: {:?}", e))?
            .l()
            .map_err(|e| format!("Failed to convert: {:?}", e))?;

        let projection = [
            "_id",
            "_data",
            "_display_name",
            "_size",
            "width",
            "height",
            "date_added",
            "date_modified",
            "mime_type",
        ];
        let proj_array = env
            .new_object_array(projection.len() as i32, "java/lang/String", JObject::null())
            .map_err(|e| format!("Failed to create array: {:?}", e))?;
        for (i, s) in projection.iter().enumerate() {
            let jstr = env
                .new_string(s)
                .map_err(|e| format!("Failed to create string: {:?}", e))?;
            env.set_object_array_element(&proj_array, i as i32, jstr)
                .map_err(|e| format!("Failed to set element: {:?}", e))?;
        }

        let jselection_owned = match selection {
            Some(s) => Some(
                env.new_string(s)
                    .map_err(|e| format!("Failed to create string: {:?}", e))?,
            ),
            None => None,
        };
        let null_object = JObject::null();
        let selection_obj = match &jselection_owned {
            Some(s) => JValue::Object(s),
            None => JValue::Object(&null_object),
        };
        let args_array = env
            .new_object_array(selection_args.len() as i32, "java/lang/String", JObject::null())
            .map_err(|e| format!("Failed to create args array: {:?}", e))?;
        for (i, s) in selection_args.iter().enumerate() {
            let jstr = env
                .new_string(s)
                .map_err(|e| format!("Failed to create string: {:?}", e))?;
            env.set_object_array_element(&args_array, i as i32, jstr)
                .map_err(|e| format!("Failed to set element: {:?}", e))?;
        }
        let sort_order = env
            .new_string("date_modified DESC")
            .map_err(|e| format!("Failed to create string: {:?}", e))?;

        let cursor = env
            .call_method(
                &content_resolver,
                "query",
                "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
                &[
                    JValue::Object(&uri),
                    JValue::Object(&proj_array),
                    selection_obj,
                    JValue::Object(&args_array),
                    JValue::Object(&sort_order.into()),
                ],
            )
            .map_err(|e| format!("Failed to query: {:?}", e))?
            .l()
            .map_err(|e| format!("Failed to get cursor: {:?}", e))?;

        if cursor.is_null() {
            return Ok(Vec::new());
        }
        parse_images_cursor(env, cursor)
    })
}

fn cursor_column_index(env: &mut JNIEnv, cursor: &JObject, column: &str) -> Result<i32, String> {
    let col_str = env
        .new_string(column)
        .map_err(|e| format!("Failed to create string: {:?}", e))?;
    let index = env
        .call_method(
            cursor,
            "getColumnIndex",
            "(Ljava/lang/String;)I",
            &[JValue::Object(&col_str)],
        )
        .map_err(|e| format!("Failed to get column index: {:?}", e))?
        .i()
        .map_err(|e| format!("Failed to get int: {:?}", e))?;
    Ok(index)
}

fn cursor_get_string(env: &mut JNIEnv, cursor: &JObject, index: i32) -> Result<String, String> {
    if index < 0 {
        return Ok(String::new());
    }
    let jstr = env
        .call_method(cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(index)])
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .l()
        .map_err(|e| format!("Failed to convert: {:?}", e))?;
    if jstr.is_null() {
        return Ok(String::new());
    }
    let s: jni::objects::JString = jstr.into();
    let value: String = env
        .get_string(&s)
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .into();
    Ok(value)
}

fn parse_images_cursor(env: &mut JNIEnv, cursor: JObject) -> Result<Vec<AndroidImageInfo>, String> {
    let mut results = Vec::new();

    let has_next = env
        .call_method(&cursor, "moveToFirst", "()Z", &[])
        .map_err(|e| format!("Failed to move to first: {:?}", e))?
        .z()
        .map_err(|e| format!("Failed to get boolean: {:?}", e))?;

    if !has_next {
        let _ = env.call_method(&cursor, "close", "()V", &[]);
        return Ok(results);
    }

    let col_id = cursor_column_index(env, &cursor, "_id")?;
    let col_data = cursor_column_index(env, &cursor, "_data")?;
    let col_name = cursor_column_index(env, &cursor, "_display_name")?;
    let col_size = cursor_column_index(env, &cursor, "_size")?;
    let col_width = cursor_column_index(env, &cursor, "width")?;
    let col_height = cursor_column_index(env, &cursor, "height")?;
    let col_date = cursor_column_index(env, &cursor, "date_modified")?;
    let col_mime = cursor_column_index(env, &cursor, "mime_type")?;

    loop {
        let id = env
            .call_method(&cursor, "getLong", "(I)J", &[JValue::Int(col_id)])
            .map_err(|e| format!("Failed to get id: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        let path = cursor_get_string(env, &cursor, col_data)?;
        let name = cursor_get_string(env, &cursor, col_name)?;
        let size = env
            .call_method(&cursor, "getLong", "(I)J", &[JValue::Int(col_size)])
            .map_err(|e| format!("Failed to get size: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        let width = if col_width >= 0 {
            let v = env
                .call_method(&cursor, "getInt", "(I)I", &[JValue::Int(col_width)])
                .map_err(|e| format!("Failed to get width: {:?}", e))?
                .i()
                .map_err(|e| format!("Failed to get int: {:?}", e))?;
            if v > 0 { Some(v) } else { None }
        } else {
            None
        };
        let height = if col_height >= 0 {
            let v = env
                .call_method(&cursor, "getInt", "(I)I", &[JValue::Int(col_height)])
                .map_err(|e| format!("Failed to get height: {:?}", e))?
                .i()
                .map_err(|e| format!("Failed to get int: {:?}", e))?;
            if v > 0 { Some(v) } else { None }
        } else {
            None
        };
        let date_modified = env
            .call_method(&cursor, "getLong", "(I)J", &[JValue::Int(col_date)])
            .map_err(|e| format!("Failed to get date: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        let mime_type = cursor_get_string(env, &cursor, col_mime)?;

        results.push(AndroidImageInfo {
            id,
            path,
            content_uri: format!("content://media/external/images/media/{}", id),
            name,
            size,
            width,
            height,
            date_added: 0,
            date_modified,
            mime_type,
            thumbnail_path: None,
        });

        let has_next = env
            .call_method(&cursor, "moveToNext", "()Z", &[])
            .map_err(|e| format!("Failed to move to next: {:?}", e))?
            .z()
            .map_err(|e| format!("Failed to get boolean: {:?}", e))?;
        if !has_next {
            break;
        }
    }

    let _ = env.call_method(&cursor, "close", "()V", &[]);
    Ok(results)
}

/// 浏览指定 BUCKET_ID 文件夹下的图片（按 DATE_TAKEN/DATE_MODIFIED 倒序）。
pub fn browse_bucket(bucket_id: &str) -> Result<Vec<BrowseItem>, String> {
    let images = query_images(Some("bucket_id = ?"), &[bucket_id.to_string()])?;
    let mut items: Vec<BrowseItem> = images.iter().map(image_to_browse_item).collect();
    items.sort_by(|a, b| {
        b.modified_at
            .unwrap_or(0)
            .cmp(&a.modified_at.unwrap_or(0))
    });
    Ok(items)
}

/// 按文件名搜索图片。
pub fn search_images(query: &str) -> Result<Vec<BrowseItem>, String> {
    let term = query.trim();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    let images = query_images(
        Some("_display_name LIKE ?"),
        &[format!("%{}%", term)],
    )?;
    Ok(images.iter().map(image_to_browse_item).collect())
}

/// 按 ID 查询单张图片信息。
pub fn get_image_info(image_id: i64) -> Result<Option<AndroidImageInfo>, String> {
    let mut images = query_images(Some("_id = ?"), &[image_id.to_string()])?;
    Ok(if images.is_empty() {
        None
    } else {
        Some(images.remove(0))
    })
}

/// 获取缩略图二进制数据（JPEG）。优先 MediaStore 系统缩略图，
/// 回退到按文件路径解码生成。
pub fn get_thumbnail_bytes(
    image_id: i64,
    cache_dir: &std::path::Path,
) -> Result<Vec<u8>, String> {
    let cache_dir_path = cache_dir.to_path_buf();
    let system_result = with_jni_env(move |env, activity| {
        crate::android::get_android_system_thumbnail(env, activity, image_id, &cache_dir_path)
    });
    if let Ok(Some((thumb_path, _, _))) = system_result {
        if let Ok(bytes) = std::fs::read(&thumb_path) {
            if !bytes.is_empty() {
                return Ok(bytes);
            }
        }
    }

    // 回退：文件路径解码
    if let Ok(Some(info)) = get_image_info(image_id) {
        if !info.path.is_empty() {
            let cache_dir_path = cache_dir.to_path_buf();
            if let Ok(r) = crate::android::generate_thumbnail(&info.path, &cache_dir_path) {
                if let Some(tp) = r.thumbnail_path {
                    if let Ok(bytes) = std::fs::read(&tp) {
                        if !bytes.is_empty() {
                            return Ok(bytes);
                        }
                    }
                }
            }
        }
    }

    Err("Thumbnail not available".to_string())
}

/// 通过 ContentResolver.openInputStream 读取 content URI（原图读取回退方案）。
fn read_via_content_resolver(uri_str: &str) -> Result<Vec<u8>, String> {
    let uri = uri_str.to_string();
    with_jni_env(move |env, activity| {
        let content_resolver = env
            .call_method(
                activity,
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )
            .map_err(|e| format!("Failed to get content resolver: {:?}", e))?
            .l()
            .map_err(|e| format!("Failed to convert: {:?}", e))?;

        let jstr = env
            .new_string(&uri)
            .map_err(|e| format!("Failed to create string: {:?}", e))?;
        let uri_obj = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&jstr)],
            )
            .map_err(|e| format!("Failed to parse uri: {:?}", e))?
            .l()
            .map_err(|e| format!("Failed to convert: {:?}", e))?;

        let input_stream = env
            .call_method(
                &content_resolver,
                "openInputStream",
                "(Landroid/net/Uri;)Ljava/io/InputStream;",
                &[JValue::Object(&uri_obj)],
            )
            .map_err(|e| format!("Failed to open input stream: {:?}", e))?
            .l()
            .map_err(|e| format!("Failed to convert: {:?}", e))?;
        if input_stream.is_null() {
            return Err("ContentResolver.openInputStream returned null".to_string());
        }

        let baos_class = env
            .find_class("java/io/ByteArrayOutputStream")
            .map_err(|e| format!("Failed to find ByteArrayOutputStream: {:?}", e))?;
        let baos = env
            .new_object(&baos_class, "()V", &[])
            .map_err(|e| format!("Failed to create ByteArrayOutputStream: {:?}", e))?;

        let buffer = env
            .new_byte_array(64 * 1024)
            .map_err(|e| format!("Failed to create byte array: {:?}", e))?;
        let buffer_obj: JObject = buffer.into();

        loop {
            let n = env
                .call_method(
                    &input_stream,
                    "read",
                    "([B)I",
                    &[JValue::Object(&buffer_obj)],
                )
                .map_err(|e| format!("Failed to read stream: {:?}", e))?
                .i()
                .map_err(|e| format!("Failed to get int: {:?}", e))?;
            if n <= 0 {
                break;
            }
            env.call_method(
                &baos,
                "write",
                "([BII)V",
                &[
                    JValue::Object(&buffer_obj),
                    JValue::Int(0),
                    JValue::Int(n),
                ],
            )
            .map_err(|e| format!("Failed to write stream: {:?}", e))?;
        }
        let _ = env.call_method(&input_stream, "close", "()V", &[]);

        let arr = env
            .call_method(&baos, "toByteArray", "()[B", &[])
            .map_err(|e| format!("Failed to get byte array: {:?}", e))?
            .l()
            .map_err(|e| format!("Failed to convert: {:?}", e))?;
        let jarr: jni::objects::JByteArray = arr.into();
        let len = env
            .get_array_length(&jarr)
            .map_err(|e| format!("Failed to get array length: {:?}", e))?;
        let mut buf = vec![0i8; len as usize];
        env.get_byte_array_region(&jarr, 0, &mut buf)
            .map_err(|e| format!("Failed to get byte array region: {:?}", e))?;

        Ok(buf.iter().map(|&b| b as u8).collect())
    })
}

/// 读取原图二进制数据。优先按 `_data` 路径直接读取（应用已申请
/// MANAGE_EXTERNAL_STORAGE），回退到 ContentResolver。
pub fn get_image_bytes(image_id: i64) -> Result<(Vec<u8>, String), String> {
    let info = get_image_info(image_id).ok().flatten();

    if let Some(info) = &info {
        if !info.path.is_empty() {
            if let Ok(bytes) = std::fs::read(&info.path) {
                if !bytes.is_empty() {
                    let mime = mime_type_of(info);
                    log::info!(
                        "[LAN Share Android] 原图读取成功 - id: {}, 大小: {} bytes, 类型: {}",
                        image_id,
                        bytes.len(),
                        mime
                    );
                    return Ok((bytes, mime));
                }
            }
        }
        if let Ok(bytes) = read_via_content_resolver(&info.content_uri) {
            return Ok((bytes, mime_type_of(info)));
        }
        Err(format!("Failed to read image {}", image_id))
    } else {
        // 无索引信息时直接按 content URI 读取
        let uri = format!("content://media/external/images/media/{}", image_id);
        match read_via_content_resolver(&uri) {
            Ok(bytes) => Ok((bytes, "image/jpeg".to_string())),
            Err(e) => Err(format!("Failed to read image {}: {}", image_id, e)),
        }
    }
}
