//! P1 内容类型分类模块
//!
//! 复用 WD14 已算好的标签（file_metadata.tags），按 content_categories.json 规则
//! 映射到内容大类，写入 file_metadata.category 并产出 source_type="auto_content" 专题。
//! 零额外推理。

use crate::db::AppDbPool;
use crate::db::file_metadata;
use crate::db::topics;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

// ============ 规则配置加载 ============

#[derive(Debug, Clone, Deserialize)]
struct CategoryRule {
    #[serde(rename = "label_cn")]
    label_cn: String,
    tags: Vec<String>,
}

static CONTENT_CATEGORIES: Lazy<HashMap<String, CategoryRule>> = Lazy::new(|| {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("clip")
        .join("content_categories.json");

    match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<HashMap<String, CategoryRule>>(&content) {
            Ok(map) => {
                log::info!(
                    "[content_classifier] Loaded {} content categories from content_categories.json",
                    map.len()
                );
                map
            }
            Err(e) => {
                log::error!("[content_classifier] Failed to parse content_categories.json: {}", e);
                HashMap::new()
            }
        },
        Err(e) => {
            log::error!("[content_classifier] Failed to read content_categories.json: {}", e);
            HashMap::new()
        }
    }
});

// ============ 取消标志 ============

static CANCEL_CLASSIFY: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static IS_CLASSIFYING: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

fn should_cancel() -> bool {
    CANCEL_CLASSIFY.load(Ordering::SeqCst)
}

// ============ 结果结构 ============

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyResult {
    pub total: usize,
    pub classified: usize,
    pub skipped: usize,
    pub category_counts: Vec<CategoryCount>,
    pub topics_created: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryCount {
    pub category: String,
    pub label_cn: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryStat {
    pub category: String,
    pub count: usize,
    pub topic_id: Option<String>,
}

/// 统计概览（含总量、已打标签数、各分类数）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationOverview {
    pub total_indexed: usize,
    pub total_with_tags: usize,
    pub categories: Vec<CategoryStat>,
}

// ============ 核心分类逻辑 ============

/// 对一张图的标签列表进行分类。
/// 命中规则：取该类下所有命中标签的数量之和，最高者胜出；最高分 < min_score → "other"。
/// tags JSON 实际存储为 Vec<String>（仅名称，无概率），所以用计数代替概率求和。
fn classify_tags(tags_value: &serde_json::Value, min_score: usize) -> String {
    // tags 实际格式为 Vec<String>，兼容可能的 [{name, prob}] 格式
    let tag_names: Vec<String> = if let Some(arr) = tags_value.as_array() {
        arr.iter()
            .filter_map(|v| {
                if let Some(s) = v.as_str() {
                    Some(s.to_string())
                } else if let Some(obj) = v.as_object() {
                    obj.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect()
    } else {
        return "other".to_string();
    };

    if tag_names.is_empty() {
        return "other".to_string();
    }

    // 把标签名归一化（小写、空格转下划线）以提高命中率
    let normalized: Vec<String> = tag_names
        .iter()
        .map(|t| t.to_lowercase().replace(' ', "_").replace('-', "_"))
        .collect();
    let tag_set: std::collections::HashSet<&str> =
        normalized.iter().map(|s| s.as_str()).collect();

    let mut best_category = "other".to_string();
    let mut best_score: usize = 0;

    for (cat_key, rule) in CONTENT_CATEGORIES.iter() {
        let score = rule
            .tags
            .iter()
            .filter(|t| {
                let tn = t.to_lowercase().replace(' ', "_").replace('-', "_");
                tag_set.contains(tn.as_str())
            })
            .count();
        if score > best_score {
            best_score = score;
            best_category = cat_key.clone();
        }
    }

    // 阈值过滤：最高分不足 min_score 则归为 other
    if best_score < min_score {
        return "other".to_string();
    }

    best_category
}

/// 获取某分类的中文标签
fn get_label_cn(category: &str) -> String {
    if category == "other" {
        return "其他".to_string();
    }
    CONTENT_CATEGORIES
        .get(category)
        .map(|r| r.label_cn.clone())
        .unwrap_or_else(|| category.to_string())
}

// ============ Tauri 命令 ============

/// 执行内容类型分类（P1 主命令）。
/// 流程：加载规则 → 查所有有 tags 的 file_metadata → 逐条分类 →
/// 批量 UPDATE category → 删旧 auto_content 专题 → 每大类建一个专题 → emit 进度。
#[tauri::command]
pub async fn classify_content_types(
    app: tauri::AppHandle,
    min_score: Option<usize>,
) -> Result<ClassifyResult, String> {
    if IS_CLASSIFYING.load(Ordering::SeqCst) {
        return Err("Classification already in progress".to_string());
    }
    if CONTENT_CATEGORIES.is_empty() {
        return Err("No content categories loaded (content_categories.json missing or invalid)".to_string());
    }

    let threshold = min_score.unwrap_or(1).max(1);

    IS_CLASSIFYING.store(true, Ordering::SeqCst);
    CANCEL_CLASSIFY.store(false, Ordering::SeqCst);

    let result = run_classification(&app, threshold).await;

    IS_CLASSIFYING.store(false, Ordering::SeqCst);
    CANCEL_CLASSIFY.store(false, Ordering::SeqCst);

    // 最终完成或取消事件
    match &result {
        Ok(r) => {
            let _ = app.emit("classify-completed", serde_json::json!({
                "total": r.total,
                "classified": r.classified,
                "skipped": r.skipped,
                "topicsCreated": r.topics_created,
            }));
        }
        Err(e) => {
            let _ = app.emit("classify-cancelled", serde_json::json!({
                "reason": e,
            }));
        }
    }

    result
}

async fn run_classification(app: &tauri::AppHandle, min_score: usize) -> Result<ClassifyResult, String> {
    let pool = app.state::<AppDbPool>();
    let conn = pool.get_connection();

    // 1. 查询所有有 tags 且在 file_index 中存在的记录
    log::info!("[content_classifier] Loading file_metadata with tags...");
    let records = file_metadata::get_all_tags_for_classification(&conn)
        .map_err(|e| format!("Failed to load tags: {}", e))?;
    let total = records.len();
    log::info!("[content_classifier] Loaded {} records with tags", total);

    if total == 0 {
        return Err(
            "没有找到带标签的图片。请先在「设置 → AI视觉」中启用 WD14 模型并生成标签，然后再进行自动分类。"
                .to_string(),
        );
    }

    // 2. 逐条分类，累积结果
    let mut category_files: HashMap<String, Vec<String>> = HashMap::new();
    let mut batch_updates: Vec<(String, String)> = Vec::new();
    let mut classified: usize = 0;
    let mut skipped: usize = 0;
    let batch_size = 500;

    for (i, (file_id, tags_value)) in records.iter().enumerate() {
        if should_cancel() {
            log::info!("[content_classifier] Cancelled at {}/{}", i, total);
            let _ = app.emit("classify-cancelled", serde_json::json!({
                "reason": "user_cancelled",
                "current": i,
                "total": total,
            }));
            return Err("Classification cancelled by user".to_string());
        }

        let category = classify_tags(tags_value, min_score);
        if category == "other" {
            skipped += 1;
        } else {
            classified += 1;
        }

        category_files
            .entry(category.clone())
            .or_default()
            .push(file_id.clone());
        batch_updates.push((file_id.clone(), category));

        // 每 batch_size 条写一次库 + emit 进度
        if batch_updates.len() >= batch_size {
            let updates = std::mem::take(&mut batch_updates);
            file_metadata::update_category_batch(&conn, &updates)
                .map_err(|e| format!("Failed to batch update category: {}", e))?;
        }

        if i % 500 == 0 || i == total - 1 {
            let _ = app.emit("classify-progress", serde_json::json!({
                "current": i + 1,
                "total": total,
                "progress": ((i + 1) as f32 / total as f32 * 100.0) as u32,
                "classified": classified,
                "skipped": skipped,
                "stage": "classifying",
            }));
        }
    }

    // 3. 写入剩余批次
    if !batch_updates.is_empty() {
        file_metadata::update_category_batch(&conn, &batch_updates)
            .map_err(|e| format!("Failed to batch update category: {}", e))?;
    }

    log::info!(
        "[content_classifier] Classification done: {} classified, {} other, {} total",
        classified,
        skipped,
        total
    );

    // 4. 删除旧 auto_content 专题
    let deleted = topics::delete_topics_by_source_type(&conn, "auto_content")
        .map_err(|e| format!("Failed to delete old auto_content topics: {}", e))?;
    log::info!("[content_classifier] Deleted {} old auto_content topics", deleted.len());

    // 5. 每个大类建一个专题（含 other）
    let now = chrono::Utc::now().timestamp();
    let mut topics_created: usize = 0;
    let mut category_counts: Vec<CategoryCount> = Vec::new();

    // 按数量降序，让大类先建
    let mut sorted_cats: Vec<(String, Vec<String>)> =
        category_files.into_iter().collect();
    sorted_cats.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

    for (category, file_ids) in sorted_cats {
        if file_ids.is_empty() {
            continue;
        }
        if should_cancel() {
            return Err("Classification cancelled during topic creation".to_string());
        }

        let count = file_ids.len();
        let label_cn = get_label_cn(&category);
        let cover_file_id = file_ids.first().cloned();
        let topic_id = format!("auto_content_{}", category);
        let topic_name = format!("{} ({})", label_cn, count);

        let topic = topics::Topic {
            id: topic_id.clone(),
            parent_id: None,
            name: topic_name,
            description: Some(format!("P1 自动内容分类 · {}", label_cn)),
            topic_type: Some("auto_content".to_string()),
            cover_file_id,
            background_file_id: None,
            cover_crop: None,
            people_ids: Vec::new(),
            file_ids: Vec::new(),
            source_url: None,
            created_at: Some(now),
            updated_at: Some(now),
            source_type: Some("auto_content".to_string()),
            work_name: None,
            work_name_cn: None,
            file_count: count as i32,
        };

        topics::upsert_topic(&conn, &topic)
            .map_err(|e| format!("Failed to upsert topic for {}: {}", category, e))?;
        topics::set_topic_files(&conn, &topic_id, &file_ids)
            .map_err(|e| format!("Failed to set topic_files for {}: {}", category, e))?;

        topics_created += 1;
        category_counts.push(CategoryCount {
            category: category.clone(),
            label_cn,
            count,
        });

        let _ = app.emit("classify-progress", serde_json::json!({
            "current": total,
            "total": total,
            "progress": 100,
            "stage": "creating_topics",
            "topicCreated": category,
        }));
    }

    log::info!(
        "[content_classifier] Created {} auto_content topics",
        topics_created
    );

    Ok(ClassifyResult {
        total,
        classified,
        skipped,
        category_counts,
        topics_created,
    })
}

/// 取消正在进行的分类。
#[tauri::command]
pub async fn cancel_content_classification() -> Result<(), String> {
    CANCEL_CLASSIFY.store(true, Ordering::SeqCst);
    log::info!("[content_classifier] Cancel requested");
    Ok(())
}

/// 返回分类概览：总文件数、已打标签数、各分类统计。
#[tauri::command]
pub async fn get_content_category_stats(
    app: tauri::AppHandle,
) -> Result<ClassificationOverview, String> {
    let pool = app.state::<AppDbPool>();
    let conn = pool.get_connection();

    let total_indexed = file_metadata::count_indexed_files(&conn)
        .map_err(|e| format!("Failed to count indexed files: {}", e))?;
    let total_with_tags = file_metadata::count_files_with_tags(&conn)
        .map_err(|e| format!("Failed to count files with tags: {}", e))?;
    let stats = file_metadata::get_category_stats(&conn)
        .map_err(|e| format!("Failed to get category stats: {}", e))?;

    let categories: Vec<CategoryStat> = stats
        .into_iter()
        .map(|(category, count)| {
            let topic_id = if category.is_empty() {
                None
            } else {
                Some(format!("auto_content_{}", category))
            };
            CategoryStat {
                category: if category.is_empty() {
                    "unprocessed".to_string()
                } else {
                    category
                },
                count: count as usize,
                topic_id,
            }
        })
        .collect();

    Ok(ClassificationOverview {
        total_indexed: total_indexed as usize,
        total_with_tags: total_with_tags as usize,
        categories,
    })
}

/// 检查是否正在分类（前端用于禁用按钮）。
#[tauri::command]
pub async fn is_content_classifying() -> Result<bool, String> {
    Ok(IS_CLASSIFYING.load(Ordering::SeqCst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_tags_landscape() {
        let tags = serde_json::json!(["sky", "mountain", "cloud", "unknown_tag"]);
        let cat = classify_tags(&tags, 1);
        assert_eq!(cat, "landscape");
    }

    #[test]
    fn test_classify_tags_people() {
        let tags = serde_json::json!(["woman", "portrait", "smile"]);
        let cat = classify_tags(&tags, 1);
        assert_eq!(cat, "people");
    }

    #[test]
    fn test_classify_tags_other() {
        let tags = serde_json::json!(["random_thing", "no_match"]);
        let cat = classify_tags(&tags, 1);
        assert_eq!(cat, "other");
    }

    #[test]
    fn test_classify_tags_empty() {
        let tags = serde_json::json!([]);
        let cat = classify_tags(&tags, 1);
        assert_eq!(cat, "other");
    }

    #[test]
    fn test_classify_tags_highest_score_wins() {
        let tags = serde_json::json!(["woman", "girl", "cat"]);
        let cat = classify_tags(&tags, 1);
        assert_eq!(cat, "people");
    }

    #[test]
    fn test_classify_tags_name_prob_format() {
        let tags = serde_json::json!([
            {"name": "sky", "prob": 0.9},
            {"name": "mountain", "prob": 0.8}
        ]);
        let cat = classify_tags(&tags, 1);
        assert_eq!(cat, "landscape");
    }

    #[test]
    fn test_classify_tags_threshold_filter() {
        // 命中 1 个 landscape 标签，阈值为 2 时应归为 other
        let tags = serde_json::json!(["sky"]);
        assert_eq!(classify_tags(&tags, 1), "landscape");
        assert_eq!(classify_tags(&tags, 2), "other");
    }
}
