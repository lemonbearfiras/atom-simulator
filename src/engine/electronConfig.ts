/**
 * Electron configuration engine.
 *
 * Model assumptions
 * -----------------
 * 1. Neutral atoms use the tabulated ground-state configurations carried in
 *    `src/data/elements.ts`, which include the real Aufbau exceptions
 *    (Cr, Cu, Nb, Mo, Ru, Rh, Pd, Ag, La, Ce, Gd, Pt, Au, and the actinides).
 *    This is deliberate: the Madelung n+ℓ rule alone mis-predicts roughly a
 *    dozen first-row and heavier transition metals.
 * 2. Ion configurations are derived from the neutral ground state by the
 *    standard removal order — electrons leave the subshell with the largest
 *    principal quantum number n first, and the largest ℓ within that n — which
 *    is why Fe²⁺ is [Ar] 3d⁶ rather than [Ar] 4s² 3d⁴. Electrons are added to
 *    anions at the lowest unfilled Madelung position.
 * 3. Orbital boxes obey Pauli exclusion (max 2 per mℓ, opposite spins) and
 *    Hund's rule (degenerate mℓ orbitals fill singly with parallel spins
 *    before pairing).
 * 4. Energies from `subshellEnergyEV` use Slater's rules + a hydrogenic
 *    formula. That is a quantitative *educational approximation*, not an
 *    HF/DFT result. Real multi-electron level ordering (e.g. 3d vs 4s) is not
 *    reproduced exactly; the UI says so.
 */

import { RYDBERG_EV } from './constants';
import type { ElementRecord } from '../data/types';

export type AzimuthalLabel = 's' | 'p' | 'd' | 'f';

export interface Subshell {
  /** "3d" */
  key: string;
  n: number;
  l: number;
  count: number;
}

/** Madelung (n + ℓ) filling order, the sequence used for rule-based predictions. */
export const MADELUNG_ORDER: Array<{ n: number; l: number }> = (() => {
  const list: Array<{ n: number; l: number }> = [];
  for (let n = 1; n <= 7; n++) {
    for (let l = 0; l <= 3; l++) {
      if (n > l) list.push({ n, l });
    }
  }
  return list.sort((a, b) => a.n + a.l - (b.n + b.l) || a.n - b.n);
})();

export const AZIMUTHAL: AzimuthalLabel[] = ['s', 'p', 'd', 'f'];

export function capacityFor(l: number): number {
  return 2 * (2 * l + 1);
}

export function subshellKey(n: number, l: number): string {
  return `${n}${AZIMUTHAL[l]}`;
}

export function parseSubshellKey(key: string): { n: number; l: number } {
  const m = /^(\d)([spdf])$/.exec(key);
  if (!m) throw new Error(`Bad subshell key: ${key}`);
  return { n: Number(m[1]), l: AZIMUTHAL.indexOf(m[2] as AzimuthalLabel) };
}

/** Rule-based neutral atom configuration from the Madelung ordering. */
export function fillMadelung(electrons: number): Subshell[] {
  const out: Subshell[] = [];
  let remaining = Math.max(0, Math.round(electrons));
  for (const { n, l } of MADELUNG_ORDER) {
    if (remaining <= 0) break;
    const cap = capacityFor(l);
    const count = Math.min(cap, remaining);
    remaining -= count;
    if (count > 0) out.push({ key: subshellKey(n, l), n, l, count });
  }
  return out;
}

export function fromSubshellTuple(
  tuples: Array<[number, AzimuthalLabel, number]>,
): Subshell[] {
  return tuples.map(([n, label, count]) => {
    const l = AZIMUTHAL.indexOf(label);
    return { key: subshellKey(n, l), n, l, count };
  });
}

export function electronCount(config: Subshell[]): number {
  return config.reduce((sum, s) => sum + s.count, 0);
}

export function sortConfig(config: Subshell[]): Subshell[] {
  return [...config].sort((a, b) => {
    const energyRankA = MADELUNG_ORDER.findIndex((o) => o.n === a.n && o.l === a.l);
    const energyRankB = MADELUNG_ORDER.findIndex((o) => o.n === b.n && o.l === b.l);
    return energyRankA - energyRankB || a.n - b.n || a.l - b.l;
  });
}

/**
 * Subshells ordered the way ionisation empties an atom: highest n first, then
 * highest ℓ. This is the "remove from the outside in" rule used throughout
 * general chemistry.
 */
export function ionisationOrder(config: Subshell[]): Subshell[] {
  return [...config].sort((a, b) => b.n - a.n || b.l - a.l);
}

export interface ConfigOptions {
  /** Expand the noble-gas core in the display string. */
  full?: boolean;
}

/**
 * Configuration for a species with `electrons` electrons and nuclear charge z.
 * `neutral` should be the tabulated ground state of the neutral atom when known.
 */
export function configurationForSpecies(
  z: number,
  electrons: number,
  neutral?: Subshell[],
): Subshell[] {
  const n = Math.max(0, Math.round(electrons));
  const base = neutral ?? fillMadelung(z);
  const baseCount = electronCount(base);

  if (n === baseCount) return sortConfig(base.map((s) => ({ ...s })));

  if (n < baseCount) {
    // Cation: remove in ionisation order.
    let toRemove = baseCount - n;
    const working = base.map((s) => ({ ...s }));
    for (const shell of ionisationOrder(working)) {
      if (toRemove <= 0) break;
      const taken = Math.min(shell.count, toRemove);
      shell.count -= taken;
      toRemove -= taken;
    }
    return sortConfig(working.filter((s) => s.count > 0));
  }

  // Anion / extra electrons: add at the lowest unfilled Madelung position.
  const working = base.map((s) => ({ ...s }));
  const counts = new Map(working.map((s) => [s.key, s.count]));
  let toAdd = n - baseCount;
  for (const { n: shellN, l } of MADELUNG_ORDER) {
    if (toAdd <= 0) break;
    if (shellN < Math.max(...working.map((s) => s.n), 1) && l < 3) continue;
    const key = subshellKey(shellN, l);
    const cap = capacityFor(l);
    const have = counts.get(key) ?? 0;
    const room = cap - have;
    if (room <= 0) continue;
    const added = Math.min(room, toAdd);
    counts.set(key, have + added);
    toAdd -= added;
    if (!working.some((s) => s.key === key)) {
      working.push({ key, n: shellN, l, count: added });
    }
  }
  // Fill in the lowest available Madelung slot for any remainder.
  for (const { n: shellN, l } of MADELUNG_ORDER) {
    if (toAdd <= 0) break;
    const key = subshellKey(shellN, l);
    const cap = capacityFor(l);
    const have = counts.get(key) ?? 0;
    const room = cap - have;
    if (room <= 0) continue;
    const added = Math.min(room, toAdd);
    counts.set(key, have + added);
    toAdd -= added;
    if (!working.some((s) => s.key === key)) {
      working.push({ key, n: shellN, l, count: added });
    }
  }
  return sortConfig(working.filter((s) => s.count > 0));
}

/** Noble-gas shorthand for display, e.g. "1s² 2s² 2p⁶ 3s¹" → "[Ne] 3s¹". */
const NOBLE_GAS_CORES: Array<{ z: number; symbol: string; config: Subshell[] }> = [
  { z: 2, symbol: 'He', config: fillMadelung(2) },
  { z: 10, symbol: 'Ne', config: fillMadelung(10) },
  { z: 18, symbol: 'Ar', config: fillMadelung(18) },
  { z: 36, symbol: 'Kr', config: fillMadelung(36) },
  { z: 54, symbol: 'Xe', config: fillMadelung(54) },
  { z: 86, symbol: 'Rn', config: fillMadelung(86) },
];

export function toDisplayString(config: Subshell[], options: ConfigOptions = {}): string {
  const sorted = sortConfig(config).filter((s) => s.count > 0);
  const supers = (v: number) => String(v).replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]);
  const plain = sorted.map((s) => `${s.key}${supers(s.count)}`).join(' ');
  if (options.full || sorted.length === 0) return plain || '—';
  const total = electronCount(sorted);
  for (let i = NOBLE_GAS_CORES.length - 1; i >= 0; i--) {
    const core = NOBLE_GAS_CORES[i];
    if (total <= core.z) continue;
    const coreSubshells = core.config;
    const matches = coreSubshells.every((cs) => {
      const found = sorted.find((s) => s.key === cs.key);
      return found !== undefined && found.count === cs.count;
    });
    if (!matches) continue;
    const remainder = sorted.filter((s) => !coreSubshells.some((cs) => cs.key === s.key));
    if (remainder.length === 0) continue;
    const rest = remainder.map((s) => `${s.key}${supers(s.count)}`).join(' ');
    // Never shorten to a core that leaves fewer subshells than the core itself.
    if (remainder.length < 2 && total < 20) return plain;
    return `[${core.symbol}] ${rest}`;
  }
  return plain;
}

/** Electrons per principal shell n, index 0 unused. */
export function shellPopulations(config: Subshell[]): number[] {
  const maxN = Math.max(1, ...config.map((s) => s.n));
  const shells = new Array(maxN + 1).fill(0) as number[];
  for (const s of config) shells[s.n] += s.count;
  return shells.slice(1);
}

export interface OrbitalBox {
  /** Magnetic quantum number mℓ. */
  ml: number;
  up: boolean;
  down: boolean;
  /** Which subshell this box belongs to, e.g. "2p". */
  subshell: string;
  index: number;
}

export interface OrbitalDiagram {
  key: string;
  n: number;
  l: number;
  boxes: OrbitalBox[];
  unpaired: number;
  /** true when the subshell is exactly half-filled or fully filled. */
  special: boolean;
}

/**
 * Orbital box diagram generated with Hund's rule and Pauli exclusion.
 * Boxes are the 2ℓ+1 mℓ orbitals; electrons enter singly with parallel spin
 * before pairing.
 */
export function orbitalDiagram(config: Subshell[]): OrbitalDiagram[] {
  return sortConfig(config)
    .filter((s) => s.count > 0)
    .map((s) => {
      const boxes: OrbitalBox[] = [];
      for (let ml = -s.l; ml <= s.l; ml++) {
        boxes.push({ ml, up: false, down: false, subshell: s.key, index: boxes.length });
      }
      let remaining = s.count;
      // Pass 1 — one spin-up electron per box (Hund's rule of maximum multiplicity).
      for (const box of boxes) {
        if (remaining <= 0) break;
        box.up = true;
        remaining -= 1;
      }
      // Pass 2 — pair with spin-down.
      for (const box of boxes) {
        if (remaining <= 0) break;
        box.down = true;
        remaining -= 1;
      }
      const unpaired = boxes.filter((b) => b.up !== b.down).length;
      return {
        key: s.key,
        n: s.n,
        l: s.l,
        boxes,
        unpaired,
        special: s.count === capacityFor(s.l) || s.count === capacityFor(s.l) / 2,
      };
    });
}

export function countUnpaired(config: Subshell[]): number {
  return orbitalDiagram(config).reduce((sum, d) => sum + d.unpaired, 0);
}

/** Outermost-shell subshells (the ones drawn in the Bohr view). */
export function outermostShell(config: Subshell[]): number {
  return Math.max(1, ...config.map((s) => s.n));
}

/**
 * Valence electrons used by the bonding models.
 * Main group: the outermost ns/np electrons. Transition metals: outermost ns
 * plus a partially filled (n−1)d, which is what actually participates in
 * bonding and common oxidation states.
 */
export function valenceElectrons(config: Subshell[], z: number): number {
  const outerN = outermostShell(config);
  const outer = config.filter((s) => s.n === outerN);
  let count = outer.reduce((sum, s) => sum + s.count, 0);
  const innerD = config.find((s) => s.l === 2 && s.n === outerN - 1);
  const innerF = config.find((s) => s.l === 3 && s.n === outerN - 2);
  if (innerD && innerD.count > 0 && innerD.count < capacityFor(2)) count += innerD.count;
  if (innerF && innerF.count > 0 && innerF.count < capacityFor(3) && z > 88) count += innerF.count;
  return count;
}

export interface ExcitationResult {
  ok: boolean;
  config: Subshell[];
  message: string;
}

/** Promote one electron from one subshell to another (a simplified excitation). */
export function excite(config: Subshell[], fromKey: string, toKey: string): ExcitationResult {
  const working = sortConfig(config.map((s) => ({ ...s })));
  const from = working.find((s) => s.key === fromKey);
  if (!from || from.count <= 0) {
    return { ok: false, config, message: `${fromKey} has no electron to promote.` };
  }
  const to = working.find((s) => s.key === toKey);
  const { n: toN, l: toL } = parseSubshellKey(toKey);
  const cap = capacityFor(toL);
  if (to && to.count >= cap) {
    return { ok: false, config, message: `${toKey} is already full (max ${cap}).` };
  }
  if (toN <= from.n) {
    return {
      ok: false,
      config,
      message: 'Absorption promotes an electron outward (higher n). Use emission to relax it.',
    };
  }
  from.count -= 1;
  if (to) to.count += 1;
  else working.push({ key: toKey, n: toN, l: toL, count: 1 });
  return {
    ok: true,
    config: sortConfig(working.filter((s) => s.count > 0)),
    message: `Promoted one electron ${fromKey} → ${toKey}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Approximate subshell energies — Slater's rules + hydrogenic formula.
 * ------------------------------------------------------------------ */

/** Slater's effective nuclear charge felt by an electron in `key`. */
export function slaterZeff(z: number, config: Subshell[], key: string): number {
  const target = parseSubshellKey(key);
  const isDOrF = target.l >= 2;
  // Electrons in the target subshell, excluding the one we are probing.
  // A virtual (empty) subshell has no same-group shielding partner.
  const sameGroup = Math.max(
    0,
    config.filter((s) => s.n === target.n && s.l === target.l).reduce((a, s) => a + s.count, 0) - 1,
  );
  let shielding = 0;
  if (target.n === 1 && target.l === 0) {
    shielding += 0.30 * sameGroup;
  } else if (isDOrF) {
    shielding += 0.35 * sameGroup;
    for (const s of config) {
      if (s.n === target.n && s.l === target.l) continue;
      const rankBefore = MADELUNG_ORDER.findIndex((o) => o.n === s.n && o.l === s.l);
      const targetRank = MADELUNG_ORDER.findIndex((o) => o.n === target.n && o.l === target.l);
      if (rankBefore < targetRank) shielding += 1.0 * s.count;
    }
  } else {
    shielding += 0.35 * sameGroup;
    for (const s of config) {
      if (s.n === target.n && s.l === target.l) continue;
      if (s.n === target.n - 1) {
        // (n−1) group: 0.85 for s/p targets, but d/f electrons below contribute 1.00.
        shielding += (s.l >= 2 ? 1.0 : 0.85) * s.count;
      } else if (s.n <= target.n - 2) {
        shielding += 1.0 * s.count;
      } else if (s.n === target.n) {
        shielding += 0.35 * s.count;
      }
    }
    // Electrons in higher shells do not shield.
  }
  const zeff = z - shielding;
  return Math.max(0.1, zeff);
}

/** Slater effective principal quantum number n*. */
const SLATER_NSTAR: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 3.7, 5: 4.0, 6: 4.2, 7: 4.2 };

/**
 * Approximate orbital energy in eV, E ≈ −Ry·(Z_eff / n_star)².
 *
 * Accurate to ~0.1 eV for hydrogen and useful to a few eV for many-electron
 * atoms; it is NOT a substitute for a Hartree–Fock calculation and does not
 * always reproduce 3d/4s ordering.
 */
export function subshellEnergyEV(z: number, config: Subshell[], key: string): number {
  const { n } = parseSubshellKey(key);
  const zeff = slaterZeff(z, config, key);
  const nStar = SLATER_NSTAR[n] ?? n;
  return -RYDBERG_EV * (zeff * zeff) / (nStar * nStar);
}

export interface ShellSummary {
  key: string;
  n: number;
  l: number;
  count: number;
  capacity: number;
  energyEV: number | null;
}

export function shellSummary(config: Subshell[], z: number, withEnergies = true): ShellSummary[] {
  return sortConfig(config).map((s) => ({
    key: s.key,
    n: s.n,
    l: s.l,
    count: s.count,
    capacity: capacityFor(s.l),
    energyEV: withEnergies ? subshellEnergyEV(z, config, s.key) : null,
  }));
}

/** Highest occupied subshell. */
export function hOMO(config: Subshell[]): Subshell | undefined {
  const sorted = sortConfig(config).filter((s) => s.count > 0);
  return sorted[sorted.length - 1];
}

/** Lowest empty subshell in Madelung order above the HOMO. */
export function lumo(config: Subshell[]): { key: string; n: number; l: number } | undefined {
  const highestN = outermostShell(config);
  const occupied = new Set(config.filter((s) => s.count > 0).map((s) => s.key));
  for (const { n, l } of MADELUNG_ORDER) {
    if (n < highestN) continue;
    const key = subshellKey(n, l);
    const cap = capacityFor(l);
    const found = config.find((s) => s.key === key);
    if (found && found.count >= cap) continue;
    if (occupied.has(key) && found && found.count < cap) return { key, n, l };
    if (!found) return { key, n, l };
  }
  return undefined;
}

export function configFromElement(record: ElementRecord): Subshell[] {
  return fromSubshellTuple(record.subshells);
}
