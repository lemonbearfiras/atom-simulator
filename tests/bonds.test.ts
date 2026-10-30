import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import type { Core } from '../src/sim/atom';
import { ACCEL_PER_EV_PER_U, MASS_SPEED_EV } from '../src/sim/units';

function booked(world: World): number {
  return world.kineticEnergyEV() + world.potentialEnergyEV() + world.bondBankEV + world.emittedEV - world.absorbedEV - world.pumpEV;
}

function internals(world: World) {
  return world as unknown as {
    forces(): void;
    substep(dt: number): void;
    chemistry(): void;
    settleBonds(): void;
    pruneUnaffordableBonds(): void;
    bondSlots(core: Core): number;
    valenceCapacity(core: Core): number;
  };
}

describe('effective atomic interactions', () => {
  it('does not bill a screened electron twice as a point charge', () => {
    const world = new World(7);
    const atom = world.spawnAtom('H', 20, 20)!;
    world.spawnElectron(25, 20);
    const bound = world.electrons.find(e => e.coreId === atom.id)!;
    const before = world.potentialEnergyEV();
    bound.x = 2 * atom.x - bound.x;
    bound.y = 2 * atom.y - bound.y;
    expect(world.potentialEnergyEV()).toBeCloseTo(before, 10);
  });

  it('matches the full force to the gradient of every booked potential', () => {
    const world = new World(7);
    world.spawnAtom('H', 20, 20);
    world.spawnAtom('O', 22, 21);
    world.spawnProton(28, 20);
    world.spawnElectron(28.025, 20.015);
    world.spawnElectron(27.8, 20.2);
    internals(world).chemistry();
    internals(world).forces();
    const h = 1e-6;
    for (const body of [...world.cores, ...world.electrons]) {
      for (const [coordinate, acceleration] of [['x', 'ax'], ['y', 'ay']] as const) {
        const position = body[coordinate];
        body[coordinate] = position + h;
        const above = world.potentialEnergyEV();
        body[coordinate] = position - h;
        const below = world.potentialEnergyEV();
        body[coordinate] = position;
        expect(body[acceleration] * body.massU / ACCEL_PER_EV_PER_U).toBeCloseTo(-(above - below) / (2 * h), 4);
      }
    }
  });

  it('converges as a fixed integration step is halved', () => {
    const excursion = (dt: number) => {
      const world = new World(17);
      world.wallsOn = false;
      world.spawnAtom('H', 20, 20);
      const baseline = booked(world);
      internals(world).forces();
      let largest = 0;
      for (let i = 0; i < Math.round(10 / dt); i++) {
        internals(world).substep(dt);
        largest = Math.max(largest, Math.abs(booked(world) - baseline));
      }
      return largest;
    };
    expect(excursion(0.001)).toBeLessThan(excursion(0.002) * 0.4);
  });
});

describe('measured bond orders', () => {
  it.each([7, 19, 31])('forms stable hydrogen with a closed energy ledger (seed %i)', (seed) => {
    const world = new World(seed);
    world.width = 40;
    world.height = 30;
    world.spawnAtom('H', 18, 15, 0.004, 0);
    world.spawnAtom('H', 22, 15, -0.004, 0);
    const baseline = booked(world);
    let formed = false;
    let maxDrift = 0;
    while (world.timeFS < 3000) {
      world.stepFrame(1);
      formed ||= world.bonds.length > 0;
      if (formed) expect(world.bonds).toHaveLength(1);
      maxDrift = Math.max(maxDrift, Math.abs(booked(world) - baseline));
    }
    expect(formed).toBe(true);
    expect(world.electrons.filter(e => e.coreId == null)).toHaveLength(0);
    const bond = world.bonds[0];
    expect(bond.order).toBe(1);
    expect(bond.lengthA).toBeCloseTo(0.7414, 4);
    // Dₑ, not the table's D₀: the molecule keeps its zero-point energy in the well.
    expect(bond.dissociationEV).toBeCloseTo(4.788, 2);
    expect(bond.promotionA + bond.promotionB).toBe(0);
    const separation = Math.hypot(bond.a.x - bond.b.x, bond.a.y - bond.b.y);
    expect(separation).toBeGreaterThan(0.4);
    expect(separation).toBeLessThan(1.5);
    expect(world.emittedEV).toBeGreaterThan(1);
    expect(maxDrift).toBeLessThan(0.4);
  }, 20000);

  it.each([
    ['O', 'O=O', 2, 5.257],
    ['N', 'N≡N', 3, 9.935],
  ])('binds %s₂ at its measured order and depth', (symbol, label, order, depth) => {
    const world = new World(3);
    world.spawnAtom(symbol, 20, 20, 0.001, 0);
    world.spawnAtom(symbol, 22, 20, -0.001, 0);
    const baseline = booked(world);
    while (world.timeFS < 150) world.stepFrame(1);
    expect(world.bonds).toHaveLength(1);
    expect(world.bonds[0].label).toBe(label);
    expect(world.bonds[0].order).toBe(order);
    // Oxygen is 5.12 eV deep and nitrogen 9.76 — one shared pair each would have said
    // 1.51 eV and 1.69 eV, which is the error this closes.
    expect(world.bonds[0].dissociationEV).toBeCloseTo(depth, 2);
    expect(world.bonds[0].lengthA).toBeLessThan(1.25);
    expect(world.electrons.filter(e => e.coreId == null)).toHaveLength(0);
    expect(Math.abs(booked(world) - baseline)).toBeLessThan(0.4);
  }, 20000);

  it('keeps a doubled pair from spending the same electrons twice', () => {
    const world = new World(5);
    const oxygen = world.spawnAtom('O', 20, 20)!;
    const other = world.spawnAtom('O', 22, 20)!;
    internals(world).chemistry();
    expect(world.bonds[0].order).toBe(2);
    // Both oxygens have now shared every unpaired electron they own.
    expect(internals(world).bondSlots(oxygen)).toBe(0);
    expect(internals(world).bondSlots(other)).toBe(0);
    // And a second round of chemistry, which recounts usage from the bonds on the books,
    // has to agree: this is where oxygen used to collect a third and fourth partner.
    internals(world).chemistry();
    expect(world.bonds).toHaveLength(1);
    expect(internals(world).bondSlots(oxygen)).toBe(0);
  });

  it.each([
    ['O', 2],
    ['N', 3],
  ])('holds a cluster of %s atoms to %i shared pairs each instead of a molecule that does not exist', (symbol, order) => {
    const world = new World(23);
    world.width = 40;
    world.height = 30;
    // A square of side 1.6 Å: every edge and both diagonals sit inside the bond reach, so an
    // atom allowed to spend the same pair twice would build a four-way cluster of them.
    for (const [dx, dy] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
      world.spawnAtom(symbol, 20 + dx, 15 + dy, -dx * 0.02, -dy * 0.02);
    }
    while (world.timeFS < 900) world.stepFrame(1);
    expect(world.bonds.length).toBeGreaterThan(0);
    for (const bond of world.bonds) expect(bond.order).toBe(order);
    for (const core of world.cores) {
      const shared = world.bonds.reduce((sum, bond) => sum + (bond.a === core || bond.b === core ? bond.order : 0), 0);
      expect(shared).toBeLessThanOrEqual(internals(world).valenceCapacity(core));
    }
    // Two dimers out of four atoms, never one ring of four.
    expect(world.bonds).toHaveLength(2);
  }, 20000);

  it('takes a bond away from an atom that can no longer pay for it', () => {
    const world = new World(29);
    const a = world.spawnAtom('O', 20, 20)!;
    const b = world.spawnAtom('O', 22, 20)!;
    internals(world).chemistry();
    const bond = world.bonds[0];
    expect(bond.order).toBe(2);
    // Pile a third electron onto the half-filled 2p shell: 2p⁵ leaves one unpaired electron,
    // not two, so this atom no longer owns the two pairs the double bond is spending.
    const outer = a.levels.findIndex((level, i) => !level.frozen && level.l === 1 && a.counts[i] > 0);
    const extra = world.spawnElectron(a.x + a.levels[outer].radiusA * 1.6, a.y)!;
    extra.coreId = a.id;
    extra.level = outer;
    world.refreshAllCores();
    expect(a.unpairedValence).toBe(1);
    expect(internals(world).valenceCapacity(a)).toBe(1);
    // Drift the pair out to where the well is empty, so the break costs nothing but the order.
    b.x = a.x + 6;
    const baseline = booked(world);
    internals(world).pruneUnaffordableBonds();
    expect(world.bonds).toHaveLength(0);
    expect(Math.abs(booked(world) - baseline)).toBeLessThan(0.05);
  }, 20000);

  it('lets carbon reach four bonds and bills the promotion once', () => {
    const world = new World(11);
    world.width = 40;
    world.height = 30;
    const carbon = world.spawnAtom('C', 20, 20)!;
    for (const [dx, dy] of [[1.6, 0], [-1.6, 0], [0, 1.6], [0, -1.6]]) {
      world.spawnAtom('H', 20 + dx, 20 + dy, -dx * 0.004, -dy * 0.004);
    }
    while (world.timeFS < 400) world.stepFrame(1);
    const onCarbon = world.bonds.filter((b) => b.a === carbon || b.b === carbon);
    expect(onCarbon.length).toBeGreaterThanOrEqual(3);
    const promotion = world.bonds.reduce((sum, b) => sum + b.promotionA + b.promotionB, 0);
    // 2s²2p² → 2s¹2p³ is 1.5 eV, and the box charges it to the bond that needed it.
    expect(promotion).toBe(1.5);
    expect(carbon.promotionPaid).toBe(true);
    expect(carbon.excitationEV).toBeCloseTo(1.5, 10);
    // The promotion is a booked term, so from here the ledger has to stay shut.
    const baseline = booked(world);
    while (world.timeFS < 800) world.stepFrame(1);
    expect(Math.abs(booked(world) - baseline)).toBeLessThan(0.4);
  });

  it('keeps closed-shell helium unbonded', () => {
    const world = new World(9);
    world.spawnAtom('He', 20, 20, 0.001, 0);
    world.spawnAtom('He', 23, 20, -0.001, 0);
    while (world.timeFS < 100) world.stepFrame(1);
    expect(world.bonds).toHaveLength(0);
  });

  it('cools vibration without draining rotation or crossing the zero-point floor', () => {
    const world = new World(9);
    const a = world.spawnAtom('H', 20, 20)!;
    const b = world.spawnAtom('H', 22, 20)!;
    internals(world).chemistry();
    const bond = world.bonds[0];
    b.x = a.x + bond.lengthA;
    a.vx = 0.12;
    b.vx = -0.12;
    a.vy = 0.02;
    b.vy = -0.02;
    const baseline = booked(world);
    const emitted = world.emittedEV;
    const px = a.massU * a.vx + b.massU * b.vx;
    internals(world).settleBonds();
    expect(a.vy).toBe(0.02);
    expect(b.vy).toBe(-0.02);
    expect(a.massU * a.vx + b.massU * b.vx).toBeCloseTo(px, 12);
    expect(world.emittedEV).toBeGreaterThan(emitted);
    expect(booked(world)).toBeCloseTo(baseline, 9);
    const q = bond.quantumEV;
    const ground = q / 2 - q * q / (16 * bond.dissociationEV);
    const radial = 0.5 * bond.reducedMassU * (a.vx - b.vx) ** 2 * MASS_SPEED_EV;
    expect(radial).toBeGreaterThanOrEqual(ground);
    expect(radial).toBeLessThan(1.5 * q - 2.25 * q * q / (4 * bond.dissociationEV));
  });

  it('breaks an outward-moving unbound pair without inventing energy', () => {
    const world = new World(9);
    const a = world.spawnAtom('H', 20, 20)!;
    const b = world.spawnAtom('H', 22, 20)!;
    internals(world).chemistry();
    expect(world.bonds).toHaveLength(1);
    b.x = a.x + 8;
    a.vx = -0.1;
    b.vx = 0.1;
    const baseline = booked(world);
    internals(world).settleBonds();
    expect(world.bonds).toHaveLength(0);
    expect(booked(world)).toBeCloseTo(baseline, 9);
  });

  it('removes a deleted atom from all bonds', () => {
    const world = new World(9);
    const a = world.spawnAtom('H', 20, 20)!;
    const b = world.spawnAtom('H', 22, 20)!;
    internals(world).chemistry();
    expect(world.bonds).toHaveLength(1);
    world.deleteNear(a.x, a.y, 0.1);
    expect(world.bonds).toHaveLength(0);
    expect(b.bonded).toBe(false);
  });

  it('accounts for stored association energy and clears bonds on reset', () => {
    const world = new World(9);
    world.spawnAtom('H', 20, 20);
    world.spawnAtom('H', 21, 20);
    const baseline = booked(world);
    internals(world).chemistry();
    expect(world.bonds).toHaveLength(1);
    expect(world.bondBankEV).toBeGreaterThan(0);
    expect(booked(world)).toBeCloseTo(baseline, 9);
    expect(world.summary().bondBankEV).toBe(world.bondBankEV);
    world.reset();
    expect(world.bonds).toHaveLength(0);
    expect(world.bondBankEV).toBe(0);
  });
});
