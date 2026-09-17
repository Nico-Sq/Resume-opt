import { describe, expect, it } from 'vitest';

import toolchain from '../../toolchain.lock.json';

describe('workspace baseline', () => {
  it('pins the runtime and package manager versions', () => {
    expect(toolchain.node).toMatch(/^20\./u);
    expect(toolchain.pnpm).toBe('10.28.2');
  });

  it('keeps the V0.1 scope on the formal application', () => {
    expect(toolchain.next).toBeTruthy();
    expect(toolchain.react).toBeTruthy();
  });
});
