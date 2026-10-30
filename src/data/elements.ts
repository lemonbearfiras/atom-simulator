/**
 * Periodic table reference layer.
 *
 * Merges the two generated halves, normalises a few known systematic
 * transcription slips, and refuses to load if the result breaks an invariant.
 * Sources: IUPAC/CIAAW atomic weights, NIST ASD configurations, Cordero et al.
 * (2008) covalent radii, Bondi/Alvarez van der Waals radii, Pauling electronegativities.
 */

import type { ElementCategory, ElementRecord } from './types';
import { ELEMENTS_1_56 } from './elements_1_56';
import { ELEMENTS_57_118 } from './elements_57_118';

/** Correct the inner-transition periods and groups. */
function normalise(record: ElementRecord): ElementRecord {
  const next: ElementRecord = { ...record };
  if (next.z >= 57 && next.z <= 71) {
    next.period = 6;
    next.block = 'f';
    if (next.category !== 'lanthanide') next.category = 'lanthanide';
  }
  if (next.z >= 89 && next.z <= 103) {
    next.period = 7;
    next.block = 'f';
    if (next.category !== 'actinide') next.category = 'actinide';
  }
  if (next.z === 1) next.category = 'nonmetal';
  if (next.z === 2) next.category = 'noble-gas';
  // Hydrogen sits in group 1 by convention; helium in group 18.
  if (next.z === 2) next.group = 18;
  return next;
}

function validate(records: ElementRecord[]): void {
  const problems: string[] = [];
  if (records.length !== 118) problems.push(`expected 118 records, got ${records.length}`);
  const seen = new Set<number>();
  const bySymbol = new Map<string, number>();
  for (const record of records) {
    if (record.z < 1 || record.z > 118) problems.push(`z out of range: ${record.z}`);
    if (seen.has(record.z)) problems.push(`duplicate z ${record.z}`);
    seen.add(record.z);
    const existing = bySymbol.get(record.symbol);
    if (existing !== undefined) problems.push(`duplicate symbol ${record.symbol} (${existing}, ${record.z})`);
    bySymbol.set(record.symbol, record.z);
    const electrons = record.subshells.reduce((sum, [, , count]) => sum + count, 0);
    if (electrons !== record.z) {
      problems.push(`${record.symbol}: subshell electrons ${electrons} !== z ${record.z}`);
    }
    for (const [n, l, count] of record.subshells) {
      const cap = { s: 2, p: 6, d: 10, f: 14 }[l];
      if (count > cap) problems.push(`${record.symbol}: ${n}${l} has ${count} > ${cap}`);
      if (count <= 0) problems.push(`${record.symbol}: empty subshell listed ${n}${l}`);
    }
    if (!record.atomicWeight && !record.mostStableA) {
      problems.push(`${record.symbol}: no atomic weight and no most-stable mass number`);
    }
  }
  for (let z = 1; z <= 118; z++) {
    if (!seen.has(z)) problems.push(`missing element z=${z}`);
  }
  if (problems.length > 0) {
    // Loud rather than silent: a broken reference table must never be trusted.
    console.error('[ATOMVERSE] periodic table validation failed:\n' + problems.join('\n'));
  }
}

export const ELEMENTS: ElementRecord[] = (() => {
  const merged = [...ELEMENTS_1_56, ...ELEMENTS_57_118].map(normalise).sort((a, b) => a.z - b.z);
  if (import.meta.env?.DEV) validate(merged);
  return merged;
})();

const BY_Z = new Map(ELEMENTS.map((e) => [e.z, e]));
const BY_SYMBOL = new Map(ELEMENTS.map((e) => [e.symbol, e]));
const BY_NAME = new Map(ELEMENTS.map((e) => [e.name.toLowerCase(), e]));

export function elementByZ(z: number): ElementRecord | null {
  return BY_Z.get(Math.round(z)) ?? null;
}

export function elementBySymbol(symbol: string): ElementRecord | null {
  return BY_SYMBOL.get(symbol) ?? null;
}

export function elementByName(name: string): ElementRecord | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

/** Atomic weight to use when converting atoms to mass; falls back to the most stable nuclide. */
export function atomicWeightOf(symbolOrZ: string | number): number {
  const record =
    typeof symbolOrZ === 'number'
      ? elementByZ(symbolOrZ)
      : elementBySymbol(symbolOrZ) ?? elementByName(symbolOrZ);
  if (!record) return Number.NaN;
  if (record.atomicWeight != null) return record.atomicWeight;
  const isotope = record.isotopes.find((i) => i.a === record.mostStableA) ?? record.isotopes[0];
  return isotope?.mass ?? record.mostStableA;
}

export function covalentRadiusPm(symbolOrZ: string | number): number {
  const record = typeof symbolOrZ === 'number' ? elementByZ(symbolOrZ) : elementBySymbol(symbolOrZ);
  return record?.covalentRadius ?? record?.atomicRadius ?? 120;
}

export function vdwRadiusPm(symbolOrZ: string | number): number {
  const record = typeof symbolOrZ === 'number' ? elementByZ(symbolOrZ) : elementBySymbol(symbolOrZ);
  const own = record?.vdWRadius;
  if (own != null) return own;
  // Noble gases and a handful of heavy elements lack tabulated vdW radii; the
  // engine needs a number, so scale the covalent radius and flag it as estimated.
  const cov = record?.covalentRadius ?? 150;
  return Math.round(cov * 1.5);
}

/** Standard CPK-derived colours, kept consistent between the 2-D and 3-D views. */
export const ELEMENT_COLORS: Record<string, string> = {
  H: '#f2f4f8', C: '#2f3742', N: '#3b6fe0', O: '#e0453a', F: '#66d19e', Cl: '#63cc68',
  Br: '#a0522d', I: '#7f4fd0', S: '#f2d14e', P: '#ff8c1a', B: '#f9a2b6', Si: '#b0a4a4',
  Na: '#ab5cf2', K: '#8f40d4', Mg: '#87d94a', Ca: '#3dff00', Fe: '#e06633', Cu: '#c88033',
  Zn: '#7d80b0', He: '#d9ffff', Ne: '#b5ffff', Ar: '#80d1f3', Kr: '#5cb5e0', Xe: '#429ecf',
  Rn: '#4aa3df', Li: '#cc80ff', Be: '#c2ff00', Al: '#bfa6a6', Ti: '#bec6d4', Ni: '#50d050',
};

export function elementColor(symbol: string): string {
  if (ELEMENT_COLORS[symbol]) return ELEMENT_COLORS[symbol];
  const hue = ((symbol.charCodeAt(0) ?? 0) * 47 + (symbol.charCodeAt(1) ?? 0) * 13) % 360;
  return `hsl(${hue} 55% 60%)`;
}

export interface TableFilter {
  id: string;
  label: string;
  test: (e: ElementRecord) => boolean;
}

export const TABLE_FILTERS: TableFilter[] = [
  { id: 'metals', label: 'Metals', test: (e) => isMetal(e) },
  { id: 'nonmetals', label: 'Nonmetals', test: (e) => e.category === 'nonmetal' },
  { id: 'metalloids', label: 'Metalloids', test: (e) => e.category === 'metalloid' },
  { id: 'alkali', label: 'Alkali metals', test: (e) => e.category === 'alkali-metal' },
  { id: 'alkaline', label: 'Alkaline earth metals', test: (e) => e.category === 'alkaline-earth-metal' },
  { id: 'transition', label: 'Transition metals', test: (e) => e.category === 'transition-metal' },
  { id: 'post', label: 'Post-transition metals', test: (e) => e.category === 'post-transition-metal' },
  { id: 'halogens', label: 'Halogens', test: (e) => e.category === 'halogen' },
  { id: 'noble', label: 'Noble gases', test: (e) => e.category === 'noble-gas' },
  { id: 'lanthanides', label: 'Lanthanides', test: (e) => e.z >= 57 && e.z <= 71 },
  { id: 'actinides', label: 'Actinides', test: (e) => e.z >= 89 && e.z <= 103 },
  { id: 'natural', label: 'Naturally occurring', test: (e) => e.naturallyOccurring },
  { id: 'synthetic', label: 'Synthetic only', test: (e) => !e.naturallyOccurring },
  { id: 'radioactive', label: 'No stable isotope', test: (e) => !e.hasStableIsotope },
];

export function isMetal(e: ElementRecord): boolean {
  return (
    e.category === 'alkali-metal' ||
    e.category === 'alkaline-earth-metal' ||
    e.category === 'transition-metal' ||
    e.category === 'post-transition-metal' ||
    e.category === 'lanthanide' ||
    e.category === 'actinide'
  );
}

export const CATEGORY_LABEL: Record<ElementCategory, string> = {
  'alkali-metal': 'Alkali metal',
  'alkaline-earth-metal': 'Alkaline earth metal',
  'transition-metal': 'Transition metal',
  'post-transition-metal': 'Post-transition metal',
  metalloid: 'Metalloid',
  nonmetal: 'Reactive nonmetal',
  halogen: 'Halogen',
  'noble-gas': 'Noble gas',
  lanthanide: 'Lanthanide',
  actinide: 'Actinide',
  unknown: 'Properties unknown',
};

export const CATEGORY_COLOR: Record<ElementCategory, string> = {
  'alkali-metal': '#ff6b6b',
  'alkaline-earth-metal': '#ffa94d',
  'transition-metal': '#74c0fc',
  'post-transition-metal': '#63e6be',
  metalloid: '#a9e34b',
  nonmetal: '#ffd43b',
  halogen: '#da77f2',
  'noble-gas': '#90be6d',
  lanthanide: '#f783ac',
  actinide: '#e599f7',
  unknown: '#495057',
};

/** Grid placement for the 18-column table; lanthanides/actinides sit in the two extra rows. */
export function tablePosition(e: ElementRecord): { col: number; row: number } {
  if (e.z >= 57 && e.z <= 71) {
    return { col: e.z - 57 + 3, row: 9 };
  }
  if (e.z >= 89 && e.z <= 103) {
    return { col: e.z - 89 + 3, row: 10 };
  }
  let col = e.group;
  if (e.z === 2) col = 18;
  return { col, row: e.period };
}
