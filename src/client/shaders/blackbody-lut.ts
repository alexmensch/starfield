// Hand-written runtime wrapper around the generated LUT data
// (`blackbody-lut-data.ts`). Re-exports the bytes + constants and owns
// the three.js DataTexture construction so the consumer in stellata.ts
// (and any future caller) only needs one import.
//
// The data sibling is regenerated wholesale by `npm run build:lut`;
// keep all hand-written code in THIS file so the generator's overwrite
// never clobbers it.

import * as THREE from 'three';
import { BV_MAX, BV_MIN, LUT_BYTES, LUT_SIZE } from './blackbody-lut-data';

export { BV_MAX, BV_MIN, LUT_BYTES, LUT_SIZE };

/** Build a 256×1 RGBA DataTexture for the star vertex shader's
 *  `uColorLut` sampler. RGBA padding because three.js dropped RGBFormat
 *  — the `.a` byte is unused. `NoColorSpace` keeps the GPU from
 *  re-applying gamma to bytes that are already sRGB-encoded. */
export function makeColorLutTexture(): THREE.DataTexture {
  const rgba = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    rgba[i * 4 + 0] = LUT_BYTES[i * 3 + 0];
    rgba[i * 4 + 1] = LUT_BYTES[i * 3 + 1];
    rgba[i * 4 + 2] = LUT_BYTES[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(rgba, LUT_SIZE, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
