import { describe, it, expectTypeOf } from 'vitest';
import type { RenderClaudeMdOptions } from '../src/render.js';
import type { AtomType } from '../src/types.js';

describe('RenderClaudeMdOptions.typeWeights', () => {
  it('typeWeights is keyed by AtomType (not arbitrary string)', () => {
    expectTypeOf<NonNullable<RenderClaudeMdOptions['typeWeights']>>()
      .toEqualTypeOf<Partial<Record<AtomType, number>>>();
  });

  it('accepts a valid AtomType key at runtime (type-check tripwire)', () => {
    const opts: RenderClaudeMdOptions = { typeWeights: { decision: 2.0 } };
    expectTypeOf(opts.typeWeights).toEqualTypeOf<Partial<Record<AtomType, number>> | undefined>();
  });
});
