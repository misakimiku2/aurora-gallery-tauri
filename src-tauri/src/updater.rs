use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// GitHub Release Asset 信息
#[derive(Debug, Clone, Deserialize)]
pub struct GithubReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
    pub content_type: String,
}

/// GitHub Release 信息
#[derive(Debug, Clone, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    pub name: String,
    pub body: Option<String>,
    pub published_at: String,
    pub html_url: String,
    pub prerelease: bool,
    pub draft: bool,
    pub assets: Vec<GithubReleaseAsset>,
}

/// 更新检查结果
#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub download_url: String,
    pub installer_url: Option<String>,
    pub installer_size: Option<u64>,
    pub release_name: String,
    pub release_notes: String,
    pub published_at: String,
    pub error: Option<String>,
}

/// 语义化版本号
#[derive(Debug, Clone, PartialEq, Eq)]
struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Option<String>,
}

impl SemVer {
    fn parse(version: &str) -> Option<Self> {
        let version = version.trim_start_matches('v').trim_start_matches('V');
        let parts: Vec<&str> = version.split('-').collect();
        let version_parts: Vec<&str> = parts[0].split('.').collect();

        if version_parts.len() != 3 {
            return None;
        }

        let major = version_parts[0].parse().ok()?;
        let minor = version_parts[1].parse().ok()?;
        let patch = version_parts[2].parse().ok()?;
        let prerelease = if parts.len() > 1 {
            Some(parts[1..].join("-"))
        } else {
            None
        };

        Some(SemVer {
            major,
            minor,
            patch,
            prerelease,
        })
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.major.cmp(&other.major) {
            Ordering::Equal => {}
            ord => return ord,
        }
        match self.minor.cmp(&other.minor) {
            Ordering::Equal => {}
            ord => return ord,
        }
        match self.patch.cmp(&other.patch) {
            Ordering::Equal => {}
            ord => return ord,
        }

        // 处理预发布版本
        match (&self.prerelease, &other.prerelease) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(a), Some(b)) => a.cmp(b),
        }
    }
}

/// 验证 GitHub Token 是否有效
async fn verify_github_token(github_token: Option<&str>) -> Result<(), String> {
    if let Some(token) = github_token {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
        
        let response = client
            .get("https://api.github.com/user")
            .header("User-Agent", "Aurora-Gallery-Updater/1.0")
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| format!("Failed to verify token: {}", e))?;
        
        let status = response.status();
        if status.is_success() {
            log::info!("GitHub Token is valid");
            Ok(())
        } else {
            let body = response.text().await.unwrap_or_default();
            log::error!("GitHub Token verification failed. Status: {}, Body: {}", status, body);
            Err(format!("Token verification failed: {}", body))
        }
    } else {
        Ok(())
    }
}

/// 检查仓库是否存在且可访问
async fn check_repo_exists(owner: &str, repo: &str, github_token: Option<&str>) -> Result<(), String> {
    let url = format!("https://api.github.com/repos/{}/{}", owner, repo);
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    
    let mut request = client
        .get(&url)
        .header("User-Agent", "Aurora-Gallery-Updater/1.0")
        .header("Accept", "application/vnd.github.v3+json");
    
    if let Some(token) = github_token {
        request = request.header("Authorization", format!("Bearer {}", token));
    }
    
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to check repo: {}", e))?;
    
    let status = response.status();
    
    if status.is_success() {
        log::info!("Repository exists and is accessible");
        Ok(())
    } else {
        let body = response.text().await.unwrap_or_default();
        log::error!("Repository check failed. Status: {}, Body: {}", status, body);
        Err(format!("Repository check failed: {}", body))
    }
}

/// 检查是否有新版本可用
pub async fn check_for_updates(
    current_version: &str,
    owner: &str,
    repo: &str,
    github_token: Option<&str>,
) -> Result<UpdateCheckResult, String> {
    log::info!("Checking for updates...");
    if let Some(token) = github_token {
        log::debug!("Using GitHub Token for authentication");
    }
    // 首先尝试使用 GitHub API (latest)
    match check_github_api_latest(current_version, owner, repo, github_token).await {
        Ok(result) => Ok(result),
        Err(api_err) => {
            log::warn!("GitHub API latest failed: {}, trying list...", api_err);
            
            // 如果 latest API 失败，尝试使用 list API
            match check_github_api_list(current_version, owner, repo, github_token).await {
                Ok(result) => Ok(result),
                Err(list_err) => {
                    log::warn!("GitHub API list failed: {}, trying fallback...", list_err);
                    
                    // 如果 API 都失败，尝试备用方案
                    match check_github_fallback(current_version, owner, repo).await {
                        Ok(result) => Ok(result),
                        Err(fallback_err) => {
                            // 如果备用方案也是 404，说明没有 Release
                            if fallback_err.contains("404") || fallback_err.contains("not found") {
                                log::info!("No releases found in repository");
                                return Ok(UpdateCheckResult {
                                    has_update: false,
                                    current_version: current_version.to_string(),
                                    latest_version: current_version.to_string(),
                                    download_url: format!("https://github.com/{}/{}/releases", owner, repo),
                                    installer_url: None,
                                    installer_size: None,
                                    release_name: String::new(),
                                    release_notes: "No releases found. This might be a development build.".to_string(),
                                    published_at: String::new(),
                                    error: None,
                                });
                            }
                            
                            log::error!("All methods failed. API: {} | List: {} | Fallback: {}", api_err, list_err, fallback_err);
                            Err(format!("GitHub API: {} | List: {} | Fallback: {}", api_err, list_err, fallback_err))
                        }
                    }
                }
            }
        }
    }
}

/// 使用 GitHub API /releases/latest 检查更新
async fn check_github_api_latest(
    current_version: &str,
    owner: &str,
    repo: &str,
    github_token: Option<&str>,
) -> Result<UpdateCheckResult, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut request = client
        .get(&url)
        .header("User-Agent", "Aurora-Gallery-Updater/1.0")
        .header("Accept", "application/vnd.github.v3+json");
    
    // 如果有 GitHub Token，添加到请求头
    if let Some(token) = github_token {
        request = request.header("Authorization", format!("Bearer {}", token));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {}", e))?;

    let status = response.status();
    
    if status == 403 {
        let body = response.text().await.unwrap_or_default();
        if body.contains("rate limit") {
            return Err("GitHub API rate limit exceeded. Please try again later.".to_string());
        }
        return Err(format!("GitHub API forbidden (403): {}", body));
    }
    
    if status == 404 {
        return Err("Repository or release not found (404)".to_string());
    }
    
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub API error ({}): {}", status, body));
    }

    let release: GithubRelease = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;

    process_release(current_version, release)
}

/// 使用 GitHub API /releases 列表检查更新
async fn check_github_api_list(
    current_version: &str,
    owner: &str,
    repo: &str,
    github_token: Option<&str>,
) -> Result<UpdateCheckResult, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=1",
        owner, repo
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let mut request = client
        .get(&url)
        .header("User-Agent", "Aurora-Gallery-Updater/1.0")
        .header("Accept", "application/vnd.github.v3+json");
    
    // 如果有 GitHub Token，添加到请求头
    if let Some(token) = github_token {
        request = request.header("Authorization", format!("Bearer {}", token));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to fetch releases list: {}", e))?;

    let status = response.status();
    
    if status == 403 {
        let body = response.text().await.unwrap_or_default();
        if body.contains("rate limit") {
            return Err("GitHub API rate limit exceeded. Please try again later.".to_string());
        }
        return Err(format!("GitHub API forbidden (403): {}", body));
    }
    
    if status == 404 {
        return Err("Repository not found (404)".to_string());
    }
    
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("GitHub API error ({}): {}", status, body));
    }

    let releases: Vec<GithubRelease> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse releases list: {}", e))?;

    if releases.is_empty() {
        return Err("No releases found".to_string());
    }

    // 获取第一个（最新的）release
    process_release(current_version, releases[0].clone())
}

/// 备用方案：使用 GitHub 页面抓取（不需要 API）
async fn check_github_fallback(
    current_version: &str,
    owner: &str,
    repo: &str,
) -> Result<UpdateCheckResult, String> {
    // 尝试从 GitHub releases 页面获取最新版本
    // 注意：GitHub 会重定向 /releases/latest 到 /releases/tag/vX.X.X
    let url = format!("https://github.com/{}/{}/releases/latest", owner, repo);
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // 允许自动重定向，这样我们可以获取最终页面
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // 使用简化的请求头，模拟普通浏览器
    let response = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.5")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release page: {}", e))?;

    let status = response.status();
    let final_url = response.url().clone();
    log::info!("GitHub fallback response status: {}, final URL: {}", status, final_url);
    
    // 如果是 404，说明没有 Release
    if status == 404 {
        return Err("No releases found (404)".to_string());
    }
    
    if !status.is_success() {
        return Err(format!("HTTP error: {}", status));
    }

    // 获取 HTML 内容
    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    // 从最终 URL 中提取版本号（GitHub 会重定向到 /releases/tag/vX.X.X）
    let url_str = final_url.as_str();
    let version = extract_version_from_url(url_str)
        .or_else(|| extract_version_from_html(&html));
    
    if let Some(version) = version {
        let latest_version = format!("v{}", version);
        log::info!("Extracted version: {}", latest_version);
        
        let current = SemVer::parse(current_version);
        let latest = SemVer::parse(&latest_version);

        let has_update = match (current, latest) {
            (Some(current), Some(latest)) => latest > current,
            _ => latest_version != current_version,
        };

        // 尝试从 HTML 中提取更多信息
        let published_at = extract_published_at_from_html(&html).unwrap_or_default();
        let release_name = extract_release_name_from_html(&html).unwrap_or_default();
        let release_notes = extract_release_notes_from_html(&html).unwrap_or_default();
        let (installer_url, installer_size) = extract_installer_from_html(&html)
            .map(|(url, size)| (Some(url), Some(size)))
            .unwrap_or((None, None));

        log::info!("Extracted from HTML - published_at: {}, release_name: {}, has_installer: {}", 
            published_at, release_name, installer_url.is_some());

        return Ok(UpdateCheckResult {
            has_update,
            current_version: current_version.to_string(),
            latest_version: latest_version.clone(),
            download_url: format!("https://github.com/{}/{}/releases/tag/{}", owner, repo, latest_version),
            installer_url,
            installer_size,
            release_name,
            release_notes,
            published_at,
            error: None,
        });
    }

    log::error!("Could not extract version from HTML, status: {}", status);
    Err("Could not extract version from release page".to_string())
}

/// 从 URL 中提取版本号
fn extract_version_from_url(url: &str) -> Option<String> {
    // URL 格式: https://github.com/misakimiku2/aurora-gallery-tauri/releases/tag/v1.0.0
    // 或者: https://github.com/misakimiku2/aurora-gallery-tauri/releases/tag/1.0.0
    
    // 查找 /tag/ 后面的版本号
    if let Some(tag_pos) = url.find("/tag/") {
        let version_start = tag_pos + 5;
        let remaining = &url[version_start..];
        // 找到版本号结束位置（遇到 ? 或 # 或字符串结束）
        let version_end = remaining.find('?')
            .or_else(|| remaining.find('#'))
            .unwrap_or(remaining.len());
        let version = &remaining[..version_end];
        // 移除开头的 v 或 V
        let version = version.trim_start_matches('v').trim_start_matches('V');
        if !version.is_empty() && version.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            return Some(version.to_string());
        }
    }
    
    None
}

/// 从 HTML 中提取版本号
fn extract_version_from_html(html: &str) -> Option<String> {
    // 尝试多种模式匹配
    
    // 模式 1: <span class="ml-1">v1.0.0</span>
    if let Some(start) = html.find("<span class=\"ml-1\">v") {
        let start = start + 19;
        if let Some(end) = html[start..].find("</span>") {
            let version = &html[start..start + end];
            if !version.is_empty() {
                return Some(version.to_string());
            }
        }
    }
    
    // 模式 2: 从 title 中提取 - "Release v1.0.0 · ..."
    if let Some(start) = html.find("Release v") {
        let start = start + 9;
        let remaining = &html[start..];
        let end = remaining.find(" · ").or_else(|| remaining.find("</title>")).unwrap_or(0);
        if end > 0 {
            let version = &html[start..start + end];
            if !version.is_empty() {
                return Some(version.to_string());
            }
        }
    }
    
    // 模式 3: 从 h1 标题中提取
    if let Some(start) = html.find("<h1") {
        let h1_end = html[start..].find(">").unwrap_or(0);
        let content_start = start + h1_end + 1;
        if let Some(version_start) = html[content_start..].find("v") {
            let version_start = content_start + version_start + 1;
            let remaining = &html[version_start..];
            let end = remaining.find("<").unwrap_or(0);
            if end > 0 {
                let version = &html[version_start..version_start + end];
                if !version.is_empty() {
                    return Some(version.to_string());
                }
            }
        }
    }
    
    // 模式 4: 从 JSON-LD 或 meta 标签中提取
    if let Some(start) = html.find("\"softwareVersion\":\"") {
        let start = start + 19;
        if let Some(end) = html[start..].find("\"") {
            let version = &html[start..start + end];
            if !version.is_empty() {
                return Some(version.to_string());
            }
        }
    }
    
    // 模式 5: 从 URL 路径中提取（备用）
    // 查找 /releases/tag/ 模式
    if let Some(start) = html.find("/releases/tag/v") {
        let start = start + 15;
        let remaining = &html[start..];
        if let Some(end) = remaining.find("\"") {
            let version = &html[start..start + end];
            if !version.is_empty() {
                return Some(version.to_string());
            }
        }
    }
    
    None
}

/// 从 HTML 中提取发布日期
fn extract_published_at_from_html(html: &str) -> Option<String> {
    if let Some(start) = html.find("<relative-time datetime=\"") {
        let start = start + 25;
        if let Some(end) = html[start..].find("\"") {
            let datetime = &html[start..start + end];
            if !datetime.is_empty() {
                return Some(datetime.to_string());
            }
        }
    }
    None
}

/// 从 HTML 中提取 release notes
fn extract_release_notes_from_html(html: &str) -> Option<String> {
    if let Some(start) = html.find("<div class=\"markdown-body\">") {
        let start = start + 27;
        if let Some(end) = html[start..].find("</div>") {
            let notes = &html[start..start + end];
            let cleaned = notes
                .replace("<br>", "\n")
                .replace("<br/>", "\n")
                .replace("<br />", "\n")
                .replace("</p>", "\n")
                .replace("<p>", "")
                .replace("<li>", "• ")
                .replace("</li>", "\n")
                .replace("<ul>", "")
                .replace("</ul>", "")
                .replace("<ol>", "")
                .replace("</ol>", "")
                .replace("<strong>", "")
                .replace("</strong>", "")
                .replace("<em>", "")
                .replace("</em>", "")
                .replace("<code>", "`")
                .replace("</code>", "`")
                .trim()
                .to_string();
            if !cleaned.is_empty() {
                return Some(cleaned);
            }
        }
    }
    None
}

/// 从 HTML 中提取 Windows 安装程序链接
fn extract_installer_from_html(html: &str) -> Option<(String, u64)> {
    if let Some(assets_start) = html.find("<div class=\"Box Box--condensed mt-3\"") {
        let assets_section = &html[assets_start..];
        
        let patterns = ["x64-setup.exe", "_setup.exe", "-setup.exe", ".exe"];
        
        for pattern in patterns.iter() {
            let search = format!(".exe\"");
            if let Some(pos) = assets_section.find(&search) {
                let before = &assets_section[..pos + 4];
                if let Some(href_start) = before.rfind("href=\"") {
                    let href_start = href_start + 6;
                    let remaining = &assets_section[href_start..];
                    if let Some(href_end) = remaining.find("\"") {
                        let url = &remaining[..href_end];
                        if url.contains("github.com") && url.ends_with(".exe") {
                            let name_lower = url.to_lowercase();
                            if pattern == &".exe" || name_lower.contains(&pattern.to_lowercase()) {
                                if pattern != &".exe" || name_lower.contains("setup") || name_lower.contains("install") {
                                    return Some((url.to_string(), 0));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    None
}

/// 从 HTML 中提取 release name（版本标题）
fn extract_release_name_from_html(html: &str) -> Option<String> {
    // 模式 1: 查找 <h1 data-view-component="true" class="d-inline mr-3">标题</h1>
    // 这是 GitHub releases 页面标题的正确结构
    if let Some(start) = html.find("class=\"d-inline mr-3\"") {
        let section = &html[start..];
        if let Some(content_start) = section.find(">") {
            let content_start = content_start + 1;
            if let Some(content_end) = section[content_start..].find("</h1>") {
                let title = &section[content_start..content_start + content_end];
                let cleaned = title.trim().to_string();
                if !cleaned.is_empty() && !cleaned.contains("Search") && !cleaned.contains("code, repositories") && !cleaned.contains("Choose a tag") {
                    return Some(cleaned);
                }
            }
        }
    }
    
    // 模式 2: 查找 h1 标签中包含 data-view-component
    if let Some(start) = html.find("<h1 data-view-component") {
        let section = &html[start..];
        if let Some(content_start) = section.find(">") {
            let content_start = content_start + 1;
            if let Some(content_end) = section[content_start..].find("</h1>") {
                let title = &section[content_start..content_start + content_end];
                let cleaned = title.trim().to_string();
                if !cleaned.is_empty() && !cleaned.contains("Search") && !cleaned.contains("code, repositories") && !cleaned.contains("Choose a tag") {
                    return Some(cleaned);
                }
            }
        }
    }
    
    None
}

/// 从 release assets 中提取 Windows 安装程序链接
fn extract_windows_installer(assets: &[GithubReleaseAsset]) -> Option<(String, u64)> {
    // 优先查找 x64-setup.exe 结尾的文件
    for asset in assets {
        let name_lower = asset.name.to_lowercase();
        if name_lower.ends_with("x64-setup.exe") || name_lower.ends_with("_setup.exe") {
            return Some((asset.browser_download_url.clone(), asset.size));
        }
    }
    
    // 如果没有找到，查找任何 .exe 文件
    for asset in assets {
        let name_lower = asset.name.to_lowercase();
        if name_lower.ends_with(".exe") {
            return Some((asset.browser_download_url.clone(), asset.size));
        }
    }
    
    None
}

/// 处理 release 数据
fn process_release(
    current_version: &str,
    release: GithubRelease,
) -> Result<UpdateCheckResult, String> {
    // 忽略草稿和预发布版本
    if release.draft || release.prerelease {
        return Ok(UpdateCheckResult {
            has_update: false,
            current_version: current_version.to_string(),
            latest_version: release.tag_name.clone(),
            download_url: release.html_url.clone(),
            installer_url: None,
            installer_size: None,
            release_name: release.name.clone(),
            release_notes: release.body.unwrap_or_default(),
            published_at: release.published_at,
            error: None,
        });
    }

    let current = SemVer::parse(current_version);
    let latest = SemVer::parse(&release.tag_name);

    let has_update = match (current, latest) {
        (Some(current), Some(latest)) => latest > current,
        _ => {
            // 如果解析失败，进行简单的字符串比较
            release.tag_name != current_version
        }
    };

    // 提取 Windows 安装程序链接
    let (installer_url, installer_size) = extract_windows_installer(&release.assets)
        .map(|(url, size)| (Some(url), Some(size)))
        .unwrap_or((None, None));

    Ok(UpdateCheckResult {
        has_update,
        current_version: current_version.to_string(),
        latest_version: release.tag_name,
        download_url: release.html_url,
        installer_url,
        installer_size,
        release_name: release.name,
        release_notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_semver_parse() {
        let v = SemVer::parse("1.2.3").unwrap();
        assert_eq!(v.major, 1);
        assert_eq!(v.minor, 2);
        assert_eq!(v.patch, 3);
        assert_eq!(v.prerelease, None);

        let v = SemVer::parse("v1.2.3-beta").unwrap();
        assert_eq!(v.major, 1);
        assert_eq!(v.minor, 2);
        assert_eq!(v.patch, 3);
        assert_eq!(v.prerelease, Some("beta".to_string()));
    }

    #[test]
    fn test_semver_compare() {
        let v1 = SemVer::parse("1.0.0").unwrap();
        let v2 = SemVer::parse("1.0.1").unwrap();
        assert!(v2 > v1);

        let v1 = SemVer::parse("1.0.0").unwrap();
        let v2 = SemVer::parse("1.1.0").unwrap();
        assert!(v2 > v1);

        let v1 = SemVer::parse("1.0.0").unwrap();
        let v2 = SemVer::parse("2.0.0").unwrap();
        assert!(v2 > v1);

        let v1 = SemVer::parse("1.0.0-alpha").unwrap();
        let v2 = SemVer::parse("1.0.0").unwrap();
        assert!(v2 > v1);
    }

    #[test]
    fn test_extract_version_from_url() {
        assert_eq!(
            extract_version_from_url("https://github.com/misakimiku2/aurora-gallery-tauri/releases/tag/v1.0.0"),
            Some("1.0.0".to_string())
        );
        assert_eq!(
            extract_version_from_url("https://github.com/misakimiku2/aurora-gallery-tauri/releases/tag/v2.1.3"),
            Some("2.1.3".to_string())
        );
        assert_eq!(
            extract_version_from_url("https://github.com/owner/repo/releases/tag/v1.0.0-beta"),
            Some("1.0.0-beta".to_string())
        );
        assert_eq!(
            extract_version_from_url("https://github.com/owner/repo/releases/tag/1.0.0"),
            Some("1.0.0".to_string())
        );
    }

    #[test]
    fn test_extract_windows_installer() {
        let assets = vec![
            GithubReleaseAsset {
                name: "Aurora.Gallery_1.0.2_x64-setup.exe".to_string(),
                browser_download_url: "https://example.com/setup.exe".to_string(),
                size: 16777216,
                content_type: "application/x-msdownload".to_string(),
            },
            GithubReleaseAsset {
                name: "Source code (zip)".to_string(),
                browser_download_url: "https://example.com/source.zip".to_string(),
                size: 1024000,
                content_type: "application/zip".to_string(),
            },
        ];
        
        let result = extract_windows_installer(&assets);
        assert!(result.is_some());
        let (url, size) = result.unwrap();
        assert_eq!(url, "https://example.com/setup.exe");
        assert_eq!(size, 16777216);
    }
}
