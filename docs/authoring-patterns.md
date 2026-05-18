# Authoring patterns — consistency at the seam

A bundle of consistency rules that catch a recurring class of subtle
bugs in stellata code. Each is the codified version of a retrospective
code-review finding; apply at write time, not at review time. These
patterns sit alongside the DRY override in `CLAUDE.md` § "Code
conventions" — together they define the write-time bar this codebase
holds itself to.

## Lifecycle pairing

Every long-lived resource has its teardown wired in the SAME diff that
introduces it.

- Each `bus.on()` subscription returns or stores an unsub that the
  dispose path calls.
- Each pool / buffer that grows has a hard cap or `shrinkIfIdle`, OR an
  explicit "we don't bother" comment with bound math.
- Each `subarray` / `Uint8Array.subarray` view returned across a method
  boundary documents its lifetime ("invalidated after grow / detach")
  OR returns a copy.

Representative finding: `EventBus` had no `clear()` so cross-session
subscriptions leaked. The fix wired `clear()` into the dispose path in
the same diff.

## Sibling symmetry

Two sibling functions / helpers / branches must be defensively
symmetric. Common pairs in stellata: lambertian vs mallama phase
factors; encode vs decode for URL state; v2 vs v3 schema; pickStar
prime vs fallback; reserved-bit decode vs ignore.

If one clamps inputs, the other clamps. If one asserts a bit budget,
the other asserts. If one logs on degenerate input, the other logs.
Asymmetry invites "I'll just call X — same shape" mistakes downstream.

Representative finding: `mallamaPhaseFactor` didn't clamp α while
`lambertianPhaseFactor` did. The sibling pair needs to clamp
identically or document the asymmetry as intentional.

## Sentinel-init for dirty-track

When introducing dirty-track / cache patterns:

- The sentinel initial value MUST fail the comparison on first write
  (force first-write to land — choose `NaN`, `-Infinity`, or a
  poison-string like `\0` if the desired state can legitimately equal
  the natural sentinel).
- Hide / dispose / reset paths MUST reset every numeric sentinel and
  every cached input — not just visibility flags.
- Cache keys MUST include every input dimension that affects the cached
  output (text + font-load + CSS class + scale, not just text).

Representative finding: `pointerEvents = ""` sentinel matched
steady-state so first-frame write was skipped, leaving the overlay
unresponsive until the second frame.

## Single source of truth for time / camera state / world offset

Code that needs the wall-clock-derived `t` reads it via
`Stellata.getT()` — never `Date.now()` directly. Code that mutates a
state struct mid-animation (e.g. `WarpState.pEnd` shifted across origin
recentre) either makes the entire struct frame-coherent OR adds an
explicit invariant comment naming which fields are valid in which phase.

Representative finding: `PlanetBodyField.attachHost` called
`Date.now()/1000` instead of routing through `getT()`; that drifted from
the live-`t` clock the rest of the solar-system layer reads.

## When to apply

These are write-time rules, not review-time rules:

- When adding a `bus.on(...)` call, find the dispose path of the file in
  the same diff and add the unsub.
- When adding `growCapacity` or `pool.push`, define the upper bound and
  a comment justifying it.
- When implementing one of a sibling pair, copy-skim the sibling and
  replicate every defence (or document the asymmetry as intentional).
- When adding a sentinel, write the first-write assertion explicitly.
- When reading time-of-day for ephemerides, route through
  `Stellata.getT()`.
