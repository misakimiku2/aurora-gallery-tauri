// Moved from main.rs — color search helpers and commands
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use rayon::prelude::*;
use palette::{FromColor, Srgb, Lab};
use palette::color_difference::Ciede2000;
use tauri;
use crate::color_db;
use rusqlite::params;

// Helper: Hex string to Lab color
pub fn hex_to_lab(hex: &str) -> Option<Lab> {
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
pub async fn search_by_palette(
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

    // If cache hasn't been initialized yet, prefer a DB-indexed fast-path to avoid blocking a full refresh.
    if !pool.is_cache_initialized() {
        eprintln!("[search_by_palette] cache cold — running DB-index fast-path and starting background preheat");
        let _ = pool.ensure_cache_initialized_async();

        let conn = pool.get_connection();
        let mut candidate_set = std::collections::HashSet::new();

        for target in &target_labs {
            let delta = 20.0f32;
            if let Ok(mut stmt) = conn.prepare("SELECT DISTINCT file_path FROM image_color_indices WHERE l BETWEEN ? AND ? AND a BETWEEN ? AND ? AND b BETWEEN ? AND ? LIMIT 1000") {
                if let Ok(rows) = stmt.query_map(rusqlite::params![target.l - delta, target.l + delta, target.a - delta, target.a + delta, target.b - delta, target.b + delta], |r| r.get::<_, String>(0)) {
                    for r in rows { if let Ok(p) = r { candidate_set.insert(p); } }
                }
            }
        }

        eprintln!("[search_by_palette] DB fast-path candidates={}", candidate_set.len());

        let mut scored: Vec<(String, f32)> = Vec::new();
        for path in candidate_set.into_iter().take(500) {
            if let Ok(Some(colors)) = {
                let mut conn2 = pool.get_connection();
                color_db::get_colors_by_file_path(&mut conn2, &path)
            } {
                let candidate_labs: Vec<Lab> = colors.iter().filter_map(|c| hex_to_lab(&c.hex)).collect();
                if candidate_labs.is_empty() { continue; }

                if is_single_color {
                    let target = &target_labs[0];
                    let position_weights = [1.0f32, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08];
                    let mut best = 0.0f32;
                    for (idx, candidate) in candidate_labs.iter().enumerate() {
                        let dist = candidate.difference(*target);
                        let sim = if dist < 5.0 { 100.0 } else if dist < 10.0 { 100.0 - (dist - 5.0) * 4.0 } else if dist < 20.0 { 80.0 - (dist - 10.0) * 3.0 } else if dist < 30.0 { 50.0 - (dist - 20.0) * 2.0 } else { (30.0 - (dist - 30.0).min(30.0)).max(0.0) };
                        let w = if idx < position_weights.len() { position_weights[idx] } else { 0.05 };
                        best = best.max(sim * w);
                    }
                    if best >= 60.0 { scored.push((path.clone(), best)); }
                } else {
                    let mut total = 0.0f32; let mut cnt = 0u32;
                    for t in target_labs.iter().take(5) { let md = candidate_labs.iter().map(|c| c.difference(*t)).fold(f32::INFINITY, |a, b| a.min(b)); total += md; cnt += 1; }
                    if cnt == 0 { continue; }
                    let avg = total / cnt as f32;
                    let score = if avg < 5.0 { 100.0 } else if avg < 10.0 { 90.0 } else if avg < 20.0 { 70.0 } else if avg < 30.0 { 50.0 } else { 20.0 };
                    if (is_atmosphere_search && score >= 85.0) || (!is_atmosphere_search && score >= 70.0) { scored.push((path.clone(), score)); }
                }
            }
        }

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(500);
        let final_results = scored.into_iter().map(|(p, _)| p).collect::<Vec<String>>();
        eprintln!("[search_by_palette] Returning {} results (DB fast-path)", final_results.len());
        return Ok(final_results);
    }

    // Offload compute-intensive task to blocking threadpool
    // Try cached full-scan first; if cache is not ready, fall back to a DB-indexed fast-path
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
                         // (omitted inner helpers retained)
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
    let final_results: Vec<String> = results.iter().map(|(path, _)| path.clone()).collect();
    eprintln!("[search_by_palette] Returning {} results", final_results.len());
    
    Ok(final_results)
}

#[tauri::command]
pub async fn search_by_color(
     pool_state: tauri::State<'_, Arc<color_db::ColorDbPool>>,
     color: String
) -> Result<Vec<String>, String> {
    search_by_palette(pool_state, vec![color]).await
}
