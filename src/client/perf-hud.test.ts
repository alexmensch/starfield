import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mark, measure, frame, buildPerfSection } from './perf-hud';

describe('perf-hud / no-op API', () => {
  it('mark/measure/frame are safe to call without installing the HUD', () => {
    // The API contract is "always callable, no-op until buildPerfSection
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

// Minimal DOM stub for buildPerfSection() — it creates ~150 nodes
// (headline, table header, row pool, histogram bars, caption) but the
// teardown tests only need the build to complete; nothing is inspected.
// vitest runs in the node environment for this project, so document is
// unavailable by default. Pattern mirrors heliopause.test.ts.
function makeDomStub(): { createElement: () => unknown; createTextNode: () => unknown } {
  type Node = {
    style: Record<string, string>;
    children: Node[];
    childNodes: Node[];
    firstChild: Node | null;
    id: string;
    textContent: string;
    nodeValue: string;
    title: string;
    appendChild: (c: Node) => Node;
    addEventListener: () => void;
  };
  const makeNode = (): Node => {
    const node: Node = {
      style: {},
      children: [],
      childNodes: [],
      firstChild: null,
      id: '',
      textContent: '',
      nodeValue: '',
      title: '',
      appendChild(c: Node) {
        this.children.push(c);
        this.childNodes.push(c);
        if (this.firstChild === null) this.firstChild = c;
        return c;
      },
      addEventListener() {},
    };
    return node;
  };
  return {
    createElement: makeNode,
    createTextNode: makeNode,
  };
}

describe('perf-hud / install → dispose teardown (9mm.190.1)', () => {
  let prevDoc: unknown;
  let perfNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = makeDomStub();
    perfNowSpy = vi.spyOn(performance, 'now');
  });

  afterEach(() => {
    perfNowSpy.mockRestore();
    (globalThis as { document?: unknown }).document = prevDoc;
  });

  it('dispose restores the no-op contract — mark/measure/frame stop calling performance.now', () => {
    const section = buildPerfSection();

    // While installed, realMark/realMeasure both call performance.now —
    // mark stores the start timestamp, measure subtracts it. Confirm
    // the install actually took effect before we test the teardown.
    perfNowSpy.mockClear();
    mark('test.a');
    measure('test.a');
    expect(perfNowSpy.mock.calls.length).toBeGreaterThan(0);

    section.dispose();

    // After dispose, every dispatch must route back through the no-op
    // stubs. No performance.now calls means _mark/_measure are no-ops
    // again; no exception from frame() means _frame is no-op too.
    perfNowSpy.mockClear();
    mark('test.b');
    measure('test.b');
    for (let i = 0; i < 100; i++) frame();
    expect(perfNowSpy.mock.calls.length).toBe(0);
  });

  it('dispose + re-build re-arms the install — `installed` flag was cleared', () => {
    // First session: install then dispose. The dispose path must reset
    // `installed = false` so the second buildPerfSection takes the
    // install branch again rather than skipping it (which would leave
    // _mark/_measure/_frame as no-ops despite a panel being visible).
    const first = buildPerfSection();
    first.dispose();

    // Confirm the dispose actually un-installed by checking mark is a
    // no-op between the two builds.
    perfNowSpy.mockClear();
    mark('between.builds');
    measure('between.builds');
    expect(perfNowSpy.mock.calls.length).toBe(0);

    // Second build re-runs the install branch and rewires the reals.
    const second = buildPerfSection();
    perfNowSpy.mockClear();
    mark('test.second');
    measure('test.second');
    expect(perfNowSpy.mock.calls.length).toBeGreaterThan(0);

    second.dispose();
  });
});
