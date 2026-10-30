import { CONSTANTS, kjPerMolToEV } from '../engine/constants';
import { clamp } from '../sim/units';

/**
 * Bond parameters for the sandbox's chemical channel.
 *
 * A bond in this box is a share of the unpaired electrons two atoms actually have, so
 * its order is decided by that count and its curve is a Morse well — the one curve that
 * carries both measured numbers a bond actually has: the depth it takes to pull the pair
 * back apart, and the separation they settle at. The harmonic curve everyone teaches
 * first has no dissociation limit at all, so a stretched bond would never break; the
 * Morse goes to zero at infinity, which is what lets a molecule come apart when it is
 * hot enough.
 *
 * `MEASURED` holds the order-one curves and `MULTI` the doubled and tripled ones — the
 * π partners a second unpaired pair can buy. Every number in both is a gas-phase
 * spectroscopic constant or a mean bond enthalpy from the standard tables. Where a pair
 * is not listed the well is *estimated* with Pauling's combination rule — the mean of
 * the two homonuclear bond enthalpies plus the extra ionic resonance energy his
 * electronegativity formula gives, scaled by his bond-order relations — capped so a pair
 * of very different atoms cannot out-bind a fluorine. The source string says which of
 * the two any given bond is, because an estimate is not a measurement and the box should
 * not pretend otherwise.
 */

/** One bond's curve, in simulation units. */
export interface BondRow {
  /** Shared electron pairs this curve describes: 1 = σ, 2 = σ+π, 3 = σ+2π. */
  order: number;
  /** eV to separate the pair from its lowest vibrational level — the measured D₀. */
  dissociationEV: number;
  /** Å, the equilibrium separation. */
  lengthA: number;
  /** cm⁻¹ fundamental stretch, or null when the pair is estimated. */
  wavenumberCM: number | null;
  measured: boolean;
  /** What the log says about where these numbers came from. */
  source: string;
}

interface RawRow {
  /** Bond enthalpy at this order, kJ/mol. */
  kj: number;
  /** Equilibrium separation, Å. */
  a: number;
  /** Fundamental stretch, cm⁻¹. */
  cm: number | null;
}

/** Key of a pair, ordered by atomic number so H–O and O–H are one row. */
export function bondKey(zA: number, zB: number): string {
  return zA <= zB ? `${zA}-${zB}` : `${zB}-${zA}`;
}

/** What the log calls a bond of this order. */
export const ORDER_MARKS = ['', '–', '=', '≡'];

/**
 * Measured single bonds.
 *
 * Diatomics carry their spectroscopic constants; the rest are the mean bond enthalpies
 * chemists quote for that bond in its common molecule.
 */
const MEASURED: Record<string, RawRow> = {
  '1-1': { kj: 436, a: 0.7414, cm: 4401.4 }, // H₂
  '1-6': { kj: 413, a: 1.087, cm: 2906 }, // C–H, methane mean
  '1-7': { kj: 391, a: 1.012, cm: 3337 }, // N–H, ammonia mean
  '1-8': { kj: 463, a: 0.958, cm: 3657 }, // O–H, water mean
  '1-9': { kj: 567, a: 0.9168, cm: 3961 }, // HF
  '1-17': { kj: 431, a: 1.2746, cm: 2914 }, // HCl
  '1-35': { kj: 366, a: 1.414, cm: 2644 }, // HBr
  '1-53': { kj: 299, a: 1.609, cm: 2330 }, // HI
  '1-16': { kj: 347, a: 1.336, cm: 2615 }, // S–H
  '1-15': { kj: 322, a: 1.42, cm: 2400 }, // P–H
  '1-14': { kj: 318, a: 1.48, cm: 1950 }, // Si–H
  '1-3': { kj: 243, a: 1.5955, cm: 1407 }, // LiH
  '1-11': { kj: 205, a: 1.887, cm: 1170 }, // NaH
  '6-6': { kj: 347, a: 1.535, cm: 900 }, // C–C, ethane
  '6-7': { kj: 305, a: 1.47, cm: 1030 }, // C–N
  '6-8': { kj: 358, a: 1.43, cm: 1033 }, // C–O
  '6-9': { kj: 485, a: 1.383, cm: 1090 }, // C–F
  '6-17': { kj: 339, a: 1.78, cm: 732 }, // C–Cl
  '6-16': { kj: 259, a: 1.81, cm: 641 }, // C–S
  '7-7': { kj: 163, a: 1.447, cm: 1000 }, // N–N, hydrazine
  '7-8': { kj: 201, a: 1.40, cm: 1200 }, // N–O
  '8-8': { kj: 146, a: 1.469, cm: 880 }, // O–O, peroxide
  '8-9': { kj: 224, a: 1.70, cm: 950 }, // O–F
  '8-16': { kj: 352, a: 1.57, cm: 750 }, // S–O
  '8-14': { kj: 452, a: 1.64, cm: 800 }, // Si–O
  '8-17': { kj: 272, a: 1.70, cm: 780 }, // Cl–O
  '9-9': { kj: 159, a: 1.412, cm: 917 }, // F₂
  '17-17': { kj: 243, a: 1.988, cm: 554 }, // Cl₂
  '35-35': { kj: 193, a: 2.281, cm: 325 }, // Br₂
  '53-53': { kj: 151, a: 2.666, cm: 214 }, // I₂
  '16-16': { kj: 266, a: 2.055, cm: 474 }, // S₈ ring bond
  '15-15': { kj: 201, a: 2.21, cm: 330 }, // P₄ edge
  '14-14': { kj: 226, a: 2.33, cm: 400 }, // Si–Si
  '3-9': { kj: 577, a: 1.56, cm: 789 }, // LiF
  '3-17': { kj: 470, a: 2.02, cm: 645 }, // LiCl
  '11-9': { kj: 477, a: 1.925, cm: 690 }, // NaF
  '11-17': { kj: 410, a: 2.3608, cm: 366 }, // NaCl
  '19-35': { kj: 376, a: 2.821, cm: 225 }, // KBr
  '19-17': { kj: 443, a: 2.666, cm: 280 }, // KCl
  '55-17': { kj: 461, a: 3.287, cm: 327 }, // CsCl
  '12-8': { kj: 393, a: 1.994, cm: 785 }, // MgO
  '20-8': { kj: 358, a: 1.838, cm: 700 }, // CaO
};

/**
 * Measured doubled and tripled bonds, keyed `pair:order`.
 *
 * A second shared pair is not a hypothetical: two nitrogen atoms each carry three
 * unpaired electrons, and the molecule they form is bound by 9.8 eV at 1.10 Å, not by
 * the 1.7 eV at 1.45 Å that a single N–N linkage is worth. Only orders with a real
 * number in the literature are listed here — a pair that has no π row stays single
 * instead of being promoted by a formula.
 */
const MULTI: Record<string, RawRow> = {
  '6-6:2': { kj: 611, a: 1.339, cm: 1623 }, // C=C, ethene
  '6-6:3': { kj: 837, a: 1.203, cm: 1942 }, // C≡C, ethyne
  '6-7:2': { kj: 615, a: 1.279, cm: 1640 }, // C=N, imine
  '6-7:3': { kj: 887, a: 1.157, cm: 2250 }, // C≡N, nitrile
  '6-8:2': { kj: 745, a: 1.203, cm: 1746 }, // C=O, carbonyl
  '6-16:2': { kj: 536, a: 1.553, cm: 1533 }, // C=S, carbon disulfide
  '7-7:2': { kj: 418, a: 1.252, cm: 1450 }, // N=N, diazene
  '7-7:3': { kj: 945, a: 1.0975, cm: 2358.6 }, // N₂
  '7-8:2': { kj: 607, a: 1.193, cm: 1610 }, // N=O, nitrogen dioxide
  '8-8:2': { kj: 498, a: 1.2075, cm: 1580.2 }, // O₂
  '8-16:2': { kj: 522, a: 1.431, cm: 1361 }, // S=O, sulfur dioxide
};

/** The strongest measured curve this pair has, at or below the electrons on offer. */
function measuredOrder(key: string, maxOrder: number): number {
  for (let order = Math.min(3, maxOrder); order >= 2; order--) {
    if (MULTI[`${key}:${order}`]) return order;
  }
  return MEASURED[key] ? 1 : 0;
}

/**
 * Homonuclear bond enthalpy used by the estimate, kJ/mol.
 *
 * For a nonmetal this is the diatomic bond. For a metal it is *not*: Mg₂ is a
 * van der Waals dimer at a hundredth of an electronvolt, and quoting that would
 * tell the box magnesium does not bond at all. So a metal carries its enthalpy of
 * atomisation shared over its valence bonds, which is the energy a bulk-like
 * neighbourhood actually costs — an honest number for the wrong reason, and the
 * reason every metal row here is marked as an estimate the moment it is used.
 */
const HOMONUCLEAR: Record<string, number> = {
  H: 436, He: 8, Li: 159, Be: 136, B: 300, C: 347, N: 163, O: 146, F: 159, Ne: 8,
  Na: 108, Mg: 148, Al: 326, Si: 226, P: 201, S: 266, Cl: 243, Ar: 8,
  K: 89, Ca: 178, Sc: 378, Ti: 473, V: 515, Cr: 397, Mn: 281, Fe: 416, Co: 439,
  Ni: 430, Cu: 338, Zn: 131, Ga: 277, Ge: 328, As: 223, Se: 256, Br: 193, Kr: 8,
  Rb: 82, Sr: 164, Pd: 378, Ag: 285, Cd: 112, In: 204, Sn: 302, Sb: 255, Te: 197,
  I: 151, Xe: 8, Cs: 78, Ba: 180, W: 849, Pt: 566, Au: 369, Hg: 62, Tl: 193, Pb: 196,
};

/** kJ/mol·⁻¹ in Pauling's ionic resonance term: 96.5 kJ/mol per unit of Δχ². */
const PAULING_IONIC_KJ = 96.485;

/**
 * Pauling's bond-order relations, used only where the tables have no number.
 *
 * A doubled bond is shorter and stronger than a single one by a fairly regular amount
 * — carbon goes 1.535 → 1.339 → 1.203 Å — so an estimate shortens by 0.65·log₁₀(order)
 * Å and deepens by order^0.75. Both are interpolations, not measurements, which is why
 * the source string says so.
 */
const PAULING_LENGTH_DROP_A = 0.65;
const PAULING_ORDER_EXPONENT = 0.75;

/** The handful of element fields a bond estimate needs. */
export interface BondElement {
  z: number;
  symbol: string;
  electronegativity: number | null;
  covalentRadius: number | null;
}

function estimateRow(a: BondElement, b: BondElement, order: number): BondRow {
  const dA = HOMONUCLEAR[a.symbol] ?? 200;
  const dB = HOMONUCLEAR[b.symbol] ?? 200;
  const chiA = a.electronegativity ?? 1.5;
  const chiB = b.electronegativity ?? 1.5;
  // Pauling's extra stabilization, capped at the geometric mean of the two
  // homonuclear bonds so a cesium–fluorine pair cannot invent a hundred eV.
  const ionic = Math.min(PAULING_IONIC_KJ * (chiA - chiB) ** 2, 1.5 * Math.sqrt(dA * dB));
  const radiusA = (a.covalentRadius ?? 150) / 100;
  const radiusB = (b.covalentRadius ?? 150) / 100;
  return {
    order,
    dissociationEV: kjPerMolToEV(Math.max(4, ((dA + dB) / 2 + ionic) * order ** PAULING_ORDER_EXPONENT)),
    lengthA: clamp(radiusA + radiusB - PAULING_LENGTH_DROP_A * Math.log10(order), 0.6, 4.5),
    wavenumberCM: null,
    measured: false,
    source: `Pauling estimate for ${a.symbol}${ORDER_MARKS[order]}${b.symbol}`,
  };
}

/**
 * The curve for this pair of elements, at the highest order the electrons on offer
 * (`maxOrder`, from their unpaired valence) can actually pay for.
 *
 * A measured row wins at whatever order it is listed at, and a pair with no doubled row
 * is not promoted by a formula — an untabulated pair keeps its single bond rather than
 * inventing a π bond nobody measured.
 */
export function bondForPair(a: BondElement, b: BondElement, maxOrder = 1): BondRow {
  const key = bondKey(a.z, b.z);
  const measured = measuredOrder(key, maxOrder);
  if (measured > 0) {
    const row = MULTI[`${key}:${measured}`] ?? MEASURED[key];
    return {
      order: measured,
      dissociationEV: kjPerMolToEV(row.kj),
      lengthA: row.a,
      wavenumberCM: row.cm,
      measured: true,
      source: `measured ${a.symbol}${ORDER_MARKS[measured]}${b.symbol}`,
    };
  }
  return estimateRow(a, b, clamp(Math.round(maxOrder), 1, 3));
}

/** The Morse curve of a row, in simulation units. */
export interface MorseCurve {
  /**
   * eV, the depth of the well below the separated atoms (Dₑ).
   *
   * The tables quote D₀ — the energy to separate a pair that is already sitting in its
   * lowest vibrational level — and a molecule cannot climb out of the bottom of the
   * well, so the box's well is deeper by exactly the zero-point energy it leaves behind.
   * Without that step every measured bond is one half-quantum too weak.
   */
  depthEV: number;
  /** Å⁻¹, how fast the well opens on either side of `rₑ`. */
  rangeInvA: number;
  /** eV, the harmonic stretch quantum of this curve. */
  quantumEV: number;
}

/**
 * Solve the Morse curve for a row and a reduced mass.
 *
 * The three numbers depend on each other: the measured stretch fixes `a` through the
 * depth, the depth fixes the zero-point energy, and the zero-point energy is what
 * separates D₀ from Dₑ. Three passes of the pair converges well inside a per-cent.
 */
export function morseCurve(row: BondRow, massU: number): MorseCurve {
  const mu = Math.max(1e-6, massU) * CONSTANTS.u;
  let depthEV = row.dissociationEV + 0.02;
  let rangeInvA = 1;
  let quantumEV = 0;
  for (let pass = 0; pass < 3; pass++) {
    if (row.wavenumberCM == null) {
      rangeInvA = clamp(1.45 / row.lengthA + 0.55, 0.7, 3.2);
    } else {
      const omega = 2 * Math.PI * (CONSTANTS.c * 100) * row.wavenumberCM; // rad/s
      rangeInvA = clamp(omega * Math.sqrt(mu / (2 * Math.max(1e-6, depthEV) * CONSTANTS.eV)) / 1e10, 0.3, 8);
    }
    const omega = rangeInvA * 1e10 * Math.sqrt((2 * Math.max(1e-6, depthEV) * CONSTANTS.eV) / mu);
    quantumEV = (CONSTANTS.hbar * omega) / CONSTANTS.eV;
    // G(0) = ωₑ/2 − ωₑxₑ/4 for a Morse, and ωₑxₑ = ωₑ²/(4Dₑ) for this one.
    depthEV = row.dissociationEV + quantumEV / 2 - (quantumEV * quantumEV) / (16 * depthEV);
  }
  return { depthEV, rangeInvA, quantumEV };
}

/** Reduced mass of a pair, in u. */
export function reducedMassU(massA: number, massB: number): number {
  return (massA * massB) / Math.max(1e-9, massA + massB);
}

/**
 * The extra bond slots a group-14 atom can buy by promoting an s pair into the empty p
 * box, and what that promotion costs in eV.
 *
 * Carbon's ground state leaves two unpaired electrons, which is why CH₂ is a reactive
 * fragment and not a molecule. The ³P → ¹D promotion is 1.50 eV and buys two more
 * unpaired electrons; four C–H bonds pay 17 eV for it, so the box lets the third and
 * fourth bonds form and charges one of them for the promotion instead of pretending it
 * is free. Every element here carries its own measured first excited term.
 */
const PROMOTION: Record<string, Promotion> = {
  C: { slots: 2, energyEV: 1.5 }, // 2s²2p² → 2s¹2p³, ¹D
  Si: { slots: 2, energyEV: 1.19 },
  Ge: { slots: 2, energyEV: 1.4 },
  Sn: { slots: 2, energyEV: 1.96 },
  Pb: { slots: 2, energyEV: 2.33 },
};

export interface Promotion {
  /** Extra unpaired electrons the promotion buys. */
  slots: number;
  /** eV, paid once — the term energy between the ground and the promoted configuration. */
  energyEV: number;
}

/** The promotion this element has available, or null when its valence is what it is. */
export function promotionFor(symbol: string): Promotion | null {
  return PROMOTION[symbol] ?? null;
}
