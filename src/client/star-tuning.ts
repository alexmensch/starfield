import type { Stellata } from './stellata';
import { makeCollapsibleSection, makeSlider } from './debug-panel';

// Dev-only tuning section for star-disc rendering. Each slider drives one
// uniform on the shared star material. Defaults match the production
// values; pulling sliders gives an immediate visual sweep.
//
// See star.frag.glsl for what each uniform shapes — comments there are
// the source of truth. Slider ranges are conservative envelopes around
// values that produce sensible visuals; nothing crashes outside them, but
// extremes (e.g. lumBias < 0.3) start to look cartoony.
//
// No reverse sync: `initial` snapshots `getStarRenderParams()` once at
// build time. If something else writes the params (URL state, presets)
// while the panel is open, the slider thumb won't move — only the
// underlying uniform.

export function buildStarSection(stellata: Stellata): HTMLDivElement {
  const { section, body } = makeCollapsibleSection({
    title: 'Star disc',
    storageKey: 'star',
  });
  const v = stellata.getStarRenderParams();

  body.appendChild(makeSlider({
    label: 'visibleThreshold',
    min: 0.02,
    max: 0.40,
    step: 0.005,
    initial: v.visibleThreshold,
    format: (x) => x.toFixed(3),
    onChange: (x) => stellata.setStarRenderParams({ visibleThreshold: x }),
  }));

  body.appendChild(makeSlider({
    label: 'coreThreshold',
    min: 0.0,
    max: 1.0,
    step: 0.01,
    initial: v.coreThreshold,
    format: (x) => x.toFixed(2),
    onChange: (x) => stellata.setStarRenderParams({ coreThreshold: x }),
  }));

  body.appendChild(makeSlider({
    label: 'discardThreshold',
    min: 0.0,
    max: 0.20,
    step: 0.005,
    initial: v.discardThreshold,
    format: (x) => x.toFixed(3),
    onChange: (x) => stellata.setStarRenderParams({ discardThreshold: x }),
  }));

  body.appendChild(makeSlider({
    label: 'distN min (distant)',
    min: 1.0,
    max: 5.0,
    step: 0.1,
    initial: v.distNMin,
    format: (x) => x.toFixed(1),
    onChange: (x) => stellata.setStarRenderParams({ distNMin: x }),
  }));

  body.appendChild(makeSlider({
    label: 'distN max (close)',
    min: 2.0,
    max: 10.0,
    step: 0.1,
    initial: v.distNMax,
    format: (x) => x.toFixed(1),
    onChange: (x) => stellata.setStarRenderParams({ distNMax: x }),
  }));

  body.appendChild(makeSlider({
    label: 'lumBias dwarf',
    min: 0.5,
    max: 1.5,
    step: 0.05,
    initial: v.lumBiasMin,
    format: (x) => x.toFixed(2),
    onChange: (x) => stellata.setStarRenderParams({ lumBiasMin: x }),
  }));

  body.appendChild(makeSlider({
    label: 'lumBias hypergiant',
    min: 0.3,
    max: 1.0,
    step: 0.05,
    initial: v.lumBiasMax,
    format: (x) => x.toFixed(2),
    onChange: (x) => stellata.setStarRenderParams({ lumBiasMax: x }),
  }));

  // Soft-knee saturation extent (magnitudes). 0 = hard cap on appSize at
  // Δm = uSizeSpan (legacy); higher values stretch the curve so very
  // bright stars (Sol from inside its own neighborhood, focused-star
  // close approach) keep growing before saturating. See uSizeKnee in
  // star.vert.glsl for the exact formula.
  body.appendChild(makeSlider({
    label: 'sizeKnee (sat. extent, mag)',
    min: 0,
    max: 48,
    step: 1,
    initial: v.sizeKnee,
    format: (x) => x.toFixed(0),
    onChange: (x) => stellata.setStarRenderParams({ sizeKnee: x }),
  }));

  return section;
}
