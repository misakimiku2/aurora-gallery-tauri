use jni::objects::{JObject, JString, JValue};
use jni::JNIEnv;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
pub struct AndroidImageInfo {
    pub id: i64,
    pub path: String,
    pub content_uri: String,
    pub name: String,
    pub size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub date_added: i64,
    pub date_modified: i64,
    pub mime_type: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AndroidFolderInfo {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub image_count: i32,
    pub cover_image_path: Option<String>,
    pub cover_image_id: Option<i64>,
    pub cover_image_width: Option<i32>,
    pub cover_image_height: Option<i32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AndroidScanAllResult {
    pub images: Vec<AndroidImageInfo>,
    pub folders: Vec<AndroidFolderInfo>,
}

pub fn scan_device_all_via_kotlin<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>, since_timestamp: i64) -> Result<AndroidScanAllResult, String> {
    let json_str = env.call_method(
        activity,
        "scanAllAsJson",
        "(J)Ljava/lang/String;",
        &[JValue::Long(since_timestamp)],
    ).map_err(|e| format!("Failed to call scanAllAsJson: {:?}", e))?;

    let jstr: JString = json_str.l()
        .map_err(|e| format!("Failed to get string result: {:?}", e))?
        .into();

    let json: String = env.get_string(&jstr)
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .into();

    let raw: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse JSON: {:?}", e))?;

    let mut images = Vec::new();
    if let Some(images_arr) = raw.get("images").and_then(|v| v.as_array()) {
        for img in images_arr {
            images.push(AndroidImageInfo {
                id: img.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                path: img.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                content_uri: img.get("content_uri").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                name: img.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                size: img.get("size").and_then(|v| v.as_i64()).unwrap_or(0),
                width: img.get("width").and_then(|v| v.as_i64()).map(|v| v as i32),
                height: img.get("height").and_then(|v| v.as_i64()).map(|v| v as i32),
                date_added: img.get("date_added").and_then(|v| v.as_i64()).unwrap_or(0),
                date_modified: img.get("date_modified").and_then(|v| v.as_i64()).unwrap_or(0),
                mime_type: img.get("mime_type").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            });
        }
    }

    let mut folders = Vec::new();
    if let Some(folders_arr) = raw.get("folders").and_then(|v| v.as_array()) {
        for folder in folders_arr {
            folders.push(AndroidFolderInfo {
                id: folder.get("id").and_then(|v| v.as_i64()).unwrap_or(0),
                name: folder.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                path: folder.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                image_count: folder.get("image_count").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
                cover_image_path: folder.get("cover_image_path").and_then(|v| v.as_str()).map(|s| s.to_string()),
                cover_image_id: folder.get("cover_image_id").and_then(|v| v.as_i64()),
                cover_image_width: folder.get("cover_image_width").and_then(|v| v.as_i64()).map(|v| v as i32),
                cover_image_height: folder.get("cover_image_height").and_then(|v| v.as_i64()).map(|v| v as i32),
            });
        }
    }

    Ok(AndroidScanAllResult { images, folders })
}

pub fn scan_device_all<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) -> Result<AndroidScanAllResult, String> {
    env.ensure_local_capacity(256)
        .map_err(|e| format!("Failed to ensure local capacity: {:?}", e))?;
    let content_resolver = get_content_resolver(env, activity)?;

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
        "bucket_id",
        "bucket_display_name",
    ];

    let sort_order = "date_modified DESC";

    let uri = get_images_uri(env)?;
    let proj_array = create_string_array(env, &projection)?;

    let cursor = env.call_method(
        &content_resolver,
        "query",
        "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
        &[
            JValue::Object(&uri),
            JValue::Object(&proj_array),
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
            JValue::Object(&env.new_string(sort_order).map_err(|e| format!("Failed to create string: {:?}", e))?.into()),
        ],
    ).map_err(|e| format!("Failed to query: {:?}", e))?;

    let cursor = cursor.l().map_err(|e| format!("Failed to get cursor: {:?}", e))?;

    parse_all_cursor(env, cursor)
}

fn parse_all_cursor(env: &mut JNIEnv, cursor: JObject) -> Result<AndroidScanAllResult, String> {
    struct FolderData {
        name: String,
        path: String,
        count: i32,
        cover_image_path: Option<String>,
        cover_image_id: Option<i64>,
        cover_image_width: Option<i32>,
        cover_image_height: Option<i32>,
        max_date_modified: i64,
    }

    let mut images = Vec::new();
    let mut folder_map: HashMap<i64, FolderData> = HashMap::new();

    let has_next = env.call_method(&cursor, "moveToFirst", "()Z", &[])
        .map_err(|e| format!("Failed to move to first: {:?}", e))?
        .z()
        .map_err(|e| format!("Failed to get boolean: {:?}", e))?;

    if !has_next {
        let _ = env.call_method(&cursor, "close", "()V", &[]);
        return Ok(AndroidScanAllResult { images, folders: Vec::new() });
    }

    let col_id = get_column_index(env, &cursor, "_id")?;
    let col_data = get_column_index(env, &cursor, "_data")?;
    let col_name = get_column_index(env, &cursor, "_display_name")?;
    let col_size = get_column_index(env, &cursor, "_size")?;
    let col_width = get_column_index(env, &cursor, "width")?;
    let col_height = get_column_index(env, &cursor, "height")?;
    let col_date_added = get_column_index(env, &cursor, "date_added")?;
    let col_date = get_column_index(env, &cursor, "date_modified")?;
    let col_mime = get_column_index(env, &cursor, "mime_type")?;
    let col_bucket_id = get_column_index(env, &cursor, "bucket_id")?;
    let col_bucket_name = get_column_index(env, &cursor, "bucket_display_name")?;

    loop {
        let id = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(col_id)])
            .map_err(|e| format!("Failed to get id: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;

        let path = get_cursor_string(env, &cursor, col_data)?;
        let name = get_cursor_string(env, &cursor, col_name)?;

        let size = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(col_size)])
            .map_err(|e| format!("Failed to get size: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;

        let width = get_cursor_int_optional(env, &cursor, col_width)?;
        let height = get_cursor_int_optional(env, &cursor, col_height)?;

        let date_added = if col_date_added >= 0 {
            env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(col_date_added)])
                .map_err(|e| format!("Failed to get date_added: {:?}", e))?
                .j()
                .map_err(|e| format!("Failed to get long: {:?}", e))?
        } else {
            0
        };

        let date_modified = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(col_date)])
            .map_err(|e| format!("Failed to get date: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;

        let mime_type = get_cursor_string(env, &cursor, col_mime)?;

        let content_uri = format!("content://media/external/images/media/{}", id);

        images.push(AndroidImageInfo {
            id,
            path: path.clone(),
            content_uri,
            name,
            size,
            width,
            height,
            date_added,
            date_modified,
            mime_type,
        });

        if col_bucket_id >= 0 {
            let bucket_id = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(col_bucket_id)])
                .map_err(|e| format!("Failed to get bucket_id: {:?}", e))?
                .j()
                .map_err(|e| format!("Failed to get long: {:?}", e))?;

            let bucket_name = get_cursor_string(env, &cursor, col_bucket_name)?;

            let cover_path = if path.is_empty() { None } else { Some(path.clone()) };

            let folder_path = if !path.is_empty() {
                if let Some(last_slash) = path.rfind('/') {
                    path[..last_slash].to_string()
                } else {
                    path.clone()
                }
            } else {
                String::new()
            };

            let entry = folder_map.entry(bucket_id).or_insert_with(|| FolderData {
                name: bucket_name,
                path: folder_path,
                count: 0,
                cover_image_path: None,
                cover_image_id: None,
                cover_image_width: None,
                cover_image_height: None,
                max_date_modified: -1,
            });
            entry.count += 1;

            if date_modified > entry.max_date_modified {
                entry.max_date_modified = date_modified;
                entry.cover_image_path = cover_path;
                entry.cover_image_id = Some(id);
                entry.cover_image_width = width;
                entry.cover_image_height = height;
            }
        }

        let has_next = env.call_method(&cursor, "moveToNext", "()Z", &[])
            .map_err(|e| format!("Failed to move to next: {:?}", e))?
            .z()
            .map_err(|e| format!("Failed to get boolean: {:?}", e))?;

        if !has_next {
            break;
        }
    }

    let _ = env.call_method(&cursor, "close", "()V", &[]);

    let folders: Vec<AndroidFolderInfo> = folder_map
        .into_iter()
        .map(|(id, data)| AndroidFolderInfo {
            id,
            name: data.name,
            path: data.path,
            image_count: data.count,
            cover_image_path: data.cover_image_path,
            cover_image_id: data.cover_image_id,
            cover_image_width: data.cover_image_width,
            cover_image_height: data.cover_image_height,
        })
        .collect();

    Ok(AndroidScanAllResult { images, folders })
}

fn get_column_index(env: &mut JNIEnv, cursor: &JObject, column: &str) -> Result<i32, String> {
    let col_str = env.new_string(column).map_err(|e| format!("Failed to create string: {:?}", e))?;
    let index = env.call_method(cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
        .map_err(|e| format!("Failed to get column index: {:?}", e))?
        .i()
        .map_err(|e| format!("Failed to get int: {:?}", e))?;
    Ok(index)
}

pub fn scan_device_images<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) -> Result<Vec<AndroidImageInfo>, String> {
    env.ensure_local_capacity(256)
        .map_err(|e| format!("Failed to ensure local capacity: {:?}", e))?;
    let content_resolver = get_content_resolver(env, activity)?;
    
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
    
    let sort_order = "date_modified DESC";
    
    let uri = get_images_uri(env)?;
    let proj_array = create_string_array(env, &projection)?;
    
    let cursor = env.call_method(
        &content_resolver,
        "query",
        "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
        &[
            JValue::Object(&uri),
            JValue::Object(&proj_array),
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
            JValue::Object(&env.new_string(sort_order).map_err(|e| format!("Failed to create string: {:?}", e))?.into()),
        ],
    ).map_err(|e| format!("Failed to query: {:?}", e))?;
    
    let cursor = cursor.l().map_err(|e| format!("Failed to get cursor: {:?}", e))?;
    
    parse_cursor(env, cursor)
}

pub fn scan_device_folders<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) -> Result<Vec<AndroidFolderInfo>, String> {
    env.ensure_local_capacity(256)
        .map_err(|e| format!("Failed to ensure local capacity: {:?}", e))?;
    let content_resolver = get_content_resolver(env, activity)?;
    
    let projection = [
        "bucket_id",
        "bucket_display_name",
        "_data",
        "_id",
        "width",
        "height",
        "date_modified",
    ];
    
    let sort_order = "date_modified DESC";
    
    let uri = get_images_uri(env)?;
    let proj_array = create_string_array(env, &projection)?;
    
    let cursor = env.call_method(
        &content_resolver,
        "query",
        "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
        &[
            JValue::Object(&uri),
            JValue::Object(&proj_array),
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
            JValue::Object(&env.new_string(sort_order).map_err(|e| format!("Failed to create string: {:?}", e))?.into()),
        ],
    ).map_err(|e| format!("Failed to query: {:?}", e))?;
    
    let cursor = cursor.l().map_err(|e| format!("Failed to get cursor: {:?}", e))?;
    
    parse_folder_cursor(env, cursor)
}

fn get_content_resolver<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) -> Result<JObject<'a>, String> {
    env.call_method(activity, "getContentResolver", "()Landroid/content/ContentResolver;", &[])
        .map_err(|e| format!("Failed to get content resolver: {:?}", e))?
        .l()
        .map_err(|e| format!("Failed to convert: {:?}", e))
}

fn get_images_uri<'a>(env: &mut JNIEnv<'a>) -> Result<JObject<'a>, String> {
    let media_class = env.find_class("android/provider/MediaStore$Images$Media")
        .map_err(|e| format!("Failed to find class: {:?}", e))?;
    
    let field = env.get_static_field(media_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
        .map_err(|e| format!("Failed to get field: {:?}", e))?;
    
    field.l().map_err(|e| format!("Failed to convert: {:?}", e))
}

fn create_string_array<'a>(env: &mut JNIEnv<'a>, strings: &[&str]) -> Result<JObject<'a>, String> {
    let array = env.new_object_array(strings.len() as i32, "java/lang/String", JObject::null())
        .map_err(|e| format!("Failed to create array: {:?}", e))?;
    
    for (i, s) in strings.iter().enumerate() {
        let jstr = env.new_string(s).map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.set_object_array_element(&array, i as i32, jstr)
            .map_err(|e| format!("Failed to set element: {:?}", e))?;
    }
    
    Ok(array.into())
}

struct ColumnIndices {
    id: i32,
    path: i32,
    name: i32,
    size: i32,
    width: i32,
    height: i32,
    date_added: i32,
    date_modified: i32,
    mime_type: i32,
}

fn get_column_indices(env: &mut JNIEnv, cursor: &JObject) -> Result<ColumnIndices, String> {
    let mut get_index = |column: &str| -> Result<i32, String> {
        let col_str = env.new_string(column).map_err(|e| format!("Failed to create string: {:?}", e))?;
        let index = env.call_method(cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?;
        Ok(index)
    };
    
    Ok(ColumnIndices {
        id: get_index("_id")?,
        path: get_index("_data")?,
        name: get_index("_display_name")?,
        size: get_index("_size")?,
        width: get_index("width")?,
        height: get_index("height")?,
        date_added: get_index("date_added")?,
        date_modified: get_index("date_modified")?,
        mime_type: get_index("mime_type")?,
    })
}

fn get_cursor_string(env: &mut JNIEnv, cursor: &JObject, index: i32) -> Result<String, String> {
    if index < 0 {
        return Ok(String::new());
    }
    
    let jstr = env.call_method(cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(index)])
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .l()
        .map_err(|e| format!("Failed to convert: {:?}", e))?;
    
    if jstr.is_null() {
        return Ok(String::new());
    }
    
    let s: JString = jstr.into();
    let result = env.get_string(&s)
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .into();
    
    Ok(result)
}

fn get_cursor_int_optional(env: &mut JNIEnv, cursor: &JObject, index: i32) -> Result<Option<i32>, String> {
    if index < 0 {
        return Ok(None);
    }
    
    let value = env.call_method(cursor, "getInt", "(I)I", &[JValue::Int(index)])
        .map_err(|e| format!("Failed to get int: {:?}", e))?
        .i()
        .map_err(|e| format!("Failed to get int: {:?}", e))?;
    
    if value == 0 {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

fn parse_cursor(env: &mut JNIEnv, cursor: JObject) -> Result<Vec<AndroidImageInfo>, String> {
    let mut results = Vec::new();
    
    let has_next = env.call_method(&cursor, "moveToFirst", "()Z", &[])
        .map_err(|e| format!("Failed to move to first: {:?}", e))?
        .z()
        .map_err(|e| format!("Failed to get boolean: {:?}", e))?;
    
    if !has_next {
        let _ = env.call_method(&cursor, "close", "()V", &[]);
        return Ok(results);
    }
    
    let column_indices = get_column_indices(env, &cursor)?;
    
    loop {
        let id = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(column_indices.id)])
            .map_err(|e| format!("Failed to get id: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        
        let path = get_cursor_string(env, &cursor, column_indices.path)?;
        let name = get_cursor_string(env, &cursor, column_indices.name)?;
        
        let size = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(column_indices.size)])
            .map_err(|e| format!("Failed to get size: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        
        let width = get_cursor_int_optional(env, &cursor, column_indices.width)?;
        let height = get_cursor_int_optional(env, &cursor, column_indices.height)?;
        
        let date_added = if column_indices.date_added >= 0 {
            env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(column_indices.date_added)])
                .map_err(|e| format!("Failed to get date_added: {:?}", e))?
                .j()
                .map_err(|e| format!("Failed to get long: {:?}", e))?
        } else {
            0
        };

        let date_modified = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(column_indices.date_modified)])
            .map_err(|e| format!("Failed to get date: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        
        let mime_type = get_cursor_string(env, &cursor, column_indices.mime_type)?;
        
        let content_uri = format!("content://media/external/images/media/{}", id);
        
        results.push(AndroidImageInfo {
            id,
            path,
            content_uri,
            name,
            size,
            width,
            height,
            date_added,
            date_modified,
            mime_type,
        });
        
        let has_next = env.call_method(&cursor, "moveToNext", "()Z", &[])
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

fn parse_folder_cursor(env: &mut JNIEnv, cursor: JObject) -> Result<Vec<AndroidFolderInfo>, String> {
    struct FolderData {
        name: String,
        path: String,
        count: i32,
        cover_image_path: Option<String>,
        cover_image_id: Option<i64>,
        cover_image_width: Option<i32>,
        cover_image_height: Option<i32>,
        max_date_modified: i64,
    }

    let mut folder_map: HashMap<i64, FolderData> = HashMap::new();

    let has_next = env.call_method(&cursor, "moveToFirst", "()Z", &[])
        .map_err(|e| format!("Failed to move to first: {:?}", e))?
        .z()
        .map_err(|e| format!("Failed to get boolean: {:?}", e))?;

    if !has_next {
        return Ok(Vec::new());
    }

    let bucket_id_index = {
        let col_str = env.new_string("bucket_id").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };

    let bucket_name_index = {
        let col_str = env.new_string("bucket_display_name").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };

    let data_index = {
        let col_str = env.new_string("_data").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };

    let id_index = {
        let col_str = env.new_string("_id").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };

    let width_index = {
        let col_str = env.new_string("width").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };

    let height_index = {
        let col_str = env.new_string("height").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };

    let date_modified_index = {
        let col_str = env.new_string("date_modified").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };

    loop {
        let bucket_id = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(bucket_id_index)])
            .map_err(|e| format!("Failed to get bucket_id: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        
        let bucket_name = get_cursor_string(env, &cursor, bucket_name_index)?;
        let data_path = get_cursor_string(env, &cursor, data_index)?;
        
        let image_id = if id_index >= 0 {
            Some(env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(id_index)])
                .map_err(|e| format!("Failed to get image id: {:?}", e))?
                .j()
                .map_err(|e| format!("Failed to get long: {:?}", e))?)
        } else {
            None
        };

        let date_modified = if date_modified_index >= 0 {
            env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(date_modified_index)])
                .map_err(|e| format!("Failed to get date_modified: {:?}", e))?
                .j()
                .map_err(|e| format!("Failed to get long: {:?}", e))?
        } else {
            0
        };

        let img_width = get_cursor_int_optional(env, &cursor, width_index)?;
        let img_height = get_cursor_int_optional(env, &cursor, height_index)?;

        let cover_path = if data_path.is_empty() { None } else { Some(data_path.clone()) };

        let folder_path = if !data_path.is_empty() {
            if let Some(last_slash) = data_path.rfind('/') {
                data_path[..last_slash].to_string()
            } else {
                data_path
            }
        } else {
            String::new()
        };

        let entry = folder_map.entry(bucket_id).or_insert_with(|| FolderData {
            name: bucket_name.clone(),
            path: folder_path,
            count: 0,
            cover_image_path: None,
            cover_image_id: None,
            cover_image_width: None,
            cover_image_height: None,
            max_date_modified: -1,
        });
        entry.count += 1;

        if date_modified > entry.max_date_modified {
            entry.max_date_modified = date_modified;
            entry.cover_image_path = cover_path;
            entry.cover_image_id = image_id;
            entry.cover_image_width = img_width;
            entry.cover_image_height = img_height;
        }
        
        let has_next = env.call_method(&cursor, "moveToNext", "()Z", &[])
            .map_err(|e| format!("Failed to move to next: {:?}", e))?
            .z()
            .map_err(|e| format!("Failed to get boolean: {:?}", e))?;
        
        if !has_next {
            break;
        }
    }
    
    let _ = env.call_method(&cursor, "close", "()V", &[]);
    
    let results: Vec<AndroidFolderInfo> = folder_map
        .into_iter()
        .map(|(id, data)| AndroidFolderInfo {
            id,
            name: data.name,
            path: data.path,
            image_count: data.count,
            cover_image_path: data.cover_image_path,
            cover_image_id: data.cover_image_id,
            cover_image_width: data.cover_image_width,
            cover_image_height: data.cover_image_height,
        })
        .collect();
    
    Ok(results)
}
