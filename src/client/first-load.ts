// Default first-load view (stellata-vjm). When the user lands on the
// bare URL with no `?v=` view fragment, park the camera 5 AU from Sol
// with Orion framed prominently in the background, the HUD on, and
// Orion highlighted via the constellation-highlight slot. The default
// constellation overlay is already on, so Orion's stick figure shows
// up without an explicit toggle.
//
// The camera direction was hand-tuned via the share URL
// `AgUiADjdurapYsa3XxiStUfoO79_Oea8sbUtPzsC`. The magnitude in that
// share landed at ~5.016 AU; we renormalise to exactly 5 AU here.
//
// Per the bead's URL contract, this module deliberately doesn't write
// to the URL — `startUrlSync` seeds its frame-tracking baseline from
// the camera state at registration time, so the user-visible URL
// stays empty until first interaction.

import { applyDecodedView, type DecodedView, type IdMaps } from './url-state';
import { AU_PC } from './ephemeris';
import type { Stellata } from './stellata';

// Sol→Orion-centroid camera position from the hand-tuned share URL,
// renormalised to exactly 5 AU. Sol is at the local origin (focus =
// Sol = default), so this is a pure object-local cam vector.
const RAW_CAM: [number, number, number] = [
  -5.56898521608673e-6,
  -2.3649381546420045e-5,
  -1.088494059331424e-6,
];

const PARK_DIST_PC = 5 * AU_PC;

function rescale(v: [number, number, number], r: number): [number, number, number] {
  const k = r / Math.hypot(v[0], v[1], v[2]);
  return [v[0] * k, v[1] * k, v[2] * k];
}

// Orion = index 59 in the Stellarium modern skyculture's alphabetical
// IAU-code ordering (verified against data/stellarium-modern-skyculture.json).
const ORION_CON_INDEX = 59;

export const FIRST_LOAD_VIEW: DecodedView = {
  cam: rescale(RAW_CAM, PARK_DIST_PC),
  up: [-0.734013020992279, -0.02810358814895153, 0.6785536408424377],
  con: ORION_CON_INDEX,
  showHud: true,
};

export function applyFirstLoadView(stellata: Stellata, idMaps: IdMaps): void {
  applyDecodedView(stellata, FIRST_LOAD_VIEW, idMaps);
}
