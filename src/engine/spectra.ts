/**
 * Atomic spectra, photon arithmetic and colour mapping.
 *
 * Hydrogen-like levels use Eₙ = −R_H·hc·Z²/n² with the reduced-mass Rydberg
 * constant, which is a numerically grounded one-electron model. It is exact for
 * H, D, He⁺ and other one-electron ions (to the extent that fine structure,
 * Lamb shift and nuclear-size effects are ignored), and only qualitative for
 * many-electron atoms, where electron–electron repulsion lifts the ℓ
 * degeneracy. Multi-electron lines are therefore taken from measured tabulated
 * wavelengths, never predicted.
 *
 * Photon arithmetic is E = hf and c = fλ with the exact SI constants.
 */

import { CONSTANTS, wavelengthFromEnergyEV, nanometresFromEnergyEV } from './constants';

/** Rydberg constant for hydrogen including nuclear-motion (reduced-mass) correction. */
export const R_HYDROGEN_PER_METRE =
  CONSTANTS.R_infinity / (1 + CONSTANTS.electronMass / CONSTANTS.protonMass); // 10967758.3 m⁻¹

/** Ionisation energy of hydrogen in eV (13.5984 eV, from the reduced-mass Rydberg). */
export const HYDROGEN_IONISATION_EV =
  (CONSTANTS.h * CONSTANTS.c * R_HYDROGEN_PER_METRE) / CONSTANTS.eV;

/** Reduced-mass factor μ/mₑ for a nucleus of mass number A (approximate). */
export function reducedMassFactor(massNumber: number): number {
  const nucleusMassKg = massNumber * CONSTANTS.u;
  return 1 / (1 + CONSTANTS.electronMass / nucleusMassKg);
}

/** One-electron level energy in eV, relative to the ionisation limit at 0. */
export function hydrogenLikeLevelEV(n: number, z = 1, massNumber?: number): number {
  if (n < 1) throw new Error('n must be >= 1');
  const factor = massNumber ? reducedMassFactor(massNumber) : 1;
  return -HYDROGEN_IONISATION_EV * factor * (z * z) / (n * n);
}

/** Wavelength in metres for a hydrogen-like transition nHigh → nLow. */
export function rydbergWavelengthMetres(nLow: number, nHigh: number, z = 1): number {
  if (nHigh <= nLow) throw new Error('emission needs nHigh > nLow');
  const wavenumber =
    R_HYDROGEN_PER_METRE * z * z * (1 / (nLow * nLow) - 1 / (nHigh * nHigh));
  return 1 / wavenumber;
}

/** Transition energy in eV between two hydrogen-like levels. */
export function transitionEnergyEV(nLow: number, nHigh: number, z = 1): number {
  return Math.abs(hydrogenLikeLevelEV(nHigh, z) - hydrogenLikeLevelEV(nLow, z));
}

export interface Photon {
  energyEV: number;
  frequencyHz: number;
  wavelengthNm: number;
  wavelengthM: number;
  /** Momentum in kg·m/s, p = E/c. */
  momentumKgMs: number;
  region: SpectralRegion;
  rgb: [number, number, number];
  visible: boolean;
}

export type SpectralRegion =
  | 'gamma'
  | 'X-ray'
  | 'ultraviolet'
  | 'visible'
  | 'infrared'
  | 'microwave'
  | 'radio';

export function classifyRegion(nm: number): SpectralRegion {
  if (nm < 0.01) return 'gamma';
  if (nm < 10) return 'X-ray';
  if (nm < 380) return 'ultraviolet';
  if (nm <= 750) return 'visible';
  if (nm < 1e6) return 'infrared';
  if (nm < 1e9) return 'microwave';
  return 'radio';
}

export function photonFromEnergyEV(energyEV: number): Photon {
  const wavelengthM = wavelengthFromEnergyEV(energyEV);
  const frequencyHz = CONSTANTS.c / wavelengthM;
  const nm = wavelengthM * 1e9;
  return {
    energyEV,
    frequencyHz,
    wavelengthNm: nm,
    wavelengthM: wavelengthM,
    momentumKgMs: (energyEV * CONSTANTS.eV) / CONSTANTS.c,
    region: classifyRegion(nm),
    rgb: wavelengthToRGB(nm),
    visible: nm >= 380 && nm <= 750,
  };
}

export function photonFromWavelengthNm(nm: number): Photon {
  const wavelengthM = nm * 1e-9;
  const energyEV = (CONSTANTS.h * CONSTANTS.c) / (wavelengthM * CONSTANTS.eV);
  return {
    energyEV,
    frequencyHz: CONSTANTS.c / wavelengthM,
    wavelengthNm: nm,
    wavelengthM,
    momentumKgMs: (energyEV * CONSTANTS.eV) / CONSTANTS.c,
    region: classifyRegion(nm),
    rgb: wavelengthToRGB(nm),
    visible: nm >= 380 && nm <= 750,
  };
}

export interface SpectralSeries {
  name: string;
  nLow: number;
  region: SpectralRegion;
  discoveryNote: string;
  formula: string;
}

export const HYDROGEN_SERIES: SpectralSeries[] = [
  {
    name: 'Lyman',
    nLow: 1,
    region: 'ultraviolet',
    discoveryNote: 'Found by Theodore Lyman (1906–1914); the whole series lies in the vacuum ultraviolet.',
    formula: '1/λ = R_H (1/1² − 1/n²), n = 2, 3, …',
  },
  {
    name: 'Balmer',
    nLow: 2,
    region: 'visible',
    discoveryNote: 'Johann Balmer (1885) fitted the four visible lines before anyone knew why they existed.',
    formula: '1/λ = R_H (1/2² − 1/n²), n = 3, 4, …',
  },
  {
    name: 'Paschen',
    nLow: 3,
    region: 'infrared',
    discoveryNote: 'Near-infrared, measured by Friedrich Paschen in 1908.',
    formula: '1/λ = R_H (1/3² − 1/n²), n = 4, 5, …',
  },
  {
    name: 'Brackett',
    nLow: 4,
    region: 'infrared',
    discoveryNote: 'Infrared series assigned by Frederick Brackett in 1922.',
    formula: '1/λ = R_H (1/4² − 1/n²), n = 5, 6, …',
  },
  {
    name: 'Pfund',
    nLow: 5,
    region: 'infrared',
    discoveryNote: 'Discovered by August Pfund in 1924, far infrared.',
    formula: '1/λ = R_H (1/5² − 1/n²), n = 6, 7, …',
  },
  {
    name: 'Humphreys',
    nLow: 6,
    region: 'infrared',
    discoveryNote: 'Far-infrared series extending into the millimetre range.',
    formula: '1/λ = R_H (1/6² − 1/n²), n = 7, 8, …',
  },
];

export interface SpectralLine {
  series: string;
  name: string;
  nLow: number;
  nHigh: number;
  wavelengthNm: number;
  energyEV: number;
  region: SpectralRegion;
  rgb: [number, number, number];
  relativeIntensity: number;
}

/** Lines of one hydrogen series. `maxN` bounds the list; real series converge. */
export function hydrogenSeriesLines(nLow: number, maxN = 12): SpectralLine[] {
  const lines: SpectralLine[] = [];
  for (let n = nLow + 1; n <= maxN; n++) {
    const nm = rydbergWavelengthMetres(nLow, n) * 1e9;
    lines.push({
      series: seriesName(nLow),
      name: `${seriesName(nLow)} ${greekLetter(n - nLow)}`,
      nLow,
      nHigh: n,
      wavelengthNm: nm,
      energyEV: transitionEnergyEV(nLow, n),
      region: classifyRegion(nm),
      rgb: wavelengthToRGB(nm),
      // Relative strengths here are illustrative: line intensity depends on
      // population and transition probability, neither of which this model solves.
      relativeIntensity: Math.max(0.05, 1 / (n - nLow)),
    });
  }
  return lines;
}

export function seriesName(nLow: number): string {
  return HYDROGEN_SERIES.find((s) => s.nLow === nLow)?.name ?? `n=${nLow}`;
}

function greekLetter(index: number): string {
  return ['', 'α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ'][index] ?? `${index}`;
}

/**
 * Measured prominent emission lines for the flame-test / element-spectra demo.
 * Source: NIST Atomic Spectra Database, air wavelengths where quoted.
 * These are tabulated data — ATOMVERSE does not claim to calculate them.
 */
export interface TabulatedLine {
  symbol: string;
  nm: number;
  label: string;
  kind: 'emission' | 'absorption';
  relativeIntensity: number;
}

export const ELEMENT_LINES: TabulatedLine[] = [
  { symbol: 'H', nm: 656.3, label: 'H-α Balmer', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'H', nm: 486.1, label: 'H-β', kind: 'emission', relativeIntensity: 0.5 },
  { symbol: 'H', nm: 434.0, label: 'H-γ', kind: 'emission', relativeIntensity: 0.32 },
  { symbol: 'H', nm: 410.2, label: 'H-δ', kind: 'emission', relativeIntensity: 0.22 },
  { symbol: 'He', nm: 587.6, label: 'He I D₃', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'He', nm: 447.1, label: 'He I', kind: 'emission', relativeIntensity: 0.6 },
  { symbol: 'He', nm: 667.8, label: 'He I', kind: 'emission', relativeIntensity: 0.5 },
  { symbol: 'He', nm: 501.6, label: 'He I', kind: 'emission', relativeIntensity: 0.4 },
  { symbol: 'Li', nm: 670.8, label: 'Li I doublet', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Na', nm: 589.6, label: 'Na D₂', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Na', nm: 589.0, label: 'Na D₁', kind: 'emission', relativeIntensity: 0.85 },
  { symbol: 'K', nm: 766.5, label: 'K I 766.5', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'K', nm: 769.9, label: 'K I 769.9', kind: 'emission', relativeIntensity: 0.8 },
  { symbol: 'Ca', nm: 422.7, label: 'Ca I resonance', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Ca', nm: 616.2, label: 'Ca I', kind: 'emission', relativeIntensity: 0.35 },
  { symbol: 'Sr', nm: 460.7, label: 'Sr I', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Ba', nm: 455.4, label: 'Ba I', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Cu', nm: 521.8, label: 'Cu I green', kind: 'emission', relativeIntensity: 0.8 },
  { symbol: 'Fe', nm: 372.0, label: 'Fe I (UV)', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Mg', nm: 285.2, label: 'Mg I (UV)', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Hg', nm: 546.1, label: 'Hg I green', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Hg', nm: 435.8, label: 'Hg I blue', kind: 'emission', relativeIntensity: 0.7 },
  { symbol: 'Ne', nm: 585.2, label: 'Ne I', kind: 'emission', relativeIntensity: 0.8 },
  { symbol: 'Ne', nm: 640.2, label: 'Ne I red', kind: 'emission', relativeIntensity: 1 },
  { symbol: 'Ar', nm: 696.6, label: 'Ar I', kind: 'emission', relativeIntensity: 1 },
];

export function linesForElement(symbol: string): TabulatedLine[] {
  return ELEMENT_LINES.filter((l) => l.symbol === symbol);
}

/* ------------------------------------------------------------------ *
 * Wavelength → sRGB.
 *
 * A piecewise linear fit to the CIE spectral locus (after Dan Bruton's
 * widely used approximation). It exists so a spectral line can be drawn in
 * roughly its real colour; it is NOT a colourimetric calculation and it
 * cannot render UV or IR, which are shown desaturated with a labelled band.
 * ------------------------------------------------------------------ */
export function wavelengthToRGB(nm: number): [number, number, number] {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  let r = 0;
  let g = 0;
  let b = 0;
  if (nm < 380) {
    // Ultraviolet: rendered as a deep violet so the line is still locatable.
    r = 90;
    g = 40;
    b = 190;
  } else if (nm < 440) {
    r = -((nm - 440) / (440 - 380));
    g = 0;
    b = 1;
  } else if (nm < 490) {
    r = 0;
    g = (nm - 440) / (490 - 440);
    b = 1;
  } else if (nm < 510) {
    r = 0;
    g = 1;
    b = -((nm - 510) / (510 - 490));
  } else if (nm < 580) {
    r = (nm - 510) / (580 - 510);
    g = 1;
    b = 0;
  } else if (nm < 645) {
    r = 1;
    g = -((nm - 645) / (645 - 580));
    b = 0;
  } else if (nm <= 780) {
    r = 1;
    g = 0;
    b = 0;
  } else {
    // Infrared: shown as a dark red glow with an explicit "not visible" label.
    r = 130;
    g = 30;
    b = 30;
  }
  let factor = 1;
  if (nm >= 380 && nm < 420) factor = 0.3 + (0.7 * (nm - 380)) / 40;
  else if (nm > 700 && nm <= 780) factor = 0.3 + (0.7 * (780 - nm)) / 80;
  const gamma = 0.8;
  return [
    clamp(255 * Math.pow(r * factor, gamma)),
    clamp(255 * Math.pow(g * factor, gamma)),
    clamp(255 * Math.pow(b * factor, gamma)),
  ];
}

export function rgbToCss(rgb: [number, number, number], alpha = 1): string {
  return alpha >= 1
    ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
    : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/** Continuous spectrum gradient stops for the spectrograph strip. */
export function spectrumGradientStops(): Array<{ stop: number; color: string }> {
  const stops: Array<{ stop: number; color: string }> = [];
  for (let nm = 380; nm <= 750; nm += 10) {
    stops.push({
      stop: (nm - 380) / (750 - 380),
      color: rgbToCss(wavelengthToRGB(nm)),
    });
  }
  return stops;
}

/** de Broglie wavelength in nm for a particle of mass m [kg] and speed v [m/s]. */
export function deBroglieNm(massKg: number, speedMs: number): number {
  return (CONSTANTS.h / (massKg * speedMs)) * 1e9;
}

/** Kinetic energy in eV gained by a charge across `volts`. */
export function electronvoltsFromVoltage(volts: number, chargeE = 1): number {
  return volts * chargeE;
}

/** Accelerating voltage needed for an electron to reach a given photon-equivalent energy. */
export function voltageForEnergyEV(ev: number): number {
  return ev;
}

/** Uncertainty-principle estimate: Δx·Δp ≥ ħ/2 → minimum kinetic energy for confinement. */
export function confinementEnergyEV(deltaXNm: number, massElectrons = 1): number {
  const dx = deltaXNm * 1e-9;
  const momentum = CONSTANTS.hbar / (2 * dx);
  const kinetic = (momentum * momentum) / (2 * CONSTANTS.electronMass * massElectrons);
  return kinetic / CONSTANTS.eV;
}

/** Bohr radius of a hydrogen-like orbit, in nm (illustrative for the Bohr model). */
export function bohrOrbitRadiusNm(n: number, z = 1): number {
  return ((n * n * CONSTANTS.bohrRadius) / z) * 1e9;
}

/** Fine-structure constant α = e²/(4πɛ₀ħc) ≈ 1/137.036. */
export const FINE_STRUCTURE_CONSTANT =
  (CONSTANTS.e * CONSTANTS.e) / (2 * CONSTANTS.epsilon0 * CONSTANTS.h * CONSTANTS.c);

/**
 * Bohr-model orbital speed as a fraction of c: v/c = Zα/n.
 * The Bohr picture is a simplified model — real electrons have no definite
 * orbit — but this speed is what the model predicts and it reproduces α's role.
 */
export function bohrSpeedOverC(n: number, z = 1): number {
  return (FINE_STRUCTURE_CONSTANT * z) / Math.max(1, n);
}

/** nm helper re-exported so consumers do not import constants directly. */
export { nanometresFromEnergyEV };
