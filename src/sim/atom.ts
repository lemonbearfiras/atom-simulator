import { ELECTRON_MASS_U, MASS_SPEED_EV, clamp } from './units';
import type { NuclearState } from './nuclear';

/** An electron counts as bound once its energy against a core falls below this. */
export const FREE_ENERGY_EV = -0.01;

/** Transitions below this energy are not named as photons; the drop stays in the orbit. */
export const MIN_LINE_EV = 0.01;

/** Half-width of an absorption line, eV. Real Doppler widths are ~10⁻⁵ eV. */
export const LINE_WIDTH_EV = 0.08;

const RYDBERG_EV = 13.605693122994;

export const AZIMUTHAL_NAMES = ['s', 'p', 'd', 'f', 'g'] as const;

export function subshellLabel(n: number, l: number): string {
  return `${n}${AZIMUTHAL_NAMES[l] ?? l}`;
}

export function capacityForL(l: number): number {
  return 2 * (2 * l + 1);
}

/**
 * One allowed electron level of an ionic core, ordered deepest first.
 *
 * `energyEV` is a real number: a measured ionisation energy where the element
 * table has one, otherwise a Slater orbital energy shifted to sit under the
 * measured first ionisation energy. `radiusA`, `speedAPerFs` and `couplingEV_A`
 * then follow from the Bohr relations, so an electron placed on the level
 * orbits with exactly that energy under the force the level implies. Energy,
 * force and spectrum cannot drift apart.
 *
 * `closed` marks a subshell the exclusion principle has filled. Electrons may
 * not radiate into it, which is what stops the atom collapsing.
 */
export interface Level {
  key: string;
  n: number;
  l: number;
  energyEV: number;
  capacity: number;
  radiusA: number;
  speedAPerFs: number;
  couplingEV_A: number;
  frozen: boolean;
  closed: boolean;
}

export interface LevelSeed {
  key: string;
  n: number;
  l: number;
  energyEV: number;
  capacity: number;
  frozen: boolean;
}

export interface Electron {
  kind: 'electron';
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  massU: number;
  charge: number;
  /** Id of the ionic core this electron belongs to, or null while free. */
  coreId: number | null;
  /** Index into that core's level ladder; −1 while free. */
  level: number;
  /** eV·Å coupling of the level this electron occupies. */
  couplingEV_A: number;
  /** Total energy against the bound core, eV. Negative while bound. */
  energyEV: number;
  /** Larmor energy drained since the last photon, eV. */
  pendingRadiationEV: number;
  /** Distance and acceleration of the pair that bends this body hardest, remembered for the timestep. */
  clockR: number;
  clockAccel: number;
}

export interface Core {
  kind: 'core';
  id: number;
  symbol: string;
  name: string;
  z: number;
  a: number;
  nuclear: NuclearState;
  massU: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  frozenElectrons: number;
  levels: Level[];
  /** Electrons sitting on each level, index-aligned with `levels`. */
  counts: number[];
  /** Radii of the occupied shells, so a stranger can screen this core without walking the whole ladder. */
  shellRadiusA: number[];
  /** eV·Å of screening carried by each shell in `shellRadiusA`. */
  shellChargeEV: number[];
  /** eV·Å of this core's pseudo-charge — what a stranger feels before any shell screens it. */
  strangerCouplingEV_A: number;
  /** Charge of this core with every explicit valence electron taken away. */
  chargeBase: number;
  /** Unpaired electrons on the explicit levels — the bonds this atom has left to give. */
  unpairedValence: number;
  /** True while this atom is holding the promoted configuration it paid for. */
  promotionPaid: boolean;
  /** eV of electronic excitation this atom is carrying as a booked potential. */
  excitationEV: number;
  /** True while a covalent channel is open between this core and another. */
  bonded: boolean;
  ljEpsilonEV: number;
  ljSigmaA: number;
  qNet: number;
  lastLineNm: number | null;
  /** Distance and acceleration of the pair that bends this nucleus hardest, remembered for the timestep. */
  clockR: number;
  clockAccel: number;
}

/**
 * A covalent bond between two nuclei: one to three shared pairs of unpaired valence
 * electrons, drawn as a Morse well.
 *
 * The bond owns the *shape* of the pair potential — depth, equilibrium length,
 * range and vibrational quantum — and the pair loop reads it off this object so
 * the force it applies and the energy `potentialEnergyEV` books are the same
 * curve. Both nuclei are held by reference: a bond that outlives its atoms would
 * be a bug, so `deleteNear` and `reset` prune them together.
 */
export interface Bond {
  id: number;
  a: Core;
  b: Core;
  /** Shared electron pairs this bond is: 1 = σ, 2 = σ+π, 3 = σ+2π. */
  order: number;
  /** eV, the depth of the well below the separated atoms (Dₑ, zero-point included). */
  dissociationEV: number;
  /** eV the atom `a` had to promote to give this bond an electron pair, or 0. */
  promotionA: number;
  /** eV the same for atom `b`. */
  promotionB: number;
  /** Å, the separation the pair settles at. */
  lengthA: number;
  /** Å⁻¹, how fast the well opens on either side of the bottom. */
  rangeInvA: number;
  /** eV, the stretch quantum this pair pays when it sheds vibration. */
  quantumEV: number;
  /** u, the mass that actually oscillates. */
  reducedMassU: number;
  measured: boolean;
  /** What the log calls it, including where the numbers came from. */
  label: string;
}

export interface NuclearBurst {
  id: number;
  x: number;
  y: number;
  ageSeconds: number;
  mode: string;
  label: string;
}

export interface NuclearRay {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ageSeconds: number;
  kind: 'beta−' | 'beta+' | 'neutrino' | 'antineutrino' | 'electron';
  energyEV: number;
  charge: number;
}

export interface Neutron {
  kind: 'neutron';
  id: number;
  nuclear: NuclearState;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  massU: number;
  charge: number;
}

export interface Photon {
  id: number;
  x: number;
  y: number;
  /** Display velocity in Å per rendered frame; light is slowed for the eye. */
  vx: number;
  vy: number;
  energyEV: number;
  wavelengthNm: number;
  frequencyHz: number;
  region: string;
  rgb: [number, number, number];
  sourceSymbol: string;
  fromKey: string;
  toKey: string;
  phase: number;
}

export interface SimEvent {
  fs: number;
  text: string;
  tone: 'info' | 'light' | 'bond' | 'warn';
  nm?: number;
}

/** Quantum defect that reproduces a measured level energy in the Rydberg formula. */
export function quantumDefect(n: number, energyEV: number, seriesCharge: number): number {
  const effectiveN = Math.sqrt((RYDBERG_EV * seriesCharge * seriesCharge) / Math.abs(energyEV));
  return clamp(n - effectiveN, 0, n - 0.4);
}

/**
 * Turn a level seed into a full level.
 *
 * The effective principal quantum number implied by the energy fixes the orbit
 * radius, and the Coulomb coupling is then whatever makes a circular orbit of
 * that radius carry exactly that energy: k = 2|E|r.
 */
export function makeLevel(seed: LevelSeed, defect: number, softA: number): Level {
  const energyEV = Math.min(-0.02, seed.energyEV);
  const effectiveN = Math.max(0.35, seed.n - defect);
  const seriesCharge = Math.sqrt((Math.abs(energyEV) * effectiveN * effectiveN) / RYDBERG_EV);
  const radiusA = clamp((0.529177210903 * effectiveN * effectiveN) / seriesCharge, 0.05, 40);
  const couplingEV_A = 2 * Math.abs(energyEV) * radiusA;
  // The speed is read off the *regularised* potential, not the bare 1/r: inside
  // an ångström the softening lifts the potential by a few hundredths of an
  // electronvolt, and the orbit the model actually builds has to carry exactly
  // the level energy the photon is priced from.
  const speedAPerFs = Math.sqrt(
    (2 * (energyEV - electronPotentialEV(couplingEV_A, radiusA, softA))) / (ELECTRON_MASS_U * MASS_SPEED_EV),
  );
  return {
    key: seed.key,
    n: seed.n,
    l: seed.l,
    energyEV,
    capacity: seed.capacity,
    radiusA,
    speedAPerFs,
    couplingEV_A,
    frozen: seed.frozen,
    closed: seed.frozen,
  };
}

/**
 * Excited levels above a real configuration.
 *
 * Rydberg's formula with the quantum defect measured from the occupied series —
 * the same parameterisation real atomic spectra tables use. A neutral core is
 * seen as charge +1 by a distant electron.
 */
export function excitedLevels(
  outermostN: number,
  defects: Map<number, number>,
  seriesCharge: number,
  maxN = 7,
): LevelSeed[] {
  const out: LevelSeed[] = [];
  for (let n = outermostN; n <= maxN; n++) {
    for (let l = 0; l <= 3; l++) {
      if (l >= n) continue;
      const defect = defects.get(l) ?? 0;
      const effectiveN = Math.max(0.5, n - defect);
      const energyEV = -(RYDBERG_EV * seriesCharge * seriesCharge) / (effectiveN * effectiveN);
      if (energyEV > -0.05) continue;
      out.push({
        key: subshellLabel(n, l),
        n,
        l,
        energyEV,
        capacity: capacityForL(l),
        frozen: false,
      });
    }
  }
  return out;
}

/** Smoothed (Plummer) attraction between an electron and a core, finite at r = 0. */
export function electronPotentialEV(couplingEV_A: number, r: number, softA: number): number {
  return -couplingEV_A / Math.sqrt(r * r + softA * softA);
}

/** Force magnitude of that potential, eV/Å. */
export function electronForceEVperA(couplingEV_A: number, r: number, softA: number): number {
  const d2 = r * r + softA * softA;
  return (couplingEV_A * r) / (d2 * Math.sqrt(d2));
}

export function kineticEV(massU: number, vx: number, vy: number): number {
  return 0.5 * massU * (vx * vx + vy * vy) * MASS_SPEED_EV;
}

/** Total energy of an electron against one core, eV. */
export function electronEnergyEV(
  e: { x: number; y: number; vx: number; vy: number; massU: number },
  core: { x: number; y: number; vx: number; vy: number },
  couplingEV_A: number,
  softA: number,
): number {
  const rvx = e.vx - core.vx;
  const rvy = e.vy - core.vy;
  const r = Math.hypot(e.x - core.x, e.y - core.y);
  return kineticEV(e.massU, rvx, rvy) + electronPotentialEV(couplingEV_A, r, softA);
}

/** Put an electron on the circular orbit of a level, keeping its side and sense of rotation. */
export function snapToLevel(e: Electron, core: Core, level: Level, softA: number): void {
  const dx = e.x - core.x;
  const dy = e.y - core.y;
  const dr = Math.hypot(dx, dy) || 1;
  e.x = core.x + (dx / dr) * level.radiusA;
  e.y = core.y + (dy / dr) * level.radiusA;
  const tangentX = -dy / dr;
  const tangentY = dx / dr;
  const sense = tangentX * (e.vx - core.vx) + tangentY * (e.vy - core.vy) >= 0 ? 1 : -1;
  e.vx = core.vx + sense * tangentX * level.speedAPerFs;
  e.vy = core.vy + sense * tangentY * level.speedAPerFs;
  e.couplingEV_A = level.couplingEV_A;
  e.energyEV = electronEnergyEV(e, core, level.couplingEV_A, softA);
}

/** Deepest open level below `index`, or −1 when the electron is already in its ground state. */
export function deeperOpenLevel(levels: Level[], index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (!levels[i].closed) return i;
  }
  return -1;
}

/** Open level nearest to an energy — the level a captured electron lands on. */
export function nearestOpenLevel(levels: Level[], energyEV: number): number {
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].closed) continue;
    const gap = Math.abs(levels[i].energyEV - energyEV);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}
