import type { Starfield } from './starfield';
import { makeSection, makeSlider } from './debug-panel';

// Dev-only tuning section for the star pipeline. Sliders for camera FOV
// (the angular extent the camera covers vertically) and the star size
// exaggeration constant K (how much we scale the eye's PSF up to keep
// stars visible in pixel space — see starfield.ts for the derivation).
// Both rerun the active preset's pixel-size computation so non-overridden
// sliders update live.

export function buildStarfieldSection(starfield: Starfield): HTMLDivElement {
  const section = makeSection('Starfield');

  section.appendChild(makeSlider({
    label: 'camera FOV',
    min: 10,
    max: 120,
    step: 1,
    initial: starfield.getCameraFov(),
    format: (v) => `${v.toFixed(0)}°`,
    onChange: (v) => starfield.setCameraFov(v),
  }));

  section.appendChild(makeSlider({
    label: 'star exaggeration K',
    min: 1,
    max: 30,
    step: 0.5,
    initial: starfield.getStarExaggerationK(),
    format: (v) => v.toFixed(1),
    onChange: (v) => starfield.setStarExaggerationK(v),
  }));

  return section;
}
