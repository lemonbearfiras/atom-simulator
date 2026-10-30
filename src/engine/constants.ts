/**
 * Physical constants and unit handling.
 *
 * Values are the 2018/2019 CODATA set as adopted by the SI redefinition.
 * Constants marked "exact" have no uncertainty because the SI defines them.
 * Internally the engine works in SI; display helpers convert to the units
 * chemists and physicists actually use.
 */

export const CONSTANTS = {
  /** Elementary charge [C] — exact by SI definition. */
  e: 1.602176634e-19,
  /** Unified atomic mass constant [kg]. CODATA 2018. */
  u: 1.66053906660e-27,
  /** Electron rest mass [kg]. CODATA 2018. */
  electronMass: 9.1093837015e-31,
  /** Proton rest mass [kg]. CODATA 2018. */
  protonMass: 1.67262192369e-27,
  /** Neutron rest mass [kg]. CODATA 2018. */
  neutronMass: 1.67492749804e-27,
  /** Speed of light in vacuum [m/s] — exact. */
  c: 299792458,
  /** Planck constant [J s] — exact. */
  h: 6.62607015e-34,
  /** Reduced Planck constant [J s]. */
  hbar: 1.054571817e-34,
  /** Boltzmann constant [J/K] — exact. */
  k_B: 1.380649e-23,
  /** Avogadro constant [1/mol] — exact. */
  N_A: 6.02214076e23,
  /** Molar gas constant [J/(mol K)] = N_A k_B. */
  R: 8.31446261815324,
  /** Vacuum permittivity [F/m]. CODATA 2018. */
  epsilon0: 8.8541878128e-12,
  /** Coulomb constant 1/(4πɛ0) [N m²/C²]. */
  k_e: 8.9875517923e9,
  /** Bohr radius [m]. CODATA 2018. */
  bohrRadius: 5.29177210903e-11,
  /** Hartree energy [J] = 2 × Rydberg constant × h c. */
  hartree: 4.3597447222071e-18,
  /** Rydberg constant [1/m] for infinite nuclear mass. CODATA 2018. */
  R_infinity: 10973731.568160,
  /** Electronvolt [J] — exact. */
  eV: 1.602176634e-19,
  /** Debye [C m]. */
  debye: 3.33564e-30,
  /** Stefan–Boltzmann constant [W/(m² K⁴)]. CODATA 2018. */
  sigma: 5.670374419e-8,
  /** Gravitational acceleration, standard [m/s²] (used only for UI metaphors). */
  g0: 9.80665,
} as const;

/** Hydrogen ground-state ionisation energy, 13.6 eV, computed from constants. */
export const RYDBERG_EV =
  (CONSTANTS.R_infinity * CONSTANTS.h * CONSTANTS.c) / CONSTANTS.eV;

/** Hartree in eV, derived so the two can never drift apart. */
export const HARTREE_EV = 2 * RYDBERG_EV;

/** Ångström in metres. */
export const ANGSTROM = 1e-10;
export const BOHR_RADIUS_ANGSTROM = CONSTANTS.bohrRadius / ANGSTROM;

/** Rest masses in u — these are the numbers the Atom Builder displays. */
export const MASS_PROTON_U = CONSTANTS.protonMass / CONSTANTS.u; // 1.007276466621
export const MASS_NEUTRON_U = CONSTANTS.neutronMass / CONSTANTS.u; // 1.008664915953
export const MASS_ELECTRON_U = CONSTANTS.electronMass / CONSTANTS.u; // 0.000548579909

/** 1 u c² expressed in MeV (used by the nuclear mass-defect maths). */
export const U_TO_MEV = 931.49410242;

export function joulesToEV(j: number): number {
  return j / CONSTANTS.eV;
}
export function evToJoules(ev: number): number {
  return ev * CONSTANTS.eV;
}
export function evToKJPerMol(ev: number): number {
  return (evToJoules(ev) * CONSTANTS.N_A) / 1000;
}
export function kjPerMolToEV(kj: number): number {
  return joulesToEV((kj * 1000) / CONSTANTS.N_A);
}
export function metresToAngstrom(m: number): number {
  return m / ANGSTROM;
}
export function angstromToMetres(a: number): number {
  return a * ANGSTROM;
}

/** E = hf. Energy in eV for a photon of frequency f [Hz]. */
export function photonEnergyEVFromFrequency(hz: number): number {
  return (CONSTANTS.h * hz) / CONSTANTS.eV;
}

/** c = fλ. Frequency [Hz] of a photon of wavelength λ [m]. */
export function frequencyFromWavelengthMetres(lambda: number): number {
  return CONSTANTS.c / lambda;
}

/** Wavelength [m] of a photon carrying E [eV]. */
export function wavelengthFromEnergyEV(ev: number): number {
  return (CONSTANTS.h * CONSTANTS.c) / (ev * CONSTANTS.eV);
}

/** Convenience: λ [nm] from E [eV]. */
export function nanometresFromEnergyEV(ev: number): number {
  return (wavelengthFromEnergyEV(ev) * 1e9);
}

export function formatNumber(value: number | null, sig = 4): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(Math.max(2, sig - 1));
  const decimals = Math.max(0, sig - Math.floor(Math.log10(abs)) - 1);
  return value.toFixed(Math.min(decimals, 8));
}

/** Signed integer charge, e.g. +2 / 0 / −1, using a real minus sign. */
export function signedCharge(charge: number): string {
  if (charge === 0) return '0';
  const mag = Math.abs(charge);
  const magnitude = mag === 1 ? '' : String(mag);
  return `${charge > 0 ? '+' : '−'}${magnitude}`;
}

export function superscript(value: number): string {
  const map: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻', '+': '⁺',
  };
  return String(value)
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('');
}

export function subscript(value: string | number): string {
  const map: Record<string, string> = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
    '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  };
  return String(value)
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('');
}
