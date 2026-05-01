import type { Stellata } from './stellata';
import { makeSection, makeSlider } from './debug-panel';

// Dev-only tuning section for star-disc rendering. Each slider drives one
// uniform on the shared star material. Defaults match the production
// values; pulling sliders gives an immediate visual sweep.
//
// See star.frag.glsl for what each uniform shapes — comments there are
// the source of truth. Slider ranges are conservative envelopes around
// values that produce sensible visuals; nothing crashes outside them, but
// extremes (e.g. lumBias < 0.3) start to look cartoony.

export function buildStarSection(stellata: Stellata): HTMLDivElement {
  const section = makeSection('Star disc');
  const v = stellata.getStarRenderParams();

  section.appendChild(makeSlider({
    label: 'visibleThreshold',
    min: 0.02,
    max: 0.40,
    step: 0.005,
    initial: v.visibleThreshold,
    format: (x) => x.toFixed(3),
    onChange: (x) => stellata.setStarRenderParams({ visibleThreshold: x }),
  }));

  section.appendChild(makeSlider({
    label: 'coreThreshold',
    min: 0.0,
    max: 1.0,
    step: 0.01,
    initial: v.coreThreshold,
    format: (x) => x.toFixed(2),
    onChange: (x) => stellata.setStarRenderParams({ coreThreshold: x }),
  }));

  section.appendChild(makeSlider({
    label: 'discardThreshold',
    min: 0.0,
    max: 0.20,
    step: 0.005,
    initial: v.discardThreshold,
    format: (x) => x.toFixed(3),
    onChange: (x) => stellata.setStarRenderParams({ discardThreshold: x }),
  }));

  section.appendChild(makeSlider({
    label: 'distN min (distant)',
    min: 1.0,
    max: 5.0,
    step: 0.1,
    initial: v.distNMin,
    format: (x) => x.toFixed(1),
    onChange: (x) => stellata.setStarRenderParams({ distNMin: x }),
  }));

  section.appendChild(makeSlider({
    label: 'distN max (close)',
    min: 2.0,
    max: 10.0,
    step: 0.1,
    initial: v.distNMax,
    format: (x) => x.toFixed(1),
    onChange: (x) => stellata.setStarRenderParams({ distNMax: x }),
  }));

  section.appendChild(makeSlider({
    label: 'lumBias dwarf',
    min: 0.5,
    max: 1.5,
    step: 0.05,
    initial: v.lumBiasMin,
    format: (x) => x.toFixed(2),
    onChange: (x) => stellata.setStarRenderParams({ lumBiasMin: x }),
  }));

  section.appendChild(makeSlider({
    label: 'lumBias hypergiant',
    min: 0.3,
    max: 1.0,
    step: 0.05,
    initial: v.lumBiasMax,
    format: (x) => x.toFixed(2),
    onChange: (x) => stellata.setStarRenderParams({ lumBiasMax: x }),
  }));

  return section;
}
