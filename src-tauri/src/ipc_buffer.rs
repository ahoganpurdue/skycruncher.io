use std::collections::HashMap;
use std::sync::Arc;

pub type BufferHandle = u64;

/// Registry for large binary buffers held in Rust memory, keyed by u64 handles.
///
/// HONEST STATUS (docs/NEXT_MOVES.md §14.f): the intended zero-copy protocol
/// was never completed. The registration command still receives the full
/// buffer across IPC, and no command consumes a stored buffer (`get()` has
/// zero callers outside these tests) — so the "avoids the JSON serialization
/// bottleneck" goal is NOT achieved by the current wiring. Kept only as the
/// storage half of a future raw-bytes IPC redesign (§14.c) — or delete.
pub struct BufferRegistry {
    buffers: HashMap<BufferHandle, Arc<Vec<u8>>>,
    next_id: BufferHandle,
}

impl BufferRegistry {
    pub fn new() -> Self {
        Self {
            buffers: HashMap::new(),
            next_id: 1,
        }
    }

    /// Store a buffer and return a lightweight handle ID.
    /// The buffer is wrapped in Arc for zero-copy sharing between pipeline stages.
    pub fn register(&mut self, data: Vec<u8>) -> BufferHandle {
        let id = self.next_id;
        self.next_id += 1;
        self.buffers.insert(id, Arc::new(data));
        log::info!("[BufferRegistry] Registered handle {} ({} bytes)", id, self.buffers[&id].len());
        id
    }

    /// Retrieve buffer by handle (zero-copy Arc clone).
    pub fn get(&self, handle: BufferHandle) -> Option<Arc<Vec<u8>>> {
        self.buffers.get(&handle).cloned()
    }

    /// Release buffer when pipeline stage is complete.
    /// Returns true if the handle existed and was removed.
    pub fn release(&mut self, handle: BufferHandle) -> bool {
        let removed = self.buffers.remove(&handle).is_some();
        if removed {
            log::info!("[BufferRegistry] Released handle {}", handle);
        }
        removed
    }

    /// Get the number of active buffers (for diagnostics).
    pub fn active_count(&self) -> usize {
        self.buffers.len()
    }

    /// Get total memory held across all active buffers.
    pub fn total_bytes(&self) -> usize {
        self.buffers.values().map(|b| b.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_and_get() {
        let mut registry = BufferRegistry::new();
        let data = vec![1u8, 2, 3, 4];
        let handle = registry.register(data.clone());
        
        let retrieved = registry.get(handle).unwrap();
        assert_eq!(&*retrieved, &data);
    }

    #[test]
    fn test_release() {
        let mut registry = BufferRegistry::new();
        let handle = registry.register(vec![0u8; 100]);
        
        assert!(registry.release(handle));
        assert!(registry.get(handle).is_none());
        assert!(!registry.release(handle)); // double-release is no-op
    }

    #[test]
    fn test_handles_are_unique() {
        let mut registry = BufferRegistry::new();
        let h1 = registry.register(vec![1]);
        let h2 = registry.register(vec![2]);
        assert_ne!(h1, h2);
    }
}
