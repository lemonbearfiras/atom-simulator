import { describe, expect, it } from 'vitest';
import { ELEMENTS } from '../src/data/elements';
import { createRng } from '../src/engine/rng';
import { decayPlan, displayHalfLife, nuclearDescription, nuclearState, nuclide } from '../src/sim/nuclear';
import { World } from '../src/sim/world';

function energy(world: World): number {
  return world.kineticEnergyEV() + world.potentialEnergyEV() + world.bondBankEV + world.emittedEV
    + world.nuclearEscapedEV - world.nuclearReleasedEV - world.absorbedEV - world.pumpEV;
}

function momentum(world: World) {
  return [...world.cores, ...world.electrons, ...world.neutrons].reduce((p, body) =>
    ({ x: p.x + body.massU * body.vx, y: p.y + body.massU * body.vy }), { ...world.nuclearEscapedMomentum });
}

function charge(world: World): number {
  return world.summary().netCharge + world.nuclearEscapedCharge;
}

function nucleons(world: World): number {
  return world.cores.reduce((n, c) => n + c.a, world.neutrons.length);
}

describe('evaluated nuclear data', () => {
  it('has evaluated stability and a supported channel for every radioactive table default', () => {
    expect(nuclide(82, 208)?.stable).toBe(true);
    expect(nuclide(1, 3)?.betaQEV).toBeCloseTo(18592.02, 2);
    expect(nuclide(92, 238)?.alphaQEV).toBeCloseTo(4269858.1, 1);
    for (const record of ELEMENTS) {
      const isotope = nuclide(record.z, record.mostStableA);
      expect(isotope, record.symbol).not.toBeNull();
      if (!isotope!.stable) expect(decayPlan(record.z, record.mostStableA), record.symbol).not.toBeNull();
    }
  });

  it('does not invent decay for unknown or unsupported nuclei', () => {
    expect(nuclearState(1, 999, () => 0.5).status).toBe('unknown');
    expect(decayPlan(1, 999)).toBeNull();
    expect(nuclearState(1, 999, () => 0.5).remainingSeconds).toBe(Infinity);
    expect(nuclearDescription(1, 999)).toContain('unknown');
    expect(nuclearDescription(2, 5)).toContain('s (from width)');
    expect(nuclearDescription(2, 5)).not.toContain('MeV');
  });

  it('samples exponential lifetimes using the disclosed compressed half-life', () => {
    const random = createRng(53);
    const halfLife = displayHalfLife(nuclide(92, 238)!.halfLifeSeconds!);
    const timers = Array.from({ length: 2000 }, () => nuclearState(92, 238, random).remainingSeconds);
    expect(timers.filter(t => t <= halfLife).length / timers.length).toBeCloseTo(0.5, 1);
    expect(displayHalfLife(1e-9)).toBeGreaterThanOrEqual(0.8);
    expect(displayHalfLife(1e30)).toBe(10);
  });
});

describe('spontaneous nuclear transitions', () => {
  it.each([
    ['U', 238, 'alpha', 'Th', 234],
    ['C', 14, 'beta−', 'N', 14],
    ['H', 3, 'beta−', 'He', 3],
    ['Be', 7, 'electron capture', 'Li', 7],
    ['Mg', 20, 'beta+', 'Na', 20],
    ['He', 5, 'neutron emission', 'He', 4],
    ['Li', 5, 'proton emission', 'He', 4],
    ['Te', 130, 'double beta−', 'Xe', 130],
    ['Rf', 267, 'fission', 'Ru', 111],
  ] as const)('%s-%i produces daughters through %s, conserving energy, charge and momentum', (symbol, a, mode, daughterSymbol, daughterA) => {
    const world = new World(71);
    world.wallsOn = false;
    const parent = world.spawnAtom(symbol, 30, 30, 0.012, -0.025, { massNumber: a })!;
    expect(parent).toBeTruthy();
    const before = { energy: energy(world), charge: charge(world), nucleons: nucleons(world), momentum: momentum(world) };
    parent.nuclear.remainingSeconds = 0;
    world.advanceNuclear(0.01);
    expect(world.nuclearDecays).toBe(1);
    expect(world.cores.some(c => c.id === parent.id)).toBe(false);
    expect(world.cores.some(c => c.symbol === daughterSymbol && c.a === daughterA)).toBe(true);
    expect(world.nuclearBursts[0].mode).toBe(mode);
    expect(charge(world)).toBe(before.charge);
    expect(nucleons(world)).toBe(before.nucleons);
    expect(Math.abs(energy(world) - before.energy)).toBeLessThan(1e-5);
    expect(momentum(world).x).toBeCloseTo(before.momentum.x, 9);
    expect(momentum(world).y).toBeCloseTo(before.momentum.y, 9);
    if (mode === 'alpha') {
      expect(world.cores.find(c => c.z === 2)?.qNet).toBe(2);
      expect(world.nuclearRays.filter(r => r.kind === 'electron')).toHaveLength(2);
      expect(world.photons).toHaveLength(0);
    }
    if (mode === 'fission') {
      expect(world.cores).toHaveLength(2);
      expect(world.neutrons).toHaveLength(2);
      expect(world.nuclearReleasedEV).toBeGreaterThan(100e6);
    }
    if (mode === 'beta−' || mode === 'double beta−') {
      expect(world.nuclearRays.filter(r => r.kind === 'beta−')).toHaveLength(mode === 'beta−' ? 1 : 2);
      expect(world.nuclearRays.some(r => r.kind === 'antineutrino')).toBe(true);
    }
    for (let frame = 0; frame < 12; frame++) world.stepFrame(0.1);
    for (const body of [...world.cores, ...world.electrons, ...world.neutrons]) {
      expect([body.x, body.y, body.vx, body.vy].every(Number.isFinite)).toBe(true);
    }
  });

  it('decays a free neutron to a proton, beta electron and antineutrino track', () => {
    const world = new World(2);
    const neutron = world.spawnNeutron(20, 20, 0.01, 0.02)!;
    const before = energy(world);
    neutron.nuclear.remainingSeconds = 0;
    world.advanceNuclear(0.1);
    expect(world.neutrons).toHaveLength(0);
    expect(world.cores[0].z).toBe(1);
    expect(world.cores[0].qNet).toBe(1);
    expect(world.nuclearRays.map(r => r.kind)).toEqual(['beta−', 'antineutrino']);
    expect(charge(world)).toBe(0);
    expect(energy(world)).toBeCloseTo(before, 6);
  });

  it('does not turn stable or ionized atoms into nuclear explosions', () => {
    const world = new World(3);
    const lead = world.spawnAtom('Pb', 10, 20)!;
    const proton = world.spawnProton(20, 20)!;
    world.spawnAtom('Ne', 40, 20, 0, 0, { charge: 3 });
    world.advanceNuclear(1e12);
    expect(world.cores).toHaveLength(3);
    expect(lead.a).toBe(208);
    expect(proton.a).toBe(1);
    expect(world.nuclearDecays).toBe(0);
    expect(world.nuclearBursts).toHaveLength(0);
  });

  it('waits for an electron before electron capture can occur', () => {
    const world = new World();
    const parent = world.spawnAtom('Be', 20, 20, 0, 0, { massNumber: 7, charge: 4 })!;
    expect(parent.frozenElectrons).toBe(0);
    parent.nuclear.remainingSeconds = 0;
    world.advanceNuclear(0.1);
    expect(world.nuclearDecays).toBe(0);
    expect(world.cores[0]).toBe(parent);
  });

  it('allows only one generation per update and respects pause, speed and reset', () => {
    const world = new World();
    const parent = world.spawnAtom('Og', 20, 20)!;
    parent.nuclear.remainingSeconds = 100;
    world.stepFrame(0, 5);
    expect(parent.nuclear.remainingSeconds).toBe(100);
    world.stepFrame(4, 0.05);
    expect(parent.nuclear.remainingSeconds).toBeCloseTo(99.8, 8);
    world.advanceNuclear(1000);
    expect(world.nuclearDecays).toBe(1);
    const burstAge = world.nuclearBursts[0].ageSeconds;
    world.advanceNuclear(0);
    expect(world.nuclearBursts[0].ageSeconds).toBe(burstAge);
    world.reset();
    world.advanceNuclear(1000);
    expect(world.nuclearDecays).toBe(0);
    expect(world.nuclearBursts).toHaveLength(0);
    expect(world.nuclearRays).toHaveLength(0);
    expect(world.nuclearReleasedEV).toBe(0);
    expect(world.nuclearEscapedEV).toBe(0);
    expect(world.nuclearEscapedCharge).toBe(0);
  });

  it('defers a decay intact when there is no room for all its products', () => {
    const world = new World();
    const parent = world.spawnAtom('Rf', 20, 20)!;
    while (world.bodyCount() < 460) world.spawnElectron(1000, 1000);
    const ids = world.cores.map(c => c.id);
    parent.nuclear.remainingSeconds = 0;
    world.advanceNuclear(0.1);
    expect(world.bodyCount()).toBe(460);
    expect(world.cores.map(c => c.id)).toEqual(ids);
    expect(world.nuclearDecays).toBe(0);
    expect(world.nuclearReleasedEV).toBe(0);
  });

  it('removes pending decay along with a deleted nucleus', () => {
    const world = new World();
    world.spawnAtom('U', 20, 20);
    world.deleteNear(20, 20);
    world.advanceNuclear(1000);
    expect(world.nuclearDecays).toBe(0);
    expect(world.cores).toHaveLength(0);
  });

  it('reschedules isotope decay after neutron capture and prices the measured separation energy', () => {
    const world = new World(11);
    const core = world.spawnAtom('H', 20, 20, 0, 0, { massNumber: 2 })!;
    world.spawnNeutron(20.1, 20);
    const before = energy(world);
    const p = momentum(world);
    world.rng = () => 0;
    const access = world as unknown as { captureNeutrons(): void };
    access.captureNeutrons();
    expect(core.a).toBe(3);
    expect(core.nuclear.status).toBe('radioactive');
    expect(core.nuclear.remainingSeconds).toBeLessThan(Infinity);
    expect(world.nuclearReleasedEV).toBeCloseTo(6257230.1, 1);
    expect(world.photons[0].energyEV).toBeGreaterThan(6.2e6);
    expect(energy(world)).toBeCloseTo(before, 5);
    expect(momentum(world).x).toBeCloseTo(p.x, 10);
    expect(momentum(world).y).toBeCloseTo(p.y, 10);
    world.advanceNuclear(0.1);
    expect(world.cores[0].symbol).toBe('He');
  });
});
