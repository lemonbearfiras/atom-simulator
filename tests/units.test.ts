import { describe, expect, it } from 'vitest';
import { evToKJPerMol, kjPerMolToEV } from '../src/engine/constants';
import { bondForPair, morseCurve, reducedMassU } from '../src/data/bonds';
import { elementBySymbol } from '../src/data/elements';

describe('molecular energy units', () => {
  it('converts a mole of electronvolts into kJ and back', () => {
    expect(evToKJPerMol(1)).toBeCloseTo(96.485332, 5);
    expect(kjPerMolToEV(436)).toBeCloseTo(4.518822, 5);
    for (const energy of [0, 0.01, 1, 13.6, 1e6]) {
      expect(kjPerMolToEV(evToKJPerMol(energy))).toBeCloseTo(energy, 8);
    }
  });

  it('keeps hydrogen bond parameters in physical units', () => {
    const hydrogen = elementBySymbol('H')!;
    const row = bondForPair(hydrogen, hydrogen, 1);
    const mu = reducedMassU(1.008, 1.008);
    const curve = morseCurve(row, mu);
    expect(row.measured).toBe(true);
    expect(row.order).toBe(1);
    // The table quotes D₀, the energy out of the lowest vibrational level.
    expect(row.dissociationEV).toBeCloseTo(4.519, 3);
    expect(row.lengthA).toBeCloseTo(0.7414, 4);
    // The well the box draws is deeper by the zero point the molecule cannot shed:
    // measured Dₑ(H₂) is 4.75 eV and ħω/2 − ħωx/4 is 0.27 eV of that.
    expect(curve.depthEV).toBeCloseTo(4.788, 2);
    expect(curve.rangeInvA).toBeCloseTo(1.937, 2);
    expect(curve.quantumEV).toBeCloseTo(0.5457, 4);
    expect(curve.depthEV - (curve.quantumEV / 2 - curve.quantumEV ** 2 / (16 * curve.depthEV)))
      .toBeCloseTo(row.dissociationEV, 6);
  });

  it('reads a triple bond off the same curve as a single one', () => {
    const nitrogen = elementBySymbol('N')!;
    const row = bondForPair(nitrogen, nitrogen, 3);
    const curve = morseCurve(row, reducedMassU(14.007, 14.007));
    expect(row.order).toBe(3);
    expect(row.dissociationEV).toBeCloseTo(9.794, 3); // 945 kJ/mol
    expect(row.lengthA).toBeCloseTo(1.0975, 4);
    expect(curve.quantumEV).toBeCloseTo(0.2924, 4); // ħω of the 2359 cm⁻¹ stretch
    expect(curve.depthEV).toBeCloseTo(9.939, 2); // measured Dₑ(N₂) is 9.91 eV
  });
});
