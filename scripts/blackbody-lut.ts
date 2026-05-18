// Blackbody → sRGB lookup table generator. TypeScript port of
// research/star-spectral-rendition/blackbody_color.py. Builds a 256-entry
// RGB table over B-V ∈ [BV_MIN, BV_MAX] via Ballesteros 2012 (B-V → Teff)
// + Planck + CIE 1931 (Wyman 2013 multi-Gaussian fits) + sRGB D65 transform.
//
// Runs at build time via `npm run build:lut`. The output module
// src/client/shaders/blackbody-lut.ts is committed; the byte signature is
// pinned by vitest so any change here forces a deliberate update on both
// sides.
//
// See SCIENCE.md § "Star colour calibration" and
// research/star-spectral-rendition/RECOMMENDATION.md § Tier 1.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---- Physical constants ------------------------------------------------

const H = 6.62607015e-34;   // Planck (J·s)
const C = 2.99792458e8;     // speed of light (m/s)
const KB = 1.380649e-23;    // Boltzmann (J/K)

// Visible band, 5 nm samples — matches blackbody_color.py.
const LAMBDA_NM_MIN = 380.0;
const LAMBDA_NM_MAX = 780.0;
const LAMBDA_NM_STEP = 5.0;

// ---- LUT shape (must match the consumer in src/client/shaders/blackbody-lut.ts) ----

/** Number of RGB entries in the LUT. 256 keeps cache lines clean and is plenty
 *  of resolution for B-V over a 2.4-magnitude span. */
export const LUT_SIZE = 256;

/** Inclusive B-V range covered by the LUT. Span is chosen to cover the
 *  full AT-HYG catalog after dust reddening — extreme M giants reach
 *  B-V ≈ +2 (Mu Cep ≈ +2.4 when heavily reddened), hot O stars dip below
 *  -0.3 (Mintaka -0.17 intrinsic). */
export const BV_MIN = -0.4;
export const BV_MAX = 2.0;

// ---- Ballesteros 2012 -------------------------------------------------

/**
 * Ballesteros 2012 empirical relation: B-V → Teff in Kelvin.
 *
 *   Teff = 4600 × ( 1/(0.92(B-V) + 1.7) + 1/(0.92(B-V) + 0.62) )
 *
 * Calibrated across A–K with reasonable extrapolation into M/B; less
 * accurate at the extremes. See RECOMMENDATION.md § Tier 1 for accuracy
 * envelope.
 */
export function ballesterosTeff(bv: number): number {
  const a = 0.92 * bv + 1.7;
  const b = 0.92 * bv + 0.62;
  return 4600.0 * (1.0 / a + 1.0 / b);
}

// ---- Planck spectral radiance -----------------------------------------

function planckSpectralRadiance(lambdaNm: number, tempK: number): number {
  const lam = lambdaNm * 1e-9;
  const a = (2.0 * H * C * C) / Math.pow(lam, 5);
  const exponent = (H * C) / (lam * KB * tempK);
  return a / (Math.exp(exponent) - 1.0);
}

// ---- CIE 1931 2° colour-matching functions (Wyman 2013) ---------------

function wymanGaussian(
  lam: number,
  alpha: number,
  betaLo: number,
  betaHi: number,
): number {
  const sigma = lam < alpha ? betaLo : betaHi;
  const t = (lam - alpha) / sigma;
  return Math.exp(-0.5 * t * t);
}

function cmfX(lam: number): number {
  return (
    0.362 * wymanGaussian(lam, 442.0, 16.0, 26.7) +
    1.056 * wymanGaussian(lam, 599.8, 37.9, 31.0) -
    0.065 * wymanGaussian(lam, 501.1, 20.4, 26.2)
  );
}

function cmfY(lam: number): number {
  return (
    0.821 * wymanGaussian(lam, 568.8, 46.9, 40.5) +
    0.286 * wymanGaussian(lam, 530.9, 16.3, 31.1)
  );
}

function cmfZ(lam: number): number {
  return (
    1.217 * wymanGaussian(lam, 437.0, 11.8, 36.0) +
    0.681 * wymanGaussian(lam, 459.0, 26.0, 13.8)
  );
}

// ---- XYZ → linear sRGB (D65) ------------------------------------------

const XYZ_TO_LIN_SRGB: readonly (readonly number[])[] = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.2040, 1.0570],
];

function gammaEncode(x: number): number {
  const c = Math.min(1.0, Math.max(0.0, x));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
}

// ---- Public: blackbody → gamma-encoded sRGB triplet -------------------

/**
 * Map T (Kelvin) → gamma-encoded sRGB triplet in [0, 1]. Out-of-gamut
 * negative linear components are clipped to zero before peak normalisation
 * (preserves chroma; brightness is renderer-side).
 */
export function blackbodyToSrgb(tempK: number): [number, number, number] {
  // Trapezoidal integration over the visible band.
  let X = 0;
  let Y = 0;
  let Z = 0;
  let prevS = planckSpectralRadiance(LAMBDA_NM_MIN, tempK);
  let prevX = prevS * cmfX(LAMBDA_NM_MIN);
  let prevY = prevS * cmfY(LAMBDA_NM_MIN);
  let prevZ = prevS * cmfZ(LAMBDA_NM_MIN);
  for (let lam = LAMBDA_NM_MIN + LAMBDA_NM_STEP; lam <= LAMBDA_NM_MAX; lam += LAMBDA_NM_STEP) {
    const s = planckSpectralRadiance(lam, tempK);
    const xi = s * cmfX(lam);
    const yi = s * cmfY(lam);
    const zi = s * cmfZ(lam);
    X += 0.5 * (prevX + xi) * LAMBDA_NM_STEP;
    Y += 0.5 * (prevY + yi) * LAMBDA_NM_STEP;
    Z += 0.5 * (prevZ + zi) * LAMBDA_NM_STEP;
    prevX = xi;
    prevY = yi;
    prevZ = zi;
  }

  let r = XYZ_TO_LIN_SRGB[0][0] * X + XYZ_TO_LIN_SRGB[0][1] * Y + XYZ_TO_LIN_SRGB[0][2] * Z;
  let g = XYZ_TO_LIN_SRGB[1][0] * X + XYZ_TO_LIN_SRGB[1][1] * Y + XYZ_TO_LIN_SRGB[1][2] * Z;
  let b = XYZ_TO_LIN_SRGB[2][0] * X + XYZ_TO_LIN_SRGB[2][1] * Y + XYZ_TO_LIN_SRGB[2][2] * Z;

  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);
  const peak = Math.max(r, g, b);
  if (peak > 0) {
    r /= peak;
    g /= peak;
    b /= peak;
  }

  return [gammaEncode(r), gammaEncode(g), gammaEncode(b)];
}

// ---- LUT build --------------------------------------------------------

/** B-V value at LUT index i ∈ [0, LUT_SIZE-1]. Endpoints map to BV_MIN / BV_MAX. */
export function bvAtIndex(i: number): number {
  return BV_MIN + (i / (LUT_SIZE - 1)) * (BV_MAX - BV_MIN);
}

/**
 * Build the 256-entry RGB LUT as a flat Uint8Array of 768 bytes (R, G, B
 * × 256). Each row's Teff = Ballesteros(bvAtIndex(i)), with Planck → CIE
 * 1931 → linear sRGB → peak-normalise → gamma-encode → uint8 quantise.
 */
export function buildLut(): Uint8Array {
  const out = new Uint8Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const bv = bvAtIndex(i);
    const teff = ballesterosTeff(bv);
    const [r, g, b] = blackbodyToSrgb(teff);
    out[i * 3 + 0] = Math.round(r * 255);
    out[i * 3 + 1] = Math.round(g * 255);
    out[i * 3 + 2] = Math.round(b * 255);
  }
  return out;
}

/**
 * Sample the LUT at a (possibly out-of-range) B-V value, linearly
 * interpolating between adjacent entries. Mirrors the GPU's linear
 * filtering on the LUT sampler texture — pure helper so the shader's
 * sampling path can be pinned by vitest.
 */
export function sampleLut(
  lut: Uint8Array,
  bv: number,
): [number, number, number] {
  const t = ((bv - BV_MIN) / (BV_MAX - BV_MIN)) * (LUT_SIZE - 1);
  const tc = Math.min(LUT_SIZE - 1, Math.max(0, t));
  const i0 = Math.floor(tc);
  const i1 = Math.min(LUT_SIZE - 1, i0 + 1);
  const f = tc - i0;
  const r = lut[i0 * 3 + 0] * (1 - f) + lut[i1 * 3 + 0] * f;
  const g = lut[i0 * 3 + 1] * (1 - f) + lut[i1 * 3 + 1] * f;
  const b = lut[i0 * 3 + 2] * (1 - f) + lut[i1 * 3 + 2] * f;
  return [r, g, b];
}

// ---- CLI entry: write src/client/shaders/blackbody-lut.ts ------------

function formatBytesAsLines(bytes: Uint8Array, perLine = 24): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += perLine) {
    const chunk = Array.from(bytes.slice(i, i + perLine))
      .map((b) => b.toString().padStart(3, ' '))
      .join(', ');
    lines.push('  ' + chunk + ',');
  }
  // Trim the trailing comma on the last line.
  const last = lines.length - 1;
  lines[last] = lines[last].replace(/,$/, '');
  return lines.join('\n');
}

function renderModule(bytes: Uint8Array): string {
  return `// AUTO-GENERATED by scripts/blackbody-lut.ts — do not edit by hand.
// Regenerate via: npm run build:lut
//
// 256-entry blackbody → sRGB lookup table indexed by B-V over [${BV_MIN}, ${BV_MAX}].
// Each entry's Teff is derived via Ballesteros 2012; chromaticity is the
// Planck spectrum at that Teff through CIE 1931 2° (Wyman 2013 multi-
// Gaussian fits) and the sRGB D65 transform, peak-normalised then gamma-
// encoded. See scripts/blackbody-lut.ts and SCIENCE.md § "Star colour
// calibration".

export const LUT_SIZE = ${LUT_SIZE};
export const BV_MIN = ${BV_MIN};
export const BV_MAX = ${BV_MAX};

/** Flat RGB bytes — R, G, B repeated ${LUT_SIZE} times. ${bytes.length} bytes. */
export const LUT_BYTES: Uint8Array = new Uint8Array([
${formatBytesAsLines(bytes)}
]);
`;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, '..', 'src/client/shaders/blackbody-lut.ts');
  const bytes = buildLut();
  await writeFile(out, renderModule(bytes));
  console.log(`Wrote ${out} (${bytes.length} LUT bytes)`);
}

const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  void main();
}
