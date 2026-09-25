//! M6b 阶段 1：AI 编排纯函数层 + provider 客户端（桌面 TS 逻辑逐行移植）。
//!
//! 移植源（逐字对齐，含怪癖）：
//! - `src/hooks/useAIAnalysis.ts`：分析 prompt 组装 / parseJSON 容错 / 三 provider 请求形状 / aiData 写库载荷；
//! - `src/services/aiService.ts`：checkConnection / 中文重命名 prompt 与响应清理 / 三对 call* / fetchModels；
//! - `src/hooks/useSearch.ts` + `src/hooks/useFileSearch.ts`：AI 搜索改写与 AiSearchFilter 的结果集应用。
//!
//! 明示不复制的桌面 quirk：LMStudio「探测后自动改写用户 model 设置」（useAIAnalysis.ts:448-475）——
//! 该行为含 setState/toast 副作用，core 侧改为 lmstudio model 为空时直接报错。
//!
//! 对桌面差异登记：桌面端 fetch/proxyHttpRequest 无显式超时；移动网络给上限
//! （chat 300s、check/fetch 15s），避免弱网下永久挂起。

use serde_json::Value;

// ==================== uniffi 面（主线程 FFI 导出要用） ====================

/// AI 服务商（对齐 `src/types.ts` 的 `AIProvider`）。
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiProvider {
    OpenAi,
    Ollama,
    LmStudio,
}

/// AI 配置（对齐 `src/types.ts:245-272` 的 `AIConfig`，端点/模型拍平成单字段）。
///
/// `language` = 全局界面语言（"zh" / 其他），同时决定：
/// - 分析 prompt 的中英文变体（桌面 `settings.language === 'zh'` 的 isChinese 分支）；
/// - 翻译目标语言（D38：不用 ai.targetLanguage，桌面 transTarget 同样取全局 language）。
#[derive(uniffi::Record, Clone, Debug)]
pub struct AiConfig {
    pub provider: AiProvider,
    pub openai_endpoint: String,
    pub openai_api_key: String,
    pub openai_model: String,
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub lmstudio_endpoint: String,
    pub lmstudio_model: String,
    /// 桌面 `systemPrompt`：openai/lmstudio 走 system role 消息；ollama /api/generate 走 body.system
    /// 字段、/api/chat 走 system role 消息（详见 [`AiClient::chat`]）。
    pub system_prompt: Option<String>,
    pub auto_tag: bool,
    pub auto_description: bool,
    pub enhance_person_description: bool,
    pub enable_ocr: bool,
    pub enable_translation: bool,
    /// 翻译目标语言 = 全局 language（D38）。
    pub language: String,
}

/// AI 搜索改写结果（对齐 `src/types.ts` 的 `AiSearchFilter`，不含 filePaths——
/// CLIP/取色搜索的路径直通分支由主线程自行处理）。
#[derive(uniffi::Record, Clone, Debug)]
pub struct AiSearchFilter {
    pub keywords: Vec<String>,
    pub colors: Vec<String>,
    pub people: Vec<String>,
    pub description: Option<String>,
    pub original_query: String,
}

/// 搜索匹配用的最小文件画像（FFI 面裁剪版）。
///
/// 注意：桌面 `useFileSearch.ts` 的 aiFilter 匹配还用到 `meta.palette` /
/// `aiData.dominantColors`（colors 条件）与 `aiData.faces[].name`（people 条件），
/// 本 DTO 未携带这两类数据（见 `apply_search_filter` 注释与报告）。
#[derive(uniffi::Record, Clone, Debug)]
pub struct SearchItem {
    pub file_id: String,
    pub name: String,
    pub tags: Vec<String>,
    pub description: Option<String>,
}

/// chat() 的场景变体。
///
/// TS 三个场景的请求形状并不一致（这是源码事实，不是抽象过度）：
/// - Analysis/Search：ollama 走 `/api/generate`（`format:"json"` 可选、`images` 数组、`system` 字段）；
///   lmstudio body 带 `stream:false`；openai/lmstudio 无 temperature。
/// - Rename：ollama 走 `/api/chat`（手工转 messages、**无** `format:"json"`）；openai/lmstudio
///   body 带 `temperature:0.7` 且模型名有兜底（`gpt-4o` / `local-model`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiChatKind {
    Analysis,
    Search,
    Rename,
}

/// parse_ai_json 的稳定产物。
///
/// 字段缺失/类型不对一律稳住：字符串字段取不到 → None；tags/objects 非 array → 空 vec
/// （对齐任务约定「tags 非 array→空」，比 TS 的「非 array 原样透传」更稳，TS 侧是潜在 bug）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AiParsed {
    pub description: Option<String>,
    pub extracted_text: Option<String>,
    pub translated_text: Option<String>,
    pub tags: Vec<String>,
    pub scene_category: Option<String>,
    pub objects: Vec<String>,
}

// ==================== 纯函数：分析 prompt / JSON 容错 / aiData 载荷 ====================

/// 组装图片分析 prompt（逐字对齐 useAIAnalysis.ts:304-323）。
///
/// 开关→行：autoDescription/enableOCR/enableTranslation/autoTag 各条件追加一行，
/// sceneCategory/objects 无条件追加；最终套固定英文框架。
pub fn build_analysis_prompt(cfg: &AiConfig) -> String {
    // 桌面：settings.language === 'zh' 决定 prompt 中英变体与翻译目标（targetLanguage 同源）
    let is_chinese = cfg.language == "zh";
    let target_language = if is_chinese { "Simplified Chinese" } else { "English" };

    let mut fields: Vec<String> = Vec::new();
    if cfg.auto_description {
        fields.push(if is_chinese {
            if cfg.enhance_person_description {
                "- description: string (请描述这张图里的内容。着重描述图片里的人物行为、体型，如果识别出具体人物请提及姓名。)".to_string()
            } else {
                "- description: string (请描述这张图里的内容。如果识别出具体人物请提及姓名。)".to_string()
            }
        } else if cfg.enhance_person_description {
            "- description: string (Please describe the content of this image. Emphasize describing people's actions, body types, and mention their names if identified.)".to_string()
        } else {
            "- description: string (Please describe the content of this image. Mention people's names if identified.)".to_string()
        });
    }
    if cfg.enable_ocr {
        fields.push(if is_chinese {
            "- extractedText: string (提取图片中的文字。)".to_string()
        } else {
            "- extractedText: string (Extract text from the image.)".to_string()
        });
    }
    if cfg.enable_translation {
        fields.push(if is_chinese {
            format!("- translatedText: string (把图片中的文字翻译成{}。)", target_language)
        } else {
            format!("- translatedText: string (Translate text from the image to {}.)", target_language)
        });
    }
    if cfg.auto_tag {
        fields.push(format!("- tags: string[] (relevant keywords in {})", target_language));
    }
    // sceneCategory / objects：无条件（useAIAnalysis.ts:317-318）
    fields.push(format!(
        "- sceneCategory: string (e.g. landscape, portrait, indoor, etc in {})",
        target_language
    ));
    fields.push(format!(
        "- objects: string[] (list of visible objects in {})",
        target_language
    ));

    // 固定框架（逐字）：模板第 3 行是 6 个空格，别"优化"掉
    format!(
        "Analyze this image. Return a VALID JSON object (no markdown, no extra text) with these fields:\n      {}\n      \n      Respond STRICTLY in JSON.",
        fields.join("\n      ")
    )
}

/// 容错解析 AI 返回文本（逐字对齐 useAIAnalysis.ts:358-384 的 parseJSON）：
/// 1. 剥 ```json 代码块（正则 `/```(?:json)?\s*([\s\S]*?)\s*```/` 取第一段，仅识别小写 json 标签）；
/// 2. 非重叠扫描所有「最内层花括号段」（正则 `/\{[\s\S]*?\}/g`：从每个 `{` 到最近的 `}`）；
/// 3. **从最后一个候选往前试 parse**（模型常先输出思考再输出结果）；
/// 4. 全失败再对剥块后的文本整体 parse；
/// 5. 仍失败 → None。
pub fn parse_ai_json(text: &str) -> Option<AiParsed> {
    let target_text = extract_code_block(text);
    let candidates = brace_candidates(target_text);
    for cand in candidates.iter().rev() {
        if let Ok(value) = serde_json::from_str::<Value>(cand) {
            return Some(ai_parsed_from(&value));
        }
    }
    // 兜底：整体 parse（嵌套 JSON 的候选段必然残缺，靠这里救回）
    serde_json::from_str::<Value>(target_text)
        .ok()
        .map(|value| ai_parsed_from(&value))
}

/// 对齐正则 `/```(?:json)?\s*([\s\S]*?)\s*```/`：取第一个闭合代码块的内容；
/// 无闭合代码块 → 原文。非 "json" 语言标签不被剥（内容里带着，同正则行为）。
fn extract_code_block(text: &str) -> &str {
    if let Some(fence) = text.find("```") {
        let after_fence = &text[fence + 3..];
        let after_tag = after_fence.strip_prefix("json").unwrap_or(after_fence);
        let content_start = after_tag.len() - after_tag.trim_start().len();
        let content = &after_tag[content_start..];
        if let Some(end) = content.find("```") {
            return content[..end].trim_end();
        }
    }
    text
}

/// 非重叠扫描「从每个 `{` 到最近 `}`」的候选段（对齐 `/\{[\s\S]*?\}/g` 的 matchAll 语义）。
fn brace_candidates(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(rel) = text[i + 1..].find('}') {
                let end = i + 1 + rel; // '}' 的下标
                out.push(&text[i..=end]);
                i = end + 1;
                continue;
            } else {
                break;
            }
        }
        i += 1;
    }
    out
}

/// 从解析出的 JSON 对象提取 AiParsed（字段缺失/类型不对要稳）。
fn ai_parsed_from(value: &Value) -> AiParsed {
    AiParsed {
        description: string_field(value, "description"),
        extracted_text: string_field(value, "extractedText"),
        translated_text: string_field(value, "translatedText"),
        tags: string_array_field(value, "tags"),
        scene_category: string_field(value, "sceneCategory"),
        objects: string_array_field(value, "objects"),
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    match value.get(key) {
        Some(Value::Array(items)) => {
            items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
        }
        _ => Vec::new(),
    }
}

/// 构造写库 aiData JSON（逐字对齐 useAIAnalysis.ts:503-516 的 baseAiData + faces）。
///
/// 确切形状（键序无关，serde_json 默认按键排序）：
/// ```json
/// {
///   "analyzed": true,
///   "analyzedAt": "2026-09-25T12:34:56.789Z",
///   "description": "…",        // 开关关 → ""（TS: autoDescription ? (result.description || '') : ''）
///   "tags": ["…"],             // 开关关或非 array → []
///   "sceneCategory": "…",      // 缺失 → "General"
///   "confidence": 0.95,        // 硬编码
///   "dominantColors": [],      // 恒空
///   "objects": ["…"],          // 非 array → []
///   "extractedText": "…",      // 仅 enableOCR 开且有值时出现；否则缺键（undefined 序列化即消失）
///   "translatedText": "…",     // 仅 enableTranslation 开且有值时出现；否则缺键
///   "faces": []                // 恒空
/// }
/// ```
/// 约定：autoTag/autoDescription/enableOCR/enableTranslation 四个开关由**调用方**在构造
/// [`AiParsed`] 时执行（关 → 对应字段置 None/空 vec），本函数只反映传入内容——签名按任务
/// 规定不带 cfg。
pub fn build_ai_data_json(parsed: &AiParsed) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("analyzed".into(), Value::Bool(true));
    // 对齐 TS new Date().toISOString() 的毫秒精度 + Z 后缀
    obj.insert(
        "analyzedAt".into(),
        Value::String(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    obj.insert(
        "description".into(),
        Value::String(parsed.description.clone().unwrap_or_default()),
    );
    obj.insert("tags".into(), serde_json::json!(parsed.tags));
    obj.insert(
        "sceneCategory".into(),
        Value::String(parsed.scene_category.clone().unwrap_or_else(|| "General".into())),
    );
    obj.insert("confidence".into(), serde_json::json!(0.95));
    obj.insert("dominantColors".into(), serde_json::json!([]));
    obj.insert("objects".into(), serde_json::json!(parsed.objects));
    // TS 里 enableOCR/enableTranslation 关（或结果缺字段）时是 undefined → JSON 缺键
    if let Some(t) = &parsed.extracted_text {
        obj.insert("extractedText".into(), Value::String(t.clone()));
    }
    if let Some(t) = &parsed.translated_text {
        obj.insert("translatedText".into(), Value::String(t.clone()));
    }
    obj.insert("faces".into(), serde_json::json!([]));
    Value::Object(obj)
}

// ==================== 纯函数：MIME 猜测 ====================

/// 按扩展名猜 MIME（逐字对齐 `src-tauri/src/system_commands.rs` read_file_as_base64 的映射；
/// `core/src/file_types.rs` 无现成映射可复用）。未知扩展名/无扩展名 → "image/jpeg"。
pub fn guess_mime(file_name: &str) -> String {
    let ext = std::path::Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        _ => "image/jpeg",
    };
    mime.to_string()
}

// ==================== 纯函数：中文重命名 ====================

/// 构造重命名 prompt（逐字对齐 aiService.ts:61-80，中文原文）。
///
/// - 扩展名在 prompt 里剥掉（调用方拿到 clean_rename_response 结果后再补回原扩展名）；
/// - personNames 非空时追加第 6 条要求，顿号连接，示例用第一个人名。
pub fn build_rename_prompt(original_name: &str, person_names: &[String]) -> String {
    let name_without_ext = strip_extension(original_name);
    let person_info_prompt = if !person_names.is_empty() {
        format!(
            "\n6. 图片中包含以下人物：{}，请在文件名中优先使用人物名称（如\"{}的...\"）",
            person_names.join("、"),
            person_names[0]
        )
    } else {
        String::new()
    };

    format!(
        "请根据这张图片的内容，直接输出一个简洁、描述性的中文文件名。不要思考，不要解释，直接输出文件名。\n\n要求：\n1. 文件名应该准确描述图片的主要内容\n2. 使用中文，简洁明了（10-20字）\n3. 不要包含特殊字符，只使用中文、英文、数字、空格和下划线\n4. 直接输出文件名，不要有任何解释、思考过程或额外文字\n5. 原文件名是：\"{}\"{}\n\n请只返回新的文件名（不包含扩展名）：",
        name_without_ext, person_info_prompt
    )
}

/// 对齐正则 `/\.[^.]+$/` 的 replace（aiService.ts:62-63）：剥最后一个「点 + 非点串」。
fn strip_extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(pos) if pos + 1 < name.len() => &name[..pos],
        _ => name,
    }
}

/// 清理重命名响应（逐字对齐 aiService.ts:126-167 的四步 + 空判定）。
/// 返回**不含扩展名**的纯文件名；清完为空 → None（调用方回退原名，原扩展名由调用方补回）。
///
/// 步骤（顺序敏感，勿调换）：
/// 1. trim；
/// 2. 移除 `<think>...</think>` 闭合块（大小写不敏感）；
/// 3. 处理 `<think>` 开头但无闭合的 GLM 格式：砍到第一个换行后，无换行则清空；
/// 4. 逐行过滤「思考行」（小写后以 think 开头，或含 用户现在/首先看/分析/根据要求）；
/// 5. 去非法字符 `"'<>|:*?\/`、换行转空格、合并多空格、trim；
/// 6. 去末尾扩展名；空 → None。
pub fn clean_rename_response(raw: &str) -> Option<String> {
    // 1. trim
    let mut new_name = raw.trim().to_string();

    // 2. 移除 think 标签及其内容（<think[\s\S]*?<\/think>/gi）
    new_name = remove_think_blocks(&new_name);

    // 3. GLM 思考格式：<think> 开头但没有闭合标签 → 移除从 <think> 到行尾
    if new_name.to_lowercase().starts_with("<think>") {
        match new_name.find('\n') {
            Some(idx) => new_name = new_name[idx + 1..].to_string(),
            None => new_name.clear(), // 整个响应都是 think 内容
        }
    }

    // 4. 过滤思考关键词行
    new_name = new_name
        .split('\n')
        .filter(|line| {
            let lower_line = line.trim().to_lowercase();
            !lower_line.starts_with("think")
                && !lower_line.contains("用户现在")
                && !lower_line.contains("首先看")
                && !lower_line.contains("分析")
                && !lower_line.contains("根据要求")
        })
        .collect::<Vec<&str>>()
        .join("\n");

    // 5. 去非法字符 + 换行转空格 + 合并空格 + trim
    let cleaned: String = new_name
        .chars()
        .filter(|c| !matches!(c, '"' | '\'' | '<' | '>' | '|' | ':' | '*' | '?' | '\\' | '/'))
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<&str>>().join(" ");

    // 6. 去 AI 顺手加的扩展名；空 → None
    let final_name = strip_extension(&cleaned);
    if final_name.is_empty() {
        None
    } else {
        Some(final_name.to_string())
    }
}

/// 对齐正则 `/<think[\s\S]*?<\/think>/gi`：移除所有闭合的 think 块；
/// 未闭合的 `<think` 保留原地（正则要求闭合才算命中）。
fn remove_think_blocks(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        match lower[i..].find("<think") {
            Some(rel) => {
                let start = i + rel;
                out.push_str(&s[i..start]);
                match lower[start..].find("</think>") {
                    Some(end_rel) => {
                        i = start + end_rel + "</think>".len();
                    }
                    None => {
                        // 此处无闭合：保留 "<think" 字面量，从其后继续找下一处
                        out.push_str(&s[start..start + "<think".len()]);
                        i = start + "<think".len();
                    }
                }
            }
            None => {
                out.push_str(&s[i..]);
                break;
            }
        }
    }
    out
}

// ==================== 纯函数：AI 搜索改写 ====================

/// 构造 AI 搜索改写 prompt（原文逐字对齐 useSearch.ts:98-110，含模板自带的缩进空格）。
///
/// 注：任务预设签名带 `language`，但 TS 源的 prompt **不**使用全局语言（固定英文），
/// 故 `language` 当前不写入 prompt（登记为闲置参数，留作后续扩展）。
pub fn build_search_rewrite_prompt(query: &str, _language: &str) -> String {
    format!(
        "\n          Analyze this search query for a photo gallery: \"{}\".\n          Extract search intent and criteria into a JSON object.\n          Return ONLY JSON.\n          \n          Expected JSON Structure:\n          {{\n            \"keywords\": string[], // Synonyms, objects, tags\n            \"colors\": string[], // Hex codes or color names\n            \"people\": string[], // Names of people\n            \"description\": string // A concise description of what to look for (optional)\n          }}\n          ",
        query
    )
}

/// 解析搜索改写结果（对齐 useSearch.ts:134-159 的解析方式）：
/// 三 provider 里 openai/ollama 都是贪婪正则 `/\{[\s\S]*\}/`（首个 `{` 到最后一个 `}`）取段
/// parse、失败再整体 parse；lmstudio 直接整体 parse。统一实现为「贪婪段 → 失败整体」。
///
/// 字段稳定化：keywords/colors/people 非 array → 空 vec（TS 的 `result.keywords || []`
/// 对非 array 真值会原样透传并在后续 .map 崩溃，属潜在 bug，core 侧按任务要求取稳）；
/// description 仅接受字符串。original_query 由调用方回填（恒置空串）。
pub fn parse_search_filter(text: &str) -> Option<AiSearchFilter> {
    let value = extract_json_object_greedy(text)?;
    Some(AiSearchFilter {
        keywords: string_array_field(&value, "keywords"),
        colors: string_array_field(&value, "colors"),
        people: string_array_field(&value, "people"),
        description: string_field(&value, "description"),
        original_query: String::new(),
    })
}

/// 首个 `{` 到最后一个 `}` 的贪婪段优先，失败退整体 parse（对齐 `/\{[\s\S]*\}/` + 兜底）。
fn extract_json_object_greedy(text: &str) -> Option<Value> {
    if let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) {
        if start < end {
            if let Ok(v) = serde_json::from_str::<Value>(&text[start..=end]) {
                if v.is_object() {
                    return Some(v);
                }
            }
        }
    }
    serde_json::from_str::<Value>(text).ok()
}

/// 把 AiSearchFilter 应用到结果集（逐条对齐 useFileSearch.ts:64-100 的 aiFilter 分支——
/// 真实生效的检索逻辑在此文件，`search.worker.ts` 未被引用仅是同逻辑副本）。
///
/// 桌面语义逐条：
/// - 四项全空 → 直接 0 结果（`!keywords.length && ... && !description → return false`）；
/// - keywords：任一关键词（小写）是 tags / aiData.objects / aiData.tags / 两级 description
///   的**子串**（`includes`，大小写不敏感）。**不匹配文件名 name**（name 只参与普通搜索分支）；
/// - colors：meta.palette / aiData.dominantColors 的小写精确相等——SearchItem 未携带这两个
///   数据源（FFI 面裁剪），故 colors 非空时当前恒不匹配（登记，见报告）；
/// - people：aiData.faces[].name 小写相等——SearchItem 未携带 faces，恒不匹配（登记）；
/// - description：小写后是文件 description 的子串；
/// - 各条件 AND，命中按输入顺序返回 file_id。
pub fn apply_search_filter(filter: &AiSearchFilter, items: Vec<SearchItem>) -> Vec<String> {
    // TS 用真值判断：description 为空串视同缺席
    let description = filter.description.as_deref().unwrap_or("").to_lowercase();
    let has_any = !filter.keywords.is_empty()
        || !filter.colors.is_empty()
        || !filter.people.is_empty()
        || !description.is_empty();
    if !has_any {
        return Vec::new();
    }

    let lower_keywords: Vec<String> = filter.keywords.iter().map(|k| k.to_lowercase()).collect();
    let lower_colors: Vec<String> = filter.colors.iter().map(|c| c.to_lowercase()).collect();
    let lower_people: Vec<String> = filter.people.iter().map(|p| p.to_lowercase()).collect();

    let mut matched_ids = Vec::new();
    for item in items {
        if !lower_keywords.is_empty() {
            let hit = lower_keywords.iter().any(|kw| {
                item.tags.iter().any(|t| t.to_lowercase().contains(kw))
                    || item
                        .description
                        .as_deref()
                        .map_or(false, |d| d.to_lowercase().contains(kw))
            });
            if !hit {
                continue;
            }
        }
        if !lower_colors.is_empty() {
            // 桌面要查 meta.palette / aiData.dominantColors（小写精确相等）；
            // SearchItem 无此数据 → 无一可满足（见函数级注释）
            let _ = &lower_colors;
            continue;
        }
        if !lower_people.is_empty() {
            // 桌面要查 aiData.faces[].name（小写精确相等）；SearchItem 无此数据 → 恒不匹配
            let _ = &lower_people;
            continue;
        }
        if !description.is_empty()
            && !item
                .description
                .as_deref()
                .map_or(false, |d| d.to_lowercase().contains(&description))
        {
            continue;
        }
        matched_ids.push(item.file_id);
    }
    matched_ids
}

// ==================== provider 客户端（reqwest::blocking） ====================

/// 对桌面差异登记：桌面 fetch/proxyHttpRequest 无显式超时；移动端给上限防永久挂起。
const CHAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// 三 provider 共用的 blocking HTTP 客户端。
pub struct AiClient {
    client: reqwest::blocking::Client,
}

impl AiClient {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .build()
            .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;
        Ok(AiClient { client })
    }

    /// 聊天式调用：analysis/rename/search 共用传输；json_mode 控制 ollama format:"json"；
    /// 返回 assistant 原文（由调用方再走 parse_ai_json / clean_rename_response / parse_search_filter）。
    ///
    /// 三 provider 分支差异全部收敛在此（对齐 TS 源码事实）：
    /// - openai：`{去尾斜杠 endpoint}/chat/completions` + `Authorization: Bearer`；
    ///   user content 为 `[{type:text},{type:image_url}]` 数组（data URL 由 mime+b64 拼回；
    ///   桌面分析路径硬编码 image/jpeg 属怪癖，由调用方传 "image/jpeg" 保持）；
    ///   Rename 时 body 带 `temperature:0.7` 且模型兜底 "gpt-4o"（aiService.ts:229-234）。
    /// - ollama：Analysis/Search 走 `/api/generate`：`{model, prompt, images:[裸 base64],
    ///   stream:false, format:"json"?}` + systemPrompt 放 body.system（useAIAnalysis.ts:416-425）；
    ///   **Rename 走 `/api/chat`**：手工转 messages（system role + user 消息带 images），
    ///   `stream:false`、**无** format 字段，模型兜底 "llava"（aiService.ts:252-303）。
    /// - lmstudio：`{去尾斜杠 endpoint}[/v1 追加]/chat/completions`；Analysis/Search 带
    ///   `stream:false`，Rename 带 `temperature:0.7`；model 为空 → Err（替代桌面
    ///   「探测自动改写 model 设置」quirk，见模块注释）。
    pub fn chat(
        &self,
        cfg: &AiConfig,
        kind: AiChatKind,
        prompt: &str,
        image_b64: Option<&str>,
        mime: &str,
        max_tokens: u32,
        json_mode: bool,
    ) -> Result<String, String> {
        match cfg.provider {
            AiProvider::OpenAi => {
                let messages = chat_style_messages(cfg, prompt, image_b64, mime);
                let model = if kind == AiChatKind::Rename && cfg.openai_model.is_empty() {
                    "gpt-4o".to_string()
                } else {
                    cfg.openai_model.clone()
                };
                let body = if kind == AiChatKind::Rename {
                    serde_json::json!({
                        "model": model,
                        "messages": messages,
                        "max_tokens": max_tokens,
                        "temperature": 0.7
                    })
                } else {
                    serde_json::json!({
                        "model": model,
                        "messages": messages,
                        "max_tokens": max_tokens
                    })
                };
                let endpoint = trim_trailing_slash(&cfg.openai_endpoint);
                let url = format!("{}/chat/completions", endpoint);
                let headers = vec![(
                    "Authorization",
                    format!("Bearer {}", cfg.openai_api_key),
                )];
                let data = self.post_json(&url, &headers, &body, CHAT_TIMEOUT)?;
                extract_choices_content(&data)
            }
            AiProvider::Ollama => {
                if kind == AiChatKind::Rename {
                    // 重命名：/api/chat（aiService.ts:279-289），无 format 字段
                    let mut messages = Vec::new();
                    if let Some(sys) = non_empty_system(cfg) {
                        messages.push(serde_json::json!({"role": "system", "content": sys}));
                    }
                    let mut user = serde_json::Map::new();
                    user.insert("role".into(), serde_json::json!("user"));
                    user.insert("content".into(), serde_json::json!(prompt));
                    if let Some(b64) = image_b64 {
                        user.insert("images".into(), serde_json::json!([b64]));
                    }
                    messages.push(Value::Object(user));

                    let model = if cfg.ollama_model.is_empty() {
                        "llava".to_string()
                    } else {
                        cfg.ollama_model.clone()
                    };
                    let body = serde_json::json!({
                        "model": model,
                        "messages": messages,
                        "stream": false
                    });
                    let url = format!("{}/api/chat", trim_trailing_slash(&cfg.ollama_endpoint));
                    let data = self.post_json(&url, &[], &body, CHAT_TIMEOUT)?;
                    data.get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| "ollama 响应缺少 message.content".to_string())
                } else {
                    // 分析/搜索：/api/generate（useAIAnalysis.ts:416-425 / useSearch.ts:144-147）
                    let mut body = serde_json::Map::new();
                    body.insert("model".into(), serde_json::json!(cfg.ollama_model));
                    body.insert("prompt".into(), serde_json::json!(prompt));
                    if let Some(b64) = image_b64 {
                        body.insert("images".into(), serde_json::json!([b64]));
                    }
                    body.insert("stream".into(), serde_json::json!(false));
                    if json_mode {
                        body.insert("format".into(), serde_json::json!("json"));
                    }
                    if let Some(sys) = non_empty_system(cfg) {
                        body.insert("system".into(), serde_json::json!(sys));
                    }
                    let url = format!("{}/api/generate", trim_trailing_slash(&cfg.ollama_endpoint));
                    let data = self.post_json(&url, &[], &Value::Object(body), CHAT_TIMEOUT)?;
                    data.get("response")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .ok_or_else(|| "ollama 响应缺少 response".to_string())
                }
            }
            AiProvider::LmStudio => {
                if cfg.lmstudio_model.is_empty() {
                    return Err("LMStudio 模型未配置，请先在设置中选择模型".to_string());
                }
                let messages = chat_style_messages(cfg, prompt, image_b64, mime);
                let body = if kind == AiChatKind::Rename {
                    // aiService.ts:318-323：带 temperature，无 stream 键
                    serde_json::json!({
                        "model": cfg.lmstudio_model,
                        "messages": messages,
                        "max_tokens": max_tokens,
                        "temperature": 0.7
                    })
                } else {
                    // useAIAnalysis.ts:477-482 / useSearch.ts:172-177：带 stream:false
                    serde_json::json!({
                        "model": cfg.lmstudio_model,
                        "messages": messages,
                        "max_tokens": max_tokens,
                        "stream": false
                    })
                };
                let url = format!(
                    "{}/chat/completions",
                    ensure_v1(&cfg.lmstudio_endpoint)
                );
                let data = self.post_json(&url, &[], &body, CHAT_TIMEOUT)?;
                extract_choices_content(&data)
            }
        }
    }

    /// 连通性探测（逐字对齐 aiService.ts:17-44 checkConnection 的三条 GET 路径）：
    /// openai → `{cleanUrl}/models` + Bearer；ollama → `{cleanUrl}/api/tags`；
    /// lmstudio → `{cleanUrl}[/v1]/models`。能拿到合法 JSON 即视为 connected。
    pub fn check_connection(&self, cfg: &AiConfig) -> Result<(), String> {
        let (url, headers) = match cfg.provider {
            AiProvider::OpenAi => (
                format!("{}/models", trim_trailing_slash(&cfg.openai_endpoint)),
                vec![("Authorization", format!("Bearer {}", cfg.openai_api_key))],
            ),
            AiProvider::Ollama => (
                format!("{}/api/tags", trim_trailing_slash(&cfg.ollama_endpoint)),
                vec![],
            ),
            AiProvider::LmStudio => (
                format!("{}/models", ensure_v1(&cfg.lmstudio_endpoint)),
                vec![],
            ),
        };
        self.get_json(&url, &headers, PROBE_TIMEOUT).map(|_| ())
    }

    /// 拉模型 id 列表（对齐 aiService.ts:349-406 fetchModels 的解析字段）：
    /// openai/lmstudio → 响应 `data.data[].id`；ollama（桌面无此路径，按 /api/tags 真实形状补齐）
    /// → `models[].name`。
    ///
    /// 偏差登记：TS 失败时回退 `AI_SERVICE_PRESETS` 预设列表；core 无预设表 → 返回 Err 交调用方
    /// 决定兜底。TS 还做视觉过滤/推荐排序/友好名，均属展示层，core 不搬（返回原始 id 序）。
    pub fn fetch_models(&self, cfg: &AiConfig) -> Result<Vec<String>, String> {
        let (url, headers) = match cfg.provider {
            AiProvider::OpenAi => {
                let mut h = Vec::new();
                if !cfg.openai_api_key.is_empty() {
                    h.push(("Authorization", format!("Bearer {}", cfg.openai_api_key)));
                }
                (
                    format!("{}/models", trim_trailing_slash(&cfg.openai_endpoint)),
                    h,
                )
            }
            AiProvider::Ollama => (
                format!("{}/api/tags", trim_trailing_slash(&cfg.ollama_endpoint)),
                vec![],
            ),
            AiProvider::LmStudio => (
                format!("{}/models", ensure_v1(&cfg.lmstudio_endpoint)),
                vec![],
            ),
        };
        let data = self.get_json(&url, &headers, PROBE_TIMEOUT)?;
        // 解析字段：openai/lmstudio → data.data[].id；ollama → models[].name
        let (list_key, id_key) = match cfg.provider {
            AiProvider::Ollama => ("models", "name"),
            _ => ("data", "id"),
        };
        let items = data
            .get(list_key)
            .and_then(Value::as_array)
            .ok_or_else(|| "Invalid response format".to_string())?;
        Ok(items
            .iter()
            .filter_map(|m| m.get(id_key).and_then(Value::as_str))
            .map(str::to_string)
            .collect())
    }

    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let mut req = self
            .client
            .post(url)
            .timeout(timeout)
            .header("Content-Type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let resp = req
            .body(body.to_string())
            .send()
            .map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status.as_u16(), text));
        }
        serde_json::from_str(&text).map_err(|e| format!("响应 JSON 解析失败: {}", e))
    }

    fn get_json(
        &self,
        url: &str,
        headers: &[(&str, String)],
        timeout: std::time::Duration,
    ) -> Result<Value, String> {
        let mut req = self.client.get(url).timeout(timeout);
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let resp = req.send().map_err(|e| format!("请求失败: {}", e))?;
        let status = resp.status();
        let text = resp.text().map_err(|e| format!("读取响应失败: {}", e))?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status.as_u16(), text));
        }
        serde_json::from_str(&text).map_err(|e| format!("响应 JSON 解析失败: {}", e))
    }
}

/// 去尾部斜杠（对齐 TS `endpoint.replace(/\/+$/, '')`；ollama TS 各 chat 路径其实没去，
/// core 统一去——登记为稳化偏差，见报告）。
fn trim_trailing_slash(endpoint: &str) -> &str {
    endpoint.trim_end_matches('/')
}

/// lmstudio 端点：先去尾斜杠再补 /v1（已有 /v1 则不动）。
fn ensure_v1(endpoint: &str) -> String {
    let ep = trim_trailing_slash(endpoint);
    if ep.ends_with("/v1") {
        ep.to_string()
    } else {
        format!("{}/v1", ep)
    }
}

/// systemPrompt 参与条件：None / 空串 / 纯空白 都不参与
/// （analysis/search 是真值判断、rename 是 trim 真值判断，core 统一取严）。
fn non_empty_system(cfg: &AiConfig) -> Option<&str> {
    cfg.system_prompt.as_deref().filter(|s| !s.trim().is_empty())
}

/// openai/lmstudio 的 messages 数组：可选 system role + user 消息。
/// 带图 → content 为 `[{type:text},{type:image_url}]` 数组；无图 → content 为纯字符串
/// （分析恒带图、搜索恒不带，与 TS 两个分支逐一对应）。
fn chat_style_messages(
    cfg: &AiConfig,
    prompt: &str,
    image_b64: Option<&str>,
    mime: &str,
) -> Vec<Value> {
    let mut messages = Vec::new();
    if let Some(sys) = non_empty_system(cfg) {
        messages.push(serde_json::json!({"role": "system", "content": sys}));
    }
    let user = match image_b64 {
        Some(b64) => serde_json::json!([{
            "type": "text",
            "text": prompt
        }, {
            "type": "image_url",
            "image_url": {"url": format!("data:{};base64,{}", mime, b64)}
        }]),
        None => serde_json::json!(prompt),
    };
    messages.push(serde_json::json!({"role": "user", "content": user}));
    messages
}

/// openai/lmstudio 响应提取：`choices[0].message.content`。
fn extract_choices_content(data: &Value) -> Result<String, String> {
    data.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "响应缺少 choices[0].message.content".to_string())
}

// ==================== 单测 ====================

#[cfg(test)]
mod ai_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    // ---------- 测试工具 ----------

    fn base_cfg(provider: AiProvider) -> AiConfig {
        AiConfig {
            provider,
            openai_endpoint: String::new(),
            openai_api_key: "sk-test".into(),
            openai_model: "gpt-4o-mini".into(),
            ollama_endpoint: String::new(),
            ollama_model: "llava:13b".into(),
            lmstudio_endpoint: String::new(),
            lmstudio_model: "qwen2-vl".into(),
            system_prompt: None,
            auto_tag: true,
            auto_description: true,
            enhance_person_description: false,
            enable_ocr: true,
            enable_translation: true,
            language: "zh".into(),
        }
    }

    /// 起迷你 HTTP 服务：收一个请求（按 Content-Length 读满 body），回固定 200 JSON，
    /// 经 channel 把原始请求文本交给测试断言。
    fn spawn_json_server(body: String) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind 127.0.0.1:0");
        let addr = listener.local_addr().expect("local_addr");
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = match listener.accept() {
                Ok(v) => v,
                Err(_) => return,
            };
            let mut buf: Vec<u8> = Vec::new();
            let mut tmp = [0u8; 8192];
            loop {
                match stream.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = find_header_end(&buf) {
                            let need = content_length(&buf[..pos]).unwrap_or(0);
                            if buf.len() >= pos + 4 + need {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&buf).to_string());
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        });
        (format!("http://{}", addr), rx)
    }

    fn find_header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|w| w == b"\r\n\r\n")
    }

    fn content_length(head: &[u8]) -> Option<usize> {
        let head_str = std::str::from_utf8(head).ok()?;
        let lower = head_str.to_lowercase();
        let idx = lower.find("content-length:")?;
        let rest = head_str[idx + "content-length:".len()..].trim();
        let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
        rest[..end].parse().ok()
    }

    fn recv_request(rx: &mpsc::Receiver<String>) -> String {
        rx.recv_timeout(Duration::from_secs(10)).expect("服务端应收到请求")
    }

    // ---------- build_analysis_prompt ----------

    #[test]
    fn analysis_prompt_all_on_zh() {
        let mut cfg = base_cfg(AiProvider::OpenAi);
        cfg.enable_ocr = true;
        cfg.enable_translation = true;
        let p = build_analysis_prompt(&cfg);
        // 固定英文框架逐字断言（一处）
        assert!(p.contains("Analyze this image. Return a VALID JSON object (no markdown, no extra text) with these fields:"));
        assert!(p.contains("Respond STRICTLY in JSON."));
        // 中文变体各开关行
        assert!(p.contains("- description: string (请描述这张图里的内容。如果识别出具体人物请提及姓名。)"));
        assert!(p.contains("- extractedText: string (提取图片中的文字。)"));
        assert!(p.contains("- translatedText: string (把图片中的文字翻译成Simplified Chinese。)"));
        assert!(p.contains("- tags: string[] (relevant keywords in Simplified Chinese)"));
        assert!(p.contains("- sceneCategory: string (e.g. landscape, portrait, indoor, etc in Simplified Chinese)"));
        assert!(p.contains("- objects: string[] (list of visible objects in Simplified Chinese)"));
        // 无 enhance 时不该出现强调句
        assert!(!p.contains("着重描述"));
    }

    #[test]
    fn analysis_prompt_all_off() {
        let mut cfg = base_cfg(AiProvider::OpenAi);
        cfg.auto_tag = false;
        cfg.auto_description = false;
        cfg.enable_ocr = false;
        cfg.enable_translation = false;
        let p = build_analysis_prompt(cfg_borrow(&cfg));
        assert!(p.contains("Analyze this image. Return a VALID JSON object"));
        assert!(!p.contains("- description: string"));
        assert!(!p.contains("- extractedText: string"));
        assert!(!p.contains("- translatedText: string"));
        assert!(!p.contains("- tags: string[]"));
        // sceneCategory/objects 无条件
        assert!(p.contains("- sceneCategory: string"));
        assert!(p.contains("- objects: string[]"));
    }

    fn cfg_borrow(cfg: &AiConfig) -> &AiConfig {
        cfg
    }

    #[test]
    fn analysis_prompt_only_auto_tag_and_translation() {
        let mut cfg = base_cfg(AiProvider::Ollama);
        cfg.auto_tag = true;
        cfg.auto_description = false;
        cfg.enable_ocr = false;
        cfg.enable_translation = true;
        let p = build_analysis_prompt(&cfg);
        assert!(p.contains("- tags: string[] (relevant keywords in Simplified Chinese)"));
        assert!(p.contains("- translatedText: string"));
        assert!(!p.contains("- description: string"));
        assert!(!p.contains("- extractedText: string"));
    }

    #[test]
    fn analysis_prompt_enhance_person_en() {
        let mut cfg = base_cfg(AiProvider::LmStudio);
        cfg.language = "en".into();
        cfg.enhance_person_description = true;
        cfg.enable_ocr = false;
        cfg.enable_translation = false;
        let p = build_analysis_prompt(&cfg);
        assert!(p.contains("- description: string (Please describe the content of this image. Emphasize describing people's actions, body types, and mention their names if identified.)"));
        assert!(p.contains("relevant keywords in English"));
        assert!(!p.contains("提取图片中的文字"));
        // 缩进怪癖：字段行以 6 空格接续
        assert!(p.contains("fields:\n      - description: string"));
        assert!(p.contains("\n      \n      Respond STRICTLY in JSON."));
    }

    // ---------- parse_ai_json ----------

    #[test]
    fn parse_ai_json_clean_object() {
        let parsed = parse_ai_json(
            r#"{"description":"一只猫","extractedText":"HELLO","translatedText":"你好","tags":["猫","宠物"],"sceneCategory":"室内","objects":["猫","沙发"]}"#,
        )
        .expect("应解析成功");
        assert_eq!(parsed.description.as_deref(), Some("一只猫"));
        assert_eq!(parsed.extracted_text.as_deref(), Some("HELLO"));
        assert_eq!(parsed.translated_text.as_deref(), Some("你好"));
        assert_eq!(parsed.tags, vec!["猫", "宠物"]);
        assert_eq!(parsed.scene_category.as_deref(), Some("室内"));
        assert_eq!(parsed.objects, vec!["猫", "沙发"]);
    }

    #[test]
    fn parse_ai_json_fenced_code_block() {
        let parsed = parse_ai_json("```json\n{\"description\":\"围栏内\",\"tags\":[]}\n```")
            .expect("围栏块应解析成功");
        assert_eq!(parsed.description.as_deref(), Some("围栏内"));
        // 无 json 语言标签的围栏同样命中正则
        let parsed2 = parse_ai_json("```\n{\"description\":\"裸围栏\"}\n```").unwrap();
        assert_eq!(parsed2.description.as_deref(), Some("裸围栏"));
    }

    #[test]
    fn parse_ai_json_last_candidate_wins_over_earlier_valid() {
        // 两个候选都合法，必须取最后一个（模型先思考后答案）
        let parsed =
            parse_ai_json("思考过程 {\"draft\":1} 最终答案 {\"description\":\"最终\"}").unwrap();
        assert_eq!(parsed.description.as_deref(), Some("最终"));
        assert!(parsed.tags.is_empty());
    }

    #[test]
    fn parse_ai_json_falls_back_to_earlier_candidate_when_last_broken() {
        let parsed =
            parse_ai_json("前文 {\"description\":\"有效\"} 尾巴 {坏掉的").unwrap();
        assert_eq!(parsed.description.as_deref(), Some("有效"));
    }

    #[test]
    fn parse_ai_json_nested_object_uses_literal_fallback() {
        // 最内层候选段必然残缺（{"description":"嵌套","meta":{"n":1}），靠整体 parse 救回
        let parsed =
            parse_ai_json(r#"{"description":"嵌套","meta":{"n":1}}"#).unwrap();
        assert_eq!(parsed.description.as_deref(), Some("嵌套"));
        assert_eq!(parsed.objects, Vec::<String>::new());
    }

    #[test]
    fn parse_ai_json_think_prefix_then_trailing_json() {
        let text = "<think>我要先看看图片 {这里有个假对象} 嗯</think>{\"description\":\"思考后的答案\"}";
        let parsed = parse_ai_json(text).unwrap();
        assert_eq!(parsed.description.as_deref(), Some("思考后的答案"));
    }

    #[test]
    fn parse_ai_json_garbage_returns_none() {
        assert!(parse_ai_json("完全没有任何花括号的回答").is_none());
        assert!(parse_ai_json("{ Broken").is_none());
        assert!(parse_ai_json("```json\n这不是JSON\n```").is_none());
        assert!(parse_ai_json("").is_none());
    }

    #[test]
    fn parse_ai_json_unstable_field_types() {
        // tags/objects 非 array → 空；description 非字符串 → None
        let parsed = parse_ai_json(r#"{"tags":"不是数组","objects":5,"description":42}"#).unwrap();
        assert_eq!(parsed.tags, Vec::<String>::new());
        assert_eq!(parsed.objects, Vec::<String>::new());
        assert_eq!(parsed.description, None);
        // 数组里的非字符串元素被剔除
        let parsed2 = parse_ai_json(r#"{"tags":["好的",123,null]}"#).unwrap();
        assert_eq!(parsed2.tags, vec!["好的"]);
    }

    // ---------- build_ai_data_json ----------

    #[test]
    fn build_ai_data_json_exact_shape() {
        let parsed = AiParsed {
            description: Some("海边日落".into()),
            extracted_text: Some("BEACH".into()),
            translated_text: Some("海滩".into()),
            tags: vec!["日落".into(), "海".into()],
            scene_category: None, // 缺失 → "General"
            objects: vec!["太阳".into()],
        };
        let v = build_ai_data_json(&parsed);
        assert_eq!(v["analyzed"], serde_json::json!(true));
        assert_eq!(v["description"], serde_json::json!("海边日落"));
        assert_eq!(v["tags"], serde_json::json!(["日落", "海"]));
        assert_eq!(v["sceneCategory"], serde_json::json!("General"));
        assert_eq!(v["confidence"], serde_json::json!(0.95));
        assert_eq!(v["dominantColors"], serde_json::json!([]));
        assert_eq!(v["objects"], serde_json::json!(["太阳"]));
        assert_eq!(v["extractedText"], serde_json::json!("BEACH"));
        assert_eq!(v["translatedText"], serde_json::json!("海滩"));
        assert_eq!(v["faces"], serde_json::json!([]));
        // analyzedAt 形如 ISO 毫秒 Z
        let at = v["analyzedAt"].as_str().unwrap();
        assert_eq!(at.len(), 24);
        assert!(at.ends_with('Z'));
        assert!(at.starts_with(char::is_numeric));
    }

    #[test]
    fn build_ai_data_json_toggles_off_by_caller_zeroing() {
        // 开关关闭 = 调用方把字段清空后传入：description → ""、tags → []、extractedText/translatedText 缺键
        let parsed = AiParsed {
            description: None,
            extracted_text: None,
            translated_text: None,
            tags: vec![],
            scene_category: Some("风景".into()),
            objects: vec!["山".into()],
        };
        let v = build_ai_data_json(&parsed);
        assert_eq!(v["description"], serde_json::json!(""));
        assert_eq!(v["tags"], serde_json::json!([]));
        assert!(v.get("extractedText").is_none(), "OCR 关闭时缺键");
        assert!(v.get("translatedText").is_none(), "翻译关闭时缺键");
        assert_eq!(v["sceneCategory"], serde_json::json!("风景"));
    }

    // ---------- guess_mime ----------

    #[test]
    fn guess_mime_mapping() {
        assert_eq!(guess_mime("a.jpg"), "image/jpeg");
        assert_eq!(guess_mime("a.JPEG"), "image/jpeg");
        assert_eq!(guess_mime("a.jfif"), "image/jpeg");
        assert_eq!(guess_mime("photo.PNG"), "image/png");
        assert_eq!(guess_mime("anim.gif"), "image/gif");
        assert_eq!(guess_mime("pic.webp"), "image/webp");
        assert_eq!(guess_mime("shot.bmp"), "image/bmp");
        assert_eq!(guess_mime("scan.tiff"), "image/tiff");
        assert_eq!(guess_mime("scan.tif"), "image/tiff");
        // 未知扩展名 / 无扩展名 → image/jpeg 兜底
        assert_eq!(guess_mime("raw.heic"), "image/jpeg");
        assert_eq!(guess_mime("noext"), "image/jpeg");
        assert_eq!(guess_mime("C:\\dir\\a.JPG"), "image/jpeg");
    }

    // ---------- build_rename_prompt ----------

    #[test]
    fn rename_prompt_without_persons() {
        let p = build_rename_prompt("IMG_20240101.jpg", &[]);
        assert!(p.starts_with("请根据这张图片的内容，直接输出一个简洁、描述性的中文文件名。不要思考，不要解释，直接输出文件名。"));
        assert!(p.contains("5. 原文件名是：\"IMG_20240101\""));
        assert!(p.ends_with("请只返回新的文件名（不包含扩展名）："));
        assert!(!p.contains("6. 图片中包含以下人物"));
        // 无扩展名输入不剥
        let p2 = build_rename_prompt("没有扩展名", &[]);
        assert!(p2.contains("5. 原文件名是：\"没有扩展名\""));
    }

    #[test]
    fn rename_prompt_with_persons() {
        let p = build_rename_prompt("photo.png", &["张三".to_string(), "李四".to_string()]);
        assert!(p.contains(
            "\n6. 图片中包含以下人物：张三、李四，请在文件名中优先使用人物名称（如\"张三的...\"）"
        ));
    }

    // ---------- clean_rename_response ----------

    #[test]
    fn clean_rename_think_wrapped() {
        assert_eq!(
            clean_rename_response("<think>用户上传了一张图片，我需要分析</think>黄昏下的海岸线"),
            Some("黄昏下的海岸线".to_string())
        );
        // 大小写不敏感 + 多块
        assert_eq!(
            clean_rename_response("<THINK>a</THINK>湖畔 <think>b</think>晨雾"),
            Some("湖畔 晨雾".to_string())
        );
    }

    #[test]
    fn clean_rename_unclosed_think() {
        // <think> 开头无闭合但有换行 → 取换行后内容
        assert_eq!(
            clean_rename_response("<think>让我想想这张图\n雪山顶上的日出"),
            Some("雪山顶上的日出".to_string())
        );
        // 整个响应都是 think 内容 → None
        assert_eq!(clean_rename_response("<think>全部是思考没有答案"), None);
    }

    #[test]
    fn clean_rename_filters_analysis_lines() {
        let raw = "根据要求，我需要生成文件名\n分析：图片中有一只猫\n首先看背景\n用户现在需要的是一个名字\n阳光下的橘猫";
        assert_eq!(clean_rename_response(raw), Some("阳光下的橘猫".to_string()));
        // 以 think 开头的行被过滤
        let raw2 = "thinkstep 一下\n花园里的玫瑰";
        assert_eq!(clean_rename_response(raw2), Some("花园里的玫瑰".to_string()));
    }

    #[test]
    fn clean_rename_illegal_chars_and_extension() {
        // 非法字符 " ' < > | : * ? \ / 全部移除；AI 加的扩展名被剥掉
        assert_eq!(
            clean_rename_response("海边:风景?*照|片\"名'<>.jpg"),
            Some("海边风景照片名".to_string())
        );
        // 换行转空格、多空格合并
        assert_eq!(
            clean_rename_response("城市\n\n夜景\t街道"),
            Some("城市 夜景 街道".to_string())
        );
    }

    #[test]
    fn clean_rename_empty_returns_none() {
        assert_eq!(clean_rename_response("   "), None);
        assert_eq!(clean_rename_response("<think>x</think>"), None);
        assert_eq!(clean_rename_response("分析"), None);
        // 纯扩展名剥完为空
        assert_eq!(clean_rename_response(".png"), None);
    }

    // ---------- provider 请求体形状（迷你 HTTP 服务） ----------

    #[test]
    fn openai_analysis_request_shape() {
        let body = r#"{"choices":[{"message":{"content":"{\"description\":\"你好\"}"}}]}"#.to_string();
        let (url, rx) = spawn_json_server(body);
        let mut cfg = base_cfg(AiProvider::OpenAi);
        cfg.openai_endpoint = url.clone();
        cfg.system_prompt = Some("你是图片分析助手".into());
        let client = AiClient::new().unwrap();
        let out = client
            .chat(&cfg, AiChatKind::Analysis, "PROMPT", Some("QUJD"), "image/jpeg", 1000, true)
            .expect("openai chat 应成功");
        assert_eq!(out, "{\"description\":\"你好\"}");
        // 再走一层 parse_ai_json 验证链路
        assert_eq!(parse_ai_json(&out).unwrap().description.as_deref(), Some("你好"));

        let req = recv_request(&rx);
        let lower = req.to_lowercase();
        assert!(lower.starts_with("post /chat/completions "), "路径应为 /chat/completions");
        assert!(lower.contains("authorization: bearer sk-test"));
        assert!(lower.contains("content-type: application/json"));
        // image_url data URL（mime 由参数决定）
        assert!(req.contains("data:image/jpeg;base64,QUJD"));
        assert!(req.contains("\"max_tokens\":1000"));
        assert!(req.contains("\"model\":\"gpt-4o-mini\""));
        // systemPrompt 走 system role 消息
        assert!(req.contains("\"role\":\"system\""));
        assert!(req.contains("你是图片分析助手"));
        // user content 是多模态数组
        assert!(req.contains("\"type\":\"text\""));
        assert!(req.contains("\"type\":\"image_url\""));
    }

    #[test]
    fn ollama_generate_request_shape() {
        let body = r#"{"response":"{\"tags\":[\"落日\"]}"}"#.to_string();
        let (url, rx) = spawn_json_server(body);
        let mut cfg = base_cfg(AiProvider::Ollama);
        cfg.ollama_endpoint = url.clone();
        cfg.system_prompt = Some("系统提示".into());
        let client = AiClient::new().unwrap();
        let out = client
            .chat(&cfg, AiChatKind::Analysis, "分析这张图", Some("QUJD"), "image/jpeg", 1000, true)
            .expect("ollama chat 应成功");
        assert!(out.contains("落日"));

        let req = recv_request(&rx);
        assert!(req.starts_with("POST /api/generate "), "路径应为 /api/generate");
        assert!(req.contains("\"images\":[\"QUJD\"]"), "images 应是裸 base64 数组");
        assert!(req.contains("\"format\":\"json\""), "json_mode 应产生 format:\"json\"");
        assert!(req.contains("\"stream\":false"));
        assert!(req.contains("\"prompt\":\"分析这张图\""));
        // systemPrompt 拼进 body.system（不是 system role）
        assert!(req.contains("\"system\":\"系统提示\""));
        assert!(!req.contains("\"role\":\"system\""));
        assert!(req.contains("\"model\":\"llava:13b\""));
    }

    #[test]
    fn ollama_generate_without_images_omits_key() {
        // 搜索场景：无图 → 不带 images 键（对齐 useSearch.ts:144）
        let body = r#"{"response":"ok"}"#.to_string();
        let (url, rx) = spawn_json_server(body);
        let mut cfg = base_cfg(AiProvider::Ollama);
        cfg.ollama_endpoint = url;
        let client = AiClient::new().unwrap();
        client
            .chat(&cfg, AiChatKind::Search, "查询", None, "image/jpeg", 500, true)
            .unwrap();
        let req = recv_request(&rx);
        assert!(req.starts_with("POST /api/generate "));
        assert!(!req.contains("\"images\""));
        assert!(req.contains("\"format\":\"json\""));
        assert!(req.contains("\"max_tokens\"") == false); // /api/generate 不传 max_tokens
    }

    #[test]
    fn lmstudio_v1_append_paths() {
        // 端点无 /v1 → 追加；已有 /v1 → 不重复
        let body = r#"{"choices":[{"message":{"content":"答案A"}}]}"#.to_string();
        let (url1, rx1) = spawn_json_server(body.clone());
        let mut cfg = base_cfg(AiProvider::LmStudio);
        cfg.lmstudio_endpoint = url1.clone();
        let client = AiClient::new().unwrap();
        let out = client
            .chat(&cfg, AiChatKind::Analysis, "问", Some("QQ=="), "image/png", 1000, false)
            .unwrap();
        assert_eq!(out, "答案A");
        let req1 = recv_request(&rx1);
        assert!(req1.starts_with("POST /v1/chat/completions "), "应追加 /v1");
        assert!(!req1.to_lowercase().contains("authorization"), "lmstudio 无鉴权头");
        assert!(req1.contains("data:image/png;base64,QQ=="));
        assert!(req1.contains("\"stream\":false"), "分析场景带 stream:false");
        assert!(!req1.contains("\"temperature\""));

        let (url2, rx2) = spawn_json_server(r#"{"choices":[{"message":{"content":"B"}}]}"#.to_string());
        cfg.lmstudio_endpoint = format!("{}/v1", url2);
        let out2 = client.chat(&cfg, AiChatKind::Search, "问2", None, "image/png", 500, false).unwrap();
        assert_eq!(out2, "B");
        let req2 = recv_request(&rx2);
        assert!(req2.starts_with("POST /v1/chat/completions "), "不应出现 //v1 或 /v1/v1");
        assert!(!req2.contains("//v1"));
    }

    #[test]
    fn ollama_rename_uses_api_chat() {
        // 桌面事实：重命名走 /api/chat（手工转 messages），无 format 字段，模型兜底 llava
        let body = r#"{"message":{"content":"夕阳下的海滩"}}"#.to_string();
        let (url, rx) = spawn_json_server(body);
        let mut cfg = base_cfg(AiProvider::Ollama);
        cfg.ollama_endpoint = url;
        cfg.ollama_model = String::new(); // 触发兜底 "llava"
        cfg.system_prompt = Some("专注命名".into());
        let client = AiClient::new().unwrap();
        let out = client
            .chat(&cfg, AiChatKind::Rename, build_rename_prompt("beach.jpg", &[]).as_str(), Some("QUJD"), "image/jpeg", 100, false)
            .unwrap();
        assert_eq!(out, "夕阳下的海滩");

        let req = recv_request(&rx);
        assert!(req.starts_with("POST /api/chat "), "重命名应走 /api/chat");
        assert!(!req.contains("\"format\""), "/api/chat 无 format 字段");
        assert!(req.contains("\"stream\":false"));
        assert!(req.contains("\"model\":\"llava\""), "空模型兜底 llava");
        // systemPrompt 转 system role 消息（不是 body.system）
        assert!(req.contains("\"role\":\"system\""));
        assert!(req.contains("专注命名"));
        // user 消息 content 是纯文本 + images 数组
        assert!(req.contains("\"role\":\"user\""));
        assert!(req.contains("\"images\":[\"QUJD\"]"));
    }

    #[test]
    fn openai_rename_has_temperature_and_model_fallback() {
        let body = r#"{"choices":[{"message":{"content":"雪山日出"}}"#.to_string();
        let body = format!("{}]}}", body); // {"choices":[{"message":{"content":"雪山日出"}}]}
        let (url, rx) = spawn_json_server(body);
        let mut cfg = base_cfg(AiProvider::OpenAi);
        cfg.openai_endpoint = url;
        cfg.openai_model = String::new(); // 兜底 gpt-4o
        let client = AiClient::new().unwrap();
        let out = client
            .chat(&cfg, AiChatKind::Rename, "重命名", None, "image/jpeg", 100, false)
            .unwrap();
        assert_eq!(out, "雪山日出");
        let req = recv_request(&rx);
        assert!(req.contains("\"temperature\":0.7"));
        assert!(req.contains("\"max_tokens\":100"));
        assert!(req.contains("\"model\":\"gpt-4o\""));
    }

    #[test]
    fn lmstudio_empty_model_returns_err() {
        let mut cfg = base_cfg(AiProvider::LmStudio);
        cfg.lmstudio_endpoint = "http://127.0.0.1:1".into();
        cfg.lmstudio_model = String::new();
        let client = AiClient::new().unwrap();
        let err = client
            .chat(&cfg, AiChatKind::Analysis, "p", None, "image/jpeg", 1000, true)
            .unwrap_err();
        assert_eq!(err, "LMStudio 模型未配置，请先在设置中选择模型");
    }

    // ---------- check_connection / fetch_models ----------

    #[test]
    fn check_connection_three_probe_paths() {
        // openai：GET {endpoint}/models + Bearer
        let (url, rx) = spawn_json_server(r#"{"data":[]}"#.to_string());
        let mut cfg = base_cfg(AiProvider::OpenAi);
        cfg.openai_endpoint = url;
        let client = AiClient::new().unwrap();
        client.check_connection(&cfg).unwrap();
        let req = recv_request(&rx);
        let lower = req.to_lowercase();
        assert!(lower.starts_with("get /models "), "openai 探测应 GET /models");
        assert!(lower.contains("authorization: bearer sk-test"));

        // ollama：GET /api/tags
        let (url, rx) = spawn_json_server(r#"{"models":[]}"#.to_string());
        cfg.provider = AiProvider::Ollama;
        cfg.ollama_endpoint = url;
        client.check_connection(&cfg).unwrap();
        let req = recv_request(&rx);
        assert!(req.starts_with("GET /api/tags "), "ollama 探测应 GET /api/tags");

        // lmstudio：GET {endpoint}/v1/models
        let (url, rx) = spawn_json_server(r#"{"data":[]}"#.to_string());
        cfg.provider = AiProvider::LmStudio;
        cfg.lmstudio_endpoint = url; // 无 /v1，应追加
        client.check_connection(&cfg).unwrap();
        let req = recv_request(&rx);
        assert!(req.starts_with("GET /v1/models "), "lmstudio 探测应 GET /v1/models");
    }

    #[test]
    fn fetch_models_parses_ids() {
        // openai：data.data[].id
        let (url, rx) = spawn_json_server(
            r#"{"data":[{"id":"m2"},{"id":"m1"},{"id":"vision-x"}]}"#.to_string(),
        );
        let mut cfg = base_cfg(AiProvider::OpenAi);
        cfg.openai_endpoint = url;
        let client = AiClient::new().unwrap();
        let models = client.fetch_models(&cfg).unwrap();
        assert_eq!(models, vec!["m2", "m1", "vision-x"]);
        let req = recv_request(&rx);
        assert!(req.to_lowercase().starts_with("get /models "));

        // ollama：models[].name（/api/tags 真实形状；桌面无此路径，属补齐）
        let (url, _) = spawn_json_server(
            r#"{"models":[{"name":"llava:latest"},{"name":"qwen2-vl:7b"}]}"#.to_string(),
        );
        cfg.provider = AiProvider::Ollama;
        cfg.ollama_endpoint = url;
        let models = client.fetch_models(&cfg).unwrap();
        assert_eq!(models, vec!["llava:latest", "qwen2-vl:7b"]);

        // 响应缺 data.data → Err（对齐 TS "Invalid response format"；预设兜底留调用方）
        let (url, _) = spawn_json_server(r#"{"unexpected":1}"#.to_string());
        cfg.provider = AiProvider::OpenAi;
        cfg.openai_endpoint = url;
        assert!(client.fetch_models(&cfg).is_err());

        // lmstudio：/v1/models 的 data.data[].id
        let (url, rx) = spawn_json_server(r#"{"data":[{"id":"local-model"}]}"#.to_string());
        cfg.provider = AiProvider::LmStudio;
        cfg.lmstudio_endpoint = format!("{}/v1", url); // 已带 /v1 → 不重复追加
        let models = client.fetch_models(&cfg).unwrap();
        assert_eq!(models, vec!["local-model"]);
        let req = recv_request(&rx);
        assert!(req.starts_with("GET /v1/models "));
        assert!(!req.contains("/v1/v1"));
    }

    // ---------- AI 搜索改写 ----------

    #[test]
    fn search_rewrite_prompt_verbatim() {
        let p = build_search_rewrite_prompt("cats on the beach", "zh");
        assert!(p.contains("Analyze this search query for a photo gallery: \"cats on the beach\"."));
        assert!(p.contains("Extract search intent and criteria into a JSON object."));
        assert!(p.contains("Return ONLY JSON."));
        assert!(p.contains("\"keywords\": string[], // Synonyms, objects, tags"));
        assert!(p.contains("\"colors\": string[], // Hex codes or color names"));
        assert!(p.contains("\"people\": string[], // Names of people"));
        assert!(p.contains("\"description\": string // A concise description of what to look for (optional)"));
        // 模板自带的前导换行与 10 空格缩进
        assert!(p.starts_with("\n          Analyze this search query"));
    }

    #[test]
    fn parse_search_filter_clean() {
        let f = parse_search_filter(
            r##"{"keywords":["猫","小猫"],"colors":["#FFA500"],"people":["小明"],"description":"橙色的小猫"}"##,
        )
        .unwrap();
        assert_eq!(f.keywords, vec!["猫", "小猫"]);
        assert_eq!(f.colors, vec!["#FFA500"]);
        assert_eq!(f.people, vec!["小明"]);
        assert_eq!(f.description.as_deref(), Some("橙色的小猫"));
        assert_eq!(f.original_query, "", "original_query 由调用方回填");
    }

    #[test]
    fn parse_search_filter_text_wrapped_and_missing_fields() {
        // 前后有思考文本：贪婪段（首个 { 到最后一个 }）命中
        let f = parse_search_filter(
            "好的，我来分析这个查询 {\"keywords\":[\"狗\"],\"colors\":[],\"people\":[]} 以上",
        )
        .unwrap();
        assert_eq!(f.keywords, vec!["狗"]);
        assert!(f.colors.is_empty());
        assert!(f.people.is_empty());
        assert_eq!(f.description, None);

        // 全字段缺失 → 稳定默认
        let f2 = parse_search_filter("{}").unwrap();
        assert!(f2.keywords.is_empty() && f2.colors.is_empty() && f2.people.is_empty());
        assert_eq!(f2.description, None);
    }

    #[test]
    fn parse_search_filter_unstable_and_garbage() {
        // keywords 非 array → 空（TS 会原样透传并崩，core 取稳）
        let f = parse_search_filter(r#"{"keywords":"猫","description":42}"#).unwrap();
        assert!(f.keywords.is_empty());
        assert_eq!(f.description, None);
        // 纯垃圾 → None
        assert!(parse_search_filter("没有任何JSON").is_none());
    }

    fn item(id: &str, name: &str, tags: &[&str], desc: Option<&str>) -> SearchItem {
        SearchItem {
            file_id: id.to_string(),
            name: name.to_string(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            description: desc.map(str::to_string),
        }
    }

    #[test]
    fn apply_search_filter_keywords_match_tags_and_description_not_name() {
        let items = vec![
            item("f1", "IMG_001.jpg", &["Sunset", "Beach"], Some("海边日落")),
            item("f2", "sunset.png", &[], None), // 名字含 sunset，但 aiFilter 不匹配 name
            item("f3", "a.jpg", &["城市"], Some("夜晚的街道")),
        ];
        let f = AiSearchFilter {
            keywords: vec!["sunset".into()],
            colors: vec![],
            people: vec![],
            description: None,
            original_query: "sunset".into(),
        };
        // 小写子串匹配：tags 命中 f1；f2 只有 name → 不命中
        assert_eq!(apply_search_filter(&f, items.clone()), vec!["f1".to_string()]);
        // description 子串命中
        let f2 = AiSearchFilter { keywords: vec!["日落".into()], ..f.clone() };
        assert_eq!(apply_search_filter(&f2, items.clone()), vec!["f1".to_string()]);
        // 任一关键词 OR
        let f3 = AiSearchFilter { keywords: vec!["没有的".into(), "街道".into()], ..f.clone() };
        assert_eq!(apply_search_filter(&f3, items), vec!["f3".to_string()]);
    }

    #[test]
    fn apply_search_filter_description_condition_and_combined() {
        let items = vec![
            item("f1", "a.jpg", &["猫"], Some("橙色的猫在睡觉")),
            item("f2", "b.jpg", &["猫"], Some("黑猫在屋顶")),
            item("f3", "c.jpg", &["狗"], Some("橙色的狗")),
        ];
        // description 独立条件：子串匹配
        let f = AiSearchFilter {
            keywords: vec![],
            colors: vec![],
            people: vec![],
            description: Some("橙色的".into()),
            original_query: "orange cat".into(),
        };
        assert_eq!(apply_search_filter(&f, items.clone()), vec!["f1", "f3"]);
        // keywords AND description
        let f2 = AiSearchFilter {
            keywords: vec!["猫".into()],
            description: Some("橙色".into()),
            ..f.clone()
        };
        assert_eq!(apply_search_filter(&f2, items), vec!["f1"]);
    }

    #[test]
    fn apply_search_filter_colors_people_currently_unmatched() {
        // 桌面 colors 查 meta.palette/aiData.dominantColors、people 查 aiData.faces[].name；
        // SearchItem 未携带这些数据 → 非空即恒不匹配（登记：FFI 面裁剪）
        let items = vec![item("f1", "a.jpg", &["天空"], Some("蓝天"))];
        let f = AiSearchFilter {
            keywords: vec!["天空".into()],
            colors: vec!["#87CEEB".into()],
            people: vec![],
            description: None,
            original_query: "sky".into(),
        };
        assert!(apply_search_filter(&f, items.clone()).is_empty());
        let f2 = AiSearchFilter {
            keywords: vec![],
            colors: vec![],
            people: vec!["张三".into()],
            description: None,
            original_query: "张三".into(),
        };
        assert!(apply_search_filter(&f2, items).is_empty());
    }

    #[test]
    fn apply_search_filter_empty_filter_returns_none() {
        // 四项全空（description 空串视同缺席）→ 0 结果，对齐 TS 守卫
        let items = vec![item("f1", "a.jpg", &["猫"], Some("描述"))];
        let f = AiSearchFilter {
            keywords: vec![],
            colors: vec![],
            people: vec![],
            description: Some(String::new()),
            original_query: "q".into(),
        };
        assert!(apply_search_filter(&f, items).is_empty());
    }

    #[test]
    fn apply_search_filter_preserves_input_order() {
        let items = vec![
            item("f3", "c.jpg", &["日落"], None),
            item("f1", "a.jpg", &["日落"], None),
            item("f2", "b.jpg", &["日落"], None),
        ];
        let f = AiSearchFilter {
            keywords: vec!["日落".into()],
            colors: vec![],
            people: vec![],
            description: None,
            original_query: "日落".into(),
        };
        assert_eq!(apply_search_filter(&f, items), vec!["f3", "f1", "f2"]);
    }
}
