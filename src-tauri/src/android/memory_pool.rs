use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct ThumbnailMemoryPool {
    pool_size: usize,
    cache: Mutex<HashMap<PathBuf, Arc<Vec<u8>>>>,
    current_usage: AtomicUsize,
    access_order: Mutex<Vec<PathBuf>>,
}

impl ThumbnailMemoryPool {
    pub fn new() -> Self {
        let total_mem = get_total_memory();
        let pool_size = match total_mem {
            mem if mem >= 8 * 1024 => 256 * 1024 * 1024,
            mem if mem >= 4 * 1024 => 128 * 1024 * 1024,
            _ => 64 * 1024 * 1024,
        };
        
        Self {
            pool_size,
            cache: Mutex::new(HashMap::new()),
            current_usage: AtomicUsize::new(0),
            access_order: Mutex::new(Vec::new()),
        }
    }
    
    pub fn get(&self, path: &PathBuf) -> Option<Arc<Vec<u8>>> {
        let cache = self.cache.lock().unwrap();
        cache.get(path).cloned()
    }
    
    pub fn put(&self, path: PathBuf, data: Vec<u8>) {
        let data_size = data.len();
        
        while self.current_usage.load(Ordering::Relaxed) + data_size > self.pool_size {
            self.evict_oldest();
        }
        
        let mut cache = self.cache.lock().unwrap();
        let mut order = self.access_order.lock().unwrap();
        
        cache.insert(path.clone(), Arc::new(data));
        order.push(path);
        
        self.current_usage.fetch_add(data_size, Ordering::SeqCst);
    }
    
    fn evict_oldest(&self) {
        let mut cache = self.cache.lock().unwrap();
        let mut order = self.access_order.lock().unwrap();
        
        if let Some(path) = order.first().cloned() {
            if let Some(data) = cache.remove(&path) {
                let size = data.len();
                self.current_usage.fetch_sub(size, Ordering::SeqCst);
            }
            order.remove(0);
        }
    }
    
    pub fn clear(&self) {
        let mut cache = self.cache.lock().unwrap();
        let mut order = self.access_order.lock().unwrap();
        
        cache.clear();
        order.clear();
        self.current_usage.store(0, Ordering::SeqCst);
    }
    
    pub fn get_usage(&self) -> usize {
        self.current_usage.load(Ordering::Relaxed)
    }
    
    pub fn get_pool_size(&self) -> usize {
        self.pool_size
    }
}

fn get_total_memory() -> usize {
    #[cfg(target_os = "android")]
    {
        use std::fs;
        let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
        for line in meminfo.lines() {
            if line.starts_with("MemTotal:") {
                let kb: String = line
                    .chars()
                    .filter(|c| c.is_ascii_digit())
                    .collect();
                return kb.parse::<usize>().unwrap_or(0) / 1024;
            }
        }
        0
    }
    
    #[cfg(not(target_os = "android"))]
    {
        num_cpus::get() * 1024
    }
}

pub enum MemoryPressure {
    Normal,
    Warning,
    Critical,
}

pub struct MemoryPressureMonitor;

impl MemoryPressureMonitor {
    pub fn check() -> MemoryPressure {
        #[cfg(target_os = "android")]
        {
            use std::fs;
            let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
            let mut available = 0u64;
            let mut total = 0u64;
            
            for line in meminfo.lines() {
                if line.starts_with("MemAvailable:") {
                    available = Self::parse_kb(line);
                } else if line.starts_with("MemTotal:") {
                    total = Self::parse_kb(line);
                }
            }
            
            if total == 0 {
                return MemoryPressure::Normal;
            }
            
            let usage_ratio = 1.0 - (available as f64 / total as f64);
            
            if usage_ratio > 0.9 {
                MemoryPressure::Critical
            } else if usage_ratio > 0.75 {
                MemoryPressure::Warning
            } else {
                MemoryPressure::Normal
            }
        }
        
        #[cfg(not(target_os = "android"))]
        {
            MemoryPressure::Normal
        }
    }
    
    fn parse_kb(line: &str) -> u64 {
        line.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0)
    }
}

pub static THUMBNAIL_POOL: Lazy<ThumbnailMemoryPool> = Lazy::new(ThumbnailMemoryPool::new);
