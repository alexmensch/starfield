# Changelog

All notable changes to Stellata are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-05-01

### Fixed

- Drop the redundant `cam=[0,0,0]` block from `?v=` URLs in observe mode
  (the camera is parked at the focal star's local origin, so the 12 zero
  bytes — ~16 base64url chars of `A`s — were noise). Receiver re-snaps
  cam to origin before `controls.update()` so the camera quaternion is
  computed correctly from the observe-mode look direction. No wire-
  format change; legacy URLs still decode.

## [1.0.0] — 2026-05-01

First tagged release.

### Catalogue and physics

- ~313,000 stars from the AT-HYG v3.3 classic-IDs subset, cross-matched
  with GCVS 5.1 for variable-star periods and amplitudes.
- Hipparcos CCDM cross-match for visual-double flagging (~13k primaries
  including Sirius, Mizar, Castor, α Cen, Albireo).
- Per-star physical radius from Stefan–Boltzmann + spectral parsing.
- Per-star line-of-sight dust extinction and reddening from the
  Edenhofer 2023 voxel grid (resampled to a 512³ ICRS cube).
- Volumetric Milky Way disc + bulge with analytical dust extinction
  along long sightlines; magnitude-consistent with the per-star pipeline.

### Rendering

- Three-pass star pipeline: depth-only core mask, opaque disc for
  close-range stars (physical-radius-scaled), and additive point glow
  for distant stars, sharing a unified super-Gaussian intensity profile.
- Variable-star pulsation in both disc radius and point glow.
- Magnitude-preset-driven star-size calibration tied to a Gaussian-PSF
  eye model (naked-eye / binoculars / all).
- Floating-origin world for stable rendering at galactic distances.

### Camera and interaction

- Navigate mode (TrackballControls orbit / zoom / pan) and Observe mode
  (direct-manipulation look-around with momentum, configurable FOV).
- Two-stage click model: focus → vector → warp, animated in three
  phases with a skip pill.
- Sky Atlas–style chart mode (observe-only) with paper aesthetic, flat
  hard-edged discs, per-frame label engine for proper names, Bayer
  letters, and constellation Latin names.
- Pinned points-of-interest in observe mode (single-click pins, arrows
  + labels in HUD), double-click slerp to centre any direction.
- Keyboard shortcuts (G/O/M/W/C/R/H/S/+/−/=/?/Esc) with help modal.

### Overlays

- Constellation stick-figure overlay (Stellarium modern sky culture)
  with typeahead picker and camera auto-aim.
- Galactic disc-outline reference layer that fades in as the camera
  pulls back from Sol.
- Toggleable galactic coordinate sphere (b/l grid).
- Head-up display ring with Sol / Galactic-Centre locator arrows that
  swivel as the user looks around.
- SVG distance-vector overlay with chevron density, near-plane clipping,
  and a hoverable warp affordance.

### Search and routing

- Fuzzy search over proper names and classical designations
  (Bayer / Flamsteed / HIP / HD / HR / Gliese).
- Two-stage search (focus / destination) with constellation auto-aim.
- Compact opaque URL state — single `?v=` blob preserves filter,
  camera, focus, vector, mode, chart, units, POIs.

### Notes

- Molecular-cloud rendering pipeline is committed but disabled in this
  release. The Zucker 2020 + 2021 ellipsoid layer needs further visual
  work; the data, build script, and shaders remain in the repository
  for the future re-enable.
- Chart-mode Milky Way isobar contour is similarly disabled — the
  volumetric disc is hidden in chart mode and will return once the
  contour treatment is refined.
