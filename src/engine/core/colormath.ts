
/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * SkyCruncher: COLOR MATHEMATICS LAYER (MINIMAL)
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 */

export interface XYZColor { X: number; Y: number; Z: number; }
export interface sRGBColor { r: number; g: number; b: number; }
export interface OklabColor { L: number; a: number; b: number; }
export interface LabColor { L: number; a: number; b: number; }

/** Used by Zenith for atmospheric extinction calculations. */
export function srgbToXYZ(r: number, g: number, b: number): XYZColor {
  let R = r / 255; let G = g / 255; let B = b / 255;
  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
  return {
    X: R * 0.4124 + G * 0.3576 + B * 0.1805,
    Y: R * 0.2126 + G * 0.7152 + B * 0.0722,
    Z: R * 0.0193 + G * 0.1192 + B * 0.9505
  };
}

/** Used by Zenith for display-ready previews. */
export function xyzToSRGB(x: number, y: number, z: number): sRGBColor {
  let r =  3.2406 * x - 1.5372 * y - 0.4986 * z;
  let g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  let b =  0.0557 * x - 0.2040 * y + 1.0570 * z;
  r = r > 0.0031308 ? 1.055 * Math.pow(r, 1 / 2.4) - 0.055 : 12.92 * r;
  g = g > 0.0031308 ? 1.055 * Math.pow(g, 1 / 2.4) - 0.055 : 12.92 * g;
  b = b > 0.0031308 ? 1.055 * Math.pow(b, 1 / 2.4) - 0.055 : 12.92 * b;
  return {
    r: Math.max(0, Math.min(255, Math.round(r * 255))),
    g: Math.max(0, Math.min(255, Math.round(g * 255))),
    b: Math.max(0, Math.min(255, Math.round(b * 255)))
  };
}

/** Used for theoretical Planckian offsets. */
export function planckianXY(T: number): { x: number; y: number } {
  const xc = 1000 / T; let x: number;
  if (T >= 1667 && T <= 4000) {
    x = -0.2661239 * Math.pow(xc, 3) - 0.2343589 * Math.pow(xc, 2) + 0.8776956 * xc + 0.179910;
  } else {
    x = -3.0258469 * Math.pow(xc, 3) + 2.1070379 * Math.pow(xc, 2) + 0.2226347 * xc + 0.240390;
  }
  let y: number;
  if (T >= 1667 && T <= 2222) {
    y = -1.1063814 * x * x * x - 1.34811020 * x * x + 2.18555832 * x - 0.20219683;
  } else if (T > 2222 && T <= 4000) {
    y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.0817580 * x * x * x - 5.87338670 * x * x + 3.75112997 * x - 0.37001483;
  }
  return { x, y };
}

/** Convert x,y coordinates and luminance Y to XYZ. */
export function xyToXYZ(x: number, y: number, Y: number = 1.0): XYZColor {
  if (y === 0) return { X: 0, Y: 0, Z: 0 };
  return {
    X: (x * Y) / y,
    Y: Y,
    Z: ((1 - x - y) * Y) / y
  };
}

/** Convert XYZ to Oklab (perceptual color space). */
export function xyzToOklab(X: number, Y: number, Z: number): OklabColor {
  const l = 0.8189330101 * X + 0.3618667424 * Y - 0.1288597137 * Z;
  const m = 0.0329845436 * X + 0.9293118715 * Y + 0.0361456387 * Z;
  const s = 0.0482003018 * X + 0.2643662691 * Y + 0.6338517070 * Z;

  const l_ = Math.cbrt(Math.max(0, l));
  const m_ = Math.cbrt(Math.max(0, m));
  const s_ = Math.cbrt(Math.max(0, s));

  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  };
}

/** Convert XYZ to CIE Lab. */
export function xyzToLab(X: number, Y: number, Z: number): LabColor {
  // D65 illuminant
  const Xn = 0.950489; const Yn = 1.000000; const Zn = 1.088840;
  
  const f = (t: number) => t > Math.pow(6/29, 3) ? Math.pow(t, 1/3) : (1/3) * Math.pow(29/6, 2) * t + 4/29;
  
  const fX = f(X / Xn);
  const fY = f(Y / Yn);
  const fZ = f(Z / Zn);
  
  return {
    L: 116 * fY - 16,
    a: 500 * (fX - fY),
    b: 200 * (fY - fZ)
  };
}

/** Generate points along the Planckian Locus from 1667K to 25000K. */
export function planckianLocus(steps: number = 100): { T: number, xy: { x: number, y: number } }[] {
  const result: { T: number, xy: { x: number, y: number } }[] = [];
  const minT = 1667;
  const maxT = 25000;
  
  // Use log scale for better distribution of temperatures
  const logMin = Math.log(minT);
  const logMax = Math.log(maxT);
  
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const T = Math.exp(logMin + t * (logMax - logMin));
    result.push({ T, xy: planckianXY(T) });
  }
  
  return result;
}

