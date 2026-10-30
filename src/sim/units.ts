/**
 * Simulation units: length in Å, mass in unified atomic mass units (u),
 * charge in elementary charges, time in femtoseconds.
 *
 * Every conversion below is derived from the CODATA constants in
 * `engine/constants.ts`, so the dynamics carry real energies and real
 * wavelengths — only the two deliberate display accelerations (radiation
 * rate and photon speed) are documented where they are used.
 */
import { CONSTANTS } from '../engine/constants';

const ANGSTROM = 1e-10; // m
const FS = 1e-15; // s

/** e²/(4πɛ₀) in eV·Å — 14.3996 eV·Å for a unit-charge pair 1 Å apart. */
export const COULOMB_EV = (CONSTANTS.k_e * CONSTANTS.e * CONSTANTS.e) / CONSTANTS.eV / ANGSTROM;

/** Acceleration [Å/fs²] per (eV/Å) of force on a 1 u body. */
export const ACCEL_PER_EV_PER_U =
  (CONSTANTS.eV / (CONSTANTS.u * ANGSTROM)) * (FS * FS) / ANGSTROM;

/** KE = ½ · mass[u] · speed[Å/fs]² · MASS_SPEED_EV — 103.64 eV per u·(Å/fs)². */
export const MASS_SPEED_EV = (CONSTANTS.u * (1e5 * 1e5)) / CONSTANTS.eV;

/** Speed of light in Å/fs (3000) — used only for the relativistic check. */
export const C_A_PER_FS = (CONSTANTS.c * FS) / ANGSTROM;

/** Bohr radius in Å. */
export const BOHR_RADIUS_A = CONSTANTS.bohrRadius / ANGSTROM;

/** Ground-state Bohr orbit speed for hydrogen, in Å/fs (≈ α·c). */
export const BOHR_SPEED_A_PER_FS = Math.sqrt(
  COULOMB_EV / (MASS_SPEED_EV * CONSTANTS.electronMass / CONSTANTS.u / 2 / BOHR_RADIUS_A),
);

/** 1 eV in kJ/mol, for display. */
export const EV_TO_KJMOL = CONSTANTS.eV * CONSTANTS.N_A / 1000;

export const ELECTRON_MASS_U = CONSTANTS.electronMass / CONSTANTS.u;
export const PROTON_MASS_U = CONSTANTS.protonMass / CONSTANTS.u;
export const NEUTRON_MASS_U = CONSTANTS.neutronMass / CONSTANTS.u;

/** Kinetic energy of a body in eV. */
export function kineticEV(massU: number, vx: number, vy: number): number {
  return 0.5 * massU * (vx * vx + vy * vy) * MASS_SPEED_EV;
}

/** Potential energy of a charge pair at separation r, in eV. */
export function pairPotentialEV(q1: number, q2: number, r: number): number {
  return (COULOMB_EV * q1 * q2) / r;
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
