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

    pub async fn create_session(&self, device_id: String, device_name: String, ip: String) -> Session {
        let session = Session::new(device_id, device_name, ip);
        let token = session.token.clone();
        let device_id_clone = session.device_id.clone();

        // 同一 device_id 重连时，先取出旧 session 的 token，以便清理
        // token_to_device 中的旧映射，避免旧 token 仍然有效导致计数泄漏。
        let old_token = {
            let mut sessions = self.sessions.write().await;
            let old = sessions.remove(&device_id_clone).map(|s| s.token);
            sessions.insert(device_id_clone.clone(), session.clone());
            old
        };

        {
            let mut token_map = self.token_to_device.write().await;
            if let Some(old) = old_token {
                token_map.remove(&old);
            }
            token_map.insert(token, device_id_clone);
        }

        session
    }

    pub async fn validate_token(&self, token: &str) -> Option<Session> {
        let device_id = {
            let token_map = self.token_to_device.read().await;
            token_map.get(token).cloned()
        }?;

        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.get_mut(&device_id) {
            if session.is_expired(SESSION_TIMEOUT_SECS) {
                self.remove_session_internal(&device_id, &session.token).await;
                return None;
            }
            session.touch();
            return Some(session.clone());
        }
        None
    }

    pub async fn get_session_by_token(&self, token: &str) -> Option<Session> {
        let device_id = {
            let token_map = self.token_to_device.read().await;
            token_map.get(token).cloned()
        }?;

        let sessions = self.sessions.read().await;
        sessions.get(&device_id).cloned()
    }

    pub async fn remove_session(&self, token: &str) {
        let device_id = {
            let token_map = self.token_to_device.read().await;
            token_map.get(token).cloned()
        };

        if let Some(device_id) = device_id {
            let mut sessions = self.sessions.write().await;
            if let Some(session) = sessions.remove(&device_id) {
                let mut token_map = self.token_to_device.write().await;
                token_map.remove(&session.token);
            }
        }
    }

    async fn remove_session_internal(&self, device_id: &str, token: &str) {
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
