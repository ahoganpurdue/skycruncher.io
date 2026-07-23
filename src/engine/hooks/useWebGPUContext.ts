import { useState, useEffect } from 'react';
import { WebGPUContext } from '../core/WebGPUContext';

/**
 * useWebGPUContext
 * 
 * Reactive hook for managing the WebGPU device lifecycle.
 * Returns the device and loading/error states.
 */
export function useWebGPUContext() {
    const [device, setDevice] = useState<GPUDevice | null>(WebGPUContext.getDevice());
    const [isLoading, setIsLoading] = useState(!WebGPUContext.isAvailable());
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;

        const init = async () => {
            if (WebGPUContext.isAvailable()) {
                setDevice(WebGPUContext.getDevice());
                setIsLoading(false);
                return;
            }

            setIsLoading(true);
            try {
                const dev = await WebGPUContext.init();
                if (mounted) {
                    setDevice(dev);
                    if (!dev) {
                        setError('WebGPU not supported or initialization failed');
                    }
                }
            } catch (err: any) {
                if (mounted) {
                    setError(err.message || 'Failed to initialize WebGPU');
                }
            } finally {
                if (mounted) {
                    setIsLoading(false);
                }
            }
        };

        init();

        return () => {
            mounted = false;
        };
    }, []);

    return {
        device,
        isAvailable: !!device,
        isLoading,
        error
    };
}
