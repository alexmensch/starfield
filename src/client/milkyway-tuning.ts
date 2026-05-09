import type { MilkyWay } from './milkyway';
import { makeCollapsibleSection, makeColor, makeSlider } from './debug-panel';

// Dev-only tuning section for the volumetric Milky Way layer. Builds a
// labelled section with sliders + colour pickers wired to the layer's
// setters. Designed to be appended into the shared debug panel root.
//
// Brightness uses a log-scale slider because the useful range spans
// ~7 orders of magnitude (1e-7 to ~10). Reddening uses linear sliders
// since the CCM default has channels above 1.0 (1.32 in blue), which
// rules out an HTML colour picker. Disc/bulge palette colours use
// `<input type="color">` since their channels are bounded to [0,1].

const BRIGHTNESS_LOG_MIN = -7; // 10^-7
const BRIGHTNESS_LOG_MAX = 1;  // 10^1
const BRIGHTNESS_LOG_RANGE = BRIGHTNESS_LOG_MAX - BRIGHTNESS_LOG_MIN;

function brightnessToSlider(v: number): number {
  if (v <= 0) return 0;
  return (Math.log10(v) - BRIGHTNESS_LOG_MIN) / BRIGHTNESS_LOG_RANGE;
}
function sliderToBrightness(s: number): number {
  return Math.pow(10, BRIGHTNESS_LOG_MIN + s * BRIGHTNESS_LOG_RANGE);
}

export function buildMilkywaySection(layer: MilkyWay): HTMLDivElement {
  const { section, body } = makeCollapsibleSection({
    title: 'Milky Way',
    storageKey: 'milkyway',
  });

  const v = layer.getValues();

  // Brightness — log-scale slider over [1e-7, 1e1]
  body.appendChild(makeSlider({
    label: 'brightness',
    min: 0,
    max: 1,
    step: 0.001,
    initial: brightnessToSlider(v.brightness),
    format: (s) => sliderToBrightness(s).toExponential(2),
    onChange: (s) => layer.setBrightness(sliderToBrightness(s)),
  }));

  body.appendChild(makeSlider({
    label: 'glowMagOffset',
    min: 5,
    max: 25,
    step: 0.1,
    initial: v.glowMagOffset,
    format: (x) => x.toFixed(1),
    onChange: (x) => layer.setGlowMagOffset(x),
  }));

  body.appendChild(makeSlider({
    label: 'discDensity',
    min: 0,
    max: 10,
    step: 0.05,
    initial: v.discDensity,
    format: (x) => x.toFixed(2),
    onChange: (x) => layer.setDiscDensity(x),
  }));

  body.appendChild(makeSlider({
    label: 'bulgeDensity',
    min: 0,
    max: 30,
    step: 0.1,
    initial: v.bulgeDensity,
    format: (x) => x.toFixed(2),
    onChange: (x) => layer.setBulgeDensity(x),
  }));

  body.appendChild(makeSlider({
    label: 'extinctionStrength',
    min: 0,
    max: 3,
    step: 0.05,
    initial: v.extinctionStrength,
    format: (x) => x.toFixed(2),
    onChange: (x) => layer.setExtinctionStrength(x),
  }));

  body.appendChild(makeColor({
    label: 'discColor',
    initial: v.discColor,
    onChange: ({ r, g, b }) => layer.setDiscColor(r, g, b),
  }));

  body.appendChild(makeColor({
    label: 'bulgeColor',
    initial: v.bulgeColor,
    onChange: ({ r, g, b }) => layer.setBulgeColor(r, g, b),
  }));

  // Reddening RGB — linear sliders since channels can exceed 1.0
  // (CCM default has 1.32 in blue). Updated together via a small
  // closure so any slider write applies all three current values.
  const reddening = { ...v.reddening };
  const updateReddening = () => layer.setReddeningRGB(reddening.r, reddening.g, reddening.b);
  for (const channel of ['r', 'g', 'b'] as const) {
    body.appendChild(makeSlider({
      label: 'reddening.' + channel,
      min: 0,
      max: 2,
      step: 0.01,
      initial: reddening[channel],
      format: (x) => x.toFixed(2),
      onChange: (x) => {
        reddening[channel] = x;
        updateReddening();
      },
    }));
  }

  return section;
}
