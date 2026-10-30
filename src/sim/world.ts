import { CONSTANTS } from '../engine/constants';
import { elementBySymbol, elementByZ } from '../data/elements';
import { decayPlan, nuclearState, nuclearDescription, nuclide, ELECTRON_REST_EV } from './nuclear';
import { bondForPair, morseCurve, ORDER_MARKS, promotionFor, reducedMassU, type BondRow } from '../data/bonds';
import type { ElementRecord } from '../data/types';
import { configFromElement, subshellEnergyEV } from '../engine/electronConfig';
import { linesForElement, photonFromEnergyEV, photonFromWavelengthNm } from '../engine/spectra';
import { createRng, type Rng } from '../engine/rng';
import {
  FREE_ENERGY_EV,
  LINE_WIDTH_EV,
  MIN_LINE_EV,
  capacityForL,
  electronEnergyEV,  electronForceEVperA,
  electronPotentialEV,
  excitedLevels,
  kineticEV,
  makeLevel,
  quantumDefect,
  snapToLevel,
  subshellLabel,
  type Bond,
  type Core,
  type Electron,
  type LevelSeed,
  type Neutron,
  type NuclearBurst,
  type NuclearRay,
  type Photon,
  type SimEvent,
} from './atom';
import {
  ACCEL_PER_EV_PER_U,
  COULOMB_EV,
  C_A_PER_FS,
  ELECTRON_MASS_U,
  MASS_SPEED_EV,
  NEUTRON_MASS_U,
  clamp,
} from './units';

/* ------------------------------------------------------------------ *
 * Short-range regularisation, in Å. The 1/r² law is untouched outside
 * these radii; inside them the force stays finite, which is what a fixed
 * timestep needs.
 * ------------------------------------------------------------------ */
const SOFT_E_CORE = 0.04;
const SOFT_E_E = 0.12;
const SOFT_CORE_CORE = 0.25;

/**
 * How close a stranger's electron may come to a nucleus.
 *
 * A bound electron belongs to its own core at its own level radius. An electron
 * that merely passes by feels the atom through its shells, and every term of that
 * field — the nucleus and each shell alike — is smoothed over the same kind of
 * sphere, so a neutral atom cancels to nothing at a distance instead of leaving a
 * residue. That cancellation is not decoration: soften the nucleus alone while
 * booking its shells as bare 1/r, and two hydrogen atoms 4 Å apart repel each other
 * with a few hundredths of an electronvolt per ångström — enough to blow a cold gas
 * apart before it ever gets to chemistry. Inside a shell, that shell stops
 * screening and the pull grows toward the full pseudo-charge of the core.
 *
 * The softening sets how far inside the innermost shell an electron may be placed
 * before the attraction is capped — which is the difference between a realistic gas
 * and a runaway: an unresolved dive through a bare 1/r hole at 0.04 Å converts tens
 * of eV of binding into hundreds of eV of junk kinetic energy in a single timestep.
 */
const SOFT_STRANGER = 0.5;
const SOFT_STRANGER_SQ = SOFT_STRANGER * SOFT_STRANGER;

/**
 * Acceleration per eV/Å of force on one electron. Every electron in the box has the
 * same mass, so the pair loops multiply by this instead of dividing by `massU` twice.
 */
const ELECTRON_ACCEL_PER_EVPERA = ACCEL_PER_EV_PER_U / ELECTRON_MASS_U;

/**
 * Radiative decay is real but roughly 10¹⁰ times too slow to watch, so the
 * Larmor power is multiplied up. Photon energies are unaffected: they are set
 * by the level gaps, not by the drain rate.
 */
const DEFAULT_RADIATION_BOOST = 3e4;

/** Light crosses this box in real life within a twentieth of a timestep. */
const PHOTON_DISPLAY_SPEED = 0.5;

/**
 * Atomic time covered by one rendered frame at 1×, when the machine can afford it.
 * Six femtoseconds is a pacing choice, not a physical one; a crowded box dilates to
 * less, because `FRAME_PAIR_FORCE_BUDGET` rations the work per frame instead.
 */
const FS_PER_FRAME = 6;

/**
 * Pair forces a frame is allowed to cost.
 *
 * Calibrated at about 40 ns per pair force in this model, so 1.7e5 of them land a
 * frame near one sixtieth of a second: ten atoms in the box integrate ~350 timesteps
 * and the clock dilates to a fraction of a femtosecond per frame, two atoms integrate
 * the whole 4000 and run at full speed. Lower it for a smoother picture with a slower
 * atomic clock, raise it for more atomic time per frame at the cost of a stutter.
 */
const FRAME_PAIR_FORCE_BUDGET = 1.7e5;

/** Resonant capture of a photon by one atom: boosted so a single photon can be caught. */
const ABSORPTION_RADIUS_A = 1.4;
const ABSORPTION_CHANCE = 0.05;
const STIMULATED_CHANCE = 0.03;

/** Free-electron capture range, Å. */
const CAPTURE_RADIUS_A = 9;

/**
 * Chemistry.
 *
 * `BOND_REACH_A` is how far apart two nuclei with valence to spare can be and still
 * have their clouds overlap enough for the covalent channel to switch on: at that
 * separation the measured Morse well is nearly empty, so switching costs nothing and
 * the pair simply falls in and pays for the fall in infrared. `BOND_FLOOR_FRACTION`
 * is where the repulsive branch of the well stops growing and turns into a hard
 * spring, the same trick the van der Waals wall uses so that a dive cannot bank
 * energy the force never charged.
 */
const BOND_REACH_A = 1.2;
const BOND_FLOOR_FRACTION = 0.55;
/**
 * A bond that has stretched to where it holds less than this fraction of its own depth
 * is over. That point lands within a few hundredths of an electronvolt of where the van
 * der Waals wall it hands off to is worth zero, so switching the pair's law back costs
 * neither side energy — which is the whole reason the break is written as a depth and
 * not as a radius.
 */
const BOND_RELEASE_FRACTION = 0.07;
/** Vibrational quanta one bond may shed per chemistry tick — a cap, not a rate. */
const MAX_VIBRATIONAL_DRAINS = 12;

const MAX_BODIES = 460;
const MAX_PHOTONS = 320;

const K_B_EV_PER_K = 8.617333262e-5;

/**
 * Energy of a hand-aimed photon: one decade of energy per 8 Å of drag.
 *
 * Light spans twelve orders of magnitude and this box is a few tens of ångström across, so
 * a linear map could never reach a gamma ray at all. The pull is logarithmic instead — a
 * nudge is a microwave, 24 Å is extreme ultraviolet, 64 Å is a MeV — which is also how it
 * reads on screen, because every equal stretch looks like the same step up the spectrum.
 */
export function photonEVForDrag(distanceA: number): number {
  return clamp(1e-2 * Math.pow(10, Math.max(0, distanceA) / 8), 1e-2, 1e7);
}

export interface SpawnOptions {
  charge?: number;
  massNumber?: number;
  /** Fraction of valence electrons promoted to an excited level at spawn. */
  excite?: number;
}

export class World {
  cores: Core[] = [];
  electrons: Electron[] = [];
  neutrons: Neutron[] = [];
  /** Reused each substep to hold the electrons that ride no shell. */
  private freeScratch: Electron[] = [];
  /** Covalent bonds between cores; the pair law of a bonded pair comes from these. */
  bonds: Bond[] = [];
  photons: Photon[] = [];
  events: SimEvent[] = [];
  nuclearBursts: NuclearBurst[] = [];
  nuclearRays: NuclearRay[] = [];
  nuclearDecays = 0;
  nuclearReleasedEV = 0;
  nuclearEscapedEV = 0;
  nuclearEscapedCharge = 0;
  nuclearEscapedMomentum = { x: 0, y: 0 };
  rng: Rng;

  width = 120;
  height = 70;
  wallsOn = false;
  /** Bare nuclei, free particles and light only: no shells, no chemistry, no element labels. */
  subatomicMode = false;
  /** Kelvin handed to every new body on top of its release speed; nothing in this box sits frozen. */
  thermostatK = 300;
  radiationBoost = DEFAULT_RADIATION_BOOST;

  timeFS = 0;
  /** Atomic time since the last round of bound/free labelling; labels run on a clock, not on pictures. */
  private labelClockFS = 0;
  frames = 0;
  lastDt = 0;
  lastSubsteps = 0;
  lastFrameFS = 0;
  clockDilated = false;
  emittedEV = 0;
  absorbedEV = 0;
  pumpEV = 0;
  /**
   * eV of bond energy released faster than a photon can carry it away.
   *
   * Radiative association pays for itself, but a bond formed in a hard dive can be
   * worth tens of electronvolts in one tick and a single photon of that size would be
   * fiction. The surplus waits here and is emitted as ordinary infrared quanta by the
   * vibrational cascade, which is how a real molecule does lose the energy anyway.
   */
  bondBankEV = 0;

  private nextId = 1;
  private coreIndex = new Map<number, Core>();
  /** Bond lookup by core-id pair, so the pair loop reads its law in one step. */
  private bondPairs = new Map<number, Bond>();
  /** Element-pair bond curves, resolved once per pair of symbols. */
  private bondRows = new Map<string, BondRow>();
  /** Core id → bonds drawn, rebuilt by `chemistry` so formation never double-books a valence. */
  private bondUsed = new Map<number, number>();

  constructor(seed = 0x5eed) {
    this.rng = createRng(seed);
  }

  /* ------------------------------------------------------------- spawning */

  bodyCount(): number {
    return this.cores.length + this.electrons.length + this.neutrons.length;
  }

  private lastFullWarnFrame = -999;

  private warnFull(): void {
    if (this.frames - this.lastFullWarnFrame < 30) return;
    this.lastFullWarnFrame = this.frames;
    this.log(`Body limit of ${MAX_BODIES} reached — clear the box to add more.`, 'warn');
  }

  spawnElectron(x: number, y: number, vx = 0, vy = 0): Electron | null {
    if (this.bodyCount() >= MAX_BODIES) {
      this.warnFull();
      return null;
    }
    const e: Electron = {
      kind: 'electron',
      id: this.nextId++,
      x,
      y,
      vx,
      vy,
      ax: 0,
      ay: 0,
      massU: ELECTRON_MASS_U,
      charge: -1,
      coreId: null,
      level: -1,
      couplingEV_A: COULOMB_EV,
      energyEV: 0,
      pendingRadiationEV: 0,
      clockR: 0,
      clockAccel: 0,
    };
    this.electrons.push(e);
    return e;
  }

  spawnNeutron(x: number, y: number, vx = 0, vy = 0): Neutron | null {
    if (this.bodyCount() >= MAX_BODIES) {
      this.warnFull();
      return null;
    }
    const n: Neutron = {
      kind: 'neutron',
      id: this.nextId++,
      nuclear: nuclearState(0, 1, this.rng),
      x,
      y,
      vx,
      vy,
      ax: 0,
      ay: 0,
      massU: NEUTRON_MASS_U,
      charge: 0,
    };
    this.neutrons.push(n);
    return n;
  }

  /** A bare proton: hydrogen with its one electron taken away. */
  spawnProton(x: number, y: number, vx = 0, vy = 0): Core | null {
    const record = elementBySymbol('H');
    if (!record) return null;
    const core = this.spawnCore(record, x, y, vx, vy, { charge: 1 });
    if (core) {
      core.symbol = 'p';
      core.name = 'proton';
    }
    return core;
  }

  /** A neutral atom of a real element, with its measured level structure. */
  spawnAtom(symbol: string, x: number, y: number, vx = 0, vy = 0, options: SpawnOptions = {}): Core | null {
    const record = elementBySymbol(symbol);
    if (!record) {
      this.log(`No measured record for “${symbol}”, so nothing was spawned.`, 'warn');
      return null;
    }
    return this.spawnCore(record, x, y, vx, vy, options);
  }

  private spawnCore(
    record: ElementRecord,
    x: number,
    y: number,
    vx: number,
    vy: number,
    options: SpawnOptions,
  ): Core | null {
    if (this.bodyCount() >= MAX_BODIES) {
      this.warnFull();
      return null;
    }
    const a = options.massNumber ?? record.mostStableA;
    if (!Number.isInteger(a) || a < record.z) return null;
    // In subatomic mode the box has no shells to fill: what the table drops is a nucleus.
    const charge = this.subatomicMode ? record.z : options.charge ?? 0;
    const built = this.buildCore(record, charge);
    if (!built) return null;
    const core = built.core;
    this.setIsotope(core, a);
    core.x = x;
    core.y = y;
    core.vx = vx;
    core.vy = vy;
    this.cores.push(core);
    this.coreIndex.set(core.id, core);
    this.fillLevels(core, built.occupancy);
    if (options.excite) {
      for (const e of this.electrons) {
        if (e.coreId !== core.id || e.level < 0) continue;
        if (this.rng() > options.excite) continue;
        const up = this.rungAbove(core, e.level);
        if (up >= 0) this.promote(e, core, up);
      }
    }
    this.refreshCore(core);
    return core;
  }

  /** Place electrons on their levels, spread around the core so they do not start on top of each other. */
  private fillLevels(core: Core, occupancy: number[]): void {
    let slot = 0;
    const placed: Electron[] = [];
    for (let i = 0; i < core.levels.length; i++) {
      const level = core.levels[i];
      for (let k = 0; k < occupancy[i]; k++) {
        const e = this.spawnElectron(0, 0, 0, 0);
        if (!e) return;
        const angle = slot * 2.399963229;
        e.x = core.x + Math.cos(angle) * level.radiusA;
        e.y = core.y + Math.sin(angle) * level.radiusA;
        e.vx = core.vx - Math.sin(angle) * level.speedAPerFs;
        e.vy = core.vy + Math.cos(angle) * level.speedAPerFs;
        e.coreId = core.id;
        e.level = i;
        e.couplingEV_A = level.couplingEV_A;
        e.energyEV = electronEnergyEV(e, core, level.couplingEV_A, SOFT_E_CORE);
        placed.push(e);
        slot += 1;
      }
    }
    this.centreOfMass(core, placed);
  }

  /**
   * Share the orbital momentum of the electrons just placed with the core.
   *
   * Every electron is put on its orbit relative to the nucleus, so as spawned the
   * pair carries the electron momenta as net momentum and the whole atom sails
   * away at its electron's fraction of the orbital speed — which then slams it
   * into the wall. Shifting core and electrons by one common velocity leaves every
   * *relative* velocity, and so every level energy, exactly as built, while
   * putting the total momentum where the atom was released.
   */
  private centreOfMass(core: Core, placed: Electron[]): void {
    if (placed.length === 0) return;
    let px = 0;
    let py = 0;
    let mass = 0;
    for (const e of placed) {
      px += e.massU * (e.vx - core.vx);
      py += e.massU * (e.vy - core.vy);
      mass += e.massU;
    }
    const shiftX = -px / (core.massU + mass);
    const shiftY = -py / (core.massU + mass);
    core.vx += shiftX;
    core.vy += shiftY;
    for (const e of placed) {
      e.vx += shiftX;
      e.vy += shiftY;
    }
  }

  /**
   * Build the level ladder of an element.
   *
   * The outermost occupied shell stays explicit; everything below it is a frozen
   * core whose subshells remain on the ladder as closed levels, so no electron
   * can ever radiate into them. Level energies are measured ionisation energies
   * where the table has them, otherwise Slater orbital energies rigidly shifted
   * to sit under the measured first ionisation energy.
   */
  private buildCore(record: ElementRecord, charge: number): { core: Core; occupancy: number[] } | null {
    const config = configFromElement(record);
    if (config.length === 0) return null;
    let outerN = Math.max(...config.map((s) => s.n));
    let valence = config.filter((s) => s.n === outerN && s.count > 0);
    while (valence.length === 0 && outerN > 1) {
      outerN -= 1;
      valence = config.filter((s) => s.n === outerN && s.count > 0);
    }
    const frozen = config.filter((s) => !valence.includes(s));
    const frozenElectrons = frozen.reduce((sum, s) => sum + s.count, 0);

    const slater = valence.map((s) => ({ s, e: subshellEnergyEV(record.z, config, s.key) }));
    const measured = record.firstIonizationEnergy;
    const shallowestSeed = slater.reduce((best, cur) => (cur.e > best.e ? cur : best), slater[0]);
    const shift = measured != null ? -measured - shallowestSeed.e : 0;

    const seeds: LevelSeed[] = [];
    const realCount = new Map<string, number>();
    for (const s of frozen) {
      seeds.push({
        key: s.key,
        n: s.n,
        l: s.l,
        energyEV: Math.min(-20, subshellEnergyEV(record.z, config, s.key)),
        capacity: capacityForL(s.l),
        frozen: true,
      });
    }
    for (const item of slater) {
      const energy = item.s === shallowestSeed.s && measured != null ? -measured : item.e + shift;
      seeds.push({ key: item.s.key, n: item.s.n, l: item.s.l, energyEV: energy, capacity: capacityForL(item.s.l), frozen: false });
      realCount.set(item.s.key, item.s.count);
    }
    seeds.sort((a, b) => a.energyEV - b.energyEV);

    const seriesCharge = 1;
    const defects = new Map<number, number>();
    for (const seed of seeds) {
      if (seed.frozen) continue;
      const value = quantumDefect(seed.n, seed.energyEV, seriesCharge);
      const known = defects.get(seed.l);
      if (known == null || value < known) defects.set(seed.l, value);
    }
    calibrateDefectFromLine(record, seeds, defects, seriesCharge);
    const knownKeys = new Set(seeds.map((s) => s.key));
    const extra = excitedLevels(outerN, defects, seriesCharge).filter((s) => !knownKeys.has(s.key));
    const levels = [...seeds, ...extra]
      .sort((a, b) => a.energyEV - b.energyEV)
      .map((s) => makeLevel(s, defects.get(s.l) ?? 0, SOFT_E_CORE));

    const core: Core = {
      kind: 'core',
      id: this.nextId++,
      symbol: record.symbol,
      name: record.name,
      z: record.z,
      a: record.mostStableA,
      nuclear: { status: 'unknown', halfLifeLabel: 'unknown', mode: 'unknown', remainingSeconds: Infinity },
      massU: record.atomicWeight ?? record.mostStableA,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      ax: 0,
      ay: 0,
      frozenElectrons,
      levels,
      counts: new Array(levels.length).fill(0) as number[],
      shellRadiusA: [],
      shellChargeEV: [],
      chargeBase: record.z - frozenElectrons,
      strangerCouplingEV_A: COULOMB_EV * (record.z - frozenElectrons),
      unpairedValence: 0,
      promotionPaid: false,
      excitationEV: 0,
      bonded: false,
      ljEpsilonEV: ljEpsilon(record),
      ljSigmaA: ljSigma(record),
      qNet: 0,
      lastLineNm: null,
      clockR: 0,
      clockAccel: 0,
    };

    const occupancy = new Array(levels.length).fill(0) as number[];
    for (let i = 0; i < levels.length; i++) {
      const count = realCount.get(levels[i].key);
      if (count != null) occupancy[i] = Math.min(levels[i].capacity, count);
    }
    let remaining = charge;
    while (remaining > 0) {
      const i = lastIndexWith(levels, occupancy, (count, level) => count > 0 && !level.frozen);
      if (i < 0) break;
      occupancy[i] -= 1;
      remaining -= 1;
    }
    while (remaining < 0) {
      const i = lastIndexWith(levels, occupancy, (count, level) => count < level.capacity && !level.frozen);
      if (i < 0) {
        this.log(`${record.symbol} has no room for another electron in this ladder.`, 'warn');
        break;
      }
      occupancy[i] += 1;
      remaining += 1;
    }
    core.frozenElectrons = Math.max(0, frozenElectrons - Math.max(0, remaining));
    core.chargeBase = record.z - core.frozenElectrons;
    core.qNet = core.chargeBase - occupancy.reduce((a, b) => a + b, 0);
    return { core, occupancy };
  }

  private setIsotope(core: Core, a: number): void {
    core.a = a;
    core.nuclear = nuclearState(core.z, a, this.rng);
    core.massU = (nuclide(core.z, a)?.atomicMassU ?? a) - (core.z - core.frozenElectrons) * ELECTRON_MASS_U;
  }

  /* ------------------------------------------------------------- dynamics */

  /**
   * Advance one rendered frame.
   *
   * The frame asks for `FS_PER_FRAME × speed` of atomic time and is integrated at
   * the timestep the physics demands — a fraction of the tightest orbit in the box,
   * so spawn uranium and the whole clock slows down with it. The budget is a limit on
   * the *work* a frame may do, not on the time it may cover: it is sized so a frame of
   * pair forces costs about one animation tick, whatever is in the box. If the timesteps
   * do not add up to the requested time the clock dilates (`clockDilated`, shown in the
   * HUD) instead of integrating badly, because an under-resolved step does not round the
   * energy, it invents one — and dilating buys a smooth picture at the same rate of
   * atomic time per second, since the frame cost is what the machine can afford either
   * way. Nothing here changes a photon energy; it only changes how fast we watch.
   */
  stepFrame(speed = 1, elapsedSeconds = 0): void {
    if (speed <= 0) return;
    this.advanceNuclear(clamp(elapsedSeconds, 0, 0.1) * clamp(speed, 0.05, 200));
    const wanted = FS_PER_FRAME * clamp(speed, 0.05, 200);
    const budget = clamp(Math.round(FRAME_PAIR_FORCE_BUDGET / Math.max(1, this.pairCount())), 8, 4000);
    let advanced = 0;
    let substeps = 0;
    let dt = 0;
    // Newly placed overlapping atoms must select their bond channel before the repulsive wall kicks them.
    if (!this.subatomicMode) {
      this.rebuildBondUsage();
      this.formBonds();
    }
    this.forces();
    while (substeps < budget && wanted - advanced > 1e-9) {
      dt = Math.min(this.pickDt(), wanted - advanced);
      this.substep(dt);
      advanced += dt;
      substeps += 1;
    }
    this.clockDilated = wanted - advanced > 1e-9;
    this.lastDt = dt;
    this.lastSubsteps = substeps;
    this.lastFrameFS = advanced;
    // Labels and chemistry refresh on an atomic-time cadence, not a per-picture one. Which law an
    // electron is booked under — bound to its own level, or free among the shells — is
    // the biggest single discontinuity in the books, and which law a pair of nuclei is on
    // (wall, or bond) is the second. Asking both once every 6 fs of real simulation time
    // keeps the drift per femtosecond the same whatever the frame budget happens to afford.
    this.labelClockFS += advanced;
    if (this.labelClockFS >= FS_PER_FRAME) {
      this.labelClockFS = 0;
      this.assignElectrons();
      this.chemistry();
    }
    this.updatePhotons(clamp(advanced / FS_PER_FRAME, 0.2, 20));
    this.frames += 1;
  }

  private pairCount(): number {
    const charges = this.electrons.length + this.cores.length;
    return (charges * (charges + 1)) / 2;
  }

  /** Set the translational temperature of every free particle and core, in kelvin. */
  setTemperature(kelvin: number): void {
    this.thermostatK = kelvin;
    const kT = K_B_EV_PER_K * kelvin;
    for (const c of this.cores) this.resampleSpeed(c, Math.sqrt(kT / (c.massU * MASS_SPEED_EV)));
    for (const e of this.electrons) {
      if (e.coreId != null) continue;
      this.resampleSpeed(e, Math.sqrt(kT / (e.massU * MASS_SPEED_EV)));
    }
    for (const n of this.neutrons) this.resampleSpeed(n, Math.sqrt(kT / (n.massU * MASS_SPEED_EV)));
    this.log(`Thermostat set to ${kelvin.toFixed(0)} K.`, 'info');
  }

  /** Two-dimensional Maxwell speed: Rayleigh with σ = √(kT/m). */
  private resampleSpeed(body: { vx: number; vy: number }, sigma: number): void {
    const angle = this.rng() * Math.PI * 2;
    const speed = sigma * Math.sqrt(-2 * Math.log(Math.max(1e-9, this.rng())));
    body.vx = Math.cos(angle) * speed;
    body.vy = Math.sin(angle) * speed;
  }

  /**
   * The tightest encounter in the box, electron or nucleus.
   *
   * Measured from the local acceleration, `2π·√(r/a)`, not from `2πr/v`: an
   * electron on a plunge orbit has almost no transverse speed, so the velocity
   * estimate says the orbit is slow exactly when it is about to whip through the
   * nucleus at the fastest speed in the box. The field counted is whichever one
   * bends this body hardest — its own level or a stranger's core it has dived into —
   * so an electron crossing a bare nucleus sets the clock too, not only the ones at
   * home, and a nucleus driven inside another atom's wall sets it as well. `forces()`
   * remembers that hardest pair on every body as it integrates, so asking the question
   * at each substep costs a sweep over bodies instead of a second sweep over pairs.
   */
  private fastestOrbitPeriod(): number {
    let period = 0.6;
    for (const e of this.electrons) {
      if (!(e.clockAccel > 0)) continue;
      const t = 2 * Math.PI * Math.sqrt(e.clockR / e.clockAccel);
      if (t < period) period = t;
    }
    for (const c of this.cores) {
      if (!(c.clockAccel > 0)) continue;
      const t = 2 * Math.PI * Math.sqrt(c.clockR / c.clockAccel);
      if (t < period) period = t;
    }
    return clamp(period, 1e-4, 2);
  }

  /** The timestep the box demands, asked again at every substep. */
  private pickDt(): number {
    const orbital = this.fastestOrbitPeriod() / 70;
    let vmax = 1;
    for (const e of this.electrons) vmax = Math.max(vmax, Math.sqrt(e.vx * e.vx + e.vy * e.vy));
    for (const c of this.cores) vmax = Math.max(vmax, Math.sqrt(c.vx * c.vx + c.vy * c.vy));
    for (const n of this.neutrons) vmax = Math.max(vmax, Math.sqrt(n.vx * n.vx + n.vy * n.vy));
    return clamp(Math.min(orbital, 0.05 / vmax), 2e-6, 4e-3);
  }

  /** Adaptive kick–drift–kick Verlet; variable steps are not strictly symplectic. */
  private substep(dt: number): void {
    this.halfKick(dt);
    this.drift(dt);
    this.forces();
    this.halfKick(dt);
    this.radiate(dt);
    // Asked every timestep, not every picture: a fast neutron walks tens of ångström
    // between two dilated frames, and the nucleus it should have been captured by is
    // simply behind it by the next look.
    if (this.neutrons.length > 0) this.captureNeutrons();
    this.timeFS += dt;
  }

  private halfKick(dt: number): void {
    for (const e of this.electrons) {
      e.vx += e.ax * dt * 0.5;
      e.vy += e.ay * dt * 0.5;
    }
    for (const c of this.cores) {
      c.vx += c.ax * dt * 0.5;
      c.vy += c.ay * dt * 0.5;
    }
    for (const n of this.neutrons) {
      n.vx += n.ax * dt * 0.5;
      n.vy += n.ay * dt * 0.5;
    }
  }

  private drift(dt: number): void {
    for (const e of this.electrons) {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (e.coreId == null) this.bounce(e);
    }
    for (const c of this.cores) {
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      this.bounceAtom(c);
    }
    for (const n of this.neutrons) {
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      this.bounce(n);
    }
  }

  /**
   * Every pair force at the current positions.
   *
   * An electron is pulled by each core through the smoothed Coulomb force with
   * the coupling of the level it occupies, electrons repel one another at the
   * full 1/r² law, and cores interact through their net charge plus the wall of
   * their clouds — that wall being a Lennard-Jones curve parameterised from
   * measured boiling points and van der Waals radii, or a measured Morse well
   * when the pair has actually bonded. Action equals reaction pair by pair, so
   * momentum is exact.
   */
  private forces(): void {
    for (const e of this.electrons) {
      e.ax = 0;
      e.ay = 0;
      e.clockAccel = 0;
    }
    for (const c of this.cores) {
      c.ax = 0;
      c.ay = 0;
      c.clockAccel = 0;
    }
    for (const n of this.neutrons) {
      n.ax = 0;
      n.ay = 0;
    }

    for (const e of this.electrons) {
      for (const c of this.cores) {
        const own = e.coreId === c.id && e.level >= 0;
        // Interatomic bound-electron interactions are already represented by the effective core-pair potential.
        if (ridesShell(e) && !own) continue;
        const dx = e.x - c.x;
        const dy = e.y - c.y;
        const r = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy));
        const f = own ? electronForceEVperA(e.couplingEV_A, r, SOFT_E_CORE) : strangerForceEVperA(c, r);
        const inv = 1 / r;
        const ux = dx * inv;
        const uy = dy * inv;
        const aE = -f * ELECTRON_ACCEL_PER_EVPERA;
        e.ax += aE * ux;
        e.ay += aE * uy;
        const bendE = Math.abs(f * ELECTRON_ACCEL_PER_EVPERA);
        if (bendE > e.clockAccel) {
          e.clockAccel = bendE;
          e.clockR = r;
        }
        const aC = (ACCEL_PER_EV_PER_U * f) / c.massU;
        c.ax += aC * ux;
        c.ay += aC * uy;
        const bendC = (ACCEL_PER_EV_PER_U * Math.abs(f)) / c.massU;
        if (bendC > c.clockAccel) {
          c.clockAccel = bendC;
          c.clockR = r;
        }
      }
    }

    // A free electron already feels bound electrons through the screened core field.
    const free = this.freeScratch;
    free.length = 0;
    for (const e of this.electrons) if (!ridesShell(e)) free.push(e);
    for (let i = 0; i < free.length; i++) {
      const a = free[i];
      for (let j = i + 1; j < free.length; j++) repelElectronPair(a, free[j]);
    }

    for (let i = 0; i < this.cores.length; i++) {
      const a = this.cores[i];
      for (let j = i + 1; j < this.cores.length; j++) {
        const b = this.cores[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const r = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy));
        const ux = dx / r;
        const uy = dy / r;
        // A bonded pair drops the van der Waals wall and takes the covalent curve in
        // its place: the wall *is* the closed-shell half of that curve, and running
        // both would bill the same cloud overlap twice.
        const bond = this.bonds.length === 0 ? null : this.bondOf(a, b);
        const f = coreCoreForceEVperA(a, b, r, bond);
        const ka = (ACCEL_PER_EV_PER_U * f) / a.massU;
        const kb = (ACCEL_PER_EV_PER_U * f) / b.massU;
        a.ax += ka * ux;
        a.ay += ka * uy;
        b.ax -= kb * ux;
        b.ay -= kb * uy;
        const bendA = Math.abs(ka);
        if (bendA > a.clockAccel) {
          a.clockAccel = bendA;
          a.clockR = r;
        }
        const bendB = Math.abs(kb);
        if (bendB > b.clockAccel) {
          b.clockAccel = bendB;
          b.clockR = r;
        }
      }
    }
  }

  /**
   * Radiation reaction for electrons that still have somewhere to fall.
   *
   * The classical Larmor power of the instantaneous acceleration decides *when*
   * the jump happens: the atom keeps a debt counter, and when it has accumulated
   * one whole quantum the electron jumps and a photon of exactly the measured
   * level gap comes out. The orbit itself is never bled down — a continuous
   * drain at fixed coupling makes the electron plunge through the softened
   * nucleus and pay for it with a hundred-eV "Lyman-alpha". Keeping the trigger
   * classical and the emission quantised is what makes the lines land on the
   * NIST wavelengths, and it is why a ground state — with nothing below it — is
   * exactly stable rather than merely long-lived.
   */
  private radiate(dt: number): void {
    for (const e of this.electrons) {
      if (e.coreId == null || e.level < 0) continue;
      const core = this.coreIndex.get(e.coreId);
      if (!core) continue;
      const target = this.nextLine(core, e.level);
      if (target < 0) {
        e.pendingRadiationEV = 0;
        continue;
      }
      const gap = core.levels[e.level].energyEV - core.levels[target].energyEV;
      const loss = larmorEVperFs(Math.sqrt(e.ax * e.ax + e.ay * e.ay)) * dt * this.radiationBoost;
      if (!(loss > 0)) continue;
      e.pendingRadiationEV += loss;
      if (e.pendingRadiationEV < gap) continue;
      e.pendingRadiationEV = 0;
      const from = core.levels[e.level];
      e.level = target;
      this.snapWithRecoil(e, core, core.levels[target]);
      this.emitPhoton(gap, e.x, e.y, core, from.key, core.levels[target].key);
      this.refreshCore(core);
      this.forces();
    }
  }

  /**
   * The level an electron radiates into: the deepest one below it that still has
   * room and is separated by more than a linewidth. Degenerate partners (2s and
   * 2p of hydrogen) are skipped, so a Rydberg electron falls in the few steps
   * that carry real energy rather than a swarm of zero-energy lines.
   */
  private nextLine(core: Core, from: number): number {
    const upper = core.levels[from].energyEV;
    for (let i = 0; i < from; i++) {
      const level = core.levels[i];
      if (level.closed) continue;
      if (core.counts[i] >= level.capacity) continue;
      if (upper - level.energyEV < MIN_LINE_EV) continue;
      return i;
    }
    return -1;
  }

  /** Move an electron onto a level and hand the momentum it drops to the nucleus. */
  private snapWithRecoil(e: Electron, core: Core, level: Core['levels'][number]): void {
    const px = e.massU * e.vx;
    const py = e.massU * e.vy;
    snapToLevel(e, core, level, SOFT_E_CORE);
    core.vx += (px - e.massU * e.vx) / core.massU;
    core.vy += (py - e.massU * e.vy) / core.massU;
  }

  private emitPhoton(energyEV: number, x: number, y: number, core: Core | null, fromKey: string, toKey: string, angle = this.rng() * Math.PI * 2): void {
    if (energyEV <= 0) return;
    if (this.photons.length >= MAX_PHOTONS) this.photons.splice(0, this.photons.length - MAX_PHOTONS + 1);
    const data = photonFromEnergyEV(energyEV);
    this.photons.push({
      id: this.nextId++,
      x,
      y,
      vx: Math.cos(angle) * PHOTON_DISPLAY_SPEED,
      vy: Math.sin(angle) * PHOTON_DISPLAY_SPEED,
      energyEV,
      wavelengthNm: data.wavelengthNm,
      frequencyHz: data.frequencyHz,
      region: data.region,
      rgb: data.rgb,
      sourceSymbol: core?.symbol ?? 'γ',
      fromKey,
      toKey,
      phase: this.rng() * Math.PI * 2,
    });
    this.emittedEV += energyEV;
    if (core) core.lastLineNm = data.wavelengthNm;
    const nm = data.wavelengthNm;
    const label = nm < 1 ? `${(nm * 1000).toFixed(1)} pm ${data.region}` : `${nm.toFixed(1)} nm ${data.region}`;
    const who = core ? `${core.symbol} ${fromKey}→${toKey}` : 'Hand-injected photon';
    this.log(`${who}: ${energyEV.toFixed(3)} eV, ${label}.`, 'light', nm);
  }

  /**
   * Photons travel and are taken back up only by an atom with a matching gap.
   *
   * A red photon crosses hydrogen untouched because nothing in the ladder is
   * 1.9 eV wide; a 121.6 nm one is caught by the ground state. A matching photon
   * that meets an already excited electron stimulates it: the electron drops and
   * a second photon leaves with the same energy and direction.
   */
  private updatePhotons(speed: number): void {
    const survivors: Photon[] = [];
    const clones: Photon[] = [];
    for (const p of this.photons) {
      p.x += p.vx * speed;
      p.y += p.vy * speed;
      p.phase += 0.7 * speed;
      // Light that has crossed the edge of the box is gone for good. Nothing brings it back
      // when the walls are off, so keeping it would let the list fill with radiation nobody
      // will ever meet again — and re-test every one of those quanta against every atom, forever.
      if (p.x < -6 || p.y < -6 || p.x > this.width + 6 || p.y > this.height + 6) continue;
      const outcome = this.photonInteraction(p, clones);
      if (outcome === 'absorbed') {
        this.absorbedEV += p.energyEV;
        continue;
      }
      survivors.push(p);
    }
    this.photons = survivors.concat(clones).slice(-MAX_PHOTONS);
  }

  private photonInteraction(p: Photon, clones: Photon[]): 'absorbed' | null {
    for (const e of this.electrons) {
      if (e.coreId == null || e.level < 0) continue;
      const core = this.coreIndex.get(e.coreId);
      if (!core) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) > ABSORPTION_RADIUS_A) continue;
      const up = this.resonantLevel(core, e.level, p.energyEV);
      if (up >= 0 && this.rng() < ABSORPTION_CHANCE) {
        this.log(`${core.symbol} caught ${p.wavelengthNm.toFixed(1)} nm: ${core.levels[e.level].key}→${core.levels[up].key}.`, 'light', p.wavelengthNm);
        this.promote(e, core, up, false);
        this.refreshCore(core);
        return 'absorbed';
      }
      const down = this.nextLine(core, e.level);
      if (down >= 0 && Math.abs(core.levels[e.level].energyEV - core.levels[down].energyEV - p.energyEV) < LINE_WIDTH_EV) {
        if (this.rng() < STIMULATED_CHANCE) {
          const from = core.levels[e.level];
          e.level = down;
          this.snapWithRecoil(e, core, core.levels[down]);
          clones.push({ ...p, id: this.nextId++ });
          this.emittedEV += from.energyEV - core.levels[down].energyEV;
          this.log(`Stimulated emission in ${core.symbol}: a twin ${p.wavelengthNm.toFixed(1)} nm photon.`, 'light', p.wavelengthNm);
          this.refreshCore(core);
          return null;
        }
      }
    }
    return null;
  }

  /** Move a bound electron to another level by hand, booking the energy to the pump. */
  exciteElectron(electronId: number, target: number): boolean {
    const e = this.electrons.find((candidate) => candidate.id === electronId);
    if (!e) return false;
    const core = this.coreIndex.get(e.coreId ?? -1);
    if (!core) return false;
    this.promote(e, core, target);
    this.refreshCore(core);
    return true;
  }

  /** Move an electron to another level, booking the difference to the pump account. */
  private promote(e: Electron, core: Core, target: number, pumped = true): void {
    const from = core.levels[e.level];
    const to = core.levels[target];
    if (!to || to.closed) return;
    // A photon that was just absorbed has already paid for the jump; charging the
    // pump as well would bill the same energy twice in the ledger.
    if (pumped) this.pumpEV += to.energyEV - (from ? from.energyEV : e.energyEV);
    e.level = target;
    this.snapWithRecoil(e, core, to);
  }

  /**
   * Bind, free and hand over electrons.
   *
   * An electron belongs to a core only while its energy there is negative: a
   * collision that lifts it above zero leaves it free, which is impact
   * ionisation. A free electron that falls deep enough into a core with room in
   * its ladder is captured, and the surplus — its kinetic energy plus the
   * binding it gains — leaves as one recombination photon.
   */
  private assignElectrons(): void {
    for (const e of this.electrons) {
      if (e.coreId != null) {
        const core = this.coreIndex.get(e.coreId);
        if (!core) {
          e.coreId = null;
          e.level = -1;
          continue;
        }
        e.energyEV = electronEnergyEV(e, core, e.couplingEV_A, SOFT_E_CORE);
        if (e.energyEV > 0) {
          this.log(`${core.symbol} lost an electron to impact (${e.energyEV.toFixed(2)} eV over).`, 'warn');
          e.coreId = null;
          e.level = -1;
          e.pendingRadiationEV = 0;
          // The shell it vacated is empty now, so it stops screening: the ion ahead of
          // the runaway pulls with its full net charge, which is the bill for the
          // escape. Skip this and an electron leaves its atom for free — 13.6 eV per
          // ionisation invented out of nothing, and the box never lights, because a
          // stale neutral core cannot recapture anything.
          this.refreshCore(core);
        }
        continue;
      }

      // A naked nucleus has no ladder to fall into: subatomic mode scatters electrons,
      // it does not take them in. Switching the mode back off hands the levels over again.
      if (this.subatomicMode) continue;

      let best: Core | null = null;
      let bestEnergy = FREE_ENERGY_EV;
      let bestLevel = -1;
      for (const c of this.cores) {
        if (Math.hypot(e.x - c.x, e.y - c.y) > CAPTURE_RADIUS_A) continue;
        const level = this.openSlot(c);
        if (level < 0) continue;
        const energy = strangerEnergyEV(e, c);
        // Capture only runs downhill: the level has to sit below the energy the
        // electron already carries, and the difference is the recombination photon.
        if (energy <= c.levels[level].energyEV + MIN_LINE_EV) continue;
        if (energy < bestEnergy) {
          bestEnergy = energy;
          best = c;
          bestLevel = level;
        }
      }
      if (!best || bestLevel < 0) continue;

      const photonEnergyEV = bestEnergy - best.levels[bestLevel].energyEV;
      e.coreId = best.id;
      e.level = bestLevel;
      this.snapWithRecoil(e, best, best.levels[bestLevel]);
      e.couplingEV_A = best.levels[bestLevel].couplingEV_A;
      e.pendingRadiationEV = 0;
      if (photonEnergyEV > MIN_LINE_EV) {
        this.emitPhoton(photonEnergyEV, e.x, e.y, best, 'free', best.levels[bestLevel].key);
      }
      this.refreshCore(best);
    }
  }

  /* ------------------------------------------------------------ chemistry */

  /**
   * Bond and unbond the atoms, once every 6 fs of atomic time.
   *
   * Chemistry is not a force — the force is the Morse curve, and the pair loop applies
   * it every timestep. What happens here is the *decision* about which curve a pair of
   * nuclei sits on: the van der Waals wall of two clouds that have not found each other,
   * or the covalent well of a shared pair. That decision has to be priced, because at
   * the moment it is taken the potential energy of the pair changes by several
   * electronvolts, and an unpriced switch is energy invented. So every switch pays: what
   * the swap gives up leaves as a photon of radiative association, what it costs comes
   * out of the pair's relative motion, and a switch nobody can afford waits for the next
   * tick instead of happening for free.
   */
  private chemistry(): void {
    if (this.subatomicMode) return;
    if (this.cores.length < 2) return;
    this.rebuildBondUsage();
    this.pruneUnaffordableBonds();
    this.formBonds();
    this.settleBonds();
    this.drainBondBank();
  }

  private rebuildBondUsage(): void {
    this.bondUsed.clear();
    for (const bond of this.bonds) {
      // A double bond spends two pairs, so it has to be charged two slots. Counting one per
      // bond is how oxygen ended up with four partners and no such molecule exists.
      this.bondUsed.set(bond.a.id, (this.bondUsed.get(bond.a.id) ?? 0) + bond.order);
      this.bondUsed.set(bond.b.id, (this.bondUsed.get(bond.b.id) ?? 0) + bond.order);
    }
  }

  /**
   * Electron pairs this atom still has to share, after the bonds it already holds.
   *
   * The count is what the unpaired electrons can do *plus* what a promotion could buy,
   * because whether the promotion is affordable is a question about the bond on the
   * table, not about the atom alone — `openBond` prices it and refuses the bond if the
   * release cannot pay.
   */
  private bondSlots(core: Core): number {
    return this.valenceCapacity(core) - this.bondSpent(core);
  }

  /** Shared pairs this atom owns: its unpaired electrons plus whatever a promotion can buy. */
  private valenceCapacity(core: Core): number {
    const promoted = core.qNet === 0 ? promotionFor(core.symbol)?.slots ?? 0 : 0;
    return core.unpairedValence + promoted;
  }

  /** Bond orders this atom has already promised away. */
  private bondSpent(core: Core): number {
    return this.bondUsed.get(core.id) ?? 0;
  }

  /**
   * Break whatever an atom can no longer pay for.
   *
   * Valence is a budget, not a suggestion: a bond spends one shared pair per order, and an
   * ionising knock or a beta decay can take an unpaired electron away from an atom that is
   * already sharing two. The surplus cannot sit there — real chemistry answers it by letting
   * the weakest bond go — so the box does the same, priced exactly like any other break,
   * with the well handed back to the pair's relative motion or to a photon.
   */
  private pruneUnaffordableBonds(): void {
    for (const core of this.cores) {
      while (this.bondSpent(core) > this.valenceCapacity(core)) {
        const mine = this.bonds
          .filter((bond) => bond.a === core || bond.b === core)
          .sort((p, q) => p.dissociationEV - q.dissociationEV);
        const weakest = mine[0];
        if (!weakest) return;
        const before = this.bonds.length;
        this.closeBond(weakest, Math.max(1e-4, Math.hypot(weakest.a.x - weakest.b.x, weakest.a.y - weakest.b.y)));
        // A break the pair cannot afford waits for the next tick, when the energy has had
        // somewhere else to come from. Bailing on the whole box is deliberate: the same
        // over-committed atom will be asked again in 6 fs.
        if (this.bonds.length === before) return;
      }
    }
  }

  /** What promoting this atom would cost this bond, or 0 when its own electrons cover it. */
  private promotionPrice(core: Core, order: number): number {
    if (core.promotionPaid || core.qNet !== 0) return 0;
    const promo = promotionFor(core.symbol);
    if (!promo || this.bondSpent(core) + order <= core.unpairedValence) return 0;
    return promo.energyEV;
  }

  /**
   * Try every close pair of atoms with unpaired electrons to spare.
   *
   * Two nuclei with a bond between them are not two nuclei any more; they are one
   * oscillator, and the box says so the moment their clouds overlap on the way in. The
   * order of that bond is the number of pairs *both* atoms have unpaired right now — a π
   * bond needs an electron that is already loose, so carbon reaches a double and nitrogen
   * reaches a triple — while a promoted electron is only good for one more σ partner. The
   * way out is left to the break test, so a fast pair that merely passed through does not
   * get booked as a molecule, and an atom that has given every pair it has away has
   * nothing left to share, which is why a box of H₂ still has walls between its molecules.
   */
  private formBonds(): void {
    for (let i = 0; i < this.cores.length; i++) {
      const a = this.cores[i];
      if (this.bondSlots(a) <= 0) continue;
      for (let j = i + 1; j < this.cores.length; j++) {
        const b = this.cores[j];
        if (this.bondSlots(b) <= 0 || this.bondOf(a, b)) continue;
        // A σ pair only needs a free slot on each side; the second and third need electrons
        // that are unpaired *and* not already promised to another bond. That is what keeps a
        // double-bonded oxygen spent, rather than a box of O₄ that no chemist has ever met.
        const piCapacity = Math.min(a.unpairedValence - this.bondSpent(a), b.unpairedValence - this.bondSpent(b));
        const order = Math.min(3, this.bondSlots(a), this.bondSlots(b), Math.max(1, piCapacity));
        if (order < 1) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const r = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy));
        const row = this.rowFor(a, b, order);
        // A radical with pairs still to give is not looking for a casual brush: two
        // half-filled clouds attract from further out than a closed shell ever does, and the
        // measured pair curve says so all the way in. The wall approximation cuts that off at
        // the bond length, so an atom still holding unshared electrons reaches out by a
        // fraction of a ångström per partner it could take.
        const hunting = 0.5 * Math.min(2, Math.min(this.bondSlots(a), this.bondSlots(b)));
        const reach = Math.max(row.lengthA + BOND_REACH_A + hunting, (a.ljSigmaA + b.ljSigmaA) / 2);
        if (r > reach) continue;
        // Only on the way in. A pair drifting apart at the edge of the reach is not
        // bonding, and taking it as bonded there would have the break test undo it on the
        // very next tick.
        if ((a.vx - b.vx) * dx + (a.vy - b.vy) * dy > 0) continue;
        if (this.openBond(a, b, r, row)) {
          if (this.bondSlots(a) <= 0) break;
        }
      }
    }
  }

  /** Accelerated Morse vibrational cooling; radial impulses preserve molecular rotation. */
  private settleBonds(): void {
    for (const bond of [...this.bonds]) {
      const a = bond.a;
      const b = bond.b;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const r = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy));
      const kinetic = this.relativeKineticEV(a, b);
      const well = bondPairEVperA(bond, r).energy;
      const total = kinetic + well;
      if (total >= 0) {
        // Flying apart with more energy than the well holds: over.
        if (
          -well < BOND_RELEASE_FRACTION * bond.dissociationEV &&
          (a.vx - b.vx) * dx + (a.vy - b.vy) * dy > 0
        ) {
          this.closeBond(bond, r);
          continue;
        }
        // A resonance still on its way in is not going to sit down and emit.
        continue;
      }
      for (let drained = 0; drained < MAX_VIBRATIONAL_DRAINS; drained++) {
        const ux = dx / r;
        const uy = dy / r;
        const radialSpeed = (a.vx - b.vx) * ux + (a.vy - b.vy) * uy;
        const radialKE = 0.5 * bond.reducedMassU * radialSpeed * radialSpeed * MASS_SPEED_EV;
        const vibration = radialKE + well + bond.dissociationEV;
        const q = bond.quantumEV;
        const effectiveLevel = (2 * bond.dissociationEV / q) *
          (1 - Math.sqrt(Math.max(0, 1 - vibration / bond.dissociationEV)));
        const level = Math.floor(effectiveLevel - 0.5);
        if (level < 1) break;
        const gap = q - q * q * level / (2 * bond.dissociationEV);
        if (gap <= MIN_LINE_EV || radialKE < gap) break;
        const change = radialSpeed * (Math.sqrt((radialKE - gap) / radialKE) - 1);
        const kickA = bond.reducedMassU / a.massU * change;
        const kickB = bond.reducedMassU / b.massU * change;
        a.vx += kickA * ux;
        a.vy += kickA * uy;
        b.vx -= kickB * ux;
        b.vy -= kickB * uy;
        this.emitPhoton(gap, (a.x + b.x) / 2, (a.y + b.y) / 2, a, `v${level}`, `v${level - 1}`);
      }
    }
  }

  /** Put one bond on the books and pay for switching the pair onto its curve. */
  private openBond(a: Core, b: Core, r: number, row: BondRow): boolean {
    const mu = reducedMassU(a.massU, b.massU);
    const curve = morseCurve(row, mu);
    const bond: Bond = {
      id: this.nextId++,
      a,
      b,
      order: row.order,
      dissociationEV: curve.depthEV,
      promotionA: this.promotionPrice(a, row.order),
      promotionB: this.promotionPrice(b, row.order),
      lengthA: row.lengthA,
      rangeInvA: curve.rangeInvA,
      quantumEV: curve.quantumEV,
      reducedMassU: mu,
      measured: row.measured,
      label: `${a.symbol}${ORDER_MARKS[row.order]}${b.symbol}`,
    };
    // The bond's own depth buys the promotion it needed; if it cannot, the pair stays two
    // atoms and the wall keeps them apart.
    const released = wallEnergyEV(a, b, r) - bondPairEVperA(bond, r).energy - bond.promotionA - bond.promotionB;
    if (!(released > 0)) return false;
    if (bond.promotionA > 0) {
      a.promotionPaid = true;
      a.excitationEV += bond.promotionA;
    }
    if (bond.promotionB > 0) {
      b.promotionPaid = true;
      b.excitationEV += bond.promotionB;
    }
    this.bonds.push(bond);
    this.bondPairs.set(this.pairKey(a.id, b.id), bond);
    a.bonded = true;
    b.bonded = true;
    this.bondUsed.set(a.id, (this.bondUsed.get(a.id) ?? 0) + bond.order);
    this.bondUsed.set(b.id, (this.bondUsed.get(b.id) ?? 0) + bond.order);
    // One photon can carry the depth of the well plus whatever the pair brought with it.
    // A harder release than that is a dive through the wall the bond has just replaced,
    // and the surplus waits in the bank instead of leaving as an invented X-ray.
    const flash = Math.min(released, row.dissociationEV + this.relativeKineticEV(a, b));
    const owed = released - flash;
    if (owed > 0) this.bondBankEV += owed;
    this.log(
      `${a.symbol} + ${b.symbol} → ${bond.label} at ${r.toFixed(2)} Å: ${released.toFixed(2)} eV given up (${row.source}).`,
      'bond',
    );
    if (flash > MIN_LINE_EV) {
      this.emitPhoton(flash, (a.x + b.x) / 2, (a.y + b.y) / 2, a, 'free', bond.label);
    } else {
      this.bondBankEV += flash;
    }
    return true;
  }

  /** Take a bond off the books and hand the pair back to the wall, priced the same way. */
  private closeBond(bond: Bond, r: number): void {
    const a = bond.a;
    const b = bond.b;
    // The well has to be paid back, and the promotion that bought this bond comes back
    // with it: the atoms relax to the configuration they were dropped in.
    const delta = wallEnergyEV(a, b, r) - bondPairEVperA(bond, r).energy - bond.promotionA - bond.promotionB;
    if (delta > 0 && !this.drainRelative(a, b, delta)) return;
    if (bond.promotionA > 0) {
      a.promotionPaid = false;
      a.excitationEV -= bond.promotionA;
    }
    if (bond.promotionB > 0) {
      b.promotionPaid = false;
      b.excitationEV -= bond.promotionB;
    }
    this.removeBond(bond);
    if (delta < -MIN_LINE_EV) {
      this.emitPhoton(-delta, (a.x + b.x) / 2, (a.y + b.y) / 2, a, bond.label, 'free');
    } else if (delta < 0) {
      this.bondBankEV += -delta;
    }
    this.log(`${bond.label} broke apart: the clouds are walling off again.`, 'warn');
  }

  private removeBond(bond: Bond): void {
    this.bondPairs.delete(this.pairKey(bond.a.id, bond.b.id));
    const at = this.bonds.indexOf(bond);
    if (at >= 0) this.bonds.splice(at, 1);
    const stillBonded = (core: Core) =>
      this.bonds.some((b) => b.a.id === core.id || b.b.id === core.id);
    bond.a.bonded = stillBonded(bond.a);
    bond.b.bonded = stillBonded(bond.b);
  }

  /**
   * Let the banked bond energy out, one quantum per tick per bond.
   *
   * Formation can hand over more than a single photon should, and a vibration that has
   * already settled cannot pay again. The surplus is still booked as owed, and it leaves
   * on the same clock as the chemistry that made it.
   */
  private drainBondBank(): void {
    if (this.bonds.length === 0 || !(this.bondBankEV > MIN_LINE_EV)) return;
    for (const bond of this.bonds) {
      if (!(this.bondBankEV > MIN_LINE_EV)) break;
      const step = Math.min(this.bondBankEV, Math.max(bond.quantumEV, MIN_LINE_EV));
      if (!(step > MIN_LINE_EV)) continue;
      this.bondBankEV -= step;
      this.emitPhoton(step, (bond.a.x + bond.b.x) / 2, (bond.a.y + bond.b.y) / 2, bond.a, 'bond', 'IR');
    }
  }

  /** The bond between these two cores, or null. Ids stay far below 2²⁰, so one multiply keys the pair. */
  private bondOf(a: Core, b: Core): Bond | null {
    return this.bondPairs.get(a.id < b.id ? this.pairKey(a.id, b.id) : this.pairKey(b.id, a.id)) ?? null;
  }

  private pairKey(lo: number, hi: number): number {
    return lo * 1048576 + hi;
  }

  /** The bond curve for a pair of elements at a given electron budget, resolved once and kept. */
  private rowFor(a: Core, b: Core, maxOrder: number): BondRow {
    const order = clamp(Math.round(maxOrder), 1, 3);
    const key = `${a.z <= b.z ? a.z + '-' + b.z : b.z + '-' + a.z}:${order}`;
    const cached = this.bondRows.get(key);
    if (cached) return cached;
    const row = bondForPair(
      elementBySymbol(a.symbol) ?? { z: a.z, symbol: a.symbol, electronegativity: null, covalentRadius: null },
      elementBySymbol(b.symbol) ?? { z: b.z, symbol: b.symbol, electronegativity: null, covalentRadius: null },
      order,
    );
    this.bondRows.set(key, row);
    return row;
  }

  /** Kinetic energy of a pair's relative motion, eV — the only part a molecule can spend. */
  private relativeKineticEV(a: Core, b: Core): number {
    const relX = a.vx - b.vx;
    const relY = a.vy - b.vy;
    const mu = (a.massU * b.massU) / (a.massU + b.massU);
    return 0.5 * mu * (relX * relX + relY * relY) * MASS_SPEED_EV;
  }

  /**
   * Take energy out of relative motion and leave the total momentum exactly where it was.
   *
   * Slowing an atom down is not the same as cooling a molecule: pushing on one nucleus
   * sends the pair's centre of mass off somewhere new, and the box would drift. This
   * scales only the relative velocity, so the pair loses vibration and keeps its flight.
   */
  private drainRelative(a: Core, b: Core, energyEV: number): boolean {
    if (energyEV <= 0) return true;
    const invSum = 1 / (a.massU + b.massU);
    const mu = a.massU * b.massU * invSum;
    const relX = a.vx - b.vx;
    const relY = a.vy - b.vy;
    const kinetic = 0.5 * mu * (relX * relX + relY * relY) * MASS_SPEED_EV;
    if (!(kinetic >= energyEV) || !(kinetic > 0)) return false;
    const scale = Math.sqrt((kinetic - energyEV) / kinetic);
    const comX = (a.massU * a.vx + b.massU * b.vx) * invSum;
    const comY = (a.massU * a.vy + b.massU * b.vy) * invSum;
    a.vx = comX + (mu / a.massU) * relX * scale;
    a.vy = comY + (mu / a.massU) * relY * scale;
    b.vx = comX - (mu / b.massU) * relX * scale;
    b.vy = comY - (mu / b.massU) * relY * scale;
    return true;
  }

  /** The deepest level on this ladder that still has room for an electron. */
  private openSlot(core: Core): number {
    for (let i = 0; i < core.levels.length; i++) {
      const level = core.levels[i];
      if (level.closed || level.frozen) continue;
      if (core.counts[i] >= level.capacity) continue;
      return i;
    }
    return -1;
  }

  /** The next rung up the ladder above `from` — where a nudge, not a tuned photon, puts an electron. */
  private rungAbove(core: Core, from: number): number {
    for (let i = from + 1; i < core.levels.length; i++) {
      const level = core.levels[i];
      if (level.closed || level.frozen) continue;
      if (core.counts[i] >= level.capacity) continue;
      return i;
    }
    return -1;
  }

  /** The open level whose gap from `from` matches the photon: absorption is a line, not a ladder. */
  private resonantLevel(core: Core, from: number, energyEV: number): number {
    const base = core.levels[from].energyEV;
    for (let i = from + 1; i < core.levels.length; i++) {
      const level = core.levels[i];
      if (level.closed || level.frozen) continue;
      if (core.counts[i] >= level.capacity) continue;
      if (Math.abs(level.energyEV - base - energyEV) < LINE_WIDTH_EV) return i;
    }
    return -1;
  }

  advanceNuclear(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    for (const burst of this.nuclearBursts) burst.ageSeconds += seconds;
    this.nuclearBursts = this.nuclearBursts.filter(b => b.ageSeconds < 1.6);
    for (const ray of this.nuclearRays) {
      ray.ageSeconds += seconds;
      ray.x += ray.vx * seconds;
      ray.y += ray.vy * seconds;
    }
    this.nuclearRays = this.nuclearRays.filter(r => r.ageSeconds < 3);
    let events = 0;
    // Snapshot parents so a daughter cannot run an entire decay chain in one frame.
    for (const parent of [...this.cores, ...this.neutrons]) {
      parent.nuclear.remainingSeconds -= seconds;
      if (parent.nuclear.remainingSeconds > 0 || events >= 8) continue;
      if (this.decayNucleus(parent)) events += 1;
      else parent.nuclear.remainingSeconds = 1;
    }
  }

  private decayNucleus(parent: Core | Neutron): boolean {
    const z = parent.kind === 'core' ? parent.z : 0;
    const a = parent.kind === 'core' ? parent.a : 1;
    const plan = decayPlan(z, a);
    if (!plan) return false;
    const crew = parent.kind === 'core' ? this.electrons.filter(e => e.coreId === parent.id) : [];
    const electronCount = (parent.kind === 'core' ? parent.frozenElectrons : 0) + crew.length;
    if (plan.mode === 'electron capture' && electronCount === 0) return false;
    let electronsLeft = electronCount - (plan.mode === 'electron capture' ? 1 : 0);
    const firstId = this.nextId;
    const prepared: { core: Core; occupancy: number[]; productIndex: number }[] = [];
    for (let i = 0; i < plan.products.length; i++) {
      const product = plan.products[i];
      if (product.z === 0) continue;
      const record = elementByZ(product.z);
      if (!record) { this.nextId = firstId; return false; }
      const assigned = i === 0 || plan.mode === 'fission' ? Math.min(electronsLeft, product.z) : 0;
      const built = this.buildCore(record, product.z - assigned);
      if (!built) { this.nextId = firstId; return false; }
      electronsLeft -= assigned;
      this.setIsotope(built.core, product.a);
      prepared.push({ ...built, productIndex: i });
    }
    const needed = prepared.reduce((sum, p) => sum + 1 + p.occupancy.reduce((x, y) => x + y, 0), 0)
      + plan.products.filter(p => p.z === 0).length;
    if (this.bodyCount() - 1 - crew.length + needed > MAX_BODIES) {
      this.nextId = firstId;
      this.warnFull();
      return false;
    }

    const beforeEnergy = this.kineticEnergyEV() + this.potentialEnergyEV();
    const momentum = [parent, ...crew].reduce((p, b) => ({ x: p.x + b.massU * b.vx, y: p.y + b.massU * b.vy }), { x: 0, y: 0 });
    const saved = { cores: this.cores, electrons: this.electrons, neutrons: this.neutrons, bonds: this.bonds,
      coreIndex: this.coreIndex, bondPairs: this.bondPairs, bonded: this.cores.map(c => c.bonded),
      promoted: this.cores.map(c => c.promotionPaid), excitation: this.cores.map(c => c.excitationEV) };
    this.cores = this.cores.filter(c => c !== parent);
    this.electrons = this.electrons.filter(e => !crew.includes(e));
    this.neutrons = this.neutrons.filter(n => n !== parent);
    this.bonds = [...this.bonds];
    this.bondPairs = new Map(this.bondPairs);
    this.coreIndex = new Map(this.coreIndex);
    this.coreIndex.delete(parent.id);
    for (const bond of this.bonds.filter(b => b.a === parent || b.b === parent)) this.removeBond(bond);
    const rollback = () => {
      this.cores = saved.cores;
      this.electrons = saved.electrons;
      this.neutrons = saved.neutrons;
      this.bonds = saved.bonds;
      this.coreIndex = saved.coreIndex;
      this.bondPairs = saved.bondPairs;
      this.cores.forEach((c, i) => {
        c.bonded = saved.bonded[i];
        c.promotionPaid = saved.promoted[i];
        c.excitationEV = saved.excitation[i];
      });
      this.nextId = firstId;
      return false;
    };

    const angle = this.rng() * Math.PI * 2;
    const groups: { body: Core | Neutron; crew: Electron[]; mass: number; dx: number; dy: number }[] = [];
    for (let i = 0; i < plan.products.length; i++) {
      const product = plan.products[i];
      const direction = angle + (i === 0 ? Math.PI : i === 1 ? 0 : (i - 1.5) * Math.PI);
      const distance = plan.products.length === 1 ? 0 : i < 2 ? 1.5 : 2.5;
      const x = parent.x + Math.cos(direction) * distance;
      const y = parent.y + Math.sin(direction) * distance;
      let body: Core | Neutron;
      let attached: Electron[] = [];
      if (product.z === 0) {
        body = this.spawnNeutron(x, y)!;
      } else {
        const built = prepared.find(p => p.productIndex === i)!;
        body = built.core;
        body.x = x;
        body.y = y;
        this.cores.push(body);
        this.coreIndex.set(body.id, body);
        this.fillLevels(body, built.occupancy);
        this.refreshCore(body);
        attached = this.electrons.filter(e => e.coreId === body.id);
      }
      const mass = body.massU + attached.length * ELECTRON_MASS_U;
      const weight = product.z === 0 && plan.mode === 'fission' ? 0.02 : 1;
      groups.push({ body, crew: attached, mass, dx: Math.cos(direction) * Math.sqrt(weight / mass),
        dy: Math.sin(direction) * Math.sqrt(weight / mass) });
    }
    const available = plan.qEV + beforeEnergy - this.kineticEnergyEV() - this.potentialEnergyEV();
    const totalMass = groups.reduce((s, g) => s + g.mass, 0);
    type RaySeed = { kind: NuclearRay['kind']; energyEV: number; charge: number; angle: number };
    const shakeoff: RaySeed[] = Array.from({ length: electronsLeft }, () =>
      ({ kind: 'electron', energyEV: 10, charge: -1, angle: this.rng() * Math.PI * 2 }));
    const betaAngle = this.rng() * Math.PI * 2;
    const neutrinoAngle = this.rng() * Math.PI * 2;
    const betaShare = 0.15 + 0.7 * this.rng();
    const radiationAt = (energy: number) => {
      const rays = [...shakeoff];
      if (plan.radiation === 'beta−' || plan.radiation === 'beta+') {
        const count = plan.mode === 'double beta−' ? 2 : 1;
        for (let i = 0; i < count; i++) {
          rays.push({ kind: plan.radiation, energyEV: energy * betaShare / count, charge: plan.radiation === 'beta−' ? -1 : 1, angle: betaAngle + i * Math.PI / 2 });
          rays.push({ kind: plan.radiation === 'beta−' ? 'antineutrino' : 'neutrino', energyEV: energy * (1 - betaShare) / count, charge: 0, angle: neutrinoAngle + i * Math.PI / 2 });
        }
      } else if (plan.radiation === 'neutrino') {
        rays.push({ kind: 'neutrino', energyEV: energy, charge: 0, angle: neutrinoAngle });
      }
      let px = 0;
      let py = 0;
      let total = 0;
      for (const ray of rays) {
        const pc = ray.charge === 0 ? ray.energyEV : Math.sqrt(ray.energyEV * (ray.energyEV + 2 * ELECTRON_REST_EV));
        const p = pc / (C_A_PER_FS * MASS_SPEED_EV);
        px += p * Math.cos(ray.angle);
        py += p * Math.sin(ray.angle);
        total += ray.energyEV;
      }
      const vx = (momentum.x - px) / totalMass;
      const vy = (momentum.y - py) / totalMass;
      return { rays, px, py, total, vx, vy, cost: total + kineticEV(totalMass, vx, vy) };
    };
    if (!Number.isFinite(available) || radiationAt(0).cost > available) return rollback();
    let radiation = radiationAt(0);
    if (plan.radiation) {
      let lo = 0;
      let hi = available;
      for (let i = 0; i < 64; i++) {
        const mid = (lo + hi) / 2;
        if (radiationAt(mid).cost > available) hi = mid;
        else lo = mid;
      }
      radiation = radiationAt((lo + hi) / 2);
    }
    const relativeEnergy = Math.max(0, available - radiation.cost);
    const meanX = groups.reduce((s, g) => s + g.mass * g.dx, 0) / totalMass;
    const meanY = groups.reduce((s, g) => s + g.mass * g.dy, 0) / totalMass;
    const seedEnergy = groups.reduce((s, g) => s + kineticEV(g.mass, g.dx - meanX, g.dy - meanY), 0);
    const scale = seedEnergy > 0 ? Math.sqrt(relativeEnergy / seedEnergy) : 0;
    for (const group of groups) {
      const vx = radiation.vx + (group.dx - meanX) * scale;
      const vy = radiation.vy + (group.dy - meanY) * scale;
      for (const body of [group.body, ...group.crew]) { body.vx += vx; body.vy += vy; }
    }
    for (const ray of radiation.rays) {
      this.nuclearRays.push({ id: this.nextId++, x: parent.x, y: parent.y, vx: Math.cos(ray.angle) * 14,
        vy: Math.sin(ray.angle) * 14, ageSeconds: 0, kind: ray.kind, energyEV: ray.energyEV, charge: ray.charge });
      this.nuclearEscapedCharge += ray.charge;
    }
    this.nuclearEscapedMomentum.x += radiation.px;
    this.nuclearEscapedMomentum.y += radiation.py;
    this.nuclearEscapedEV += radiation.total;
    this.nuclearReleasedEV += plan.qEV;
    this.nuclearDecays += 1;
    const name = `${z === 0 ? 'n' : elementByZ(z)!.symbol}-${a}`;
    const daughters = plan.products.map(p => p.z === 0 ? 'n' : `${elementByZ(p.z)!.symbol}-${p.a}`).join(' + ');
    const label = `${name} → ${daughters} · ${plan.mode}`;
    this.nuclearBursts.push({ id: this.nextId++, x: parent.x, y: parent.y, ageSeconds: 0, mode: plan.mode, label });
    this.nuclearBursts = this.nuclearBursts.slice(-32);
    this.nuclearRays = this.nuclearRays.slice(-256);
    this.rebuildBondUsage();
    this.log(`${label}; Q ${(plan.qEV / 1e6).toPrecision(4)} MeV${plan.approximate ? ' (approximate products / mass)' : ''}. Real half-life ${parent.nuclear.halfLifeLabel}; display time compressed.`, 'warn');
    return true;
  }

  private captureNeutrons(): void {
    const keep: Neutron[] = [];
    for (const n of this.neutrons) {
      let captured = false;
      for (const c of this.cores) {
        if (Math.hypot(n.x - c.x, n.y - c.y) > 0.9) continue;
        if (Math.hypot(n.vx - c.vx, n.vy - c.vy) > 60) continue;
        const qEV = nuclide(c.z, c.a + 1)?.neutronSeparationEV;
        if (qEV == null || qEV <= 0 || this.rng() > 0.06) continue;
        const crew = this.electrons.filter(e => e.coreId === c.id);
        const incoming = [c, ...crew, n];
        const beforeKE = incoming.reduce((s, b) => s + kineticEV(b.massU, b.vx, b.vy), 0);
        const px = incoming.reduce((s, b) => s + b.massU * b.vx, 0);
        const py = incoming.reduce((s, b) => s + b.massU * b.vy, 0);
        this.setIsotope(c, c.a + 1);
        if (c.symbol === 'p') { c.symbol = 'H'; c.name = 'Hydrogen'; }
        const bodies = [c, ...crew];
        const mass = bodies.reduce((s, b) => s + b.massU, 0);
        const shiftX = (px - bodies.reduce((s, b) => s + b.massU * b.vx, 0)) / mass;
        const shiftY = (py - bodies.reduce((s, b) => s + b.massU * b.vy, 0)) / mass;
        for (const b of bodies) { b.vx += shiftX; b.vy += shiftY; }
        const baseKE = bodies.reduce((s, b) => s + kineticEV(b.massU, b.vx, b.vy), 0);
        const available = qEV + beforeKE - baseKE;
        const angle = this.rng() * Math.PI * 2;
        const ux = Math.cos(angle);
        const uy = Math.sin(angle);
        const cost = (energy: number) => {
          const p = energy / (C_A_PER_FS * MASS_SPEED_EV);
          return energy + kineticEV(mass, (px - p * ux) / mass, (py - p * uy) / mass) - kineticEV(mass, px / mass, py / mass);
        };
        let lo = 0;
        let hi = Math.max(0, available) * 2;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (cost(mid) > available) hi = mid;
          else lo = mid;
        }
        const gammaEV = (lo + hi) / 2;
        const p = gammaEV / (C_A_PER_FS * MASS_SPEED_EV);
        for (const b of bodies) { b.vx -= p * ux / mass; b.vy -= p * uy / mass; }
        this.nuclearReleasedEV += qEV;
        this.nuclearEscapedMomentum.x += p * ux;
        this.nuclearEscapedMomentum.y += p * uy;
        this.emitPhoton(gammaEV, c.x, c.y, c, 'n', `${c.symbol}-${c.a}`, angle);
        this.log(`Neutron captured: ${c.symbol}-${c.a}, ${(gammaEV / 1e6).toFixed(4)} MeV gamma; ${nuclearDescription(c.z, c.a)}.`, 'bond');
        captured = true;
        break;
      }
      if (!captured) keep.push(n);
    }
    const changed = this.neutrons.length !== keep.length;
    this.neutrons = keep;
    if (changed) this.forces();
  }

  private bounce(body: { x: number; y: number; vx: number; vy: number }): void {
    if (!this.wallsOn) return;
    if (body.x < 0) this.mirrorX(body, 0);
    else if (body.x > this.width) this.mirrorX(body, this.width);
    if (body.y < 0) this.mirrorY(body, 0);
    else if (body.y > this.height) this.mirrorY(body, this.height);
  }

  /**
   * The wall scatters the whole atom, not whichever member happened to cross it.
   *
   * Reflecting one particle of a bound pair rewrites their *relative* velocity: it
   * strips angular momentum off the electron, the electron falls to a tighter
   * orbit and the box quietly eats the energy difference. Mirroring nucleus and
   * electrons together in the wall plane is the specular reflection of a neutral
   * atom — orbit, energy and sense of rotation survive the bounce untouched.
   */
  private bounceAtom(core: Core): void {
    if (!this.wallsOn) return;
    const crew = this.electrons.filter((e) => e.coreId === core.id);
    if (core.x < 0 || core.x > this.width) {
      const wall = core.x < 0 ? 0 : this.width;
      for (const body of [core, ...crew]) this.mirrorX(body, wall);
    }
    if (core.y < 0 || core.y > this.height) {
      const wall = core.y < 0 ? 0 : this.height;
      for (const body of [core, ...crew]) this.mirrorY(body, wall);
    }
  }

  private mirrorX(body: { x: number; y: number; vx: number; vy: number }, wall: number): void {
    body.x = 2 * wall - body.x;
    body.vx = -body.vx;
  }

  private mirrorY(body: { x: number; y: number; vx: number; vy: number }, wall: number): void {
    body.y = 2 * wall - body.y;
    body.vy = -body.vy;
  }

  /** Recount who is on which level, close the filled subshells, update net charge. */
  private refreshCore(core: Core): void {
    core.counts = new Array(core.levels.length).fill(0) as number[];
    let bound = 0;
    for (const e of this.electrons) {
      if (e.coreId !== core.id || e.level < 0) continue;
      core.counts[e.level] += 1;
      bound += 1;
    }
    const radius: number[] = [];
    const charge: number[] = [];
    let unpaired = 0;
    for (let i = 0; i < core.levels.length; i++) {
      core.levels[i].closed = core.levels[i].frozen || core.counts[i] >= core.levels[i].capacity;
      if (core.counts[i] > 0) {
        radius.push(core.levels[i].radiusA);
        charge.push(COULOMB_EV * core.counts[i]);
        // Hund's rule on the level as it stands: paired boxes contribute nothing to
        // bonding, half-filled ones contribute every electron. Only the explicit
        // levels count, because a frozen core electron is not in the box to share.
        const capacity = core.levels[i].capacity;
        const filled = capacity / 2;
        unpaired += core.counts[i] <= filled ? core.counts[i] : capacity - core.counts[i];
      }
    }
    core.shellRadiusA = radius;
    core.shellChargeEV = charge;
    core.strangerCouplingEV_A = COULOMB_EV * core.chargeBase;
    core.unpairedValence = unpaired;
    core.qNet = core.chargeBase - bound;
  }

  refreshAllCores(): void {
    for (const c of this.cores) this.refreshCore(c);
  }

  /* ------------------------------------------------------------- controls */

  /**
   * Strip the box to nuclei, loose electrons, neutrons and light.
   *
   * Every body that rode a shell leaves the box the way an erase takes a body: with its
   * energy, as a bookkeeping entry rather than an invention. What is left is Rutherford
   * physics — naked Coulomb between bare nuclei and the electrons that fly past them,
   * radioactive decay, neutron capture, and light nobody can absorb because nothing has a
   * level left to jump. Turning the mode back off hands the ladders over again, and a free
   * electron in range falls into one with a recombination photon.
   */
  setSubatomicMode(on: boolean): void {
    if (this.subatomicMode === on) return;
    this.subatomicMode = on;
    if (!on) {
      this.log('Atomic mode back on: shells, chemistry and line spectra are modelled again.', 'info');
      return;
    }
    const stripped = this.electrons.filter((e) => e.coreId != null).length;
    const broken = this.bonds.length;
    const writtenOff = this.bondBankEV;
    this.electrons = this.electrons.filter((e) => e.coreId == null);
    this.bonds = [];
    this.bondPairs.clear();
    this.bondUsed.clear();
    this.bondBankEV = 0;
    for (const core of this.cores) {
      core.frozenElectrons = 0;
      core.chargeBase = core.z;
      core.promotionPaid = false;
      core.excitationEV = 0;
      core.bonded = false;
      core.lastLineNm = null;
    }
    this.refreshAllCores();
    this.forces();
    this.log(
      `Subatomic mode: ${stripped} orbiting e⁻ and ${broken} bonds out of the box${writtenOff > 0.005 ? `, ${writtenOff.toFixed(1)} eV of stored bond energy written off` : ''} — what is left is nuclei, free particles and light.`,
      'warn',
    );
  }

  /**
   * Put a photon in the box by hand.
   *
   * Nothing about it is free: the energy is charged to the pump account, the same one the
   * level pump uses, so what the box emitted still equals what it was given.
   */
  spawnPhoton(energyEV: number, x: number, y: number, angle = this.rng() * Math.PI * 2): void {
    if (!(energyEV > 0)) return;
    this.pumpEV += energyEV;
    this.emitPhoton(energyEV, x, y, null, 'gun', 'free', angle);
  }

  /**
   * The speed a hand-released body picks up from the box's temperature.
   *
   * A particle sitting perfectly still is not a thing that exists at 300 K, and a box where
   * half the bodies hang motionless while the rest move is a picture of nothing. The kick is
   * drawn from the same Rayleigh distribution `setTemperature` hands out, so a released atom
   * arrives with the thermal spread of the gas it was dropped into. It is applied where the
   * hand releases and not inside `spawn`, because the sim's own products — a neutron fired by
   * a decay — are priced against exact momentum and keep the speed they were born with.
   */
  thermalVelocity(massU: number): { vx: number; vy: number } {
    if (!(this.thermostatK > 0) || !(massU > 0)) return { vx: 0, vy: 0 };
    const sigma = Math.sqrt((K_B_EV_PER_K * this.thermostatK) / (massU * MASS_SPEED_EV));
    const angle = this.rng() * Math.PI * 2;
    const speed = sigma * Math.sqrt(-2 * Math.log(Math.max(1e-9, this.rng())));
    return { vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
  }

  /** Empty the box and the clock. */
  reset(): void {
    this.cores = [];
    this.electrons = [];
    this.neutrons = [];
    this.photons = [];
    this.events = [];
    this.bonds = [];
    this.bondPairs.clear();
    this.bondUsed.clear();
    this.coreIndex.clear();
    this.timeFS = 0;
    this.labelClockFS = 0;
    this.nextId = 1;
    this.frames = 0;
    this.emittedEV = 0;
    this.absorbedEV = 0;
    this.pumpEV = 0;
    this.bondBankEV = 0;
    this.nuclearBursts = [];
    this.nuclearRays = [];
    this.nuclearDecays = 0;
    this.nuclearReleasedEV = 0;
    this.nuclearEscapedEV = 0;
    this.nuclearEscapedCharge = 0;
    this.nuclearEscapedMomentum = { x: 0, y: 0 };
    this.lastFrameFS = 0;
    this.log('Box cleared.', 'info');
  }

  heat(amount: number): void {
    for (const e of this.electrons) {
      e.vx += this.rng() * 2 * amount - amount;
      e.vy += this.rng() * 2 * amount - amount;
    }
    for (const c of this.cores) {
      c.vx += (this.rng() * 2 * amount - amount) / 60;
      c.vy += (this.rng() * 2 * amount - amount) / 60;
    }
    for (const n of this.neutrons) {
      n.vx += this.rng() * 2 * amount - amount;
      n.vy += this.rng() * 2 * amount - amount;
    }
    this.log(`Thermal kick of ±${amount.toFixed(1)} Å/fs applied.`, 'info');
  }

  /** Delete whatever is nearest to a point: an atom with its electrons, or a loose particle. */
  deleteNear(x: number, y: number, radius = 2.5): boolean {
    let removed = false;
    let bestCore: Core | null = null;
    let bestCoreR = radius;
    for (const c of this.cores) {
      const r = Math.hypot(c.x - x, c.y - y);
      if (r < bestCoreR) {
        bestCoreR = r;
        bestCore = c;
      }
    }
    if (bestCore) {
      const doomed = bestCore;
      for (const bond of this.bonds.filter((x) => x.a === doomed || x.b === doomed)) this.removeBond(bond);
      this.electrons = this.electrons.filter((e) => e.coreId !== doomed.id);
      this.cores = this.cores.filter((c) => c !== doomed);
      this.coreIndex.delete(doomed.id);
      removed = true;
    }
    const beforeE = this.electrons.length;
    this.electrons = this.electrons.filter((e) => Math.hypot(e.x - x, e.y - y) > radius);
    const beforeN = this.neutrons.length;
    this.neutrons = this.neutrons.filter((n) => Math.hypot(n.x - x, n.y - y) > radius);
    return removed || this.electrons.length < beforeE || this.neutrons.length < beforeN;
  }

  describe(x: number, y: number, radius = 2): string | null {
    for (const c of this.cores) {
      if (Math.hypot(c.x - x, c.y - y) > Math.max(radius, 1.5)) continue;
      const bound = this.electrons.filter((e) => e.coreId === c.id).length;
      return `${c.symbol}${c.qNet === 0 ? '' : c.qNet > 0 ? `+${c.qNet}` : c.qNet} ${c.name} · Z=${c.z} A=${c.a} · ${bound} orbiting e⁻ · ${nuclearDescription(c.z, c.a)}`;
    }
    for (const e of this.electrons) {
      if (Math.hypot(e.x - x, e.y - y) > radius) continue;
      return `electron · ${kineticEV(e.massU, e.vx, e.vy).toFixed(2)} eV · ${e.coreId == null ? 'free' : `bound on level ${this.coreIndex.get(e.coreId)?.levels[e.level]?.key ?? '?'}`}`;
    }
    for (const n of this.neutrons) {
      if (Math.hypot(n.x - x, n.y - y) > radius) continue;
      return `neutron · ${kineticEV(n.massU, n.vx, n.vy).toFixed(3)} eV · ${nuclearDescription(0, 1)}`;
    }
    return null;
  }

  log(text: string, tone: SimEvent['tone'] = 'info', nm?: number): void {
    this.events.push({ fs: this.timeFS, text, tone, nm });
    if (this.events.length > 150) this.events.splice(0, this.events.length - 150);
  }

  /* --------------------------------------------------------------- report */

  /** Mechanical energy: kinetic plus every pair potential in play, plus what the atoms carry. */
  potentialEnergyEV(): number {
    let sum = 0;
    for (const c of this.cores) sum += c.excitationEV;
    for (const e of this.electrons) {
      for (const c of this.cores) {
        const own = e.coreId === c.id && e.level >= 0;
        if (ridesShell(e) && !own) continue;
        const r = Math.max(1e-4, Math.hypot(e.x - c.x, e.y - c.y));
        sum += own ? electronPotentialEV(e.couplingEV_A, r, SOFT_E_CORE) : strangerPotentialEV(c, r);
      }
    }
    for (let i = 0; i < this.electrons.length; i++) {
      for (let j = i + 1; j < this.electrons.length; j++) {
        const a = this.electrons[i];
        const b = this.electrons[j];
        if (ridesShell(a) || ridesShell(b)) continue;
        const r = Math.hypot(a.x - b.x, a.y - b.y);
        sum += COULOMB_EV / Math.sqrt(r * r + SOFT_E_E * SOFT_E_E);
      }
    }
    for (let i = 0; i < this.cores.length; i++) {
      for (let j = i + 1; j < this.cores.length; j++) {
        const a = this.cores[i];
        const b = this.cores[j];
        const r = Math.max(1e-4, Math.hypot(a.x - b.x, a.y - b.y));
        sum += coreCorePotentialEV(a, b, r, this.bonds.length === 0 ? null : this.bondOf(a, b));
      }
    }
    return sum;
  }

  /** Energy sitting in the bond wells, relative to every pair pulled apart to infinity. */
  bondEnergyEV(): number {
    let sum = 0;
    for (const bond of this.bonds) {
      sum += bondPairEVperA(bond, Math.max(1e-4, Math.hypot(bond.a.x - bond.b.x, bond.a.y - bond.b.y))).energy;
    }
    return sum;
  }

  kineticEnergyEV(): number {
    let sum = 0;
    for (const e of this.electrons) sum += kineticEV(e.massU, e.vx, e.vy);
    for (const c of this.cores) sum += kineticEV(c.massU, c.vx, c.vy);
    for (const n of this.neutrons) sum += kineticEV(n.massU, n.vx, n.vy);
    return sum;
  }

  /**
   * Translational temperature of the box, from the mean random kinetic energy of
   * the particles that actually translate: nuclei, free electrons, neutrons. An
   * electron on an orbit is 20 Å/fs even in a gas at 3 K, so counting orbital
   * motion would report sixty thousand kelvin for a box of cold hydrogen. Two
   * dimensions means two degrees of freedom, so ⟨energy⟩ is kT and not 3kT/2 —
   * which is also what setTemperature hands out.
   */
  temperatureK(): number {
    const movers = [...this.cores, ...this.neutrons, ...this.electrons.filter((e) => e.coreId == null)];
    if (movers.length === 0) return 0;
    const ke = movers.reduce((sum, body) => sum + kineticEV(body.massU, body.vx, body.vy), 0);
    return (ke / movers.length) / K_B_EV_PER_K;
  }

  summary(): {
    cores: number;
    electrons: number;
    neutrons: number;
    photons: number;
    bonds: number;
    radioactive: number;
    nuclearDecays: number;
    nuclearReleasedEV: number;
    nuclearEscapedEV: number;
    freeElectrons: number;
    ions: number;
    timeFS: number;
    dt: number;
    frameFS: number;
    substeps: number;
    clockDilated: boolean;
    kineticEV: number;
    potentialEV: number;
    mechanicalEV: number;
    bondBankEV: number;
    emittedEV: number;
    absorbedEV: number;
    pumpEV: number;
    temperatureK: number;
    netCharge: number;
  } {
    const kineticEV = this.kineticEnergyEV();
    const potentialEV = this.potentialEnergyEV();
    return {
      cores: this.cores.length,
      electrons: this.electrons.length,
      neutrons: this.neutrons.length,
      photons: this.photons.length,
      bonds: this.bonds.length,
      radioactive: this.cores.filter(c => c.nuclear.status === 'radioactive').length + this.neutrons.length,
      nuclearDecays: this.nuclearDecays,
      nuclearReleasedEV: this.nuclearReleasedEV,
      nuclearEscapedEV: this.nuclearEscapedEV,
      freeElectrons: this.electrons.filter((e) => e.coreId == null).length,
      ions: this.cores.filter((c) => c.qNet !== 0).length,
      timeFS: this.timeFS,
      dt: this.lastDt,
      frameFS: this.lastFrameFS,
      substeps: this.lastSubsteps,
      clockDilated: this.clockDilated,
      kineticEV,
      potentialEV,
      mechanicalEV: kineticEV + potentialEV,
      bondBankEV: this.bondBankEV,
      emittedEV: this.emittedEV,
      absorbedEV: this.absorbedEV,
      pumpEV: this.pumpEV,
      temperatureK: this.temperatureK(),
      netCharge:
        this.cores.reduce((s, c) => s + c.qNet, 0) - this.electrons.filter((e) => e.coreId == null).length,
    };
  }
}

/**
 * The field an outside electron feels from an atom, with its own electrons smeared
 * over their shells.
 *
 * Each occupied level is a shell of charge spread over a sphere the size of that
 * orbit, and the nucleus is spread over a smaller one, so the field of the whole atom
 * on a stranger is the difference of two smoothed Coulomb terms. A neutral atom
 * therefore cancels almost exactly at a distance — a passing electron is left alone,
 * which is why hydrogen has no negative ion — and an electron that dives inside a
 * shell picks up that shell's worth of unscreened attraction, up to the full
 * pseudo-charge of the core. That is what lets a close encounter excite or strip an
 * atom while two atoms drifting past each other at a few ångströms barely notice.
 *
 * Both halves are smoothed on purpose. A bare 1/r shell against a softened nucleus
 * leaves a residue of a few hundredths of an electronvolt per ångström at 4 Å, and a
 * cold gas spends a quarter of an electronvolt of flight energy on it. The shell walk
 * is the price of the cancellation; it runs over the occupied levels, of which an atom
 * has a handful.
 */
function strangerPotentialEV(core: Core, r: number): number {
  const rr = r * r;
  const dn = Math.sqrt(rr + SOFT_STRANGER_SQ);
  let u = -core.strangerCouplingEV_A / dn;
  const radii = core.shellRadiusA;
  const charges = core.shellChargeEV;
  for (let i = 0; i < radii.length; i++) {
    const radius = radii[i];
    u += charges[i] / Math.sqrt(rr + radius * radius);
  }
  return u;
}

/** Force of that field, eV/Å, positive meaning attraction toward the core. */
function strangerForceEVperA(core: Core, r: number): number {
  const rr = r * r;
  const dn2 = rr + SOFT_STRANGER_SQ;
  const dn = Math.sqrt(dn2);
  let f = (core.strangerCouplingEV_A * r) / (dn2 * dn);
  const radii = core.shellRadiusA;
  const charges = core.shellChargeEV;
  for (let i = 0; i < radii.length; i++) {
    const ds2 = rr + radii[i] * radii[i];
    f -= (charges[i] * r) / (ds2 * Math.sqrt(ds2));
  }
  return f;
}

/** Energy of an electron that does not belong to this core yet. */
function strangerEnergyEV(e: Electron, core: Core): number {
  return (
    kineticEV(e.massU, e.vx - core.vx, e.vy - core.vy) +
    strangerPotentialEV(core, Math.max(1e-4, Math.hypot(e.x - core.x, e.y - core.y)))
  );
}

/**
 * An electron standing on a level has its share of the atom's field already baked into
 * that level's energy, so it is not also carried as a point charge: the shells, not the
 * electrons, are what a stranger feels. Free electrons are the exception — they belong to
 * no atom, so they push and pull as particles.
 */
function ridesShell(e: Electron): boolean {
  return e.coreId != null && e.level >= 0;
}

/** Push two electrons apart at the full 1/r² law, equal and opposite on both. */
function repelElectronPair(a: Electron, b: Electron): void {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy));
  const f = electronForceEVperA(COULOMB_EV, r, SOFT_E_E);
  const inv = 1 / r;
  const k = f * ELECTRON_ACCEL_PER_EVPERA * inv;
  a.ax += k * dx;
  a.ay += k * dy;
  b.ax -= k * dx;
  b.ay -= k * dy;
  const bend = Math.abs(f * ELECTRON_ACCEL_PER_EVPERA);
  if (bend > a.clockAccel) {
    a.clockAccel = bend;
    a.clockR = r;
  }
  if (bend > b.clockAccel) {
    b.clockAccel = bend;
    b.clockR = r;
  }
}

/**
 * The pair law between two nuclei: their net charges, then the wall of the clouds.
 *
 * Both halves come from one expression on purpose. The wall is Lennard-Jones above
 * 0.62·σ and a *hard spring* below it — the contact force stops growing there, so
 * driving two cores through each other costs that force times the depth of the dive,
 * linearly and without limit. Book the raw 1/r¹² instead and a fast projectile can
 * bank a megaelectronvolt the force never charged it for, which is exactly the
 * single-frame six-hundred-thousand-eV jump this replaced. Nothing here needs a clamp:
 * a softened Coulomb and a frozen-wall force are both bounded by construction, and the
 * timestep is set from the acceleration they produce.
 *
 * A bonded pair swaps the wall for its Morse curve — same job, one attractive well and
 * one repulsive wall, but with the depth and the equilibrium length of a real bond
 * instead of a condensate. The bond's own force and energy come out of `bondPairEVperA`
 * together, so the pair loop can never apply a law the books are not carrying.
 */
function coreCoreForceEVperA(a: Core, b: Core, r: number, bond: Bond | null): number {
  return (
    electronForceEVperA(COULOMB_EV * a.qNet * b.qNet, r, SOFT_CORE_CORE) +
    (bond ? bondPairEVperA(bond, r).force : wallForceEVperA(a, b, r).force)
  );
}

function coreCorePotentialEV(a: Core, b: Core, r: number, bond: Bond | null): number {
  return (
    (COULOMB_EV * a.qNet * b.qNet) / Math.sqrt(r * r + SOFT_CORE_CORE * SOFT_CORE_CORE) +
    (bond ? bondPairEVperA(bond, r).energy : wallForceEVperA(a, b, r).energy)
  );
}

/**
 * The covalent curve of one bond: its energy and force at separation r, from `V(r) =
 * D(1 − e^(−a(r−rₑ)))² − D`.
 *
 * The same call returns both, so the force is always the exact gradient of what gets
 * booked — which is the only reason a vibrating molecule integrates cleanly on a
 * symplectic step. Below `BOND_FLOOR_FRACTION·rₑ` the force freezes and the curve
 * continues as a straight line, the identical trick the van der Waals wall uses: an
 * exponential wall that keeps growing pays nothing for the energy it appears to charge.
 */
function bondPairEVperA(bond: Bond, r: number): { force: number; energy: number } {
  const floor = BOND_FLOOR_FRACTION * bond.lengthA;
  const rr = Math.max(r, floor);
  const tail = Math.exp(-bond.rangeInvA * (rr - bond.lengthA));
  const slope = 1 - tail;
  const energy = bond.dissociationEV * slope * slope - bond.dissociationEV;
  // dV/dr is positive outside the bottom (a pull back in) and negative inside (a push
  // apart), so the force the pair loop wants — positive meaning repulsion — is −dV/dr.
  const force = -2 * bond.dissociationEV * bond.rangeInvA * slope * tail;
  return { force, energy: r < rr ? energy + force * (rr - r) : energy };
}

/** What the van der Waals wall would be worth for this pair right now, eV. */
function wallEnergyEV(a: Core, b: Core, r: number): number {
  return wallForceEVperA(a, b, r).energy;
}

/** The wall at distance r: its outward force and the energy stored in pushing to r. */
function wallForceEVperA(a: Core, b: Core, r: number): { force: number; energy: number } {
  const sigma = (a.ljSigmaA + b.ljSigmaA) / 2;
  const epsilon = Math.sqrt(a.ljEpsilonEV * b.ljEpsilonEV);
  const contact = 0.62 * sigma;
  const rr = Math.max(r, contact);
  const s6 = Math.pow(sigma / rr, 6);
  const force = (24 * epsilon * (2 * s6 * s6 - s6)) / rr;
  const energy = 4 * epsilon * (s6 * s6 - s6);
  return { force, energy: r < rr ? energy + force * (rr - r) : energy };
}

function lastIndexWith(
  levels: { capacity: number; frozen: boolean }[],
  occupancy: number[],
  test: (count: number, level: { capacity: number; frozen: boolean }) => boolean,
): number {
  for (let i = occupancy.length - 1; i >= 0; i--) {
    if (test(occupancy[i], levels[i])) return i;
  }
  return -1;
}

/**
 * Pin the first excited series to a measured spectral line.
 *
 * A quantum defect fitted to the ground state alone predicts resonance lines to
 * a few tenths of an electronvolt. Where the NIST-tabulated line list has a
 * strong line for this element, the defect of the dipole partner subshell is set
 * so that the ground-to-first-excited gap reproduces that wavelength exactly —
 * which is why sodium in this box glows at 589.6 nm rather than near 340 nm.
 */
function calibrateDefectFromLine(
  record: ElementRecord,
  seeds: LevelSeed[],
  defects: Map<number, number>,
  seriesCharge: number,
): void {
  const open = seeds.filter((s) => !s.frozen);
  if (open.length === 0) return;
  const homo = open.reduce((best, s) => (s.energyEV > best.energyEV ? s : best), open[0]);
  const taken = new Set(seeds.map((s) => s.key));
  const lines = linesForElement(record.symbol)
    .filter((line) => line.kind === 'emission')
    .sort((a, b) => b.relativeIntensity - a.relativeIntensity);
  for (const line of lines) {
    const photonEV = photonFromWavelengthNm(line.nm).energyEV;
    const target = homo.energyEV + photonEV;
    if (target >= -0.05) continue;
    for (const l of [homo.l + 1, homo.l - 1]) {
      if (l < 0 || l >= homo.n) continue;
      if (taken.has(subshellLabel(homo.n, l))) continue;
      const defect = quantumDefect(homo.n, target, seriesCharge);
      if (defect <= 0) continue;
      defects.set(l, defect);
      return;
    }
  }
}

/** Larmor power of an accelerating unit charge, eV per fs. */
function larmorEVperFs(accelAperFs2: number, chargeE = 1): number {
  const accelSI = accelAperFs2 * 1e20;
  const q = chargeE * CONSTANTS.e;
  const powerW = (q * q * accelSI * accelSI) / (6 * Math.PI * CONSTANTS.epsilon0 * CONSTANTS.c ** 3);
  return (powerW * 1e-15) / CONSTANTS.eV;
}

/** Well depth from the measured boiling point: ε ≈ 0.65 k_B T_b reproduces noble-gas values. */
function ljEpsilon(record: ElementRecord): number {
  const tb = record.boilingPointK ?? 120;
  return clamp(K_B_EV_PER_K * tb * 0.65, 0.002, 0.35);
}

/** Contact distance from the tabulated van der Waals radius, falling back to covalent. */
function ljSigma(record: ElementRecord): number {
  const radius = record.vdWRadius ?? record.covalentRadius ?? 150;
  return clamp((radius * 2) / 100, 1.4, 6.5);
}
