/**
 * WebGPUContext SINGLETON LIFECYCLE — device acquisition, cross-library monkeypatch,
 * and device-loss recovery. (Renamed from gpu_pipeline.test.ts: the old name implied
 * GPU *pipeline math* coverage, but this file runs NO compute shader / WGSL kernel — the
 * device/adapter are fully mocked. The numeric GPU kernels remain UNTESTED at the unit
 * level; that gap is real and belongs to a future single-kernel readback test lane.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebGPUContext } from '../core/WebGPUContext';

describe('WebGPUContext singleton lifecycle (no GPU-math coverage — see header)', () => {
    
    beforeEach(() => {
        WebGPUContext.reset();
        vi.restoreAllMocks();
    });

    it('should maintain a single GPUDevice instance across multiple init calls', async () => {
        const mockDevice = { label: 'mock-device', lost: new Promise(() => {}) } as any;
        const mockAdapter = {
            requestDevice: vi.fn().mockResolvedValue(mockDevice),
            limits: {
                maxStorageBufferBindingSize: 1024,
                maxBufferSize: 1024
            },
            constructor: {
                prototype: {
                    requestDevice: vi.fn()
                }
            }
        } as any;

        // Mock navigator.gpu
        vi.stubGlobal('navigator', {
            gpu: {
                requestAdapter: vi.fn().mockResolvedValue(mockAdapter)
            }
        });

        const device1 = await WebGPUContext.init();
        const device2 = await WebGPUContext.init();

        expect(device1).toBe(mockDevice);
        expect(device2).toBe(mockDevice);
        expect(mockAdapter.requestDevice).toHaveBeenCalledTimes(1);
    });

    it('should monkeypatch GPUAdapter.requestDevice to return the singleton', async () => {
        const mockDevice = { label: 'SkyCruncher_Primary_Compute', lost: new Promise(() => {}) } as any;
        
        // We need a class-like structure to test prototype monkeypatching
        class MockAdapter {
            limits = { maxStorageBufferBindingSize: 1024, maxBufferSize: 1024 };
            async requestDevice() { return mockDevice; }
        }
        
        const adapterInstance = new MockAdapter();
        
        vi.stubGlobal('navigator', {
            gpu: {
                requestAdapter: vi.fn().mockResolvedValue(adapterInstance)
            }
        });

        // Initialize to trigger monkeypatch
        const primaryDevice = await WebGPUContext.init();
        expect(primaryDevice).toBe(mockDevice);

        // Now simulate a library (like ORT) trying to request its own device
        const secondaryDevice = await (adapterInstance as any).requestDevice({ label: 'Foreign_Library_Device' });
        
        // It SHOULD be intercepted and return our primary device
        expect(secondaryDevice).toBe(mockDevice);
        expect(secondaryDevice.label).toBe('SkyCruncher_Primary_Compute');
    });

    it('should handle device loss by clearing the cache', async () => {
        let deviceLostCallback: ((info: any) => void) | undefined;
        const lostPromise = new Promise((resolve) => {
            deviceLostCallback = resolve;
        });

        const mockDevice = { 
            label: 'mock-device', 
            lost: lostPromise 
        } as any;
        
        const mockAdapter = {
            requestDevice: vi.fn().mockResolvedValue(mockDevice),
            limits: { maxStorageBufferBindingSize: 1024, maxBufferSize: 1024 },
            constructor: { prototype: { requestDevice: vi.fn() } }
        } as any;

        vi.stubGlobal('navigator', {
            gpu: { requestAdapter: vi.fn().mockResolvedValue(mockAdapter) }
        });

        await WebGPUContext.init();
        expect(WebGPUContext.getDevice()).toBe(mockDevice);

        // Trigger device loss
        if (deviceLostCallback) deviceLostCallback({ message: 'Device test loss', reason: 'destroyed' });
        
        // Wait a tick for the promise to resolve
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(WebGPUContext.getDevice()).toBeNull();
    });
});
