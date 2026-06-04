import { describe, it, expect } from 'vitest';
import * as publicApi from '../src/index.js';

describe('public API surface', () => {
  it('exports exactly the intentional set of names', () => {
    const exported = Object.keys(publicApi).sort();
    expect(exported).toMatchSnapshot();
  });
});
