//! M6a 阶段 1 元数据端点的请求/响应形状与纯合并逻辑。
//!
//! 契约（docs/Android/Kotlin版/M6a互联契约定稿.md §2）：
//! - LAN 协议字段一律 snake_case（与 lan_share 现状一致），故不复用
//!   core FileMetadata 的 camelCase serde，这里单独定义传输结构；
//! - 写端点「整行读改写」：读旧行 → 只覆盖 patch 出现的字段 → 整行写回，
//!   这是「不互吞」的服务端半边（upsert 是覆盖语义，必须先合并再写）；
//! - 新 tags 并入桌面词表（user_data.json 的 customTags 并集）。

use serde::{Deserialize, Serialize};

use crate::db::file_metadata::FileMetadata;

// ============ 传输结构（snake_case，契约冻结） ============

#[derive(Debug, Deserialize)]
pub struct MetadataBatchRequest {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetadataItem {
    pub path: String,
    pub tags: Vec<String>,
    pub description: String,
    pub source_url: String,
}

#[derive(Debug, Serialize)]
pub struct MetadataBatchResponse {
    pub items: Vec<MetadataItem>,
}

#[derive(Debug, Deserialize)]
pub struct MetadataPatchRequest {
    pub path: String,
    pub patch: MetadataPatch,
}

/// patch 三字段全可选，缺省（或 null）= 不改。tags: [] 是显式清空。
#[derive(Debug, Default, Deserialize)]
pub struct MetadataPatch {
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PersonPatchRequest {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// 共享根相对 path（不是 file_id）：服务端换算 cover_file_id。
    #[serde(default)]
    pub avatar_path: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TopicCreateRequest {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TopicIdQuery {
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct TopicMembersRequest {
    pub topic_id: String,
    /// 共享根相对 path 列表，服务端换算 file_id。
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    #[serde(default)]
    pub people_ids: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct TopicMembersResponse {
    pub success: bool,
    pub file_count: i32,
}

#[derive(Debug, Deserialize)]
pub struct TopicMemberRemoveQuery {
    pub topic_id: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub people_id: Option<String>,
}

// ============ 合并逻辑（纯函数，可单测） ============

/// 把 LAN patch 合并进旧行（无旧行则以空默认为底），返回待整行写回的行。
/// `db_path` 是规范化后的绝对路径（入库用）；客户端回显 path 由调用方另行组装。
pub fn merge_metadata_patch(
    existing: Option<FileMetadata>,
    file_id: &str,
    db_path: &str,
    patch: &MetadataPatch,
) -> FileMetadata {
    let now = chrono::Utc::now().timestamp_millis();
    let mut row = existing.unwrap_or(FileMetadata {
        file_id: file_id.to_string(),
        path: db_path.to_string(),
        tags: None,
        description: None,
        source_url: None,
        ai_data: None,
        category: None,
        updated_at: None,
    });

    if let Some(tags) = &patch.tags {
        row.tags = Some(serde_json::to_value(tags).unwrap_or(serde_json::json!([])));
    }
    if let Some(description) = &patch.description {
        row.description = Some(description.clone());
    }
    if let Some(source_url) = &patch.source_url {
        row.source_url = Some(source_url.clone());
    }
    row.updated_at = Some(now);
    row
}

/// 把库行转成 LAN 响应 item（path 回显客户端传入的不透明字符串，非库内路径）。
/// tags 列是 JSON，非数组或解析失败按空数组兜底；description/source_url 缺省为空串。
pub fn metadata_to_item(path: &str, m: &FileMetadata) -> MetadataItem {
    let tags = m
        .tags
        .as_ref()
        .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
        .unwrap_or_default();
    MetadataItem {
        path: path.to_string(),
        tags,
        description: m.description.clone().unwrap_or_default(),
        source_url: m.source_url.clone().unwrap_or_default(),
    }
}

/// 把新词并集进 user_data.json 的 customTags（桌面词表；与安卓本地词表两套不混）。
/// 就地修改并返回是否有变化。user_data 非 object 时重置为 {} 再写。
pub fn merge_tags_into_user_data(user_data: &mut serde_json::Value, new_tags: &[String]) -> bool {
    if new_tags.is_empty() {
        return false;
    }
    if !user_data.is_object() {
        *user_data = serde_json::json!({});
    }
    let obj = user_data.as_object_mut().expect("checked above");
    let entry = obj.entry("customTags".to_string()).or_insert(serde_json::json!([]));
    if !entry.is_array() {
        *entry = serde_json::json!([]);
    }
    let list = entry.as_array_mut().expect("checked above");
    let mut changed = false;
    for tag in new_tags {
        if tag.is_empty() {
            continue;
        }
        if !list.iter().any(|v| v.as_str() == Some(tag.as_str())) {
            list.push(serde_json::Value::String(tag.clone()));
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn existing_row() -> FileMetadata {
        FileMetadata {
            file_id: "abc123456".into(),
            path: "N:/shots/a.png".into(),
            tags: Some(serde_json::json!(["fps", "四人"])),
            description: Some("旧描述".into()),
            source_url: Some("https://old".into()),
            ai_data: Some(serde_json::json!({"wd14": ["fps"]})),
            category: Some("game".into()),
            updated_at: Some(1000),
        }
    }

    /// 契约锁定：patch 只传 description 时 tags（及 source_url/ai_data/category）原样。
    #[test]
    fn patch_only_description_keeps_tags() {
        let patch = MetadataPatch {
            tags: None,
            description: Some("新描述".into()),
            source_url: None,
        };
        let merged = merge_metadata_patch(Some(existing_row()), "abc123456", "N:/shots/a.png", &patch);

        assert_eq!(
            merged.tags.as_ref().and_then(|t| serde_json::from_value::<Vec<String>>(t.clone()).ok()),
            Some(vec!["fps".to_string(), "四人".to_string()]),
            "只传 description 时 tags 不得被清掉"
        );
        assert_eq!(merged.description.as_deref(), Some("新描述"));
        assert_eq!(merged.source_url.as_deref(), Some("https://old"));
        assert_eq!(merged.category.as_deref(), Some("game"));
        assert!(merged.ai_data.is_some(), "未入参字段整行写回时必须保留");
    }

    /// patch 只传 tags 时 description / source_url 原样（对称半边）。
    #[test]
    fn patch_only_tags_keeps_description_and_source_url() {
        let patch = MetadataPatch {
            tags: Some(vec!["新词".into()]),
            description: None,
            source_url: None,
        };
        let merged = merge_metadata_patch(Some(existing_row()), "abc123456", "N:/shots/a.png", &patch);

        assert_eq!(
            merged.tags.as_ref().and_then(|t| serde_json::from_value::<Vec<String>>(t.clone()).ok()),
            Some(vec!["新词".to_string()])
        );
        assert_eq!(merged.description.as_deref(), Some("旧描述"));
        assert_eq!(merged.source_url.as_deref(), Some("https://old"));
    }

    /// tags: [] 是显式清空（区别于缺省不改）。
    #[test]
    fn patch_empty_tags_clears_tags_only() {
        let patch = MetadataPatch {
            tags: Some(vec![]),
            description: None,
            source_url: None,
        };
        let merged = merge_metadata_patch(Some(existing_row()), "abc123456", "N:/shots/a.png", &patch);
        assert_eq!(merged.tags, Some(serde_json::json!([])));
        assert_eq!(merged.description.as_deref(), Some("旧描述"));
    }

    /// 无旧行时以空默认为底新建，只落 patch 字段。
    #[test]
    fn patch_without_existing_row_creates_defaults() {
        let patch = MetadataPatch {
            tags: None,
            description: Some("d".into()),
            source_url: None,
        };
        let merged = merge_metadata_patch(None, "fff000111", "N:/shots/b.png", &patch);

        assert_eq!(merged.file_id, "fff000111");
        assert_eq!(merged.path, "N:/shots/b.png");
        assert!(merged.tags.is_none());
        assert_eq!(merged.description.as_deref(), Some("d"));
        assert_eq!(merged.source_url, None);
    }

    /// serde 形状锁定：反序列化 patch 只传 description 时 tags 为 None（缺省=不改）。
    #[test]
    fn patch_deserialization_shape() {
        let patch: MetadataPatch = serde_json::from_str(r#"{"description": "只改描述"}"#).unwrap();
        assert!(patch.tags.is_none());
        assert!(patch.source_url.is_none());
        assert_eq!(patch.description.as_deref(), Some("只改描述"));

        // tags 显式 null 与缺省同义
        let patch: MetadataPatch =
            serde_json::from_str(r#"{"tags": null, "source_url": "https://x"}"#).unwrap();
        assert!(patch.tags.is_none());
        assert_eq!(patch.source_url.as_deref(), Some("https://x"));
    }

    /// metadata_to_item：查不到的行给空默认；非数组 tags 兜底空数组。
    #[test]
    fn item_defaults_for_missing_values() {
        let row = FileMetadata {
            file_id: "x".into(),
            path: "p".into(),
            tags: None,
            description: None,
            source_url: None,
            ai_data: None,
            category: None,
            updated_at: None,
        };
        let item = metadata_to_item("Apex/a.png", &row);
        assert_eq!(item.path, "Apex/a.png");
        assert!(item.tags.is_empty());
        assert_eq!(item.description, "");
        assert_eq!(item.source_url, "");

        let bad = FileMetadata { tags: Some(serde_json::json!("not-an-array")), ..row };
        assert!(metadata_to_item("p", &bad).tags.is_empty());
    }

    /// 词表并集：新词追加、已有词不重复、空串跳过。
    #[test]
    fn custom_tags_union_dedup() {
        let mut ud = serde_json::json!({"customTags": ["fps"], "other": 1});
        let changed = merge_tags_into_user_data(&mut ud, &["fps".into(), "新词".into(), "".into()]);
        assert!(changed);
        assert_eq!(ud["customTags"], serde_json::json!(["fps", "新词"]));
        assert_eq!(ud["other"], 1);

        // 全部已存在 → 无变化
        let mut ud = serde_json::json!({"customTags": ["fps"]});
        assert!(!merge_tags_into_user_data(&mut ud, &["fps".into()]));
        assert_eq!(ud["customTags"], serde_json::json!(["fps"]));

        // customTags 缺失/类型异常时自愈
        let mut ud = serde_json::json!({"other": 1});
        assert!(merge_tags_into_user_data(&mut ud, &["a".into()]));
        assert_eq!(ud["customTags"], serde_json::json!(["a"]));

        let mut ud = serde_json::json!("not-an-object");
        assert!(merge_tags_into_user_data(&mut ud, &["a".into()]));
        assert_eq!(ud["customTags"], serde_json::json!(["a"]));
    }
}
