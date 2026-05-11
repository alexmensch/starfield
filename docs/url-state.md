# URL state

All Stellata UI state — camera pose, focus, magnitude settings, overlay
toggles, observe-mode flag, POIs, cloud focus — lives in a single
opaque URL param: `?v=<base64url>`. The blob is a binary, versioned
envelope — `[1 byte version] [LEB128 presence mask, 1–4 bytes]
[payload]` in v3 — and only the fields that diverge from canonical
defaults occupy bytes. A fully-default state has no `?v=` at all, a
typical share lands at ~10–25 chars, and worst-case (every field
overridden) tops out around 70 chars. See `src/client/url-state.ts`
for the format and the `FIELDS_V3` table.

Three wire formats coexist. **v3** (current) carries an LEB128 presence
mask and per-component vec3 sub-masks: `cam`, `tgt`, `up`, and
`worldOffset` each prefix their payload with a 1-byte sub-mask, and
only components that diverge from the per-key default cost a float32
on the wire. **v2** packs each narrow scalar (`fov`, `mag`, `smin`,
`smax`, `span`) into 1 byte at the slider's native step; star refs and
POI HIPs are 3 bytes (1 tag bit + 23-bit id, plenty for 313k catalog
rows and 120k HIPs); cloud refs are 1 byte; vec3s are flat 12 bytes.
**v1** (legacy: 32-bit mask, float32 scalars, uint32 ids) is still
decoded. Old shared URLs auto-upgrade to v3 on load via
`applyFromUrl`'s post-debounce rewrite, so the address bar silently
shrinks without breaking anyone's bookmark.

The vec3 sub-mask uses **strict equality** (`!==`), not the EPS=1e-3
`approx` check — under floating origin (a7d.2.11) the local-frame cam
can land at sub-µpc magnitudes, well inside that epsilon. Eliding
those as "approximately default" would silently round the camera to
the frame origin on round-trip. The cam vec3 is the only one whose
default depends on mode (`[0,0,30]` navigate / `[0,0,0]` observe);
the v3 decoder fills missing components from the static navigate
default, then `decodeV3`'s post-pass swaps z=0 in observe mode when
the sub-mask leaves z unset (flags decodes after cam in `FIELDS_V3`
bit order, so mode isn't known until the field loop completes).

- `url-state.ts applyFromUrl` runs **before** `startUrlSync` subscribes, so
  applying the URL on load doesn't echo back into history.
- Default-compression: a field is encoded only when its value differs
  from the canonical default. Encoder pre-computes the presence mask
  in one walk, then writes only the bytes for set bits. Default state
  produces no `?v=` at all (clean URL).
- Star focus is encoded with a tag bit — high bit set ⇒ HIP number,
  clear ⇒ row index. HIPs survive future catalog reorderings; index
  fallback exists for the ~63% of catalog stars without a HIP. Sol is
  the canonical default focus and is encoded by *omitting* the field;
  "explicitly unfocused" uses a separate zero-byte presence bit so the
  three states (default Sol / specific star / cleared) stay
  unambiguous.
- If `?v=` carries a focus without camera params (a hand-typed share),
  `applyDecodedView` calls `focusStar(idx, { animate: false })` which
  snaps the camera to the park pose — URL restore must not surface as a
  2 s glide on page load. If camera params are also present, it uses
  `setOrbitTarget` so the explicit camera wins.
- Camera changes are tracked via `onFrame` with a stringified-coord hash
  and a 300 ms debounced writer. The hash covers position, target,
  **and** `camera.up` — so two-finger roll (which only mutates `up`)
  still triggers a URL update.
- `camera.up` round-trips when it differs from `(0, 1, 0)` and is
  applied **before** focus/orbit dispatch because `focusStar` /
  `setOrbitTarget` call `controls.update()` which reads `camera.up` to
  derive orientation.
- `mode=observe` is applied **after** camera params + `controls.update()`
  so the saved pose lands first; the receiver then
  `setCameraMode('observe', { animate: false })` if the bit is set and
  a focused star exists. Default-omitted (navigate).
- The URL writer skips frame-hash updates while
  `isObserveTransitionActive()` is true, mirroring the warp guard — the
  observe enter/exit translate animates camera position and would
  otherwise flood history with intermediate poses.

Cloud-related state (cloud focus, cloud measurement vector, MC overlay
toggle) lives in the same `?v=` blob — see `docs/molecular-clouds.md`.

`worldOffset` (FIELDS_V2 bit 20, vec3 Float32) serialises only when
`focusedStar === null` AND the offset isn't ≈Sol — see
`docs/architecture.md` § Floating origin for the precision-anchor
semantics that make this round-trip safe.

**Adding a field.** Claim the next free presence bit in `FIELDS_V3`,
declare its type and bytes, and add encode/decode logic in
`currentStateOf` / `applyDecodedView`. Old shared URLs decode fine
because their bit is 0 in the presence mask. Don't repurpose retired
bits for ~6 months of deploy overlap. Breaking-shape changes (resizing
existing fields, semantic shifts) need a new `SCHEMA_VERSION` and a
parallel `FIELDS_V<n>` table; freeze the old one verbatim so its
decoder stays correct, and `applyFromUrl` will auto-upgrade legacy
URLs to the new schema after the same 300 ms debounce as routine URL
writes.

**Console helpers.** `window.debug.decodeView('AQAA…')` decodes a blob
and `console.table`s the fields; `window.debug.encodeView()` returns
the blob for the current Stellata state. Useful when debugging a
shared URL that someone reports.
