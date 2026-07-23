import { srgbToXYZ, xyzToOklab, sRGBColor, OklabColor } from '../../engine/core/colormath';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// X11 NAMED COLORS â€” For Perceptual Matching
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface NamedColor {
  name: string;
  rgb: sRGBColor;
  oklab: OklabColor;
}

/** 
 * Find the nearest X11 color name using Oklab Euclidean distance.
 * Oklab is used because it is perceptually uniform, meaning the
 * mathematical distance corresponds well to human perceived difference.
 */
export function getNearestX11Color(r: number, g: number, b: number): NamedColor {
  const inputOklab = xyzToOklab(
    ...Object.values(srgbToXYZ(r, g, b)) as [number, number, number]
  );
  
  let minDist = Infinity;
  let nearest = X11_COLORS[0];

  for (const c of X11_COLORS) {
    // Euclidean distance in Oklab (L, a, b)
    const dL = c.oklab.L - inputOklab.L;
    const da = c.oklab.a - inputOklab.a;
    const db = c.oklab.b - inputOklab.b;
    const dist = dL*dL + da*da + db*db;
    
    if (dist < minDist) {
      minDist = dist;
      nearest = c;
    }
  }
  return nearest;
}

// Pre-calculate Oklab for all X11 colors to avoid runtime conversion
function createX11(name: string, r: number, g: number, b: number): NamedColor {
  const xyz = srgbToXYZ(r, g, b);
  return {
    name,
    rgb: { r, g, b },
    oklab: xyzToOklab(xyz.X, xyz.Y, xyz.Z)
  };
}

const X11_COLORS: NamedColor[] = [
  createX11('Black', 0, 0, 0),
  createX11('Navy', 0, 0, 128),
  createX11('DarkBlue', 0, 0, 139),
  createX11('MediumBlue', 0, 0, 205),
  createX11('Blue', 0, 0, 255),
  createX11('DarkGreen', 0, 100, 0),
  createX11('Green', 0, 128, 0),
  createX11('Teal', 0, 128, 128),
  createX11('DarkCyan', 0, 139, 139),
  createX11('DeepSkyBlue', 0, 191, 255),
  createX11('DarkTurquoise', 0, 206, 209),
  createX11('MediumSpringGreen', 0, 250, 154),
  createX11('Lime', 0, 255, 0),
  createX11('SpringGreen', 0, 255, 127),
  createX11('Aqua', 0, 255, 255),
  createX11('Cyan', 0, 255, 255),
  createX11('MidnightBlue', 25, 25, 112),
  createX11('DodgerBlue', 30, 144, 255),
  createX11('LightSeaGreen', 32, 178, 170),
  createX11('ForestGreen', 34, 139, 34),
  createX11('SeaGreen', 46, 139, 87),
  createX11('DarkSlateGray', 47, 79, 79),
  createX11('LimeGreen', 50, 205, 50),
  createX11('MediumSeaGreen', 60, 179, 113),
  createX11('Turquoise', 64, 224, 208),
  createX11('RoyalBlue', 65, 105, 225),
  createX11('SteelBlue', 70, 130, 180),
  createX11('DarkSlateBlue', 72, 61, 139),
  createX11('MediumTurquoise', 72, 209, 204),
  createX11('Indigo', 75, 0, 130),
  createX11('DarkOliveGreen', 85, 107, 47),
  createX11('CadetBlue', 95, 158, 160),
  createX11('CornflowerBlue', 100, 149, 237),
  createX11('MediumAquaMarine', 102, 205, 170),
  createX11('DimGray', 105, 105, 105),
  createX11('SlateBlue', 106, 90, 205),
  createX11('OliveDrab', 107, 142, 35),
  createX11('SlateGray', 112, 128, 144),
  createX11('LightSlateGray', 119, 136, 153),
  createX11('MediumSlateBlue', 123, 104, 238),
  createX11('LawnGreen', 124, 252, 0),
  createX11('Chartreuse', 127, 255, 0),
  createX11('Aquamarine', 127, 255, 212),
  createX11('Maroon', 128, 0, 0),
  createX11('Purple', 128, 0, 128),
  createX11('Olive', 128, 128, 0),
  createX11('Gray', 128, 128, 128),
  createX11('SkyBlue', 135, 206, 235),
  createX11('LightSkyBlue', 135, 206, 250),
  createX11('BlueViolet', 138, 43, 226),
  createX11('DarkRed', 139, 0, 0),
  createX11('DarkMagenta', 139, 0, 139),
  createX11('SaddleBrown', 139, 69, 19),
  createX11('DarkSeaGreen', 143, 188, 143),
  createX11('LightGreen', 144, 238, 144),
  createX11('MediumPurple', 147, 112, 219),
  createX11('DarkViolet', 148, 0, 211),
  createX11('PaleGreen', 152, 251, 152),
  createX11('DarkOrchid', 153, 50, 204),
  createX11('YellowGreen', 154, 205, 50),
  createX11('Sienna', 160, 82, 45),
  createX11('Brown', 165, 42, 42),
  createX11('DarkGray', 169, 169, 169),
  createX11('LightBlue', 173, 216, 230),
  createX11('GreenYellow', 173, 255, 47),
  createX11('PaleTurquoise', 175, 238, 238),
  createX11('LightSteelBlue', 176, 196, 222),
  createX11('PowderBlue', 176, 224, 230),
  createX11('FireBrick', 178, 34, 34),
  createX11('DarkGoldenRod', 184, 134, 11),
  createX11('MediumOrchid', 186, 85, 211),
  createX11('RosyBrown', 188, 143, 143),
  createX11('DarkKhaki', 189, 183, 107),
  createX11('Silver', 192, 192, 192),
  createX11('MediumVioletRed', 199, 21, 133),
  createX11('IndianRed', 205, 92, 92),
  createX11('Peru', 205, 133, 63),
  createX11('Chocolate', 210, 105, 30),
  createX11('Tan', 210, 180, 140),
  createX11('LightGray', 211, 211, 211),
  createX11('Thistle', 216, 191, 216),
  createX11('Orchid', 218, 112, 214),
  createX11('GoldenRod', 218, 165, 32),
  createX11('PaleVioletRed', 219, 112, 147),
  createX11('Crimson', 220, 20, 60),
  createX11('Gainsboro', 220, 220, 220),
  createX11('Plum', 221, 160, 221),
  createX11('BurlyWood', 222, 184, 135),
  createX11('LightCyan', 224, 255, 255),
  createX11('Lavender', 230, 230, 250),
  createX11('DarkSalmon', 233, 150, 122),
  createX11('Violet', 238, 130, 238),
  createX11('PaleGoldenRod', 238, 232, 170),
  createX11('LightCoral', 240, 128, 128),
  createX11('Khaki', 240, 230, 140),
  createX11('AliceBlue', 240, 248, 255),
  createX11('HoneyDew', 240, 255, 240),
  createX11('Azure', 240, 255, 255),
  createX11('SandyBrown', 244, 164, 96),
  createX11('Wheat', 245, 222, 179),
  createX11('Beige', 245, 245, 220),
  createX11('WhiteSmoke', 245, 245, 245),
  createX11('MintCream', 245, 255, 250),
  createX11('GhostWhite', 248, 248, 255),
  createX11('Salmon', 250, 128, 114),
  createX11('AntiqueWhite', 250, 235, 215),
  createX11('Linen', 250, 240, 230),
  createX11('LightGoldenRodYellow', 250, 250, 210),
  createX11('OldLace', 253, 245, 230),
  createX11('Red', 255, 0, 0),
  createX11('Magenta', 255, 0, 255),
  createX11('Fuchsia', 255, 0, 255),
  createX11('DeepPink', 255, 20, 147),
  createX11('OrangeRed', 255, 69, 0),
  createX11('Tomato', 255, 99, 71),
  createX11('HotPink', 255, 105, 180),
  createX11('Coral', 255, 127, 80),
  createX11('DarkOrange', 255, 140, 0),
  createX11('LightSalmon', 255, 160, 122),
  createX11('Orange', 255, 165, 0),
  createX11('LightPink', 255, 182, 193),
  createX11('Pink', 255, 192, 203),
  createX11('Gold', 255, 215, 0),
  createX11('PeachPuff', 255, 218, 185),
  createX11('NavajoWhite', 255, 222, 173),
  createX11('Moccasin', 255, 228, 181),
  createX11('Bisque', 255, 228, 196),
  createX11('MistyRose', 255, 228, 225),
  createX11('BlanchedAlmond', 255, 235, 205),
  createX11('PapayaWhip', 255, 239, 213),
  createX11('LavenderBlush', 255, 240, 245),
  createX11('SeaShell', 255, 245, 238),
  createX11('Cornsilk', 255, 248, 220),
  createX11('LemonChiffon', 255, 250, 205),
  createX11('FloralWhite', 255, 250, 240),
  createX11('Snow', 255, 250, 250),
  createX11('Yellow', 255, 255, 0),
  createX11('LightYellow', 255, 255, 224),
  createX11('Ivory', 255, 255, 240),
  createX11('White', 255, 255, 255)
];

