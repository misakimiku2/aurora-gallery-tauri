// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::fs;
use std::num::NonZeroU32;
use std::sync::Arc;
use tauri::Manager;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use serde_json;


use base64::{Engine as _, engine::general_purpose};
use fast_image_resize as fr;
use rayon::prelude::*;
use palette::{FromColor, Srgb, Lab};
use palette::color_difference::Ciede2000;

// 导入颜色相关模块
mod color_extractor;
mod color_db;
mod color_worker;
mod db;

// --- Window State Management ---

#[derive(Serialize, Deserialize, Debug)]
struct SavedWindowState {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    maximized: bool,
}

impl Default for SavedWindowState {
    fn default() -> Self {
        Self { width: 1280.0, height: 800.0, x: 100.0, y: 100.0, maximized: false }
    }
}

fn get_window_state_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    app_handle.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).join("window_state.json")
}

fn save_window_state(app_handle: &tauri::AppHandle) {
    let window = match app_handle.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let path = get_window_state_path(app_handle);
    let mut state = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<SavedWindowState>(&s).ok())
            .unwrap_or(SavedWindowState::default())
    } else {
        SavedWindowState::default()
    };

    if window.is_maximized().unwrap_or(false) {
        state.maximized = true;
    } else {
        state.maximized = false;
        // Don't save if minimized
        if !window.is_minimized().unwrap_or(false) {
            if let (Ok(pos), Ok(size), Ok(factor)) = (window.outer_position(), window.inner_size(), window.scale_factor()) {
                let l_pos = pos.to_logical::<f64>(factor);
                let l_size = size.to_logical::<f64>(factor);
                state.x = l_pos.x;
                state.y = l_pos.y;
                state.width = l_size.width;
                state.height = l_size.height;
            }
        }
    }
    
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = fs::write(path, json);
    }
}

// --- Color Search Implementation ---

// Helper: Hex string to Lab color
fn hex_to_lab(hex: &str) -> Option<Lab> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 { return None; }
    
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    
    // Normalize to 0.0 - 1.0
    let srgb = Srgb::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    Some(Lab::from_color(srgb))
}

#[tauri::command]
async fn search_by_palette(
    pool_state: tauri::State<'_, Arc<color_db::ColorDbPool>>,
    target_palette: Vec<String>
) -> Result<Vec<String>, String> {
    eprintln!("[search_by_palette] Called with {} colors: {:?}", target_palette.len(), target_palette);
    
    // Parse target palette to Lab once
    let target_labs: Vec<Lab> = target_palette.iter()
        .filter_map(|h| hex_to_lab(h))
        .collect();
    eprintln!("[search_by_palette] Parsed {} valid Lab colors", target_labs.len());
        
    if target_labs.is_empty() {
        return Ok(Vec::new());
    }

    let is_single_color = target_labs.len() == 1;
    let is_atmosphere_search = target_labs.len() >= 5;

    let pool = pool_state.inner().clone();
    
    // Offload compute-intensive task to blocking threadpool
    // Using access_cache to avoid copying data
    let results = tokio::task::spawn_blocking(move || {
        pool.access_cache(|all_colors| {
             eprintln!("[search_by_palette] Searching in {} cached images", all_colors.len());
             
             let mut results: Vec<(String, f32)> = all_colors.par_iter()
                .filter_map(|image_data| {
                     // Use PRECOMPUTED Labs! No hex_to_lab parsing here anymore.
                     let candidate_labs = &image_data.labs;
                     
                     if candidate_labs.is_empty() { return None; }
                     
                     let score: f32;
                     let threshold: f32;
    
                     if is_single_color {
                 // ========== 单色搜索：考虑颜色位置权重 ==========
                 // 核心思想：用户搜索红色时，想找的是"红色氛围为主"的图片
                 // 所以不仅要找到相似颜色，还要求该颜色在图片中占比足够大（位置靠前）
                 
                 let target = &target_labs[0];
                 
                 // 辅助函数：计算颜色的"色彩程度"（基于Lab空间）
                 fn calc_colorfulness(lab_a: f32, lab_b: f32) -> f32 {
                     (lab_a * lab_a + lab_b * lab_b).sqrt() / 127.0
                 }
                 
                 // 检查目标颜色是否有明显色彩（非灰色）
                 let target_colorfulness = calc_colorfulness(target.a, target.b);
                 let target_is_colorful = target_colorfulness > 0.05; // 目标颜色有色彩
                 
                 // 检查候选图片是否为纯黑白/灰度
                 let candidate_max_colorfulness = candidate_labs.iter()
                     .take(5)
                     .map(|lab| calc_colorfulness(lab.a, lab.b))
                     .fold(0.0f32, f32::max);
                 let candidate_is_grayscale = candidate_max_colorfulness < 0.03;
                 
                 // 如果搜索的是彩色，但候选图是纯灰度，直接排除
                 if target_is_colorful && candidate_is_grayscale {
                     return None;
                 }
                 
                 // 位置权重：第1位=1.0, 第2位=0.7, 第3位=0.5, 第4位=0.35, 之后更低
                 // 这确保占比大的颜色能贡献高分，但也允许第2-3位的颜色有一定权重
                 let position_weights = [1.0f32, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08];
                 
                 let mut best_weighted_score = 0.0f32;
                 
                 for (idx, candidate) in candidate_labs.iter().enumerate() {
                     let dist = candidate.difference(*target); // CIEDE2000
                     
                     // 相似度分数：距离越小，分数越高
                     // DeltaE < 10 认为是相似颜色，< 5 非常相似
                     let similarity = if dist < 5.0 {
                         100.0
                     } else if dist < 10.0 {
                         100.0 - (dist - 5.0) * 4.0 // 5-10 -> 100-80
                     } else if dist < 20.0 {
                         80.0 - (dist - 10.0) * 3.0 // 10-20 -> 80-50
                     } else if dist < 30.0 {
                         50.0 - (dist - 20.0) * 2.0 // 20-30 -> 50-30
                     } else {
                         (30.0 - (dist - 30.0).min(30.0)).max(0.0) // 30+ -> 30-0
                     };
                     
                     // 位置权重
                     let pos_weight = if idx < position_weights.len() {
                         position_weights[idx]
                     } else {
                         0.05 // 第8个以后的颜色权重很低
                     };
                     
                     // 加权分数 = 相似度 * 位置权重
                     let weighted_score = similarity * pos_weight;
                     
                     if weighted_score > best_weighted_score {
                         best_weighted_score = weighted_score;
                     }
                 }
                 
                 score = best_weighted_score;
                 // 阈值：需要 score >= 60 才认为是"红色氛围为主"的图片
                 // 这意味着要么前3位颜色中有相似颜色，要么第1位颜色非常接近
                 threshold = 60.0;
                 
             } else if is_atmosphere_search {
                 // ========== 氛围搜索（5色以上）：整体调色板结构匹配 ==========
                 // 核心思想：找与参考图片整体色调相似的图片
                 // 要求双向匹配：目标颜色能在候选中找到 + 候选主色也要在目标中有对应
                 // 同时避免将黑白漫画与彩色图片匹配（通过彩度检测）
                 
                 // 辅助函数：计算颜色的"色彩程度"（基于Lab空间）
                 // 在Lab空间中，a和b值决定了色彩，值越大表示色彩越饱和
                 fn calc_colorfulness(lab_a: f32, lab_b: f32) -> f32 {
                     // 计算a、b值的欧氏距离，表示离灰色轴（a=0, b=0）有多远
                     (lab_a * lab_a + lab_b * lab_b).sqrt() / 127.0 // 除以Lab色彩空间的最大值作为归一化
                 }
                 
                 // 计算目标调色板的整体色彩程度
                 let target_colorfulness: Vec<f32> = target_labs.iter()
                     .take(5)
                     .map(|lab| calc_colorfulness(lab.a, lab.b))
                     .collect();
                 
                 let target_avg_colorfulness = if !target_colorfulness.is_empty() {
                     target_colorfulness.iter().sum::<f32>() / target_colorfulness.len() as f32
                 } else {
                     0.0
                 };
                 
                 // 计算候选调色板的整体色彩程度
                 let candidate_colorfulness: Vec<f32> = candidate_labs.iter()
                     .take(5)
                     .map(|lab| calc_colorfulness(lab.a, lab.b))
                     .collect();
                 
                 let candidate_avg_colorfulness = if !candidate_colorfulness.is_empty() {
                     candidate_colorfulness.iter().sum::<f32>() / candidate_colorfulness.len() as f32
                 } else {
                     0.0
                 };
                 
                 // 策略1：计算加权最小距离（考虑位置）
                 // 目标调色板中的前几个颜色更重要
                 let target_weights = [1.0f32, 0.85, 0.7, 0.55, 0.4];
                 
                 let mut weighted_total_dist = 0.0f32;
                 let mut total_weight = 0.0f32;
                 
                 for (t_idx, t) in target_labs.iter().enumerate() {
                     let t_weight = if t_idx < target_weights.len() {
                         target_weights[t_idx]
                     } else {
                         0.05
                     };
                     
                     // 找候选颜色中最佳匹配，同时考虑候选位置
                     let mut best_match_dist = f32::INFINITY;
                     let mut best_match_pos = candidate_labs.len();
                     
                     for (c_idx, c) in candidate_labs.iter().enumerate() {
                         let dist = c.difference(*t);
                         if dist < best_match_dist {
                             best_match_dist = dist;
                             best_match_pos = c_idx;
                         }
                     }
                     
                     // 位置惩罚：如果目标的主色（前3位）只能在候选的后面找到匹配，大幅增加惩罚
                     let position_penalty = if t_idx < 3 {
                         if best_match_pos > 4 {
                             best_match_dist * 0.8 // 主色匹配在后面，增加80%惩罚
                         } else if best_match_pos > 2 {
                             best_match_dist * 0.4 // 主色匹配在中间，增加40%惩罚
                         } else {
                             0.0 // 主色匹配在前面，无惩罚
                         }
                     } else {
                         0.0
                     };
                     
                     let adjusted_dist = best_match_dist + position_penalty;
                     weighted_total_dist += adjusted_dist * t_weight;
                     total_weight += t_weight;
                 }
                 
                 let avg_weighted_dist = weighted_total_dist / total_weight;
                 
                 // 策略2：严格的双向匹配 - 候选图片的主色也必须在目标调色板中找到对应
                 // 这是关键：防止完全不同氛围的图片被匹配进来
                 let mut reverse_mismatch_penalty = 0.0f32;
                 
                 // 检查候选图片的前5个主色
                 for (c_idx, c) in candidate_labs.iter().take(5).enumerate() {
                     let min_dist_to_target = target_labs.iter()
                         .map(|t| c.difference(*t))
                         .fold(f32::INFINITY, |a, b| a.min(b));
                     
                     // 更严格的不匹配阈值：DeltaE > 12 就开始惩罚
                     // 第1个主色最重要，第2、3个次之
                     if min_dist_to_target > 12.0 {
                         let penalty_weight = match c_idx {
                             0 => 10.0,  // 第1个主色不匹配，重罚
                             1 => 7.5,   // 第2个主色
                             2 => 5.5,   // 第3个主色
                             3 => 4.0,   // 第4个主色
                             _ => 2.5,   // 第5个主色
                         };
                         
                         // 惩罚力度：差异越大，惩罚越重
                         let excess_dist = min_dist_to_target - 12.0;
                         reverse_mismatch_penalty += excess_dist * penalty_weight * 0.18;
                     }
                 }
                 
                 // 策略3：色彩程度不匹配惩罚 - 防止将黑白漫画与彩色图片匹配
                 // 改进版：区分纯黑白、低饱和度彩色、高饱和度彩色三种情况
                 let mut colorfulness_mismatch_penalty = 0.0f32;
                 
                 // 辅助函数：判断是否为"纯黑白/灰度"图片
                 // 纯黑白图片的特征：所有颜色的 colorfulness 都非常低（< 0.03）
                 fn is_pure_grayscale(colorfulness_values: &[f32]) -> bool {
                     if colorfulness_values.is_empty() { return true; }
                     let max_cf = colorfulness_values.iter().cloned().fold(0.0f32, f32::max);
                     // 如果最大 colorfulness 都 < 0.03，认为是纯灰度
                     max_cf < 0.03
                 }
                 
                 // 辅助函数：判断颜色是否有明确的色相方向（而不是散乱或接近灰色轴）
                 // 通过检查 a、b 值是否有一致的倾向
                 fn has_color_tendency(labs: &[Lab]) -> bool {
                     if labs.len() < 2 { return false; }
                     
                     // 统计有意义的色彩值（colorfulness > 0.02 的颜色）
                     let meaningful_colors: Vec<(f32, f32)> = labs.iter()
                         .take(5)
                         .filter(|lab| {
                             let cf = (lab.a * lab.a + lab.b * lab.b).sqrt() / 127.0;
                             cf > 0.02  // 只考虑有一点色彩的颜色
                         })
                         .map(|lab| (lab.a, lab.b))
                         .collect();
                     
                     // 如果没有足够的有意义颜色，没有色彩倾向
                     if meaningful_colors.len() < 2 { return false; }
                     
                     // 计算平均 a、b 值
                     let avg_a = meaningful_colors.iter().map(|(a, _)| *a).sum::<f32>() / meaningful_colors.len() as f32;
                     let avg_b = meaningful_colors.iter().map(|(_, b)| *b).sum::<f32>() / meaningful_colors.len() as f32;
                     
                     // 如果平均值离原点有一定距离，说明有色彩倾向
                     let avg_chroma = (avg_a * avg_a + avg_b * avg_b).sqrt();
                     avg_chroma > 3.0  // Lab 空间中，a/b 差异 > 3 就有可感知的颜色倾向
                 }
                 
                 let target_is_pure_grayscale = is_pure_grayscale(&target_colorfulness);
                 let candidate_is_pure_grayscale = is_pure_grayscale(&candidate_colorfulness);
                 let target_has_color = has_color_tendency(&target_labs);
                 let candidate_has_color = has_color_tendency(&candidate_labs);
                 
                 // 核心逻辑：目标有颜色倾向，但候选是纯灰度 → 重罚
                 if target_has_color && candidate_is_pure_grayscale {
                     // 目标是低饱和度彩色（如暖色调），候选是纯黑白 → 绝对排除
                     colorfulness_mismatch_penalty = 50.0;
                 } else if target_has_color && !candidate_has_color {
                     // 目标有色彩倾向，候选没有明确色彩倾向 → 强惩罚
                     colorfulness_mismatch_penalty = 40.0;
                 } else if !target_is_pure_grayscale && candidate_is_pure_grayscale {
                     // 目标有一点色彩（可能是轻微偏色的图），候选是纯黑白 → 强惩罚
                     colorfulness_mismatch_penalty = 35.0;
                 } else if target_is_pure_grayscale && !candidate_is_pure_grayscale {
                     // 目标是纯黑白，候选有颜色 → 中等惩罚
                     colorfulness_mismatch_penalty = 25.0;
                 } else {
                     // 两者都有颜色或都是灰度，检查 colorfulness 差异
                     let colorfulness_diff = (target_avg_colorfulness - candidate_avg_colorfulness).abs();
                     
                     if target_avg_colorfulness > 0.2 && candidate_avg_colorfulness < 0.05 {
                         // 高饱和目标 vs 极低饱和候选
                         colorfulness_mismatch_penalty = colorfulness_diff * 40.0;
                     } else if colorfulness_diff > 0.1 {
                         // 一般的色彩程度差异惩罚
                         colorfulness_mismatch_penalty = (colorfulness_diff - 0.1) * 15.0;
                     }
                 }
                 
                 // 最终分数
                 let raw_score = 100.0 - avg_weighted_dist - reverse_mismatch_penalty - colorfulness_mismatch_penalty;
                 score = raw_score.max(0.0);
                 
                 // 氛围搜索阈值提高到85分
                 // 这确保只有真正氛围相似的图片才能通过
                 threshold = 85.0;
                 
             } else {
                 // ========== 中等数量颜色搜索（2-4色）==========
                 // 混合策略：要求每个目标颜色都能找到匹配，但也考虑位置
                 
                 let mut total_min_dist = 0.0f32;
                 let mut position_bonus = 0.0f32;
                 
                 for t in &target_labs {
                     let mut min_dist = f32::INFINITY;
                     let mut best_pos = candidate_labs.len();
                     
                     for (idx, c) in candidate_labs.iter().enumerate() {
                         let dist = c.difference(*t);
                         if dist < min_dist {
                             min_dist = dist;
                             best_pos = idx;
                         }
                     }
                     
                     total_min_dist += min_dist;
                     
                     // 如果匹配颜色在前4位，给予位置奖励
                     if best_pos < 4 && min_dist < 15.0 {
                         position_bonus += (4.0 - best_pos as f32) * 2.0;
                     }
                 }
                 
                 let avg_dist = total_min_dist / target_labs.len() as f32;
                 score = 100.0 - avg_dist + position_bonus / target_labs.len() as f32;
                 threshold = 88.0;
             }
             
             if score >= threshold {
                 Some((image_data.file_path.clone(), score))
             } else {
                 None
             }
        })
        .collect();

        // Sort by score descending (best match first)
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        
        // Return top results directly here inside the closure
        (results, is_single_color, is_atmosphere_search)
        }) // End of access_cache closure
    }).await.map_err(|e| format!("Search task failed: {}", e))? // End of spawn_blocking, handle JoinError
    .map_err(|e| format!("Cache access failed: {}", e))?; // Handle access_cache error

    // Destructure results
    let (results, _, _) = results; // is_single_color etc are from inside, but we have them outside too.
    
    let threshold_used = if is_single_color { 60.0 } else if is_atmosphere_search { 85.0 } else { 88.0 };
    let final_results: Vec<String> = results.iter().map(|(path, _)| path.clone()).collect();
    eprintln!("[search_by_palette] Returning {} results", final_results.len());
    
    Ok(final_results)
}

#[tauri::command]
async fn search_by_color(
     pool_state: tauri::State<'_, Arc<color_db::ColorDbPool>>,
     color: String
) -> Result<Vec<String>, String> {
    search_by_palette(pool_state, vec![color]).await
}

use db::AppDbPool;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileType {
    Image,
    Folder,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub width: u32,
    pub height: u32,
    pub size_kb: u32,
    pub created: String,
    pub modified: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub r#type: FileType,
    pub path: String,
    pub size: Option<u64>,
    pub children: Option<Vec<String>>,
    pub tags: Vec<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: Option<String>,
    pub meta: Option<ImageMeta>,
    pub description: Option<String>,
    pub source_url: Option<String>,
    pub ai_data: Option<serde_json::Value>,
}

// Supported image extensions
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "ico", "svg",
];

// Generate ID from file path (MD5 hash, first 9 chars)
fn generate_id(path: &str) -> String {
    // Normalize path (replace backslashes with forward slashes)
    let normalized = path.replace('\\', "/");
    
    let hash = md5::compute(normalized.as_bytes());
    
    // Convert to hex and take first 9 characters
    format!("{:x}", hash)[..9].to_string()
}

// Normalize path separators
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

// Generate a unique file path by adding _copy suffix if file exists
fn generate_unique_file_path(dest_path: &str) -> String {
    let path = Path::new(dest_path);
    if !path.exists() {
        return dest_path.to_string();
    }
    
    // Get parent directory and file stem/extension
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let file_stem = path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let extension = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    
    // Try _copy, _copy2, _copy3, etc.
    for counter in 1.. {
        let new_name = if counter == 1 {
            format!("{}_copy{}", file_stem, extension)
        } else {
            format!("{}_copy{}{}", file_stem, counter, extension)
        };
        let new_path = parent.join(&new_name);
        if !new_path.exists() {
            return new_path.to_str().unwrap_or(dest_path).to_string();
        }
    }
    
    // Fallback (should never reach here)
    dest_path.to_string()
}

// Check if file extension is supported
fn is_supported_image(extension: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}


#[tauri::command]
async fn scan_directory(path: String, app: tauri::AppHandle) -> Result<HashMap<String, FileNode>, String> {
    use std::fs;
    use std::io::Read;
    use rayon::prelude::*;
    
    let root_path = Path::new(&path);
    
    // Check if path exists and is a directory
    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    if !root_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Load metadata from database
    let metadatas = {
        let pool = app.state::<AppDbPool>();
        let conn = pool.get_connection();
        db::file_metadata::get_all_metadata(&conn).map_err(|e| e.to_string())?
    };
    let metadata_map: HashMap<String, db::file_metadata::FileMetadata> = metadatas
        .into_iter()
        .map(|m| (m.file_id.clone(), m))
        .collect();
    
    let mut all_files: HashMap<String, FileNode> = HashMap::new();
    
    // Get root directory metadata
    let root_metadata = match fs::metadata(root_path) {
        Ok(m) => m,
        Err(e) => return Err(format!("Failed to read root directory: {}", e)),
    };
    
    let root_id = generate_id(&path);
    let root_name = root_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Root")
        .to_string();
    
    // Create root directory node
    let root_node = FileNode {
        id: root_id.clone(),
        parent_id: None,
        name: root_name,
        r#type: FileType::Folder,
        path: normalize_path(&path),
        size: None,
        children: Some(Vec::new()),
        tags: Vec::new(),
        created_at: root_metadata
            .created()
            .ok()
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
            .and_then(|secs| {
                chrono::DateTime::from_timestamp(secs as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            }),
        updated_at: root_metadata
            .modified()
            .ok()
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
            .and_then(|secs| {
                chrono::DateTime::from_timestamp(secs as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            }),
        url: None,
        meta: None,
        description: None,
        source_url: None,
        ai_data: None,
    };
    
    all_files.insert(root_id.clone(), root_node.clone());
    
    // Use jwalk for parallel directory traversal
    let normalized_root_path = normalize_path(&path);
    
    // Build path -> id mapping (will be populated as we process entries)
    let mut path_to_id: HashMap<String, String> = HashMap::new();
    path_to_id.insert(normalized_root_path.clone(), root_id.clone());
    
    // Process entries in parallel using jwalk
    let file_nodes: Vec<(String, FileNode, String)> = jwalk::WalkDir::new(&path)
        .into_iter()
        .par_bridge()
        .filter_map(|entry_result| {
            let entry = match entry_result {
                Ok(e) => e,
                Err(_) => return None,
            };
            
            let entry_path = entry.path();
            
            // Skip root directory itself
            if entry_path == root_path {
                return None;
            }
            
            // Skip hidden files (except .pixcall)
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            
            // Skip .Aurora_Cache folder and its contents
            if entry_path.components().any(|c| c.as_os_str() == ".Aurora_Cache") {
                return None;
            }
            
            if file_name.starts_with('.') && file_name != ".pixcall" {
                return None;
            }
            
            let full_path = normalize_path(entry_path.to_str().unwrap_or(""));
            
            // Get metadata
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => return None,
            };
            
            // Get parent path directly from entry_path (thread-safe)
            let parent_path = if let Some(parent) = entry_path.parent() {
                normalize_path(parent.to_str().unwrap_or(""))
            } else {
                normalized_root_path.clone()
            };
            
            let file_id = generate_id(&full_path);
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            
            // Check if it's a directory
            let is_directory = metadata.is_dir();
            
            if is_directory {
                // Create folder node (parent_id will be set later)
                let folder_node = FileNode {
                    id: file_id.clone(),
                    parent_id: None, // Will be set later
                    name: file_name,
                    r#type: FileType::Folder,
                    path: full_path.clone(),
                    size: None,
                    children: Some(Vec::new()),
                    tags: Vec::new(),
                    created_at: metadata
                        .created()
                        .ok()
                        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                        .and_then(|secs| {
                            chrono::DateTime::from_timestamp(secs as i64, 0)
                                .map(|dt| dt.to_rfc3339())
                        }),
                    updated_at: metadata
                        .modified()
                        .ok()
                        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                        .and_then(|secs| {
                            chrono::DateTime::from_timestamp(secs as i64, 0)
                                .map(|dt| dt.to_rfc3339())
                        }),
                    url: None,
                    meta: None,
                    description: None,
                    source_url: None,
                    ai_data: None,
                };
                
                Some((file_id, folder_node, parent_path))
            } else {
                // Check if it's a supported image
                let extension = entry_path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_default();
                
                if is_supported_image(&extension) {
                    // Create image file node (parent_id will be set later)
                    let file_size = metadata.len();
                    
                    // Use imageinfo to quickly get image dimensions
                    let (width, height) = {
                        // Read just the first few bytes needed for imageinfo
                        if let Ok(mut file) = fs::File::open(entry_path) {
                            let mut buffer = vec![0u8; 4096]; // Read first 4KB, enough for most formats
                            if let Ok(bytes_read) = file.read(&mut buffer) {
                                buffer.truncate(bytes_read);
                                if let Ok(info) = imageinfo::ImageInfo::from_raw_data(&buffer) {
                                    (info.size.width as u32, info.size.height as u32)
                                } else {
                                    (0, 0)
                                }
                            } else {
                                (0, 0)
                            }
                        } else {
                            (0, 0)
                        }
                    };
                    
                    let image_node = FileNode {
                        id: file_id.clone(),
                        parent_id: None, // Will be set later
                        name: file_name,
                        r#type: FileType::Image,
                        path: full_path.clone(),
                        size: Some(file_size),
                        children: None,
                        tags: Vec::new(),
                        created_at: metadata
                            .created()
                            .ok()
                            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                            .and_then(|secs| {
                                chrono::DateTime::from_timestamp(secs as i64, 0)
                                    .map(|dt| dt.to_rfc3339())
                            }),
                        updated_at: metadata
                            .modified()
                            .ok()
                            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                            .and_then(|secs| {
                                chrono::DateTime::from_timestamp(secs as i64, 0)
                                    .map(|dt| dt.to_rfc3339())
                            }),
                        url: None, // Don't use file path as URL - frontend will use getThumbnail() instead
                        meta: Some(ImageMeta {
                            width,
                            height,
                            size_kb: (file_size / 1024) as u32,
                            created: metadata
                                .created()
                                .ok()
                                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                                .and_then(|secs| {
                                    chrono::DateTime::from_timestamp(secs as i64, 0)
                                        .map(|dt| dt.to_rfc3339())
                                })
                                .unwrap_or_default(),
                            modified: metadata
                                .modified()
                                .ok()
                                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                                .and_then(|secs| {
                                    chrono::DateTime::from_timestamp(secs as i64, 0)
                                        .map(|dt| dt.to_rfc3339())
                                })
                                .unwrap_or_default(),
                            format: extension,
                        }),
                        description: None,
                        source_url: None,
                        ai_data: None,
                    };
                    
                    Some((file_id, image_node, parent_path))
                } else {
                    None
                }
            }
        })
        .collect();
    
    // Now process nodes sequentially to build relationships
    // First pass: add all folders to path_to_id mapping
    for (id, node, _) in &file_nodes {
        if matches!(node.r#type, FileType::Folder) {
            path_to_id.insert(node.path.clone(), id.clone());
        }
    }
    
    // Second pass: add all nodes to the map and resolve parent_id
    for (id, mut node, parent_path) in file_nodes {
        // Resolve parent_id from parent_path
        if !parent_path.is_empty() {
            if let Some(parent_id) = path_to_id.get(&parent_path).cloned() {
                node.parent_id = Some(parent_id);
            } else {
                // If parent not found in path_to_id, it might be the root
                if parent_path == normalize_path(&path) {
                    node.parent_id = Some(root_id.clone());
                }
            }
        }
        
        // Merge metadata if available
        if let Some(meta) = metadata_map.get(&id) {
            if let Some(tags_val) = &meta.tags {
                if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) {
                    node.tags = tags_vec;
                }
            }
            node.description = meta.description.clone();
            node.source_url = meta.source_url.clone();
            node.ai_data = meta.ai_data.clone();
        }

        all_files.insert(id.clone(), node);
    }
    
    // Build parent-child relationships
    let mut children_to_add: Vec<(String, String)> = Vec::new(); // (parent_id, child_id)
    for (id, node) in all_files.iter() {
        if let Some(parent_id) = &node.parent_id {
            children_to_add.push((parent_id.clone(), id.clone()));
        } else if node.id != root_id {
            // Root-level item (shouldn't happen if parent_id resolution worked correctly)
            children_to_add.push((root_id.clone(), id.clone()));
        }
    }
    
    // Add children to their parents
    for (parent_id, child_id) in children_to_add {
        if let Some(parent_node) = all_files.get_mut(&parent_id) {
            if let Some(children) = &mut parent_node.children {
                children.push(child_id);
            }
        }
    }
    
    // Sort children for all folders
    let folder_ids: Vec<String> = all_files.keys().cloned().collect();
    for folder_id in folder_ids {
        // Get children list first (immutable borrow)
        let children_opt = all_files.get(&folder_id)
            .and_then(|n| n.children.as_ref())
            .map(|c| c.clone());
        
        if let Some(mut children_sorted) = children_opt {
            // Sort using immutable borrow of all_files
            children_sorted.sort_by(|a, b| {
                let a_node = all_files.get(a);
                let b_node = all_files.get(b);
                
                match (a_node, b_node) {
                    (Some(a_n), Some(b_n)) => {
                        // Folders first
                        match (&a_n.r#type, &b_n.r#type) {
                            (FileType::Folder, FileType::Folder) => a_n.name.cmp(&b_n.name),
                            (FileType::Folder, _) => std::cmp::Ordering::Less,
                            (_, FileType::Folder) => std::cmp::Ordering::Greater,
                            _ => a_n.name.cmp(&b_n.name),
                        }
                    }
                    _ => std::cmp::Ordering::Equal,
                }
            });
            
            // Now update with mutable borrow
            if let Some(node) = all_files.get_mut(&folder_id) {
                if let Some(children) = &mut node.children {
                    *children = children_sorted;
                }
            }
        }
    }
    
    // Collect all image paths from the scan results
    let image_paths: Vec<String> = all_files
        .iter()
        .filter(|(_, node)| matches!(node.r#type, FileType::Image))
        .map(|(_, node)| node.path.clone())
        .collect();
    
    // Add all image paths to color database in batches
    if !image_paths.is_empty() {
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let batch_size = 100;
        
        // Process in batches to avoid database overload
        for chunk in image_paths.chunks(batch_size) {
            let chunk_vec: Vec<String> = chunk.iter().cloned().collect();
            let pool_clone = pool.clone();
            
            // Add to database in a blocking thread
            let result = tokio::task::spawn_blocking(move || {
                let mut conn = pool_clone.get_connection();
                color_db::add_pending_files(&mut conn, &chunk_vec)
            }).await;
            
            if let Err(e) = result {
                eprintln!("Failed to add batch to color database: {}", e);
            } else if let Err(e) = result.unwrap() {
                eprintln!("Database error when adding batch: {}", e);
            }
        }
    }
    
    // DO NOT update root node in map - it's already there with children!
    // all_files.insert(root_id, root_node); // This line was overwriting the root node!
    
    Ok(all_files)
}

#[tauri::command]
async fn scan_file(file_path: String, parent_id: Option<String>, app: tauri::AppHandle) -> Result<FileNode, String> {
    use std::fs;
    
    let path = Path::new(&file_path);
    
    // Check if path exists
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    
    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    
    let file_id = generate_id(&normalize_path(&file_path));
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    let is_directory = path.is_dir();
    let is_image = is_supported_image(&extension);
    
    if is_directory {
        // Create folder node
        Ok(FileNode {
            id: file_id,
            parent_id,
            name: file_name,
            r#type: FileType::Folder,
            path: normalize_path(&file_path),
            size: None,
            children: Some(Vec::new()),
            tags: Vec::new(),
            created_at: metadata
                .created()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            updated_at: metadata
                .modified()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            url: None,
            meta: None,
            description: None,
            source_url: None,
            ai_data: None,
        })
    } else if is_image {
        // Create image file node
        let file_size = metadata.len();
        let (width, height) = image::image_dimensions(path).unwrap_or((0, 0));
        
        // Create image file node
        let image_node = FileNode {
            id: file_id,
            parent_id,
            name: file_name,
            r#type: FileType::Image,
            path: normalize_path(&file_path),
            size: Some(file_size),
            children: None,
            tags: Vec::new(),
            created_at: metadata
                .created()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            updated_at: metadata
                .modified()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            url: None,
            meta: Some(ImageMeta {
                width,
                height,
                size_kb: (file_size / 1024) as u32,
                created: metadata
                    .created()
                    .ok()
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                    .and_then(|secs| {
                        chrono::DateTime::from_timestamp(secs as i64, 0)
                            .map(|dt| dt.to_rfc3339())
                    })
                    .unwrap_or_default(),
                modified: metadata
                    .modified()
                    .ok()
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                    .and_then(|secs| {
                        chrono::DateTime::from_timestamp(secs as i64, 0)
                            .map(|dt| dt.to_rfc3339())
                    })
                    .unwrap_or_default(),
                format: extension,
            }),
            description: None,
            source_url: None,
            ai_data: None,
        };
        
        // Add image to color database
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let image_path = image_node.path.clone();
        
        // Add to database in a blocking thread
        let result = tokio::task::spawn_blocking(move || {
            let mut conn = pool.get_connection();
            color_db::add_pending_files(&mut conn, &[image_path])
        }).await;
        
        if let Err(e) = result {
            eprintln!("Failed to add file to color database: {}", e);
        } else if let Err(e) = result.unwrap() {
            eprintln!("Database error when adding file: {}", e);
        }
        
        let mut final_node = image_node;
        
        // Merge metadata if available
        {
            let pool = app.state::<AppDbPool>();
            let conn = pool.get_connection();
            if let Ok(Some(meta)) = db::file_metadata::get_metadata_by_id(&conn, &final_node.id) {
                if let Some(tags_val) = &meta.tags {
                    if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) {
                        final_node.tags = tags_vec;
                    }
                }
                final_node.description = meta.description.clone();
                final_node.source_url = meta.source_url.clone();
                final_node.ai_data = meta.ai_data.clone();
            }
        }

        Ok(final_node)
    } else {
        // Create unknown file node
        let file_size = metadata.len();
        
        Ok(FileNode {
            id: file_id,
            parent_id,
            name: file_name,
            r#type: FileType::Unknown,
            path: normalize_path(&file_path),
            size: Some(file_size),
            children: None,
            tags: Vec::new(),
            created_at: metadata
                .created()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            updated_at: metadata
                .modified()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            url: None,
            meta: None,
            description: None,
            source_url: None,
            ai_data: None,
        })
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn save_user_data(app: tauri::AppHandle, data: serde_json::Value) -> Result<bool, String> {
    use std::io::Write;
    
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    // Create directory if it doesn't exist
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    
    let data_file = app_data_dir.join("user_data.json");
    
    let json_string = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize data: {}", e))?;
    
    let mut file = fs::File::create(&data_file)
        .map_err(|e| format!("Failed to create data file: {}", e))?;
    
    file.write_all(json_string.as_bytes())
        .map_err(|e| format!("Failed to write data file: {}", e))?;
    
    Ok(true)
}

#[tauri::command]
async fn load_user_data(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let data_file = app_data_dir.join("user_data.json");
    
    if !data_file.exists() {
        return Ok(None);
    }
    
    let contents = fs::read_to_string(&data_file)
        .map_err(|e| format!("Failed to read data file: {}", e))?;
    
    let data: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse data file: {}", e))?;
    
    Ok(Some(data))
}

// Command to ensure a directory exists
#[tauri::command]
async fn ensure_directory(path: String) -> Result<(), String> {
    let cache_path = Path::new(&path);
    if !cache_path.exists() {
        fs::create_dir_all(cache_path)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    Ok(())
}

// Command to check if file exists
#[tauri::command]
async fn file_exists(file_path: String) -> Result<bool, String> {
    let path = Path::new(&file_path);
    Ok(path.exists())
}

// Command to create a folder
#[tauri::command]
async fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir(&path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;
    Ok(())
}

// Command to rename a file or folder
#[tauri::command]
async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(())
}

// Command to delete a file or folder
#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if file_path.is_dir() {
        // Delete directory recursively
        fs::remove_dir_all(file_path)
            .map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        // Delete file
        fs::remove_file(file_path)
            .map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn copy_file(src_path: String, dest_path: String) -> Result<(), String> {
    let src = Path::new(&src_path);
    let mut dest = Path::new(&dest_path);
    
    // Check if source exists
    if !src.exists() {
        return Err(format!("Source does not exist: {}", src_path));
    }
    
    // Check if source is a file or directory
    let is_dir = src.is_dir();
    
    // Normalize paths for comparison
    let src_normalized = normalize_path(&src_path);
    let dest_normalized = normalize_path(&dest_path);
    
    // Check if source and destination are exactly the same path
    // For files: allow self-copy (will generate unique filename)
    // For directories: don't allow exact same path copy
    if src_normalized == dest_normalized {
        if is_dir {
            return Err(format!("Cannot copy directory to itself: {}", src_path));
        } else {
            // This is a file self-copy - generate a unique filename in the same directory
            println!("Copying file to the same directory, will generate unique filename");
        }
    }
    
    // For files, generate unique path if destination exists
    let final_dest_path = if !is_dir && dest.exists() {
        let unique_path = generate_unique_file_path(&dest_path);
        println!("Destination file exists, using unique path: {}", unique_path);
        unique_path
    } else {
        dest_path.clone()
    };
    
    dest = Path::new(&final_dest_path);
    
    // Create parent directory if it doesn't exist
    if let Some(dest_parent) = dest.parent() {
        if !dest_parent.exists() {
            fs::create_dir_all(dest_parent)
                .map_err(|e| format!("Failed to create destination directory: {}", e))?;
        }
    }
    
    println!("Copying {}: {} to {}", if is_dir { "directory" } else { "file" }, src_path, final_dest_path);
    
    // On Windows, use appropriate command based on source type
    // On other platforms, use standard fs operations
    #[cfg(windows)]
    {
        use std::process::Command;
        
        let max_retries = 3;
        let mut last_error: Option<std::io::Error> = None;
        
        for attempt in 0..max_retries {
            if is_dir {
                // Use robocopy for directory copying - call robocopy.exe directly
                let src_win = src_path.replace("/", "\\");
                let dest_win = final_dest_path.replace("/", "\\");
                
                // Call robocopy.exe directly with separate arguments to avoid quote escaping issues
                // /E: copy subdirectories, including empty ones
                // /NFL: no file list
                // /NDL: no directory list  
                // /NJH: no job header
                // /NJS: no job summary
                // /R:3: retry 3 times
                // /W:1: wait 1 second between retries
                println!("Attempt {}: Using robocopy: {} -> {}", attempt + 1, src_win, dest_win);
                
                let output = Command::new("robocopy")
                    .arg(&src_win)
                    .arg(&dest_win)
                    .arg("*")  // Copy all files
                    .arg("/E")
                    .arg("/NFL")
                    .arg("/NDL")
                    .arg("/NJH")
                    .arg("/NJS")
                    .arg("/R:3")
                    .arg("/W:1")
                    .output()
                    .map_err(|e| format!("Failed to execute robocopy command: {}", e))?;
                
                // robocopy returns 0-7, where 0-1 are success
                let exit_code = output.status.code().unwrap_or(0);
                if exit_code <= 1 {
                    println!("Directory copy succeeded");
                    return Ok(());
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let error_msg = if !stderr.is_empty() { stderr } else { stdout };
                    println!("Robocopy attempt {} failed with code {}: {}", attempt + 1, exit_code, error_msg.trim());
                    last_error = Some(std::io::Error::new(std::io::ErrorKind::Other, error_msg.trim().to_string()));
                }
            } else {
                // Use Rust fs::copy for file copying - more reliable than Windows copy command
                println!("Attempt {}: Using fs::copy: {} -> {}", attempt + 1, src_path, final_dest_path);
                match fs::copy(src, dest) {
                    Ok(_) => {
                        println!("File copy succeeded");
                        return Ok(());
                    }
                    Err(e) => {
                        println!("fs::copy attempt {} failed: {:?}", attempt + 1, e);
                        last_error = Some(e);
                    }
                }
            }
            
            // Wait before retrying
            if attempt < max_retries - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
        
        // If all retries failed, return the last error
        if let Some(e) = last_error {
            return Err(format!("Failed to copy after {} attempts: {}", max_retries, e));
        }
    }
    
    // For non-Windows platforms
    #[cfg(not(windows))]
    {
        let max_retries = 3;
        let mut last_error: Option<std::io::Error> = None;
        
        for attempt in 0..max_retries {
            if is_dir {
                // Use fs::copy_dir_all for directory copying
                match fs::copy_dir_all(src, dest) {
                    Ok(_) => return Ok(()),
                    Err(e) => {
                        println!("copy_dir_all attempt {} failed: {:?}", attempt + 1, e);
                        last_error = Some(e);
                    }
                }
            } else {
                // Use fs::copy for file copying
                match fs::copy(src, dest) {
                    Ok(_) => return Ok(()),
                    Err(e) => {
                        last_error = Some(e);
                        println!("fs::copy attempt {} failed: {:?}", attempt + 1, e);
                    }
                }
            }
            
            // Wait before retrying
            if attempt < max_retries - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
        
        // If all retries failed, return the last error
        if let Some(e) = last_error {
            return Err(format!("Failed to copy after {} attempts: {}", max_retries, e));
        }
    }
    
    // This should never be reached
    Err("Unknown error occurred while copying".to_string())
}

#[tauri::command]
async fn move_file(src_path: String, dest_path: String) -> Result<(), String> {
    let src = Path::new(&src_path);
    let dest = Path::new(&dest_path);
    
    // Check if source exists
    if !src.exists() {
        return Err(format!("Source file does not exist: {}", src_path));
    }
    
    // Create dest directory if it doesn't exist
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create destination directory: {}", e))?;
        }
    }
    
    // Try to move file with retry mechanism for file locking issues
    let max_retries = 3;
    let mut attempt = 0;
    let mut last_error: Option<std::io::Error> = None;
    
    while attempt < max_retries {
        match fs::rename(src, dest) {
            Ok(_) => return Ok(()),
            Err(e) => {
                attempt += 1;
                last_error = Some(e);
                
                // Wait a bit before retrying
                if attempt < max_retries {
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }
        }
    }
    
    // If all retries failed, try a fallback approach: copy + delete
    if let Some(e) = last_error {
        if e.kind() == std::io::ErrorKind::PermissionDenied || 
           e.kind() == std::io::ErrorKind::Other {
            
            // Fallback: copy then delete
            match fs::copy(src, dest) {
                Ok(_) => {
                    // Copy succeeded, now delete the original
                    match fs::remove_file(src) {
                        Ok(_) => return Ok(()),
                        Err(delete_err) => {
                            // If delete fails, try to clean up the copy
                            let _ = fs::remove_file(dest);
                            return Err(format!("Failed to delete original file after copy: {}", delete_err));
                        }
                    }
                },
                Err(copy_err) => {
                    return Err(format!("Failed to move file after {} attempts, fallback copy also failed: {} (original error: {})", max_retries, copy_err, e));
                }
            }
        } else {
            return Err(format!("Failed to move file after {} attempts: {}", max_retries, e));
        }
    }
    
    // This should never happen, but just in case
    Err("Unknown error occurred while moving file".to_string())
}

#[tauri::command]
async fn write_file_from_bytes(file_path: String, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;
    
    let path = Path::new(&file_path);
    
    // Create parent directory if it doesn't exist
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }
    
    // Write file with retry mechanism
    let max_retries = 3;
    let mut attempt = 0;
    let mut last_error: Option<std::io::Error> = None;
    
    while attempt < max_retries {
        match fs::File::create(path) {
            Ok(mut file) => {
                match file.write_all(&bytes) {
                    Ok(_) => return Ok(()),
                    Err(e) => {
                        attempt += 1;
                        last_error = Some(e);
                        if attempt < max_retries {
                            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                        }
                    }
                }
            },
            Err(e) => {
                attempt += 1;
                last_error = Some(e);
                if attempt < max_retries {
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }
        }
    }
    
    if let Some(e) = last_error {
        Err(format!("Failed to write file after {} attempts: {}", max_retries, e))
    } else {
        Err("Unknown error occurred while writing file".to_string())
    }
}

#[tauri::command]
async fn get_default_paths() -> Result<HashMap<String, String>, String> {
    use std::env;
    
    let mut paths = HashMap::new();
    
    // Get user's home directory
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| "C:\\Users\\User".to_string());
    
    // Default resource root (Pictures folder)
    let resource_root = if cfg!(windows) {
        format!("{}\\Pictures\\AuroraGallery", home)
    } else if cfg!(target_os = "macos") {
        format!("{}/Pictures/AuroraGallery", home)
    } else {
        format!("{}/Pictures/AuroraGallery", home)
    };
    
    // Default cache root
    let cache_root = if cfg!(windows) {
        format!("{}\\AppData\\Local\\Aurora\\Cache", home)
    } else if cfg!(target_os = "macos") {
        format!("{}/Library/Application Support/Aurora/Cache", home)
    } else {
        format!("{}/.local/share/aurora/cache", home)
    };
    
    paths.insert("resourceRoot".to_string(), resource_root);
    paths.insert("cacheRoot".to_string(), cache_root);
    
    Ok(paths)
}

#[tauri::command]
async fn open_path(path: String, is_file: Option<bool>) -> Result<(), String> {
    use std::process::Command;
    use std::path::Path;
    
    // 规范化路径：确保使用正确的路径分隔符，并转换为绝对路径
    let path_obj = Path::new(&path);
    
    // 检查路径是否存在
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    // 如果路径是相对路径，尝试转换为绝对路径
    let absolute_path = if path_obj.is_absolute() {
        path.clone()
    } else {
        match std::env::current_dir() {
            Ok(current_dir) => {
                match path_obj.canonicalize() {
                    Ok(canonical) => canonical.to_string_lossy().to_string(),
                    Err(_) => {
                        // 如果无法规范化，尝试组合当前目录和路径
                        current_dir.join(path_obj).to_string_lossy().to_string()
                    }
                }
            }
            Err(_) => path.clone(),
        }
    };
    
    // 使用绝对路径创建Path对象，确保所有后续操作都基于绝对路径
    let abs_path_obj = Path::new(&absolute_path);
    
    let is_file_path = is_file.unwrap_or_else(|| abs_path_obj.is_file());
    
    // 计算目标路径
    let target_path = if is_file_path {
        // 情况1：文件 - 打开父目录
        match abs_path_obj.parent() {
            Some(parent) => {
                let parent_str = parent.to_str().unwrap_or(&absolute_path);
                println!("File parent path: {}", parent_str);
                parent_str.to_string()
            },
            None => {
                println!("File has no parent, using absolute path: {}", absolute_path);
                absolute_path.clone()
            },
        }
    } else {
        // 情况2：文件夹
        match is_file {
            Some(false) => {
                // 右键菜单打开文件夹：打开父目录
                match abs_path_obj.parent() {
                    Some(parent) => {
                        let parent_str = parent.to_str().unwrap_or(&absolute_path);
                        println!("Folder parent path (from context menu): {}", parent_str);
                        parent_str.to_string()
                    },
                    None => {
                        println!("Folder has no parent, using absolute path: {}", absolute_path);
                        absolute_path.clone()
                    },
                }
            },
            _ => {
                // 设置面板打开文件夹：直接打开该文件夹
                println!("Opening folder directly: {}", absolute_path);
                absolute_path.clone()
            }
        }
    };
    
    println!("open_path: path={}, target_path={}, is_file={:?}, is_file_path={}", 
             path, target_path, is_file, is_file_path);
    
    println!("Final target_path: {}", target_path);
    
    // 直接使用系统命令打开文件管理器，但不等待命令完成，避免阻塞和闪退问题
    let result = if cfg!(windows) {
        // Windows: 使用explorer命令，确保路径使用正确的反斜杠格式
        // 将正斜杠转换为反斜杠，确保Windows能够正确识别路径
        let win_target_path = target_path.replace("/", "\\");
        println!("Windows command: explorer.exe \"{}\"", win_target_path);
        
        // 使用spawn()而不是status()或output()，这样命令会在后台运行，不会阻塞主线程
        // 同时，使用Command::new("explorer.exe")直接调用，避免使用cmd.exe包装
        Command::new("explorer.exe")
            .arg(win_target_path)
            .spawn()
            .map(|_| ())
    } else if cfg!(target_os = "macos") {
        // macOS: 使用open命令
        println!("macOS command: open \"{}\"", target_path);
        Command::new("open")
            .arg(target_path.clone())
            .spawn()
            .map(|_| ())
    } else {
        // Linux: 使用xdg-open命令
        println!("Linux command: xdg-open \"{}\"", target_path);
        Command::new("xdg-open")
            .arg(target_path.clone())
            .spawn()
            .map(|_| ())
    };
    
    match result {
        Ok(_) => {
            println!("Successfully started file manager for: {}", target_path);
            Ok(())
        },
        Err(e) => {
            let error_msg = format!("Failed to open path '{}': {}", target_path, e);
            println!("{}", error_msg);
            Err(error_msg)
        }
    }
}

#[derive(Clone, Serialize)]
struct BatchResult {
    path: String,
    url: Option<String>,
}

// 1. 提取核心生成逻辑为独立函数 (不作为 command)
fn process_single_thumbnail(file_path: &str, cache_root: &Path) -> Option<String> {
    use std::fs;
    use std::io::{Read, BufWriter, BufReader};
    use image::codecs::jpeg::{JpegEncoder, JpegDecoder};
    use image::ImageFormat;
    
    let image_path = Path::new(file_path);
    if !image_path.exists() || file_path.contains(".Aurora_Cache") {
        return None;
    }

    // 快速 Hash
    let metadata = fs::metadata(image_path).ok()?;
    let size = metadata.len();
    let modified = metadata.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);
    
    let mut file = fs::File::open(image_path).ok()?;
    let mut buffer = [0u8; 4096];
    let bytes_read = file.read(&mut buffer).unwrap_or(0);
    
    let cache_key = format!("{}-{}-{:?}", size, modified, &buffer[..bytes_read]);
    let cache_filename = format!("{:x}", md5::compute(cache_key.as_bytes()))[..24].to_string();
    
    // 先尝试检查两种格式的缓存文件是否存在，避免不必要的图像处理
    let jpg_cache_file_path = cache_root.join(format!("{}.jpg", cache_filename));
    let webp_cache_file_path = cache_root.join(format!("{}.webp", cache_filename));
    
    // 如果任一缓存文件存在，直接返回路径
    if jpg_cache_file_path.exists() {
        return Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string());
    }
    
    if webp_cache_file_path.exists() {
        return Some(webp_cache_file_path.to_str().unwrap_or_default().to_string());
    }
    
    // 缓存未命中，继续生成逻辑
    // 重新打开文件，使用 BufReader 以流式方式读取，避免一次性分配大内存
    let file = fs::File::open(image_path).ok()?;
    let reader = BufReader::new(file);
    
    // 1. 尝试识别格式
    let format = image::guess_format(&buffer[..bytes_read]).unwrap_or(ImageFormat::Png);

    let img = if format == ImageFormat::Jpeg {
        // 【针对 JPEG 的超大图优化】
        // 使用 BufReader 直接作为输入源，配合 scale 解码
        let mut decoder = JpegDecoder::new(reader).ok()?;
        
        // 如果原图非常大，我们可以只加载它的缩略版
        decoder.scale(256, 256).ok()?; 
        
        image::DynamicImage::from_decoder(decoder).ok()?
    } else {
        // 【针对 PNG 及其他格式的优化】
        // 使用流式解码器，避免先将整个文件读入 Vec<u8>
        // 这对于大尺寸 PNG (几十MB) 能节省大量内存带宽
        let mut image_reader = image::io::Reader::new(reader);
        image_reader.set_format(format);
        
        // 限制解码时的内存使用，防止炸弹攻击（可选，这里设为 512MB 足够应对 8K 图）
        image_reader.no_limits(); 
        
        image_reader.decode().ok()?
    };

    // 检查图片是否包含透明像素 (alpha < 255)
    let has_transparency = {
        let rgba = img.to_rgba8();
        let mut found_transparent = false;
        for pixel in rgba.pixels() {
            if pixel[3] < 255 {
                found_transparent = true;
                break;
            }
        }
        found_transparent
    };

    let width = img.width();
    let height = img.height();
    const TARGET_MIN_SIZE: u32 = 256;
    
    let (dst_width, dst_height) = if width < height {
        let ratio = height as f32 / width as f32;
        (TARGET_MIN_SIZE, (TARGET_MIN_SIZE as f32 * ratio) as u32)
    } else {
        let ratio = width as f32 / height as f32;
        ((TARGET_MIN_SIZE as f32 * ratio) as u32, TARGET_MIN_SIZE)
    };

    let src_width = NonZeroU32::new(width)?;
    let src_height = NonZeroU32::new(height)?;
    let dst_width_nz = NonZeroU32::new(dst_width)?;
    let dst_height_nz = NonZeroU32::new(dst_height)?;

    // 根据是否有透明度选择不同的处理方式
    if has_transparency {
        // 有透明度，生成 WebP 格式
        let src_image = fr::Image::from_vec_u8(
            src_width,
            src_height,
            img.to_rgba8().into_raw(),
            fr::PixelType::U8x4,
        ).ok()?;

        let mut dst_image = fr::Image::new(dst_width_nz, dst_height_nz, src_image.pixel_type());
        
        // 使用 Hamming 滤镜 (比 Lanczos3 快，质量也很好)
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut()).ok()?;

        // 确保目录存在
        if !cache_root.exists() {
            let _ = fs::create_dir_all(cache_root);
        }

        let cache_file = fs::File::create(&webp_cache_file_path).ok()?;
        let mut writer = BufWriter::new(cache_file);
        // 使用 image 库的 write_to 方法来处理 WebP 编码
        let resized_img = image::DynamicImage::ImageRgba8(image::ImageBuffer::from_raw(dst_width, dst_height, dst_image.buffer().to_vec())?);
        resized_img.write_to(&mut writer, ImageFormat::WebP).ok()?;

        Some(webp_cache_file_path.to_str().unwrap_or_default().to_string())
    } else {
        // 无透明度，生成 JPEG 格式
        let src_image = fr::Image::from_vec_u8(
            src_width,
            src_height,
            img.to_rgb8().into_raw(),
            fr::PixelType::U8x3,
        ).ok()?;

        let mut dst_image = fr::Image::new(dst_width_nz, dst_height_nz, src_image.pixel_type());
        
        // 使用 Hamming 滤镜 (比 Lanczos3 快，质量也很好)
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut()).ok()?;

        // 确保目录存在
        if !cache_root.exists() {
            let _ = fs::create_dir_all(cache_root);
        }

        let cache_file = fs::File::create(&jpg_cache_file_path).ok()?;
        let mut writer = BufWriter::new(cache_file);
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, 80);
        encoder.encode(dst_image.buffer(), dst_width, dst_height, image::ColorType::Rgb8.into()).ok()?;

        Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string())
    }
}

#[tauri::command]
async fn get_thumbnail(file_path: String, cache_root: String) -> Result<Option<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&cache_root);
        if !root.exists() {
             let _ = fs::create_dir_all(root);
        }
        process_single_thumbnail(&file_path, root)
    }).await;
    
    match result {
        Ok(val) => Ok(val),
        Err(e) => Err(e.to_string())
    }
}

#[derive(Clone, Serialize)]
struct ThumbnailBatchResult {
    path: String,
    url: Option<String>,
    colors: Option<Vec<color_extractor::ColorResult>>,
    from_cache: bool,
}

#[tauri::command]
async fn get_thumbnails_batch(
    file_paths: Vec<String>,
    cache_root: String,
    on_event: tauri::ipc::Channel<ThumbnailBatchResult>,
    _app: tauri::AppHandle
) -> Result<(), String> {
    // 放入 blocking 线程处理缩略图读取
    let file_paths_clone2 = file_paths;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&cache_root);
        if !root.exists() {
             let _ = fs::create_dir_all(root);
        }

        // 使用 Rayon 并行处理！
        file_paths_clone2.par_iter().for_each(|path| {
            // 快速检查缓存是否存在，跳过复杂的缩略图生成逻辑
            use std::fs;
            use std::io::{Read};
            
            let image_path = Path::new(path);
            if !image_path.exists() || path.contains(".Aurora_Cache") {
                let _ = on_event.send(ThumbnailBatchResult {
                    path: path.clone(),
                    url: None,
                    colors: None,
                    from_cache: false,
                });
                return;
            }

            // 快速 Hash - 复用 process_single_thumbnail 中的缓存逻辑
            let metadata = match fs::metadata(image_path) {
                Ok(m) => m,
                Err(_) => {
                    let _ = on_event.send(ThumbnailBatchResult {
                        path: path.clone(),
                        url: None,
                        colors: None,
                        from_cache: false,
                    });
                    return;
                }
            };
            let size = metadata.len();
            let modified = metadata.modified()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                .unwrap_or(0);
            
            let mut file = match fs::File::open(image_path) {
                Ok(f) => f,
                Err(_) => {
                    let _ = on_event.send(ThumbnailBatchResult {
                        path: path.clone(),
                        url: None,
                        colors: None,
                        from_cache: false,
                    });
                    return;
                }
            };
            let mut buffer = [0u8; 4096];
            let bytes_read = file.read(&mut buffer).unwrap_or(0);
            
            let cache_key = format!("{}-{}-{:?}", size, modified, &buffer[..bytes_read]);
            let cache_filename = format!("{:x}", md5::compute(cache_key.as_bytes()))[..24].to_string();
            
            // 先尝试检查两种格式的缓存文件是否存在，避免不必要的图像处理
            let jpg_cache_file_path = root.join(format!("{}.jpg", cache_filename));
            let webp_cache_file_path = root.join(format!("{}.webp", cache_filename));
            
            // 如果任一缓存文件存在，直接返回路径，跳过不必要的处理
            if jpg_cache_file_path.exists() {
                let url = Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string());
                let _ = on_event.send(ThumbnailBatchResult {
                    path: path.clone(),
                    url,
                    colors: None, // 跳过颜色提取，提高响应速度
                    from_cache: true,
                });
                return;
            }
            
            if webp_cache_file_path.exists() {
                let url = Some(webp_cache_file_path.to_str().unwrap_or_default().to_string());
                let _ = on_event.send(ThumbnailBatchResult {
                    path: path.clone(),
                    url,
                    colors: None, // 跳过颜色提取，提高响应速度
                    from_cache: true,
                });
                return;
            }
            
            // 缓存未命中，才执行完整的缩略图生成逻辑
            let url = process_single_thumbnail(path, root);
            
            // 立即发送结果回前端，跳过颜色提取
            let _ = on_event.send(ThumbnailBatchResult {
                path: path.clone(),
                url,
                colors: None, // 跳过颜色提取，提高响应速度
                from_cache: false,
            });
        });
        
        Ok(())
    }).await;

    match result {
        Ok(val) => val,
        Err(e) => Err(e.to_string())
    }
}

/// 生成拖拽预览图（用于外部拖拽时显示）
/// 将多个缩略图组合成一个堆叠效果的预览图
#[tauri::command]
async fn generate_drag_preview(
    thumbnail_paths: Vec<String>,
    total_count: usize,
    cache_root: String,
) -> Result<Option<String>, String> {
    use std::io::BufWriter;
    use image::{ImageBuffer, Rgba, RgbaImage, ImageEncoder};
    use image::imageops::{overlay, resize, FilterType};
    
    let result = tauri::async_runtime::spawn_blocking(move || -> Option<String> {
        // 预览图尺寸
        const PREVIEW_SIZE: u32 = 128;
        const THUMB_SIZE: u32 = 100;
        const BORDER_WIDTH: u32 = 2;
        
        // 创建透明背景
        let mut canvas: RgbaImage = ImageBuffer::from_pixel(
            PREVIEW_SIZE, 
            PREVIEW_SIZE, 
            Rgba([0, 0, 0, 0])
        );
        
        // 最多显示3个缩略图
        let preview_count = thumbnail_paths.len().min(3);
        
        // 加载并绘制每个缩略图（从后往前绘制，最后一个在最上面）
        for (i, thumb_path) in thumbnail_paths.iter().take(preview_count).enumerate().rev() {
            let thumb_path = Path::new(thumb_path);
            if !thumb_path.exists() {
                continue;
            }
            
            // 加载缩略图
            let img = match image::open(thumb_path) {
                Ok(img) => img,
                Err(_) => continue,
            };
            
            // 调整大小
            let thumb = resize(&img, THUMB_SIZE - BORDER_WIDTH * 2, THUMB_SIZE - BORDER_WIDTH * 2, FilterType::Triangle);
            
            // 创建带白色边框的缩略图
            let mut bordered: RgbaImage = ImageBuffer::from_pixel(
                THUMB_SIZE,
                THUMB_SIZE,
                Rgba([255, 255, 255, 230]) // 白色边框，略微透明
            );
            
            // 将缩略图放在边框中央
            overlay(&mut bordered, &thumb, BORDER_WIDTH as i64, BORDER_WIDTH as i64);
            
            // 计算位置偏移（堆叠效果）
            let offset_x = match i {
                0 => (PREVIEW_SIZE - THUMB_SIZE) / 2,
                1 => (PREVIEW_SIZE - THUMB_SIZE) / 2 - 8,
                _ => (PREVIEW_SIZE - THUMB_SIZE) / 2 + 8,
            };
            let offset_y = (PREVIEW_SIZE - THUMB_SIZE) / 2 + (i as u32) * 6;
            
            // 绘制到画布
            overlay(&mut canvas, &bordered, offset_x as i64, offset_y as i64);
        }
        
        // 如果有多个文件，添加计数徽章（总是显示，即使只有1个文件也显示）
        if total_count > 1 {
            // 绘制蓝色圆形徽章
            let badge_size = 28u32;
            let badge_x = PREVIEW_SIZE - badge_size - 4;
            let badge_y = PREVIEW_SIZE - badge_size - 4;
            
            // 绘制圆形背景
            for y in 0..badge_size {
                for x in 0..badge_size {
                    let dx = x as f32 - badge_size as f32 / 2.0;
                    let dy = y as f32 - badge_size as f32 / 2.0;
                    let dist = (dx * dx + dy * dy).sqrt();
                    if dist <= badge_size as f32 / 2.0 {
                        let px = badge_x + x;
                        let py = badge_y + y;
                        if px < PREVIEW_SIZE && py < PREVIEW_SIZE {
                            canvas.put_pixel(px, py, Rgba([37, 99, 235, 255])); // 蓝色
                        }
                    }
                }
            }
            
            // 绘制数字
            let count_text = total_count.to_string();
            // 使用简单的位图字体绘制数字
            // 数字 0-9 的 5x7 位图
            let digit_bitmaps: [[[u8; 5]; 7]; 10] = [
                // 0
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 1
                [[0,0,1,0,0], [0,1,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,1,1,1,0]],
                // 2
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1]],
                // 3
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
                // 4
                [[1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1]],
                // 5
                [[1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
                // 6
                [[1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 7
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1]],
                // 8
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 9
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
            ];
            
            let digit_width = 5u32;
            let digit_height = 7u32;
            let spacing = 1u32;
            let total_text_width = (digit_width + spacing) * count_text.len() as u32 - spacing;
            let text_start_x = badge_x + (badge_size - total_text_width) / 2;
            let text_start_y = badge_y + (badge_size - digit_height) / 2;
            
            // 绘制每个数字
            for (char_idx, ch) in count_text.chars().enumerate() {
                if let Some(digit) = ch.to_digit(10) {
                    let digit_bitmap = &digit_bitmaps[digit as usize];
                    let digit_x = text_start_x + (digit_width + spacing) * char_idx as u32;
                    
                    for (row_idx, row) in digit_bitmap.iter().enumerate() {
                        for (col_idx, &pixel) in row.iter().enumerate() {
                            if pixel == 1 {
                                let px = digit_x + col_idx as u32;
                                let py = text_start_y + row_idx as u32;
                                if px < PREVIEW_SIZE && py < PREVIEW_SIZE {
                                    canvas.put_pixel(px, py, Rgba([255, 255, 255, 255])); // 白色
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // 保存预览图到缓存目录
        let cache_path = Path::new(&cache_root);
        if !cache_path.exists() {
            let _ = fs::create_dir_all(cache_path);
        }
        
        let preview_file = cache_path.join("_drag_preview.png");
        
        let file = match fs::File::create(&preview_file) {
            Ok(f) => f,
            Err(_) => return None,
        };
        let writer = BufWriter::new(file);
        
        let encoder = image::codecs::png::PngEncoder::new(writer);
        match encoder.write_image(
            canvas.as_raw(),
            PREVIEW_SIZE,
            PREVIEW_SIZE,
            image::ColorType::Rgba8,
        ) {
            Ok(_) => Some(preview_file.to_str().unwrap_or_default().to_string()),
            Err(_) => None,
        }
    }).await;
    
    match result {
        Ok(val) => Ok(val),
        Err(e) => Err(e.to_string())
    }
}

#[tauri::command]
async fn read_file_as_base64(file_path: String) -> Result<Option<String>, String> {
    use std::fs;
    
    // Check if file exists
    if !Path::new(&file_path).exists() {
        return Ok(None);
    }
    
    // Read file as bytes
    let file_bytes = fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    // Detect image format from file extension
    let extension = Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    
    // Determine MIME type based on extension
    let mime_type = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        _ => "image/jpeg", // Default to JPEG
    };
    
    // Encode to base64
    let base64_str = general_purpose::STANDARD.encode(&file_bytes);
    Ok(Some(format!("data:{};base64,{}", mime_type, base64_str)))
}

// 窗口控制命令
#[tauri::command]
async fn hide_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    save_window_state(&app_handle);
    let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
async fn show_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
async fn exit_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    save_window_state(&app_handle);
    app_handle.exit(0);
    Ok(())
}

// 手动执行WAL检查点
#[tauri::command]
async fn force_wal_checkpoint(app: tauri::AppHandle) -> Result<bool, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    // 在单独线程中执行WAL检查点
    let result = tokio::task::spawn_blocking(move || {
        pool.force_wal_checkpoint()
    }).await.map_err(|e| format!("Failed to execute WAL checkpoint: {}", e))?;
    
    result.map_err(|e| format!("WAL checkpoint error: {}", e))?;
    Ok(true)
}

// 获取WAL文件信息
#[tauri::command]
async fn get_wal_info(app: tauri::AppHandle) -> Result<(i64, i64), String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    // 在单独线程中获取WAL信息
    let result = tokio::task::spawn_blocking(move || {
        pool.get_wal_info()
    }).await.map_err(|e| format!("Failed to get WAL info: {}", e))?;
    
    result
}



#[tauri::command]
async fn get_dominant_colors(
    file_path: String, 
    count: usize, 
    thumbnail_path: Option<String>,
    app: tauri::AppHandle
) -> Result<Vec<color_extractor::ColorResult>, String> {
    use std::fs::File;
    use std::io::BufReader;
    use std::sync::Arc;
    
    // 1. 尝试从数据库获取颜色数据
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    let file_path_clone = file_path.clone();
    
    // 在单独线程中执行数据库操作
    let db_result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        color_db::get_colors_by_file_path(&mut conn, &file_path_clone)
    }).await.map_err(|e| format!("Failed to execute database query: {}", e))?;
    
    if let Ok(Some(colors)) = db_result {
        if !colors.is_empty() {
            return Ok(colors);
        }
    }
    
    // 2. 数据库中没有数据，提取颜色
    // 优先使用缩略图路径，如果提供了的话
    let image_path = if let Some(thumb_path) = &thumbnail_path {
        if Path::new(thumb_path).exists() {
            thumb_path.clone()
        } else {
            file_path.clone()
        }
    } else {
        file_path.clone()
    };
    
    // Check if file exists
    if !Path::new(&image_path).exists() {
        return Err(format!("File does not exist: {}", image_path));
    }
    
    // Load image (from thumbnail if available, otherwise from original)
    let file = File::open(&image_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    
    let reader = BufReader::new(file);
    let img = image::load(reader, image::ImageFormat::from_path(&image_path).unwrap_or(image::ImageFormat::Jpeg))
        .map_err(|e| format!("Failed to load image: {}", e))?;
    
    // Extract dominant colors
    let colors = color_extractor::get_dominant_colors(&img, count);
    
    // 3. 将提取的颜色保存到数据库
    if !colors.is_empty() {
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let file_path_clone = file_path.clone();
        let colors_clone = colors.clone();
        
        // 在单独线程中执行数据库操作
        let _ = tokio::task::spawn_blocking(move || {
            {
                let mut conn = pool.get_connection();
                // 先检查是否存在记录
                match color_db::get_colors_by_file_path(&mut conn, &file_path_clone) {
                    Ok(None) => {
                        // 不存在记录，插入待处理状态
                        let _ = color_db::add_pending_files(&mut conn, &[file_path_clone.clone()]);
                    },
                    _ => {}
                }
            } // Drop lock
            
            // 保存颜色数据
            pool.save_colors(&file_path_clone, &colors_clone)
        }).await;
    }
    
    Ok(colors)
}

#[tauri::command]
fn db_get_all_people(pool: tauri::State<AppDbPool>) -> Result<Vec<db::persons::Person>, String> {
    let conn = pool.get_connection();
    db::persons::get_all_people(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_upsert_person(pool: tauri::State<AppDbPool>, person: db::persons::Person) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::upsert_person(&conn, &person).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_delete_person(pool: tauri::State<AppDbPool>, id: String) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::delete_person(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_update_person_avatar(
    pool: tauri::State<AppDbPool>, 
    person_id: String, 
    cover_file_id: String, 
    face_box: Option<db::persons::FaceBox>
) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::update_person_avatar(&conn, &person_id, &cover_file_id, face_box.as_ref()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn db_upsert_file_metadata(
    pool: tauri::State<'_, AppDbPool>, 
    metadata: db::file_metadata::FileMetadata
) -> Result<(), String> {
    let conn = pool.get_connection();
    db::file_metadata::upsert_file_metadata(&conn, &metadata).map_err(|e| e.to_string())
}

fn main() {
    
    tauri::Builder::default()
        // 清理调试阶段的 setup 注入，恢复默认构建
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            search_by_palette,
            search_by_color,
            scan_directory,
            save_user_data,
            load_user_data,
            get_default_paths,
            get_thumbnail,
            get_thumbnails_batch,
            generate_drag_preview,
            read_file_as_base64,
            ensure_directory,
            file_exists,
            open_path,
            create_folder,
            rename_file,
            delete_file,
            copy_file,
            move_file,
            write_file_from_bytes,
            scan_file,
            hide_window,
            show_window,
            exit_app,
            get_dominant_colors,
            search_by_color,
            search_by_palette,
            color_worker::pause_color_extraction,
            color_worker::resume_color_extraction,
            force_wal_checkpoint,
            get_wal_info,
            db_get_all_people,
            db_upsert_person,
            db_delete_person,
            db_update_person_avatar,
            db_upsert_file_metadata
        ])
        .setup(|app| {
            // 创建托盘菜单
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            
            // 获取应用句柄用于事件处理
            let app_handle = app.handle().clone();
            
            // 创建托盘图标
            let tray = TrayIconBuilder::new()
                .tooltip("Aurora Gallery")
                .icon(app.default_window_icon().expect("No default window icon").clone())
                .menu(&menu)
                .show_menu_on_left_click(false) // 禁用左键点击显示菜单，只有右键才显示
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
                    // 处理托盘图标的鼠标事件
                    match event {
                        TrayIconEvent::DoubleClick { .. } => {
                            // 双击显示窗口
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {
                            // 单击不触发任何操作
                        }
                    }
                })
                .build(app)?;
            
            // 保存托盘图标到应用状态
            app.manage(Some(tray));
            
            // 初始化颜色数据库
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to get app data directory");
            let db_path = app_data_dir.join("colors.db");
            
            let pool = match color_db::ColorDbPool::new(&db_path) {
        Ok(pool_instance) => {
            // 初始化数据库表结构
            {
                let mut conn = pool_instance.get_connection();
                if let Err(e) = color_db::init_db(&mut conn) {
                    eprintln!("Failed to initialize color database: {}", e);
                }
                
                // 清理卡在"processing"状态的文件
                if let Err(e) = color_db::reset_processing_to_pending(&mut conn) {
                    eprintln!("Failed to reset processing files to pending: {}", e);
                }
            }
            // 刷新缓存（加载所有已完成的颜色到内存）
            if let Err(e) = pool_instance.refresh_cache() {
                eprintln!("Failed to refresh color cache: {}", e);
            }

            // 记录初始化后的数据库文件大小
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
            
            // 将数据库连接池保存到应用状态
            let pool_arc = Arc::new(pool);
            app.manage(pool_arc.clone());

            // 初始化应用通用数据库 (Metadata/Persons)
            let app_db_path = app_data_dir.join("metadata.db");
            let app_db_pool = match AppDbPool::new(&app_db_path) {
                Ok(pool) => {
                    // Limit the scope of the connection guard so it is dropped
                    // before we move the pool out of this match arm.
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
            
            // 启动后台颜色提取任务
            // 持续处理待处理文件，每批最多处理50个文件
            let batch_size = 50;
            // 正确克隆AppHandle后再包装到Arc中
            let app_handle_new = app.handle().clone();
            let app_handle_arc = Arc::new(app_handle_new);
            
            tauri::async_runtime::spawn(async move {
                color_worker::color_extraction_worker(
                    pool_arc,
                    batch_size,
                    Some(app_handle_arc)
                ).await;
            });
            
            // 恢复窗口位置和大小
            if let Some(window) = app.get_webview_window("main") {
                let app_handle_for_state = app.handle();
                let path = get_window_state_path(app_handle_for_state);
                if path.exists() {
                    if let Ok(json) = fs::read_to_string(&path) {
                        if let Ok(state) = serde_json::from_str::<SavedWindowState>(&json) {
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: state.width, height: state.height }));
                            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: state.x, y: state.y }));
                            if state.maximized {
                                let _ = window.maximize();
                            }
                        }
                    }
                }
                let _ = window.show();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 保存窗口状态
                save_window_state(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}