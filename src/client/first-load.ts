// Default first-load view (stellata-vjm). When the user lands on the
// bare URL with no `?v=` view fragment, park the camera 5 AU from Sol
// aimed at the galactic centre with the HUD on. The galactic-centre
// framing puts Sgr / Sco low on the horizon and the brightest part
// of the Milky Way bulge filling the background — a clean "you are
// here" anchor without the visual noise of a highlighted constellation
// asterism layered over it.
//
// The camera direction was hand-tuned via the share URL
// `AgUgABxe0bUcwKA3M1hyN3JRp77d8BW_muE9PwI`. The magnitude in that
// share landed at ~4.96 AU; we renormalise to exactly 5 AU here.
//
// Per the bead's URL contract, this module deliberately doesn't write
// to the URL — `startUrlSync` seeds its frame-tracking baseline from
// the camera state at registration time, so the user-visible URL
// stays empty until first interaction.

import { applyDecodedView, type DecodedView, type IdMaps } from './url-state';
import { AU_PC } from './ephemeris';
import type { Stellata } from './stellata';

// Sol→galactic-centre camera position from the hand-tuned share URL,
// renormalised to exactly 5 AU. Sol is at the local origin (focus =
// Sol = default), so this is a pure object-local cam vector.
const RAW_CAM: [number, number, number] = [
  -1.5599102880514693e-6,
  1.9162944226991385e-5,
  1.4444859516515862e-5,
];

const PARK_DIST_PC = 5 * AU_PC;

function rescale(v: [number, number, number], r: number): [number, number, number] {
  const k = r / Math.hypot(v[0], v[1], v[2]);
  return [v[0] * k, v[1] * k, v[2] * k];
}

export const FIRST_LOAD_VIEW: DecodedView = {
  cam: rescale(RAW_CAM, PARK_DIST_PC),
  up: [-0.32679325342178345, -0.5857065320014954, 0.7417236566543579],
  showHud: true,
};

export function applyFirstLoadView(stellata: Stellata, idMaps: IdMaps): void {
  applyDecodedView(stellata, FIRST_LOAD_VIEW, idMaps);
}
