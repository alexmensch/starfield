// Plain-English UTC timestamp for the current `t` driving planet
// positions. Visible iff focused star has a planet system, chart mode
// is off, and no warp is in flight. The warp gate exists because
// focused-planet-system stays pinned to the source for the duration
// of a warp — without it the readout would tick during a warp where
// the time has no logical referent.

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
