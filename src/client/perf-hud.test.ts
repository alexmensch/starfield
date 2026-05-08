import { describe, it, expect } from 'vitest';
import { mark, measure, frame } from './perf-hud';

describe('perf-hud / no-op API', () => {
  it('mark/measure/frame are safe to call without installing the HUD', () => {
    // The API contract is "always callable, no-op until installPerfHud
    // runs". Production code calls these unconditionally; if they ever
    // start throwing without the HUD installed, every animate() tick
    // would crash.
    expect(() => {
      mark('test.section');
      measure('test.section');
      frame();
    }).not.toThrow();
  });

  it('repeated frame() calls without install do nothing', () => {
    for (let i = 0; i < 100; i++) frame();
    // No assertion beyond "didn't throw and didn't allocate visible
    // state" — internal counters are off by design when not installed.
  });
});
