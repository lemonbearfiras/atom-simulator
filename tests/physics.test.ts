/**
 * Physics validation for the 2D sandbox.
 *
 * This is the audit of the claims made in the ⓘ notes: the box runs on real
 * units, so a hydrogen line must come out at 121.6 nm, a ground state must be
 * genuinely stable, and the energy ledger must close. Tolerances are loose where
 * the model is an approximation (Slater-shifted level energies, orbital phase)
 * and tight where the model claims to be exact (measured lines, momentum).
 */
import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { electronForceEVperA, electronPotentialEV, type Core } from '../src/sim/atom';
import { COULOMB_EV, ELECTRON_MASS_U, kineticEV } from '../src/sim/units';

/** Everything the ledger knows about. Its one free variable is orbital phase. */
function booked(world: World): number {
  return (
    world.kineticEnergyEV() + world.potentialEnergyEV() + world.bondBankEV + world.emittedEV - world.absorbedEV - world.pumpEV
  );
}

function core(world: World, symbol: string): Core {
  const found = world.cores.find((candidate) => candidate.symbol === symbol);
  if (!found) throw new Error(`${symbol} is not in the box`);
  return found;
}

function levelIndex(atom: Core, key: string): number {
  const index = atom.levels.findIndex((level) => level.key === key);
  if (index < 0) throw new Error(`${atom.symbol} has no ${key} level`);
  return index;
}

function soleElectron(world: World) {
  if (world.electrons.length !== 1) throw new Error('expected exactly one electron');
  return world.electrons[0];
}

function radius(electron: { x: number; y: number }, atom: Core): number {
  return Math.hypot(electron.x - atom.x, electron.y - atom.y);
}

describe('Coulomb law', () => {
  it('is inverse-square, and the constant is the measured e²/4πɛ₀', () => {
    expect(COULOMB_EV).toBeCloseTo(14.399645, 5);
    const near = electronForceEVperA(COULOMB_EV, 2, 1e-6);
    const far = electronForceEVperA(COULOMB_EV, 4, 1e-6);
    expect(near).toBeCloseTo(COULOMB_EV / 4, 6);
    expect(near / far).toBeCloseTo(4, 6);
    expect(electronForceEVperA(COULOMB_EV, 3, 1e-6)).toBeCloseTo(COULOMB_EV / 9, 6);
  });

  it('is the exact negative gradient of the potential the ledger books', () => {
    // Force and energy must come from one law or the symplectic integrator drifts.
    const soft = 0.04;
    const r = 1.5;
    const h = 1e-6;
    const dUdr =
      (electronPotentialEV(COULOMB_EV, r + h, soft) - electronPotentialEV(COULOMB_EV, r - h, soft)) / (2 * h);
    expect(electronForceEVperA(COULOMB_EV, r, soft)).toBeCloseTo(dUdr, 6);
  });

  it('reaches the world with the right magnitude and sign', () => {
    const repel = new World(7);
    expect(repel.spawnElectron(28, 30)).toBeTruthy();
    expect(repel.spawnElectron(32, 30)).toBeTruthy();
    expect(repel.potentialEnergyEV()).toBeCloseTo(14.399645 / Math.sqrt(16 + 0.12 * 0.12), 3);

    const attract = new World(8);
    expect(attract.spawnProton(28, 30)).toBeTruthy();
    expect(attract.spawnElectron(32, 30)).toBeTruthy();
    expect(attract.potentialEnergyEV()).toBeCloseTo(-14.399645 / Math.sqrt(16 + 0.5 * 0.5), 3);
  });
});

describe('hydrogen', () => {
  it('holds the measured ground state and emits nothing at all', () => {
    const world = new World(11);
    expect(world.spawnAtom('H', 40, 35)).toBeTruthy();
    const atom = core(world, 'H');
    const ground = levelIndex(atom, '1s');
    expect(ground).toBe(0);
    const electron = soleElectron(world);

    const startEnergy = electron.energyEV;
    const startRadius = radius(electron, atom);

    for (let frame = 0; frame < 400; frame++) world.stepFrame(1);

    expect(world.photons).toHaveLength(0);
    expect(world.emittedEV).toBe(0);
    expect(electron.coreId).not.toBeNull();
    expect(electron.level).toBe(ground);
    // −13.6 eV, allowing for the orbital-phase wobble of a softened 1/r² orbit.
    expect(startEnergy).toBeLessThan(-13.4);
    expect(electron.energyEV).toBeLessThan(-13.4);
    expect(Math.abs(electron.energyEV - startEnergy)).toBeLessThan(0.5);
    // It did not spiral into the nucleus.
    expect(radius(electron, atom)).toBeGreaterThan(startRadius * 0.6);
  });

  it('falls 2p → 1s and pays for it with a 121.6 nm Lyman-alpha photon', () => {
    const world = new World(12);
    expect(world.spawnAtom('H', 40, 35)).toBeTruthy();
    const atom = core(world, 'H');
    const excited = levelIndex(atom, '2p');
    const electron = soleElectron(world);
    expect(world.exciteElectron(electron.id, excited)).toBe(true);
    // Pumping up to 2p stored exactly the Lyman-alpha gap.
    expect(world.pumpEV).toBeCloseTo(10.2, 1);
    const ledger0 = booked(world);

    // The photon is caught back up by the ground state it came from, so the event
    // log is the durable record of what left the atom.
    for (let frame = 0; frame < 600 && world.emittedEV < 10; frame++) world.stepFrame(1);

    const line = world.events.find((event) => event.nm != null && event.nm > 115 && event.nm < 128);
    expect(line, 'no Lyman-alpha logged').toBeTruthy();
    expect(line!.nm).toBeCloseTo(121.6, 0);
    expect(world.emittedEV).toBeGreaterThan(10);
    expect(world.emittedEV).toBeLessThan(11.5);
    expect(electron.level).toBe(0);
    // The energy that left the atom is the energy that shows up in the field.
    expect(Math.abs(booked(world) - ledger0)).toBeLessThan(0.3);

    // And the cascade stops: a ground state has nowhere left to fall.
    const lines = world.events.filter((event) => event.nm != null).length;
    for (let frame = 0; frame < 300; frame++) world.stepFrame(1);
    expect(world.events.filter((event) => event.nm != null).length).toBe(lines);
  });

  it('captures a slow electron and radiates the binding energy as one photon', () => {
    const world = new World(13);
    expect(world.spawnProton(40, 35)).toBeTruthy();
    // Released 5 Å away at 0.02 Å/fs: 0.0011 eV of kinetic energy, near rest.
    const free = world.spawnElectron(45, 35, 0, -0.02);
    expect(free).toBeTruthy();
    const ledger0 = booked(world);

    let frames = 0;
    while (frames < 4000 && free!.coreId == null) {
      world.stepFrame(1);
      frames += 1;
    }
    expect(free!.coreId, 'the electron was never captured').not.toBeNull();

    expect(world.photons.length).toBeGreaterThanOrEqual(1);
    const total = world.photons.reduce((sum, photon) => sum + photon.energyEV, 0);
    // It was released 5 Å out, where it already carried 2.87 eV of potential
    // energy, so the recombination line is 13.6 eV minus that head start.
    expect(total).toBeGreaterThan(10.5);
    expect(total).toBeLessThan(13.7);

    for (const bound of world.electrons.filter((e) => e.coreId != null)) {
      expect(electronEnergyIsNegative(bound));
    }
    // Bookkeeping closes across the capture, within the phase wobble.
    expect(Math.abs(booked(world) - ledger0)).toBeLessThan(0.2);
  });
});

describe('the notes promise measured lines', () => {
  it('makes sodium glow at the sodium D line, 589.6 nm', () => {
    const world = new World(21);
    expect(world.spawnAtom('Na', 40, 35)).toBeTruthy();
    const atom = core(world, 'Na');
    const open = atom.levels.map((level, index) => ({ level, index })).filter(({ level }) => !level.frozen);
    const homo = open[0].index;
    const up = open[1].index;
    const electron = world.electrons.find((e) => e.coreId === atom.id);
    expect(electron).toBeTruthy();
    expect(world.exciteElectron(electron!.id, up)).toBe(true);

    for (let frame = 0; frame < 800 && world.photons.length === 0; frame++) world.stepFrame(1);

    expect(world.photons.length).toBeGreaterThan(0);
    const first = world.photons.find((p) => p.energyEV > 1.5 && p.energyEV < 2.6);
    expect(first, 'no visible photon from sodium').toBeTruthy();
    expect(first!.wavelengthNm).toBeCloseTo(589.6, 0);
    // Yellow: red and green channels lit, blue dim.
    expect(first!.rgb[0]).toBeGreaterThan(0.6);
    expect(first!.rgb[1]).toBeGreaterThan(0.6);
    expect(first!.rgb[2]).toBeLessThan(0.4);
    // It came from the HOMO and it fell back to it.
    expect(electron!.level).toBe(homo);
  });
});

describe('energy and momentum', () => {
  it('pays for every cascade line it logs, one atom at a time', () => {
    const world = new World(32);
    world.width = 60;
    world.height = 40;
    const core = world.spawnAtom('H', 30, 20, 0, 0, { excite: 1 });
    expect(core).toBeTruthy();
    const ledger0 = booked(world);
    for (let frame = 0; frame < 400; frame++) world.stepFrame(1);

    expect(world.emittedEV).toBeGreaterThan(0);
    expect(world.events.filter((event) => event.nm != null).length).toBeGreaterThan(0);
    expect(Math.abs(booked(world) - ledger0)).toBeLessThan(0.4);
  });

  // The test that used to be skipped. Eight atoms with a third of their valence
  // electrons started excited used to open the ledger by ~56 eV over 120 frames,
  // because an electron shaken outside its own atom kept feeling its nucleus
  // unscreened while its former neighbours kept feeling it as a bare point charge:
  // every ionisation traded a hundred eV of phantom pair repulsion for nothing.
  // The atom now presents its electrons as shells (screened outside, unscreened
  // inside), so the crowded box closes to the same 0.4 eV as the single atom above.
  it('keeps the ledger closed while a radiating gas decays', () => {
    const world = new World(31);
    world.width = 60;
    world.height = 40;
    const symbols = ['H', 'H', 'H', 'He', 'H', 'He', 'H', 'H'];
    symbols.forEach((symbol, i) => {
      // A roomy grid, and a third of the valence electrons start on an excited
      // level, because collisions in this box shake electrons off rather than
      // up — the cascade is what has to pay for the light.
      world.spawnAtom(symbol, 10 + (i % 4) * 12, 12 + Math.floor(i / 4) * 16, 0, 0, { excite: 0.4 });
    });

    const ledger0 = booked(world);
    // Ran in atomic time, not frames: a frame integrates as many timesteps as its work
    // budget affords, so retuning that budget would quietly shrink the femtoseconds this
    // test covers and the cascade would never get going. 600 fs is the window the
    // original 120 frames of this box actually integrated.
    while (world.timeFS < 600) world.stepFrame(1);

    expect(world.emittedEV).toBeGreaterThan(0);
    expect(Math.abs(booked(world) - ledger0)).toBeLessThan(0.4);
  });

  it('conserves total momentum to machine precision', () => {
    const world = new World(41);
    world.wallsOn = false;
    for (const symbol of ['H', 'H', 'O', 'H', 'Ne']) {
      expect(world.spawnAtom(symbol, 12 + (world.cores.length % 3) * 20, 20 + world.cores.length * 4)).toBeTruthy();
    }
    world.setTemperature(300);

    const momentumOf = () => {
      let px = 0;
      let py = 0;
      for (const body of [...world.cores, ...world.electrons, ...world.neutrons]) {
        px += body.massU * body.vx;
        py += body.massU * body.vy;
      }
      return { px, py };
    };
    const before = momentumOf();
    for (let frame = 0; frame < 120; frame++) world.stepFrame(1);
    const after = momentumOf();

    // Walls are the one external force, and this box is big enough to avoid them.
    expect(Math.abs(after.px - before.px)).toBeLessThan(1e-12);
    expect(Math.abs(after.py - before.py)).toBeLessThan(1e-12);
  });
});

describe('many-electron atoms', () => {
  // The box is dragged open by dropping real elements into it, so an atom of
  // oxygen has to arrive as an atom of oxygen. Before the shells carried the
  // atom's own repulsion, six valence electrons sharing a 0.53 Å orbit booked
  // +407 eV and every heavy atom dropped in was a bomb: the seed below used to
  // strip itself to nineteen free electrons and 139,000 K within 25 frames.
  it('releases a heavy atom as a bound atom, not an explosion', () => {
    for (const symbol of ['C', 'N', 'O', 'Ne', 'Na', 'Cl', 'Fe']) {
      const world = new World(71);
      const atom = world.spawnAtom(symbol, 30, 20);
      expect(atom, symbol).toBeTruthy();
      const ledger0 = booked(world);
      // Bound: the whole atom weighs less than its parts.
      expect(world.kineticEnergyEV() + world.potentialEnergyEV(), symbol).toBeLessThan(0);

      for (let frame = 0; frame < 120; frame++) world.stepFrame(1);

      expect(world.electrons.filter((e) => e.coreId == null), `${symbol} ionised`).toHaveLength(0);
      expect(atom!.qNet, symbol).toBe(0);
      expect(Math.abs(booked(world) - ledger0), `${symbol} ledger`).toBeLessThan(0.5);
    }
  });

  it('leaves a cold gas of heavy atoms cold', () => {
    const world = new World(72);
    world.width = 70;
    world.height = 45;
    ['O', 'O', 'N', 'Ne'].forEach((symbol, i) => {
      expect(world.spawnAtom(symbol, 16 + (i % 2) * 26, 14 + Math.floor(i / 2) * 18, 0, 0)).toBeTruthy();
    });
    const ledger0 = booked(world);
    // 300 fs of atomic time — what 150 frames of this box integrated before the frame
    // work budget was retuned, written in femtoseconds so it stays that way.
    while (world.timeFS < 300) world.stepFrame(1);

    // Nothing here has ten electronvolts to spare, so nothing should be ionising.
    expect(world.temperatureK()).toBeLessThan(3000);
    expect(world.electrons.filter((e) => e.coreId == null)).toHaveLength(0);
    expect(Math.abs(booked(world) - ledger0)).toBeLessThan(2);
  });
});

describe('open boundaries', () => {
  // The screen is a window, not a box: anything aimed off the edge keeps going
  // rather than rebounding and re-energising the scene.
  it('lets a fast electron leave the view without mirroring its velocity', () => {
    const world = new World(81);
    world.width = 30;
    world.height = 20;
    expect(world.wallsOn).toBe(false);
    const electron = world.spawnElectron(6, 10, 0, -0.6);
    expect(electron).toBeTruthy();

    for (let frame = 0; frame < 60; frame++) world.stepFrame(1);

    expect(electron!.y).toBeLessThan(0);
    expect(electron!.vy).toBeLessThan(0);
    expect(Math.hypot(electron!.vx, electron!.vy)).toBeCloseTo(0.6, 12);
    expect(world.electrons).toHaveLength(1);
  });

  it('keeps a runaway neutron travelling and out of the ledger', () => {
    const world = new World(82);
    const neutron = world.spawnNeutron(10, 10, 0.4, 0.1);
    expect(neutron).toBeTruthy();
    const before = world.kineticEnergyEV();

    for (let frame = 0; frame < 120; frame++) world.stepFrame(1);

    expect(neutron!.x).toBeGreaterThan(150);
    expect(neutron!.vx).toBeCloseTo(0.4, 12);
    expect(world.neutrons).toHaveLength(1);
    expect(world.kineticEnergyEV()).toBeCloseTo(before, 9);
  });

  it('still bounces when walls are switched back on', () => {
    const world = new World(83);
    world.width = 20;
    world.height = 20;
    world.wallsOn = true;
    const neutron = world.spawnNeutron(10, 10, 0.4, 0.1);
    for (let frame = 0; frame < 200; frame++) world.stepFrame(1);

    expect(neutron!.x).toBeGreaterThanOrEqual(0);
    expect(neutron!.x).toBeLessThanOrEqual(20);
    expect(neutron!.y).toBeGreaterThanOrEqual(0);
    expect(neutron!.y).toBeLessThanOrEqual(20);
    expect(Math.hypot(neutron!.vx, neutron!.vy)).toBeCloseTo(Math.hypot(0.4, 0.1), 12);
  });
});

describe('nuclear capture', () => {
  it('pays the deuteron binding energy as a 2.22 MeV gamma', () => {
    const world = new World(51);
    expect(world.spawnProton(30, 30)).toBeTruthy();
    expect(world.spawnNeutron(30, 38, 0, -0.001)).toBeTruthy();

    for (let frame = 0; frame < 6000 && world.neutrons.length > 0; frame++) world.stepFrame(1);

    expect(world.neutrons, 'the neutron was never captured').toHaveLength(0);
    const gamma = world.photons.find((p) => p.energyEV > 1e5);
    expect(gamma, 'no capture gamma').toBeTruthy();
    expect(gamma!.energyEV).toBeGreaterThan(2.2e6);
    expect(gamma!.energyEV).toBeLessThan(2.25e6);
    expect(gamma!.region).toBe('gamma');
    // A neutron carries no charge, so the box ends up a single deuterium atom.
    expect(world.cores).toHaveLength(1);
    expect(world.cores[0].qNet).toBe(1);
  });
});

describe('unit helpers', () => {
  it('prices kinetic energy in eV from u and Å/fs', () => {
    // 1 u at 1 Å/fs is 1e5 m/s: ½ · 1.66054e-27 · 1e10 J = 51.82 eV.
    expect(kineticEV(1, 1, 0)).toBeCloseTo(51.821, 2);
    // The Bohr orbit speed of hydrogen is the ground-state energy by definition.
    expect(kineticEV(ELECTRON_MASS_U, 21.876, 0)).toBeCloseTo(13.6057, 2);
  });
});

function electronEnergyIsNegative(electron: { energyEV: number }): void {
  if (!(electron.energyEV < 0)) throw new Error('a bound electron came out non-negative');
}
