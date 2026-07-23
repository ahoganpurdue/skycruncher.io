declare module 'libraw-wasm' {
    export interface LibRawMetadata {
        imageSize: {
            width: number;
            height: number;
        };
        // Add other properties as needed from the readme/API
    }

    export interface LibRawOptions {
        noInterpolation?: boolean;
        outputBps?: number;
        outputColor?: number;
        noAutoBright?: boolean;
        useCameraWb?: boolean;
        useAutoWb?: boolean;
        [key: string]: any;
    }

    export default class LibRaw {
        constructor();
        open(buffer: Uint8Array, options?: LibRawOptions): Promise<void>;
        metadata(fullOutput?: boolean): Promise<LibRawMetadata>;
        imageData(): Promise<Uint16Array | Uint8Array>;
    }
}

