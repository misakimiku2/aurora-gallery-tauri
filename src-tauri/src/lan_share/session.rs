use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::types::{Session, SESSION_TIMEOUT_SECS};

pub struct SessionManager {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    token_to_device: Arc<RwLock<HashMap<String, String>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            token_to_device: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// 创建会话（同一 device_id 重连 = 换代，旧 token 立即失效）。
    ///
    /// 2026-10-11 硬化：双表（sessions / token_to_device）的「清旧 + 立新」收进同一
    /// 临界区，并 retain 清掉该 device 的全部历史 token 映射（含并发交错窗口可能残留的
    /// 悬垂条目）。旧实现分两次独立加锁，并发认证交错时会留下「token_map 残留旧 token、
    /// sessions 已是新代」的乱态——旧 token 借残留映射继续放行、陈旧 logout 又按
    /// device 误删新会话（安卓端 15s 互踢振荡的两块拼图）。
    ///
    /// 锁序约定（全模块唯一）：同时持两把锁时一律 sessions → token_to_device，禁止反向。
    pub async fn create_session(&self, device_id: String, device_name: String, ip: String) -> Session {
        let session = Session::new(device_id, device_name, ip);

        let mut sessions = self.sessions.write().await;
        let mut token_map = self.token_to_device.write().await;

        let device = session.device_id.clone();
        sessions.insert(device.clone(), session.clone());
        token_map.retain(|_, v| v.as_str() != device.as_str());
        token_map.insert(session.token.clone(), device);

        session
    }

    /// 校验 token：**必须与当前会话的 token 严格一致**。
    ///
    /// 2026-10-11 两处修复：
    /// 1) 归属比对——token_map 可能残留旧代 token 的映射（历史并发窗口遗留）。旧实现
    ///    「查到 device_id 且有未过期会话就放行（仅 touch 当前会话）」会让已被顶替的旧
    ///    token 复活，与「同 device_id 顶旧 token」语义直接打架。现在不一致即判无效。
    /// 2) 死锁——旧实现在持有 sessions 写锁期间调用 remove_session_internal（其内部
    ///    再次 await 同一把写锁）。tokio::sync::RwLock 不可重入：某设备会话首次过期、
    ///    且其请求恰好早于清理循环到达时，会永久挂死整张会话表。现改为出块释放锁后再删。
    pub async fn validate_token(&self, token: &str) -> Option<Session> {
        let device_id = {
            let token_map = self.token_to_device.read().await;
            token_map.get(token).cloned()
        }?;

        let mut expired = false;
        let result = {
            let mut sessions = self.sessions.write().await;
            match sessions.get_mut(&device_id) {
                // 悬垂映射：token 已换代，本次请求判无效（不再借尸还魂）
                Some(session) if session.token.as_str() != token => None,
                Some(session) => {
                    if session.is_expired(SESSION_TIMEOUT_SECS) {
                        expired = true;
                        None
                    } else {
                        session.touch();
                        Some(session.clone())
                    }
                }
                None => None,
            }
        };
        // 过期删除必须在锁外执行（remove_session_internal 会重新获取写锁，锁内调用即死锁）
        if expired {
            self.remove_session_internal(&device_id, token).await;
        }
        result
    }

    /// 按 token 取会话（logout 用）。同样要求 token 与当前会话严格一致——
    /// 悬垂旧 token 不再冒充身份返回会话（否则 handle_logout 会误拿新代会话信息）。
    pub async fn get_session_by_token(&self, token: &str) -> Option<Session> {
        let device_id = {
            let token_map = self.token_to_device.read().await;
            token_map.get(token).cloned()
        }?;

        let sessions = self.sessions.read().await;
        sessions
            .get(&device_id)
            .filter(|s| s.token.as_str() == token)
            .cloned()
    }

    /// 按 token 注销会话（logout）。
    ///
    /// 2026-10-11 硬化：只删「传入 token 与当前会话 token 一致」的会话。旧实现凭 token
    /// 查到 device_id 后无条件删该 device 的**当前**会话——传入的是已被顶替的旧 token 时
    /// （token_map 残留映射 + 安卓端 cleanup 的 fire-and-forget logout 恰好携带陈旧
    /// token），会把刚签发的新会话连坐误杀。不一致（悬垂条目）只清理映射本身。
    pub async fn remove_session(&self, token: &str) {
        let device_id = {
            let token_map = self.token_to_device.read().await;
            token_map.get(token).cloned()
        };

        if let Some(device_id) = device_id {
            let mut sessions = self.sessions.write().await;
            let mut token_map = self.token_to_device.write().await;
            let is_current = sessions
                .get(&device_id)
                .map(|s| s.token.as_str() == token)
                .unwrap_or(false);
            if is_current {
                sessions.remove(&device_id);
            }
            token_map.remove(token);
        }
    }

    /// 按 device_id 移除会话（桌面端主动"断开"设备时使用），返回是否移除成功。
    /// 强踢语义：连同该 device 的全部 token 映射（含悬垂残留）一并清理。
    pub async fn remove_session_by_device(&self, device_id: &str) -> bool {
        let session = {
            let mut sessions = self.sessions.write().await;
            sessions.remove(device_id)
        };
        if let Some(session) = session {
            let mut token_map = self.token_to_device.write().await;
            token_map.retain(|_, v| v.as_str() != session.device_id.as_str());
            return true;
        }
        false
    }

    async fn remove_session_internal(&self, device_id: &str, token: &str) {
        // 前置约定：调用方传入的 (device_id, token) 必须取自 sessions 表的真值
        //（外部输入路径一律走 remove_session 的一致性检查，不要用外部输入直达本函数）。
        let mut sessions = self.sessions.write().await;
        sessions.remove(device_id);

        let mut token_map = self.token_to_device.write().await;
        token_map.remove(token);
    }

    pub async fn cleanup_expired(&self) {
        let expired_tokens: Vec<(String, String)> = {
            let sessions = self.sessions.read().await;
            sessions
                .iter()
                .filter(|(_, session)| session.is_expired(SESSION_TIMEOUT_SECS))
                .map(|(device_id, session)| (device_id.clone(), session.token.clone()))
                .collect()
        };

        for (device_id, token) in expired_tokens {
            self.remove_session_internal(&device_id, &token).await;
        }
    }

    pub async fn get_all_sessions(&self) -> Vec<Session> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }

    pub async fn get_device_count(&self) -> usize {
        let sessions = self.sessions.read().await;
        sessions.len()
    }

    pub async fn rename_device(&self, device_id: &str, new_name: &str) -> bool {
        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(device_id) {
            session.device_name = new_name.to_string();
            return true;
        }
        false
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// 把某设备的 last_active 拨回过期前（模拟 3600s 不活跃）。
    async fn force_expired(mgr: &SessionManager, device_id: &str) {
        let mut sessions = mgr.sessions.write().await;
        let s = sessions.get_mut(device_id).expect("session 应存在");
        s.last_active = Instant::now() - Duration::from_secs(SESSION_TIMEOUT_SECS + 60);
    }

    #[tokio::test]
    async fn same_device_reissue_invalidates_old_token() {
        let mgr = SessionManager::new();
        let s1 = mgr
            .create_session("dev-1".into(), "phone".into(), "10.0.0.2".into())
            .await;
        let s2 = mgr
            .create_session("dev-1".into(), "phone".into(), "10.0.0.2".into())
            .await;

        assert!(
            mgr.validate_token(&s1.token).await.is_none(),
            "旧 token 换代后必须立即失效"
        );
        assert!(mgr.validate_token(&s2.token).await.is_some(), "新 token 必须有效");
    }

    #[tokio::test]
    async fn stale_logout_does_not_kill_current_session() {
        let mgr = SessionManager::new();
        let s1 = mgr
            .create_session("dev-1".into(), "phone".into(), "10.0.0.2".into())
            .await;
        let s2 = mgr
            .create_session("dev-1".into(), "phone".into(), "10.0.0.2".into())
            .await;

        // 陈旧 token 的 logout：不得连坐误删刚签发的新会话
        mgr.remove_session(&s1.token).await;
        assert!(
            mgr.validate_token(&s2.token).await.is_some(),
            "陈旧 token 的 logout 不得影响当前会话"
        );
        assert!(
            mgr.get_session_by_token(&s1.token).await.is_none(),
            "陈旧 token 不得冒充身份取到会话"
        );
    }

    #[tokio::test]
    async fn expired_session_validate_does_not_deadlock() {
        let mgr = SessionManager::new();
        let s1 = mgr
            .create_session("dev-1".into(), "phone".into(), "10.0.0.2".into())
            .await;
        force_expired(&mgr, "dev-1").await;

        // 旧实现在此会因写锁重入永久挂起；修复后必须快速返回 None
        let r = tokio::time::timeout(Duration::from_secs(2), mgr.validate_token(&s1.token)).await;
        assert!(r.is_ok(), "过期校验不得死锁（旧实现在此永久挂起）");
        assert!(r.unwrap().is_none(), "过期会话应判无效");

        // 重新认证照常工作（过期会话已被惰性清理，无残留映射）
        let s2 = mgr
            .create_session("dev-1".into(), "phone".into(), "10.0.0.2".into())
            .await;
        assert!(mgr.validate_token(&s2.token).await.is_some(), "重新认证后应恢复可用");
        assert!(mgr.validate_token(&s1.token).await.is_none(), "旧 token 不得复活");
    }
}
