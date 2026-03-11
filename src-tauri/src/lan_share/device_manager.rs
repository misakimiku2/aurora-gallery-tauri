use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

use super::types::{ConnectedDevice, Session};

pub struct DeviceManager {
    devices: Arc<RwLock<HashMap<String, ConnectedDevice>>>,
}

impl DeviceManager {
    pub fn new() -> Self {
        Self {
            devices: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn register_device(&self, session: &Session) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let device = ConnectedDevice {
            id: session.device_id.clone(),
            name: session.device_name.clone(),
            ip: session.ip.clone(),
            connected_at: now,
            last_active_at: now,
        };

        let mut devices = self.devices.write().await;
        devices.insert(device.id.clone(), device);
    }

    pub async fn update_activity(&self, device_id: &str) {
        let mut devices = self.devices.write().await;
        if let Some(device) = devices.get_mut(device_id) {
            device.last_active_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
        }
    }

    pub async fn remove_device(&self, device_id: &str) {
        let mut devices = self.devices.write().await;
        devices.remove(device_id);
    }

    pub async fn get_devices(&self) -> Vec<ConnectedDevice> {
        let devices = self.devices.read().await;
        devices.values().cloned().collect()
    }

    pub async fn get_device_count(&self) -> usize {
        let devices = self.devices.read().await;
        devices.len()
    }

    pub async fn cleanup_inactive(&self, timeout_secs: u64) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let inactive_ids: Vec<String> = {
            let devices = self.devices.read().await;
            devices
                .iter()
                .filter(|(_, device)| now.saturating_sub(device.last_active_at) > timeout_secs)
                .map(|(id, _)| id.clone())
                .collect()
        };

        let mut devices = self.devices.write().await;
        for id in inactive_ids {
            devices.remove(&id);
        }
    }
}

impl Default for DeviceManager {
    fn default() -> Self {
        Self::new()
    }
}
