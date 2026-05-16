// Discreet plain-English UTC timestamp showing the current `t`
// (Unix-seconds) the planets are positioned for. Sits under the star
// count in the bottom-right `.meta` block.
//
// Visible only while the focused star has a planet system (3re.6
// contract — Sol in v1), chart mode is off, and a warp is not in
// flight; matches the rest of the solar-system layer's visibility
// gate. The warp gate exists because focused-planet-system stays
// pinned to the source for the duration of a warp (camera-frame
// invariant), so without this filter the readout would tick on
// during a Sol→other-star warp where the time has no logical
// referent (see PR #36 review notes).
//
// v1 always shows wall-clock now and ticks once per second. The time-
// scrubber epic (stellata-nmu) will swap the per-second tick for
// scrubber-driven updates without changing the format.

import type { Stellata } from '../stellata';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** Format a Unix-seconds value as `D MMM YYYY, HH:MM:SS UTC` (e.g.
 *  `7 May 2026, 18:23:45 UTC`). Locale-independent so the output is
 *  identical across browsers — month names use the en-US short form
 *  the user picked over numeric date order to avoid DD/MM vs MM/DD
 *  ambiguity. The `UTC` suffix removes any timezone confusion. */
export function formatTimeReadout(t: number): string {
  const d = new Date(t * 1000);
  const day = d.getUTCDate();
  const mon = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${day} ${mon} ${year}, ${hh}:${mm}:${ss} UTC`;
}

export interface TimeReadoutDeps {
  el: HTMLElement;
  stellata: Stellata;
}

/** Mount the readout into `el`. Subscribes to planet-system focus
 *  changes and filter changes (for chart mode) to gate visibility;
 *  ticks once per second to refresh the displayed value. Returns a
 *  teardown function for tests / HMR. */
export function createTimeReadout({ el, stellata }: TimeReadoutDeps): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    el.textContent = formatTimeReadout(stellata.getT());
  };

  const updateVisibility = () => {
    const visible = stellata.getFocusedPlanetSystem() !== null
      && !stellata.getFilter().chart
      && !stellata.getWarpActive();
    if (el.hidden === !visible) return;
    el.hidden = !visible;
    if (visible) {
      tick();
      if (timer === undefined) {
        timer = setInterval(tick, 1000);
      }
    } else if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const offPlanetSystem = stellata.on('planetSystem', updateVisibility);
  const offFilter = stellata.on('filter', updateVisibility);
  const offWarp = stellata.on('warp', updateVisibility);
  updateVisibility();

  return () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    offPlanetSystem();
    offFilter();
    offWarp();
  };
}
