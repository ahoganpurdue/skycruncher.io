// Type surface for the shared bubble-tile renderer (tsc reads this for the
// .ts fixture test; the runtime lives in bubble_tiles.mjs). Loose by design —
// this is a render-layer tool, not engine canon.

export type RGB = [number, number, number];
export type TileStatus = 'pass' | 'warn' | 'fail' | 'absent' | 'info';

export interface Tile { label: string; value: string; status: TileStatus; }
export interface TileGroup { title: string; color: RGB; tiles: Tile[]; }

export interface Canvas { w: number; h: number; px: Uint8ClampedArray; }

export interface HeaderSpec {
  frame?: string;
  imageType?: string;
  rig?: string;
  statusText?: string;
  statusColor?: RGB;
}

export interface BuildGroupsInput {
  solution?: Record<string, unknown> | null;
  truth?: Record<string, unknown> | null;
  psf_field?: Record<string, unknown> | null;
  psf_attribution?: Record<string, unknown> | null;
  wcs?: Record<string, unknown> | null;
  astrometry?: Record<string, unknown> | null;
  detection?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export const PASS: RGB;
export const WARN: RGB;
export const FAIL: RGB;
export const ABSENT: RGB;
export const INFO: RGB;
export const TEXT: RGB;
export const DIM: RGB;
export const SHADOW: RGB;
export const FONT: Record<string, string[]>;

export function statusColor(s: TileStatus): RGB;
export function makeCanvas(w: number, h: number): Canvas;
export function blend(c: Canvas, x: number, y: number, r: number, g: number, b: number, a?: number): void;
export function setPx(c: Canvas, x: number, y: number, r: number, g: number, b: number, a?: number): void;
export function fillRect(c: Canvas, x0: number, y0: number, w: number, h: number, r: number, g: number, b: number, a?: number): void;
export function fillRoundRect(c: Canvas, x: number, y: number, w: number, h: number, rad: number, col: RGB, a?: number): void;
export function strokeRoundRect(c: Canvas, x: number, y: number, w: number, h: number, rad: number, col: RGB, a?: number): void;
export function dropShadow(c: Canvas, x: number, y: number, w: number, h: number, rad: number, a?: number): void;
export function drawChar(c: Canvas, ch: string, x: number, y: number, s: number, col: RGB, a?: number): void;
export function textWidth(str: string, s: number): number;
export function drawText(c: Canvas, str: string, x: number, y: number, s: number, col: RGB, a?: number, shadow?: boolean): number;
export function drawRing(c: Canvas, cx: number, cy: number, rad: number, col: RGB, a?: number): void;
export function buildGroups(input?: BuildGroupsInput): TileGroup[];
export function stretch(lum: Float32Array | number[], opts?: { asinh?: number; lo?: number; hi?: number }): Uint8ClampedArray;
export function grayToCanvas(gray: Uint8Array | Uint8ClampedArray, w: number, h: number): Canvas;
export function composite(c: Canvas, opts: { header?: HeaderSpec; groups?: TileGroup[] }): Canvas;
export function encodePng(c: Canvas): Buffer;
