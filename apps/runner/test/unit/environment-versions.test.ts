import { describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/environment.js';

describe('toolchain version comparison (v0.3, D-46)', () => {
  it('compares numeric dotted versions', () => {
    expect(compareVersions('2.1.316', '2.1.316')).toBe(0);
    expect(compareVersions('2.1.320', '2.1.316')).toBeGreaterThan(0);
    expect(compareVersions('0.166.0', '0.170.1')).toBeLessThan(0);
    expect(compareVersions('12.16.1', '12.9.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});
