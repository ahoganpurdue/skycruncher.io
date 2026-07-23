/**
 * SCALE MANAGER â€” Central Source of Truth for Coordinate Mapping
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Manages transitions between three distinct resolution spaces:
 * 1. NATIVE: 1:1 Physical Sensor Pixels (e.g. 5184 x 3456)
 * 2. science: Binned/Processing area (e.g. 2592 x 1728)
 * 3. PREVIEW: Browser Visual Canvas (e.g. 1920 x 1280)
 */

export class ScaleManager {
    public static readonly PIXEL_SIZE_MM = 0.00376; // Default for many Sony/Nikon sensors
    public readonly nativeW: number;
    public readonly nativeH: number;
    
    public readonly scienceW: number;
    public readonly scienceH: number;
    
    public readonly previewW: number;
    public readonly previewH: number;
    
    public readonly ui_scale_factor: number;

    constructor(sensorW: number, sensorH: number, maxPreviewDim: number = 1920) {
        // 1. Native Space
        this.nativeW = sensorW;
        this.nativeH = sensorH;

        // 2. science Space (Assuming 2x2 Bayer Binning)
        this.scienceW = Math.floor(sensorW / 2);
        this.scienceH = Math.floor(sensorH / 2);

        // 3. UI Preview Space
        const scale = Math.min(1.0, maxPreviewDim / sensorW);
        this.previewW = Math.floor(sensorW * scale);
        this.previewH = Math.floor(sensorH * scale);
        
        this.ui_scale_factor = this.previewW / this.nativeW;
    }

    // --- COORDINATE TRANSLATORS ---

    /** Maps a star found in the binned science buffer back to the real Sensor coordinates */
    public scienceToNative(x: number, y: number) {
        return {
            x: x * (this.nativeW / this.scienceW),
            y: y * (this.nativeH / this.scienceH)
        };
    }

    /** Maps a NATIVE sensor coordinate down to the science buffer */
    public nativeToscience(x: number, y: number) {
        return {
            x: x * (this.scienceW / this.nativeW),
            y: y * (this.scienceH / this.nativeH)
        };
    }

    /** Maps a true Sensor coordinate down to the visual UI canvas */
    public nativeToPreview(x: number, y: number) {
        return {
            x: x * (this.previewW / this.nativeW),
            y: y * (this.previewH / this.nativeH)
        };
    }
    
    /** Maps a Preview coordinate back to 1:1 Sensor space */
    public previewToNative(x: number, y: number) {
        return {
            x: x * (this.nativeW / this.previewW),
            y: y * (this.nativeH / this.previewH)
        };
    }

    // --- SCALE TRANSLATORS (arcsec/px) ---

    /** Returns the arcsec/px for the science buffer given the native scale */
    public getscienceScale(nativeScale: number): number {
        return nativeScale * (this.nativeW / this.scienceW);
    }

    /** Returns the arcsec/px for the Preview buffer given the native scale */
    public getPreviewScale(nativeScale: number): number {
        return nativeScale * (this.nativeW / this.previewW);
    }

    /** Returns the native arcsec/px given the scale of a specific buffer */
    public getNativeScale(bufferScale: number, bufferWidth: number): number {
        return bufferScale * (bufferWidth / this.nativeW);
    }

    /** Returns the scale of a specific buffer (arcsec/px) given the native scale */
    public getBufferScale(nativeScale: number, bufferWidth: number): number {
        return nativeScale * (this.nativeW / bufferWidth);
    }

    /**
     * Calculates the "Letterbox" scaling for an aspect-ratio fit into a canvas.
     */
    private getCanvasLetterbox(canvasW: number, canvasH: number) {
        const scale = Math.min(canvasW / this.previewW, canvasH / this.previewH);
        const ox = (canvasW - this.previewW * scale) / 2;
        const oy = (canvasH - this.previewH * scale) / 2;
        return { scale, ox, oy };
    }

    /**
     * Maps a coordinate from the Browser Canvas buffer back to 1:1 Sensor space.
     * Accounts for both Letterbox offsets and Preview->Native scaling.
     */
    public canvasToNative(cx: number, cy: number, canvasWidth: number, canvasHeight: number) {
        const { scale, ox, oy } = this.getCanvasLetterbox(canvasWidth, canvasHeight);
        
        // 1. Canvas -> Preview
        const px = (cx - ox) / scale;
        const py = (cy - oy) / scale;
        
        // 2. Preview -> Native
        return this.previewToNative(px, py);
    }

    /**
     * Maps a Native coordinate directly to the visible Canvas pixels.
     * Used for drawing overlays on the UI canvas.
     */
    public nativeToCanvas(nativeX: number, nativeY: number, canvasWidth: number, canvasHeight: number) {
        // 1. Native -> Preview
        const { x: px, y: py } = this.nativeToPreview(nativeX, nativeY);
        const { scale, ox, oy } = this.getCanvasLetterbox(canvasWidth, canvasHeight);
        
        // 2. Preview -> Canvas
        return {
            x: px * scale + ox,
            y: py * scale + oy
        };
    }

    /** Helper to attach scale metadata for the frontend to consume */
    public getFrontendExport() {
        return {
            sensor_width: this.nativeW,
            sensor_height: this.nativeH,
            preview_width: this.previewW,
            preview_height: this.previewH,
            // The frontend just multiplies native coordinates by this factor
            ui_scale_factor: this.previewW / this.nativeW 
        };
    }
}

