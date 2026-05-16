import { makeCollapsibleSection, makeSlider } from './debug-panel';
import {
  DEFAULT_SIZE_RELATIVE_LABEL_FACTOR,
  getSizeRelativeLabelFactor,
  setSizeRelativeLabelFactor,
} from './local-group';

// Dev-only tuning section for the Local Group wireframe layer
// (stellata-38m). Currently exposes a single live-tunable knob — the
// size-relative-distance fallback factor that gates ultra-faint dwarf
// labels — but the section is the natural home for future LG visual
// knobs (ring opacity, sample density, per-kind colour palettes).
//
// Section title "Deep field" is intentionally broader than "Local
// Group" so the same chrome can host the eventual 1.5-2 Mpc envelope
// (stellata-1ui) and any chart-mode glyph experiments without a
// rename.
//
// No reverse sync — see `SliderOpts.initial` in debug-panel.ts.

// Range chosen so the user can both tighten the labels (1× = labels
// only fire at the surface of the object) and 20× the default before
// labels start to read as "always-on context".
const FACTOR_MIN = 1;
const FACTOR_MAX = 200;
const FACTOR_STEP = 1;

export function buildDeepFieldSection(): HTMLDivElement {
  const { section, body } = makeCollapsibleSection({
    title: 'Deep field',
    storageKey: 'deep-field',
  });

  body.appendChild(makeSlider({
    label: 'ultra-faint label factor',
    min: FACTOR_MIN,
    max: FACTOR_MAX,
    step: FACTOR_STEP,
    initial: getSizeRelativeLabelFactor(),
    format: (x) => `${x.toFixed(0)}× (default ${DEFAULT_SIZE_RELATIVE_LABEL_FACTOR})`,
    onChange: (x) => setSizeRelativeLabelFactor(x),
  }));

  return section;
}
