/**
 * Shared data contracts for ATOMVERSE's reference datasets.
 *
 * Provenance rules (see docs/SCIENTIFIC-MODELS.md):
 *  - `measured` / `tabulated` values come from reference sources listed per field.
 *  - `null` means "no reliable value available" — never invent one.
 */

export type ElementCategory =
  | 'alkali-metal'
  | 'alkaline-earth-metal'
  | 'transition-metal'
  | 'post-transition-metal'
  | 'metalloid'
  | 'nonmetal'
  | 'halogen'
  | 'noble-gas'
  | 'lanthanide'
  | 'actinide'
  | 'unknown';

/** Data provenance tag used by the inspector UI. */
export type ValueKind = 'measured' | 'tabulated' | 'calculated' | 'estimated' | 'illustrative';

export interface IsotopeAbundance {
  /** Mass number A. */
  a: number;
  /** Nuclide mass in unified atomic mass units (u), 6 significant figures where tabulated. */
  mass: number;
  /** Terrestrial isotopic abundance, 0..1. Null for synthetic radionuclides. */
  abundance: number | null;
  /** Nuclear spin quantum number I (ℏ units). Null where not tabulated here. */
  spin: number | null;
  /** true when the nuclide is radioactive (half-life below geological timescales). */
  radioactive: boolean;
  /** Half-life in years. Null when stable or unmeasured. */
  halfLifeYears: number | null;
}

export interface ElementRecord {
  z: number;
  symbol: string;
  name: string;
  /** Standard atomic weight (u) from IUPAC/CIAAW. Null for elements with no stable nuclide. */
  atomicWeight: number | null;
  /** Mass number of the most stable / most common nuclide, used when atomicWeight is null. */
  mostStableA: number;
  category: ElementCategory;
  group: number;
  period: number;
  block: 's' | 'p' | 'd' | 'f';
  /** Ground-state electron configuration, noble-gas core form, e.g. "[Ar] 3d⁵ 4s¹". Includes known Aufbau exceptions. */
  configuration: string;
  /** Valence electrons used by the bonding models. */
  valenceElectrons: number;
  /** Pauling electronegativity; null where not tabulated (mostly Z > 99). */
  electronegativity: number | null;
  /** First ionisation energy in eV. */
  firstIonizationEnergy: number | null;
  /** Second ionisation energy in eV (partial table; null where omitted). */
  secondIonizationEnergy: number | null;
  /** Electron affinity in eV. */
  electronAffinity: number | null;
  /** Empirical / calculated atomic radius in pm. */
  atomicRadius: number | null;
  /** Single-bond covalent radius in pm. */
  covalentRadius: number | null;
  /** van der Waals radius in pm (Bondi / Alvarez set). */
  vdWRadius: number | null;
  /** Density at STP in g/cm³ (gas values marked by standardState). */
  density: number | null;
  meltingPointK: number | null;
  boilingPointK: number | null;
  /** Standard state at 298 K, 1 bar. */
  standardState: 'solid' | 'liquid' | 'gas' | 'unknown';
  /** Common oxidation states, ordered by prevalence, signed integers. */
  oxidationStates: number[];
  /** Occurs naturally (primordial or decay product) as opposed to synthetic-only. */
  naturallyOccurring: boolean;
  /** Stable (observationally) nuclides exist for this element. */
  hasStableIsotope: boolean;
  /** Named isotopes of this element carried in the isotope table. */
  isotopes: IsotopeAbundance[];
  /** Common compounds the element forms, for the element laboratory. */
  compounds: string[];
  /** Short factual summary shown in the element panel. */
  summary: string;
  /**
   * Subshell populations for the neutral ground state, spectroscopic order,
   * counts only (no Unicode superscripts). Counts are absolute — the noble-gas
   * core is expanded, e.g. carbon = [[1,"s",2],[2,"s",2],[2,"p",2]].
   * Must be consistent with `configuration`: the listed subshell counts plus any
   * core electrons must equal `z`.
   */
  subshells: Array<[n: number, l: 's' | 'p' | 'd' | 'f', count: number]>;
}

export type DecayMode =
  | 'alpha'
  | 'beta-'
  | 'beta+'
  | 'electron-capture'
  | 'gamma'
  | 'internal-conversion'
  | 'spontaneous-fission'
  | 'proton-emission'
  | 'neutron-emission'
  | 'stable';

export interface RadionuclideRecord {
  /** e.g. "U-238" */
  id: string;
  z: number;
  a: number;
  symbol: string;
  /** Nuclide mass in u. */
  mass: number | null;
  /** Half-life in years (may be fractional years). */
  halfLifeYears: number | null;
  /** Half-life in seconds, authoritative when >= 1 s. */
  halfLifeSeconds: number | null;
  /** Human readable half-life, e.g. "24.1 days". */
  halfLabelText: string;
  decayModes: Array<{ mode: DecayMode; branchFraction: number }>;
  /** Ground-state–to–ground-state Q value in MeV for the dominant mode. */
  qValueMeV: number | null;
  /** Alpha particle kinetic energy in MeV where applicable. */
  alphaEnergyMeV: number | null;
  /** Max beta energy in MeV where applicable. */
  betaMaxMeV: number | null;
  /** Prominent gamma energy in MeV where applicable. */
  gammaMeV: number | null;
  daughterId: string | null;
  note?: string;
}

export interface DecayChainStep {
  nuclideId: string;
  decayMode: DecayMode;
  halfLabelText: string;
}

export interface MoleculeBondRecord {
  /** 0-based atom index in the parent molecule's atom list. */
  a: number;
  b: number;
  order: 1 | 2 | 3 | 1.5;
  /** Equilibrium bond length in Å. */
  lengthAngstrom: number;
  /** Bond dissociation energy in kJ/mol. */
  energyKJPerMol: number;
  /** e.g. "sigma + one pi". */
  description: string;
}

export interface MoleculeRecord {
  id: string;
  name: string;
  /** Hill-order formula, e.g. "C2H4". */
  formula: string;
  /** Display formula with subscripts, e.g. "C₂H₄". */
  formulaPretty: string;
  /** Element symbols, one per atom. */
  atoms: string[];
  bonds: MoleculeBondRecord[];
  /**
   * Ångström coordinates. 3-D when the molecule is modelled in 3-D, otherwise all z = 0.
   * Order matches `atoms`.
   */
  geometry: Array<[number, number, number]>;
  /** VSEPR description of the reference centre, e.g. "bent (AX₂E₂)". */
  vsepr: string;
  /** Idealised bond angle in degrees at the reference centre. */
  bondAngleDeg: number | null;
  /** Dipole moment in Debye; 0 for nonpolar. */
  dipoleDebye: number | null;
  /** HOMO–LUMO / gap info where taught, in eV. */
  homoLumoGapEV: number | null;
  /** Molecular mass in u, computed from atomic weights at build time when omitted. */
  massU: number | null;
  unbondedPairsAtCentre: number;
  geometrySource: ValueKind;
  note: string;
}
