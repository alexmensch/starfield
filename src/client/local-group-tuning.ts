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

// Range chosen so the user can sweep from "labels fire only at the
// surface of the object" (1×) up to "labels fire from anywhere in the
// 250 kpc envelope" (~2000×). The closest unlabelled ultra-faint
// (Draco II at 21.6 kpc, max-axis 19 pc) needs factor ≈ 1140 for its
// label to fire when viewed from Sol; the typical ~100 pc dwarf needs
// ≈ 200-500 at typical satellite distances. Default 10× keeps labels
// suppressed until the camera is genuinely close to the object —
// useful for "discover as you fly past" UX, not for "always on" wide-
// field context labelling.
const FACTOR_MIN = 1;
const FACTOR_MAX = 2000;
const FACTOR_STEP = 1;

// Reference dwarf size for the slider readout. Numbers vary widely:
// Draco II has max-axis 19 pc, Antlia II 105 pc, Ursa Major II 139 pc.
// 100 pc is the rough middle and makes the slider's value easy to map
// to "threshold in kpc".
const REFERENCE_AXIS_PC = 100;

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
    // Readout shows both the raw factor and what it means in kpc for a
    // reference-sized 100 pc dwarf, so the slider's value isn't an
    // abstract number — e.g. "10× → 1 kpc / 100×: 10 kpc / 1000×:
    // 100 kpc". (Default factor labelled to anchor expectations.)
    format: (x) => {
      const kpc = (x * REFERENCE_AXIS_PC) / 1000;
      const defaultTag = x === DEFAULT_SIZE_RELATIVE_LABEL_FACTOR ? ' (default)' : '';
      return `${x.toFixed(0)}× — 100 pc dwarf reveals within ${kpc.toFixed(1)} kpc${defaultTag}`;
    },
    onChange: (x) => setSizeRelativeLabelFactor(x),
  }));

  return section;
}
