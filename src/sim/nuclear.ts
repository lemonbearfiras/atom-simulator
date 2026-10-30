import data from '../data/nuclides.json';
import { NEUTRON_MASS_U, clamp } from './units';

export interface Nuclide {
  z: number;
  a: number;
  stable: boolean;
  halfLifeSeconds: number | null;
  halfLifeLabel: string;
  mode: string;
  atomicMassU: number | null;
  alphaQEV: number | null;
  betaQEV: number | null;
  ecQEV: number | null;
  neutronSeparationEV: number | null;
  protonSeparationEV: number | null;
  estimatedMass: boolean;
}

export type NuclearMode = 'alpha' | 'beta−' | 'double beta−' | 'beta+' | 'electron capture' | 'fission' | 'neutron emission' | 'proton emission';
export interface NuclearDecay {
  mode: NuclearMode;
  products: { z: number; a: number }[];
  qEV: number;
  radiation: 'beta−' | 'beta+' | 'neutrino' | null;
  approximate: boolean;
}
export interface NuclearState {
  status: 'stable' | 'radioactive' | 'unknown';
  halfLifeLabel: string;
  mode: string;
  remainingSeconds: number;
}

const MASS_ENERGY_EV = 931.49410242e6;
export const ELECTRON_REST_EV = 510998.95;
const records = new Map<string, Nuclide>();
for (const row of data.rows) {
  const [z, a, stable, halfLifeSeconds, halfLifeLabel, mode, atomicMassU, alphaQEV, betaQEV, ecQEV,
    neutronSeparationEV, protonSeparationEV, estimatedMass] = row as [number, number, boolean, number | null, string,
    string, number | null, number | null, number | null, number | null, number | null, number | null, boolean];
  // Resonance widths are energies; LiveChart supplies their converted half-lives separately.
  const lifetimeLabel = /(?:keV|MeV|eV)$/.test(halfLifeLabel) && halfLifeSeconds != null
    ? `${halfLifeSeconds.toExponential(3)} s (from width)`
    : halfLifeLabel.replace(/^GT/, '>').replace(/^LT/, '<').replace(/^GE/, '≥').replace(/^LE/, '≤');
  records.set(`${z}:${a}`, { z, a, stable, halfLifeSeconds, halfLifeLabel: lifetimeLabel, mode, atomicMassU, alphaQEV, betaQEV,
    ecQEV, neutronSeparationEV, protonSeparationEV, estimatedMass });
}

export function nuclide(z: number, a: number): Nuclide | null {
  return records.get(`${z}:${a}`) ?? null;
}

const plans = new Map<string, NuclearDecay | null>();
export function decayPlan(z: number, a: number): NuclearDecay | null {
  const key = `${z}:${a}`;
  if (plans.has(key)) return plans.get(key)!;
  const record = nuclide(z, a);
  let plan: NuclearDecay | null = null;
  if (record && !record.stable && record.halfLifeSeconds != null && record.halfLifeSeconds > 0) {
    const make = (mode: NuclearMode, products: NuclearDecay['products'], qEV: number | null,
      radiation: NuclearDecay['radiation'] = null): NuclearDecay | null =>
      qEV != null && qEV > 0 && products.every(p => nuclide(p.z, p.a))
        ? { mode, products, qEV, radiation, approximate: record.estimatedMass } : null;
    switch (record.mode) {
      case 'A': plan = make('alpha', [{ z: z - 2, a: a - 4 }, { z: 2, a: 4 }], record.alphaQEV); break;
      case 'B-': plan = make('beta−', [{ z: z + 1, a }], record.betaQEV, 'beta−'); break;
      case '2B-': {
        const daughterMass = nuclide(z + 2, a)?.atomicMassU;
        plan = make('double beta−', [{ z: z + 2, a }], record.atomicMassU && daughterMass
          ? (record.atomicMassU - daughterMass) * MASS_ENERGY_EV : null, 'beta−');
        break;
      }
      case 'B+': plan = make('beta+', [{ z: z - 1, a }], record.ecQEV == null ? null : record.ecQEV - 2 * ELECTRON_REST_EV, 'beta+'); break;
      case 'EC':
      case 'EC+B+': plan = make('electron capture', [{ z: z - 1, a }], record.ecQEV, 'neutrino'); break;
      case 'N': plan = make('neutron emission', [{ z, a: a - 1 }, { z: 0, a: 1 }], -(record.neutronSeparationEV ?? 0)); break;
      case 'P': plan = make('proton emission', [{ z: z - 1, a: a - 1 }, { z: 1, a: 1 }], -(record.protonSeparationEV ?? 0)); break;
      case 'SF': {
        // A fixed illustrative split, not a measured fission-yield distribution.
        const a1 = Math.round((a - 2) * 0.42);
        const z1 = Math.round(z * a1 / (a - 2));
        const first = nuclide(z1, a1);
        const second = nuclide(z - z1, a - 2 - a1);
        if (record.atomicMassU && first?.atomicMassU && second?.atomicMassU) {
          const qEV = (record.atomicMassU - first.atomicMassU - second.atomicMassU - 2 * NEUTRON_MASS_U) * MASS_ENERGY_EV;
          plan = make('fission', [{ z: z1, a: a1 }, { z: z - z1, a: a - 2 - a1 }, { z: 0, a: 1 }, { z: 0, a: 1 }], qEV);
          if (plan) plan.approximate = true;
        }
        break;
      }
    }
  }
  plans.set(key, plan);
  return plan;
}

export function displayHalfLife(seconds: number): number {
  return clamp(0.8 + 0.35 * Math.log10(1 + seconds), 0.8, 10);
}

export function nuclearState(z: number, a: number, random: () => number): NuclearState {
  const record = nuclide(z, a);
  const plan = decayPlan(z, a);
  return {
    status: record?.stable ? 'stable' : record?.halfLifeSeconds ? 'radioactive' : 'unknown',
    halfLifeLabel: record?.halfLifeLabel || 'unknown',
    mode: plan?.mode ?? (record?.stable ? 'stable' : `${record?.mode || 'unknown'} (unmodeled)`),
    remainingSeconds: plan && record?.halfLifeSeconds
      ? -Math.log(Math.max(1e-12, 1 - random())) * displayHalfLife(record.halfLifeSeconds) / Math.LN2 : Infinity,
  };
}

export function nuclearDescription(z: number, a: number): string {
  const record = nuclide(z, a);
  if (record?.stable) return 'stable nucleus';
  if (!record?.halfLifeSeconds) return 'nuclear stability unknown';
  const plan = decayPlan(z, a);
  return `${plan?.mode ?? `${record.mode || 'decay'} unmodeled`} · half-life ${record.halfLifeLabel} (real)`;
}
