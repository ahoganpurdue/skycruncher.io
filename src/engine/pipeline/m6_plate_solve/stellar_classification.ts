/**
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * STELLAR CLASSIFICATION â€” Harvard & Yerkes reference Data
 * â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
 * 
 * Source: Wikipedia (Stellar Classification)
 * https://en.wikipedia.org/wiki/Stellar_classification
 * 
 * This data is used by the Zenith Normalizer and the Physics Engine to
 * categorize stars and validate observed color indices against physical models.
 */

export interface SpectralTypeInfo {
    type: string;
    temperatureRange: [number, number]; // [min, max] in Kelvin
    color: string;
    bvIndexRange: [number, number];     // [min, max] B-V index
    mainsequenceMass: number;           // Solar masses (typical)
    mainsequenceRadius: number;         // Solar radii (typical)
    mainsequenceLuminosity: number;     // Solar luminosities (typical)
}

/**
 * THE HARVARD CLASSIFICATION (Spectral Type)
 * Categorizes stars by temperature.
 */
export const HARVARD_SPECTRAL_TYPES: Record<string, SpectralTypeInfo> = {
    'O': {
        type: 'O',
        temperatureRange: [30000, 100000],
        color: 'Blue',
        bvIndexRange: [-0.33, -0.30],
        mainsequenceMass: 16,
        mainsequenceRadius: 6.6,
        mainsequenceLuminosity: 30000
    },
    'B': {
        type: 'B',
        temperatureRange: [10000, 30000],
        color: 'Blue-white',
        bvIndexRange: [-0.30, -0.02],
        mainsequenceMass: 2.1,
        mainsequenceRadius: 1.8,
        mainsequenceLuminosity: 25
    },
    'A': {
        type: 'A',
        temperatureRange: [7500, 10000],
        color: 'White',
        bvIndexRange: [-0.02, 0.30],
        mainsequenceMass: 1.4,
        mainsequenceRadius: 1.4,
        mainsequenceLuminosity: 5
    },
    'F': {
        type: 'F',
        temperatureRange: [6000, 7500],
        color: 'Yellow-white',
        bvIndexRange: [0.30, 0.58],
        mainsequenceMass: 1.05,
        mainsequenceRadius: 1.15,
        mainsequenceLuminosity: 1.5
    },
    'G': {
        type: 'G',
        temperatureRange: [5200, 6000],
        color: 'Yellow',
        bvIndexRange: [0.58, 0.81],
        mainsequenceMass: 0.8,
        mainsequenceRadius: 0.96,
        mainsequenceLuminosity: 0.66
    },
    'K': {
        type: 'K',
        temperatureRange: [3700, 5200],
        color: 'Orange',
        bvIndexRange: [0.81, 1.40],
        mainsequenceMass: 0.45,
        mainsequenceRadius: 0.7,
        mainsequenceLuminosity: 0.08
    },
    'M': {
        type: 'M',
        temperatureRange: [2400, 3700],
        color: 'Red',
        bvIndexRange: [1.40, 2.00],
        mainsequenceMass: 0.08,
        mainsequenceRadius: 0.7,
        mainsequenceLuminosity: 0.01
    }
};

/**
 * THE YERKES CLASSIFICATION (Luminosity Class)
 * Categorizes stars by their size and evolutionary stage.
 */
export const YERKES_LUMINOSITY_CLASSES = {
    '0':   { id: '0',   label: 'Hypergiant' },
    'Ia':  { id: 'Ia',  label: 'Luminous Supergiant' },
    'Ib':  { id: 'Ib',  label: 'Less Luminous Supergiant' },
    'II':  { id: 'II',  label: 'Bright Giant' },
    'III': { id: 'III', label: 'Giant' },
    'IV':  { id: 'IV',  label: 'Subgiant' },
    'V':   { id: 'V',   label: 'Main-sequence (Dwarf)' },
    'sd':  { id: 'sd',  label: 'Subdwarf' },
    'D':   { id: 'D',   label: 'White Dwarf' }
} as const;

/**
 * Estimating a star's surface temperature (Teff) directly from the B-V index.
 * USES the Ballesteros Formula:
 * Teff = 4600 * (1 / (0.92 * (B-V) + 1.7) + 1 / (0.92 * (B-V) + 0.62))
 */
export function bvToTemperature(bv: number): number {
    const term1 = 1 / (0.92 * bv + 1.7);
    const term2 = 1 / (0.92 * bv + 0.62);
    return 4600 * (term1 + term2);
}

/**
 * Classifies a star's spectral type based on its B-V color index.
 */
export function classifyByBV(bv: number): SpectralTypeInfo | null {
    const temp = bvToTemperature(bv);
    return classifyByTemperature(temp);
}

/**
 * Classifies a star's spectral type based on its surface temperature.
 */
export function classifyByTemperature(tempK: number): SpectralTypeInfo | null {
    for (const type in HARVARD_SPECTRAL_TYPES) {
        const info = HARVARD_SPECTRAL_TYPES[type];
        if (tempK >= info.temperatureRange[0] && tempK <= info.temperatureRange[1]) {
            return info;
        }
    }
    if (tempK > 100000) return HARVARD_SPECTRAL_TYPES['O'];
    if (tempK < 2400) return HARVARD_SPECTRAL_TYPES['M'];
    return null;
}

