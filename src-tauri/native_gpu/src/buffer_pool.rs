use std::collections::HashMap;

pub struct BufferPool {
    buffers: HashMap<u64, Vec<wgpu::Buffer>>,
}

impl BufferPool {
    pub fn new() -> Self {
        Self {
            buffers: HashMap::new(),
        }
    }

    pub fn get_buffer(&mut self, device: &wgpu::Device, size: u64, usage: wgpu::BufferUsages) -> wgpu::Buffer {
        if let Some(list) = self.buffers.get_mut(&size) {
            if let Some(buffer) = list.pop() {
                // Check if usage matches or if we need a new one
                // For now, keep it simple and just return the buffer if available
                return buffer;
            }
        }
        
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Pooled Buffer"),
            size,
            usage,
            mapped_at_creation: false,
        })
    }

    pub fn return_buffer(&mut self, size: u64, buffer: wgpu::Buffer) {
        self.buffers.entry(size).or_insert_with(Vec::new).push(buffer);
    }
}
