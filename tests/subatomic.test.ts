import { describe, expect, it } from 'vitest';
import { World, photonEVForDrag } from '../src/sim/world';
import { DEFAULT_SCALE, drawWorld, type View } from '../src/render/draw';
import { ELECTRON_MASS_U, MASS_SPEED_EV } from '../src/sim/units';

/** Boltzmann in eV per kelvin, written out again on purpose: the test must not share the model's constant. */
const K_B_EV_PER_K = 8.617333262e-5;

function booked(world: World): number {
  return world.kineticEnergyEV() + world.potentialEnergyEV() + world.bondBankEV + world.emittedEV - world.absorbedEV - world.pumpEV;
}

/** Everything drawWorld would write as text, with no browser behind it. */
function fakeCanvas(): { texts: string[]; ctx: CanvasRenderingContext2D } {
  const texts: string[] = [];
  const gradient = { addColorStop: () => {} };
  const ctx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    clearRect: () => {},
    setLineDash: () => {},
    fillText: (text: string) => texts.push(String(text)),
    strokeText: (text: string) => texts.push(String(text)),
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  } as unknown as CanvasRenderingContext2D;
  return { texts, ctx };
}

function labelsOnScreen(subatomic: boolean): string[] {
  const world = new World(5);
  if (subatomic) world.setSubatomicMode(true);
  const carbon = world.spawnAtom('C', 20, 20)!;
  // A remembered line, so the test says what the renderer does with one — not what a fresh
  // nucleus happens not to have.
  carbon.lastLineNm = 5727;
  const view: View = { scale: DEFAULT_SCALE, panX: 0, panY: 0, width: 900, height: 600 };
  const { texts, ctx } = fakeCanvas();
  drawWorld(ctx, world, view, null);
  return texts;
}

describe('subatomic mode', () => {
  it('drops a table atom as a bare nucleus', () => {
    const world = new World(3);
    world.setSubatomicMode(true);
    const carbon = world.spawnAtom('C', 20, 20)!;
    expect(carbon.qNet).toBe(6);
    expect(carbon.chargeBase).toBe(6);
    expect(carbon.counts.every((count) => count === 0)).toBe(true);
    expect(world.electrons).toHaveLength(0);
    // The isotope still comes along, electrons or no electrons.
    expect(carbon.a).toBe(12);
    expect(carbon.massU).toBeCloseTo(12, 2);
  });

  it('keeps nuclei from bonding, and proves the same script bonds when shells are modelled', () => {
    const pair = (subatomic: boolean) => {
      const world = new World(23);
      world.width = 40;
      world.height = 30;
      if (subatomic) world.setSubatomicMode(true);
      world.spawnAtom('H', 18, 15, 0.004, 0);
      world.spawnAtom('H', 22, 15, -0.004, 0);
      for (let frame = 0; frame < 120; frame++) world.stepFrame(1);
      return world;
    };
    const gas = pair(false);
    expect(gas.bonds).toHaveLength(1);
    const nuclei = pair(true);
    expect(nuclei.bonds).toHaveLength(0);
    expect(nuclei.cores.map((core) => core.qNet)).toEqual([1, 1]);
    expect(nuclei.summary().bonds).toBe(0);
  });

  it('scatters electrons instead of taking them in', () => {
    const probe = (subatomic: boolean) => {
      const world = new World(31);
      world.width = 60;
      world.height = 40;
      if (subatomic) world.setSubatomicMode(true);
      world.spawnAtom('H', 20, 20);
      world.spawnElectron(23, 20);
      for (let frame = 0; frame < 60; frame++) world.stepFrame(1);
      return world;
    };
    const withShells = probe(false);
    expect(withShells.electrons.some((e) => e.coreId != null)).toBe(true);
    expect(withShells.emittedEV).toBeGreaterThan(0);

    const nuclei = probe(true);
    expect(nuclei.electrons.every((e) => e.coreId == null)).toBe(true);
    expect(nuclei.emittedEV).toBe(0);
    expect(nuclei.photons).toHaveLength(0);
  });

  it('strips the box on the way in and hands the ladders back on the way out', () => {
    const world = new World(17);
    world.width = 40;
    world.height = 30;
    world.spawnAtom('H', 18, 15, 0.004, 0);
    world.spawnAtom('H', 22, 15, -0.004, 0);
    for (let frame = 0; frame < 120; frame++) world.stepFrame(1);
    expect(world.bonds).toHaveLength(1);

    world.setSubatomicMode(true);
    expect(world.bonds).toHaveLength(0);
    expect(world.electrons).toHaveLength(0);
    expect(world.bondBankEV).toBe(0);
    for (const core of world.cores) {
      expect(core.qNet).toBe(1);
      expect(core.bonded).toBe(false);
      expect(core.excitationEV).toBe(0);
    }
    expect(world.events.some((event) => event.text.includes('Subatomic mode'))).toBe(true);
    // Toggling again changes nothing, which is what an idempotent control has to do.
    world.setSubatomicMode(true);
    expect(world.cores).toHaveLength(2);

    world.setSubatomicMode(false);
    world.reset();
    world.spawnAtom('H', 19, 15, 0.003, 0);
    world.spawnAtom('H', 21, 15, -0.003, 0);
    for (let frame = 0; frame < 150; frame++) world.stepFrame(1);
    expect(world.bonds).toHaveLength(1);
  });

  it('books a hand-injected photon to the pump and finds nothing to absorb it', () => {
    const world = new World(41);
    world.setSubatomicMode(true);
    world.spawnAtom('C', 20, 20);
    const baseline = booked(world);
    world.spawnPhoton(10.2, 8, 8, 0);
    expect(world.photons).toHaveLength(1);
    expect(world.photons[0].sourceSymbol).toBe('γ');
    expect(world.pumpEV).toBeCloseTo(10.2, 9);
    expect(world.emittedEV).toBeCloseTo(10.2, 9);
    expect(booked(world)).toBeCloseTo(baseline, 9);

    for (let frame = 0; frame < 60; frame++) world.stepFrame(1);
    // No shells means no line to jump: the light crosses the box unpaid.
    expect(world.absorbedEV).toBe(0);
    expect(Math.abs(booked(world) - baseline)).toBeLessThan(0.05);

    // And when it has crossed the edge it is forgotten — the books still remember it was paid for.
    for (let frame = 0; frame < 400; frame++) world.stepFrame(1);
    expect(world.photons).toHaveLength(0);
    expect(world.emittedEV).toBeCloseTo(10.2, 9);
    expect(Math.abs(booked(world) - baseline)).toBeLessThan(0.05);
  });

  it('maps a drag to one decade of spectrum every eight ångström', () => {
    expect(photonEVForDrag(0)).toBeCloseTo(0.01, 10);
    expect(photonEVForDrag(8)).toBeCloseTo(0.1, 9);
    expect(photonEVForDrag(16)).toBeCloseTo(1, 9);
    expect(photonEVForDrag(24)).toBeCloseTo(10, 8);
    expect(photonEVForDrag(64)).toBeCloseTo(1e6, 4);
    // Clamped at both ends: no photon of zero energy, and nothing past a beam dump.
    expect(photonEVForDrag(-5)).toBeCloseTo(0.01, 10);
    expect(photonEVForDrag(1000)).toBe(1e7);
  });

  it('throws away the element symbol and the line label, and keeps the nucleus', () => {
    expect(labelsOnScreen(false)).toContain('C');
    expect(labelsOnScreen(false)).toContain('A=12');
    expect(labelsOnScreen(false)).toContain('5727 nm');
    const bare = labelsOnScreen(true);
    expect(bare).not.toContain('C');
    expect(bare).not.toContain('5727 nm');
    expect(bare).toContain('A=12');
  });

  it('forgets the lines a nucleus remembered when its shells are taken away', () => {
    const world = new World(5);
    const carbon = world.spawnAtom('C', 20, 20)!;
    carbon.lastLineNm = 121.6;
    world.setSubatomicMode(true);
    expect(carbon.lastLineNm).toBeNull();
  });
});

describe('thermostat', () => {
  it('starts the box at room temperature', () => {
    expect(new World(1).thermostatK).toBe(300);
  });

  it('kicks a released body with the Maxwell spread of that temperature', () => {
    const draws = (massU: number, world: World, count: number) => {
      let sum = 0;
      for (let i = 0; i < count; i++) {
        const v = world.thermalVelocity(massU);
        sum += v.vx * v.vx + v.vy * v.vy;
      }
      return sum / count;
    };
    const world = new World(13);
    const samples = 40000;
    const meanSquare = draws(1, world, samples);
    // Two dimensions: ⟨½mv²⟩ = kT, so ⟨v²⟩ = 2kT/m.
    expect(0.5 * MASS_SPEED_EV * meanSquare).toBeGreaterThan(K_B_EV_PER_K * 300 * 0.95);
    expect(0.5 * MASS_SPEED_EV * meanSquare).toBeLessThan(K_B_EV_PER_K * 300 * 1.05);
    // And it is a thermal speed, not a fixed one: the light particle goes faster by the mass
    // ratio, which between a 1 u nucleus and an electron is 1823.
    const ratio = draws(ELECTRON_MASS_U, world, samples) / meanSquare;
    expect(ratio).toBeGreaterThan(1700);
    expect(ratio).toBeLessThan(1950);
  });

  it('stops kicking at absolute zero', () => {
    const world = new World(13);
    world.thermostatK = 0;
    expect(world.thermalVelocity(1)).toEqual({ vx: 0, vy: 0 });
  });

  it('re-tempers everything already in the box', () => {
    const world = new World(19);
    world.setSubatomicMode(true);
    world.width = 120;
    world.height = 70;
    for (let i = 0; i < 400; i++) {
      world.spawnProton(6 + (i % 20) * 5.5, 6 + Math.floor(i / 20) * 5.5, 0, 0);
    }
    expect(world.temperatureK()).toBe(0);
    world.setTemperature(1000);
    expect(world.thermostatK).toBe(1000);
    // 400 Rayleigh draws, so this is a band rather than a number: ±30% is about 2σ.
    expect(world.temperatureK()).toBeGreaterThan(700);
    expect(world.temperatureK()).toBeLessThan(1300);
  });
});
