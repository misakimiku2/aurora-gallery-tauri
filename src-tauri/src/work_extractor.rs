use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkExtractionResult {
    pub work_name: String,
    pub work_name_cn: Option<String>,
    pub character_name: String,
    pub character_name_cn: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCharacter {
    pub tag_name: String,
    pub tag_name_cn: Option<String>,
    pub person_id: Option<String>,
    pub image_count: usize,
    pub cover_file_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkTopicInfo {
    pub work_name: String,
    pub work_name_cn: Option<String>,
    pub character_count: usize,
    pub image_count: usize,
    pub characters: Vec<WorkCharacter>,
    pub existing_topic_id: Option<String>,
    pub cover_file_id: Option<String>,
    pub sample_file_ids: Vec<String>,
    pub file_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkTopicsResult {
    pub topics: Vec<crate::db::topics::Topic>,
    pub people: Vec<crate::db::persons::Person>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkToCreate {
    pub name: String,
    pub topic_type: Option<String>,
    pub cover_file_id: Option<String>,
}

static SERIES_NAMES: Lazy<HashMap<String, String>> = Lazy::new(|| {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("clip")
        .join("series_names.json");
    
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            match serde_json::from_str::<HashMap<String, String>>(&content) {
                Ok(map) => {
                    log::info!("Loaded {} series names from series_names.json", map.len());
                    map
                }
                Err(e) => {
                    log::error!("Failed to parse series_names.json: {}", e);
                    HashMap::new()
                }
            }
        }
        Err(e) => {
            log::error!("Failed to read series_names.json: {}", e);
            HashMap::new()
        }
    }
});

pub fn get_series_name_cn(work_name: &str) -> Option<String> {
    SERIES_NAMES.get(work_name).cloned()
}

pub fn extract_work_name(tag_name: &str, tag_name_cn: Option<&str>) -> Option<WorkExtractionResult> {
    let work_name = extract_work_name_from_english(tag_name)?;
    
    let work_name_cn = tag_name_cn
        .and_then(|cn| extract_work_name_from_chinese(cn))
        .or_else(|| get_series_name_cn(&work_name));
    
    let character_name = extract_character_name_from_english(tag_name, &work_name);
    
    let character_name_cn = tag_name_cn
        .and_then(|cn| extract_character_name_from_chinese(cn));
    
    Some(WorkExtractionResult {
        work_name,
        work_name_cn,
        character_name,
        character_name_cn,
    })
}

fn extract_work_name_from_english(tag: &str) -> Option<String> {
    let patterns = [
        "_(",
        "(",
    ];
    
    for pattern in patterns.iter() {
        if let Some(pos) = tag.rfind(pattern) {
            let start = pos + pattern.len();
            if let Some(end) = tag[start..].find(')') {
                let work = &tag[start..start + end];
                if !work.is_empty() {
                    return Some(work.to_string());
                }
            }
        }
    }
    
    None
}

fn extract_work_name_from_chinese(tag: &str) -> Option<String> {
    if let Some(pos) = tag.rfind('(') {
        let start = pos + 1;
        if let Some(end) = tag[start..].find(')') {
            let work = &tag[start..start + end];
            if !work.is_empty() {
                return Some(work.to_string());
            }
        }
    }
    
    None
}

fn extract_character_name_from_english(tag: &str, work_name: &str) -> String {
    let pattern = format!("_({})", work_name);
    if let Some(pos) = tag.find(&pattern) {
        return tag[..pos].to_string();
    }
    
    let pattern = format!("({})", work_name);
    if let Some(pos) = tag.find(&pattern) {
        if pos > 0 && tag.chars().nth(pos - 1) == Some('_') {
            return tag[..pos - 1].to_string();
        }
        return tag[..pos].to_string();
    }
    
    tag.to_string()
}

fn extract_character_name_from_chinese(tag: &str) -> Option<String> {
    if let Some(pos) = tag.find('(') {
        return Some(tag[..pos].to_string());
    }
    None
}

pub fn normalize_work_name(work_name: &str) -> String {
    let lower = work_name.to_lowercase();
    
    match lower.as_str() {
        "kantai_collection" => "kancolle".to_string(),
        "fate/grand_order" | "fate_grand_order" => "fate_grand_order".to_string(),
        _ => work_name.to_string(),
    }
}

pub fn get_work_display_name(work_name: &str, language: &str) -> String {
    if language == "zh" {
        get_series_name_cn(work_name).unwrap_or_else(|| work_name.to_string())
    } else {
        work_name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_work_name_vocaloid() {
        let result = extract_work_name("hatsune_miku_(VOCALOID)", Some("初音未来(VOCALOID)"));
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r.work_name, "VOCALOID");
        assert_eq!(r.character_name, "hatsune_miku");
    }

    #[test]
    fn test_extract_work_name_touhou() {
        let result = extract_work_name("hakurei_reimu_(touhou)", Some("博丽灵梦(东方 Project)"));
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r.work_name, "touhou");
        assert_eq!(r.work_name_cn, Some("东方 Project".to_string()));
        assert_eq!(r.character_name, "hakurei_reimu");
    }

    #[test]
    fn test_extract_work_name_genshin() {
        let result = extract_work_name("ganyu_(genshin_impact)", Some("甘雨(原神)"));
        assert!(result.is_some());
        let r = result.unwrap();
        assert_eq!(r.work_name, "genshin_impact");
        assert_eq!(r.work_name_cn, Some("原神".to_string()));
        assert_eq!(r.character_name, "ganyu");
    }

    #[test]
    fn test_extract_work_name_no_work() {
        let result = extract_work_name("some_character", None);
        assert!(result.is_none());
    }
}
