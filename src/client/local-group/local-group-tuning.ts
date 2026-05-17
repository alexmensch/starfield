import { makeCollapsibleSection, makeSlider } from '../debug/debug-panel';
import {
  DEFAULT_TOP_N,
  DEFAULT_MIN_PIXEL_SIZE_PX,
  DEFAULT_MW_INSIDE_DISC_PC,
  getTopN, setTopN,
  getMinPixelSize, setMinPixelSize,
  getMwInsideDiscPc, setMwInsideDiscPc,
} from './local-group';

// Dev-only tuning section for the Local Group wireframe layer
// (stellata-38m). Three knobs drive the apparent-size ranking that
// governs both the MW label and every LG dwarf label:
//
//   • top N        — max labels visible at once (default 5).
//   • minPxSize    — apparent-size floor; sub-pixel objects can't earn
//                    a label even if they'd otherwise rank.
//   • mwInsideDisc — camera-to-GC distance below which every label is
//                    suppressed. This is the *only* per-object policy
//                    exception (Sol sits inside the MW disc; labelling
//                    extragalactic objects from inside is clutter).
//
// Section title "Deep field" is intentionally broader than "Local
// Group" so future LG-layer knobs (ring opacity, sample density, the
// eventual 1.5-2 Mpc envelope) can share the chrome without rename.

const TOP_N_MIN = 0;
const TOP_N_MAX = 20;
const TOP_N_STEP = 1;

const MIN_PX_MIN = 0;
const MIN_PX_MAX = 50;
const MIN_PX_STEP = 0.5;

// 0 disables the inside-MW guard entirely (label-from-anywhere mode);
// 20 kpc is comfortably outside the disc on any line of sight.
const MW_INSIDE_MIN = 0;
const MW_INSIDE_MAX = 20_000;
const MW_INSIDE_STEP = 250;

export function buildDeepFieldSection(): HTMLDivElement {
  const { section, body } = makeCollapsibleSection({
    title: 'Deep field',
    storageKey: 'deep-field',
  });

  body.appendChild(makeSlider({
    label: 'top N labels',
    min: TOP_N_MIN,
    max: TOP_N_MAX,
    step: TOP_N_STEP,
    initial: getTopN(),
    format: (x) => {
      const tag = x === DEFAULT_TOP_N ? ' (default)' : '';
      return `${x.toFixed(0)}${tag}`;
    },
    onChange: (x) => setTopN(x),
  }));

  body.appendChild(makeSlider({
    label: 'min apparent size (px)',
    min: MIN_PX_MIN,
    max: MIN_PX_MAX,
    step: MIN_PX_STEP,
    initial: getMinPixelSize(),
    format: (x) => {
      const tag = x === DEFAULT_MIN_PIXEL_SIZE_PX ? ' (default)' : '';
      return `${x.toFixed(1)} px${tag}`;
    },
    onChange: (x) => setMinPixelSize(x),
  }));

  body.appendChild(makeSlider({
    label: 'inside-MW guard (pc)',
    min: MW_INSIDE_MIN,
    max: MW_INSIDE_MAX,
    step: MW_INSIDE_STEP,
    initial: getMwInsideDiscPc(),
    format: (x) => {
      const tag = x === DEFAULT_MW_INSIDE_DISC_PC ? ' (default)' : '';
      return `${(x / 1000).toFixed(1)} kpc${tag}`;
    },
    onChange: (x) => setMwInsideDiscPc(x),
  }));

  return section;
}
