import { describe, it, expect } from 'vitest';
import { blandAltman } from '../blandAltman';

describe('blandAltman — acuerdo estimado vs referencia (F6)', () => {
  it('calcula sesgo, sd, LoA y percentiles', () => {
    const pairs = [
      { estimate: 122, reference: 120 },
      { estimate: 118, reference: 120 },
      { estimate: 120, reference: 120 },
    ];
    const r = blandAltman(pairs);
    expect(r).not.toBeNull();
    expect(r!.n).toBe(3);
    expect(r!.bias).toBeCloseTo(0, 9);
    expect(r!.sd).toBeCloseTo(Math.sqrt((4 + 4 + 0) / 2), 9);
    expect(r!.loaLow).toBeCloseTo(r!.bias - 1.96 * r!.sd, 9);
    expect(r!.loaHigh).toBeCloseTo(r!.bias + 1.96 * r!.sd, 9);
  });

  it('sin pares válidos → null', () => {
    expect(blandAltman([])).toBeNull();
    expect(blandAltman([{ estimate: NaN, reference: 120 }])).toBeNull();
  });

  it('dirección NEW_MINUS_REFERENCE: sesgo positivo si el nuevo sobreestima', () => {
    const r = blandAltman([{ estimate: 130, reference: 120 }, { estimate: 128, reference: 120 }]);
    expect(r!.bias).toBeCloseTo(9, 9);
  });
});