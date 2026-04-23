import { createReadStream, statSync, existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const SRC_CSV = resolve(ROOT, 'data/athyg_33_classic_ids.csv');
const SRC_STELLARIUM = resolve(ROOT, 'data/stellarium-modern-skyculture.json');
const OUT_BIN = resolve(ROOT, 'public/catalog.bin');
const OUT_CON = resolve(ROOT, 'public/constellations.json');
const OUT_SEARCH = resolve(ROOT, 'public/search-index.json');

const MAX_DIST_PC = 50_000;
const DEFAULT_CI = 0.65;
// Pairs within this 3D distance are flagged as a physical binary/multiple system.
// 0.005 pc ≈ 1030 AU — wide-binary territory. Gaia resolves most bound pairs
// wider than ~0.5 arcsec so this captures the visually-renderable cases.
const BINARY_MAX_SEP_PC = 0.005;

const HEADER_SIZE = 32;
const RECORD_SIZE = 40;
const BINARY_VERSION = 2;

const CONSTELLATIONS: { code: string; name: string }[] = [
  { code: 'And', name: 'Andromeda' },
  { code: 'Ant', name: 'Antlia' },
  { code: 'Aps', name: 'Apus' },
  { code: 'Aql', name: 'Aquila' },
  { code: 'Aqr', name: 'Aquarius' },
  { code: 'Ara', name: 'Ara' },
  { code: 'Ari', name: 'Aries' },
  { code: 'Aur', name: 'Auriga' },
  { code: 'Boo', name: 'Boötes' },
  { code: 'Cae', name: 'Caelum' },
  { code: 'Cam', name: 'Camelopardalis' },
  { code: 'Cap', name: 'Capricornus' },
  { code: 'Car', name: 'Carina' },
  { code: 'Cas', name: 'Cassiopeia' },
  { code: 'Cen', name: 'Centaurus' },
  { code: 'Cep', name: 'Cepheus' },
  { code: 'Cet', name: 'Cetus' },
  { code: 'Cha', name: 'Chamaeleon' },
  { code: 'Cir', name: 'Circinus' },
  { code: 'CMa', name: 'Canis Major' },
  { code: 'CMi', name: 'Canis Minor' },
  { code: 'Cnc', name: 'Cancer' },
  { code: 'Col', name: 'Columba' },
  { code: 'Com', name: 'Coma Berenices' },
  { code: 'CrA', name: 'Corona Australis' },
  { code: 'CrB', name: 'Corona Borealis' },
  { code: 'Crt', name: 'Crater' },
  { code: 'Cru', name: 'Crux' },
  { code: 'Crv', name: 'Corvus' },
  { code: 'CVn', name: 'Canes Venatici' },
  { code: 'Cyg', name: 'Cygnus' },
  { code: 'Del', name: 'Delphinus' },
  { code: 'Dor', name: 'Dorado' },
  { code: 'Dra', name: 'Draco' },
  { code: 'Equ', name: 'Equuleus' },
  { code: 'Eri', name: 'Eridanus' },
  { code: 'For', name: 'Fornax' },
  { code: 'Gem', name: 'Gemini' },
  { code: 'Gru', name: 'Grus' },
  { code: 'Her', name: 'Hercules' },
  { code: 'Hor', name: 'Horologium' },
  { code: 'Hya', name: 'Hydra' },
  { code: 'Hyi', name: 'Hydrus' },
  { code: 'Ind', name: 'Indus' },
  { code: 'Lac', name: 'Lacerta' },
  { code: 'Leo', name: 'Leo' },
  { code: 'Lep', name: 'Lepus' },
  { code: 'Lib', name: 'Libra' },
  { code: 'LMi', name: 'Leo Minor' },
  { code: 'Lup', name: 'Lupus' },
  { code: 'Lyn', name: 'Lynx' },
  { code: 'Lyr', name: 'Lyra' },
  { code: 'Men', name: 'Mensa' },
  { code: 'Mic', name: 'Microscopium' },
  { code: 'Mon', name: 'Monoceros' },
  { code: 'Mus', name: 'Musca' },
  { code: 'Nor', name: 'Norma' },
  { code: 'Oct', name: 'Octans' },
  { code: 'Oph', name: 'Ophiuchus' },
  { code: 'Ori', name: 'Orion' },
  { code: 'Pav', name: 'Pavo' },
  { code: 'Peg', name: 'Pegasus' },
  { code: 'Per', name: 'Perseus' },
  { code: 'Phe', name: 'Phoenix' },
  { code: 'Pic', name: 'Pictor' },
  { code: 'PsA', name: 'Piscis Austrinus' },
  { code: 'Psc', name: 'Pisces' },
  { code: 'Pup', name: 'Puppis' },
  { code: 'Pyx', name: 'Pyxis' },
  { code: 'Ret', name: 'Reticulum' },
  { code: 'Scl', name: 'Sculptor' },
  { code: 'Sco', name: 'Scorpius' },
  { code: 'Sct', name: 'Scutum' },
  { code: 'Ser', name: 'Serpens' },
  { code: 'Sex', name: 'Sextans' },
  { code: 'Sge', name: 'Sagitta' },
  { code: 'Sgr', name: 'Sagittarius' },
  { code: 'Tau', name: 'Taurus' },
  { code: 'Tel', name: 'Telescopium' },
  { code: 'TrA', name: 'Triangulum Australe' },
  { code: 'Tri', name: 'Triangulum' },
  { code: 'Tuc', name: 'Tucana' },
  { code: 'UMa', name: 'Ursa Major' },
  { code: 'UMi', name: 'Ursa Minor' },
  { code: 'Vel', name: 'Vela' },
  { code: 'Vir', name: 'Virgo' },
  { code: 'Vol', name: 'Volans' },
  { code: 'Vul', name: 'Vulpecula' },
];

if (CONSTELLATIONS.length !== 88) {
  throw new Error(`Expected 88 constellations, got ${CONSTELLATIONS.length}`);
}

const CON_INDEX: Map<string, number> = new Map(
  CONSTELLATIONS.map((c, i) => [c.code.toLowerCase(), i])
);

// HIPs that Stellarium's modern sky culture references but the underlying
// catalog does not carry 3D positions for. Every entry must include a
// human-readable reason so a future audit can decide whether upstream data
// has been fixed. `buildFigureLines` silently skips these; any other
// unmatched HIP is a hard build error.
const KNOWN_MISSING_HIPS: Map<number, string> = new Map([
  [5165, 'α Phoenicis (Ankaa) — HYG lacks parallax for this multiple-star system; upstream data gap'],
  [89341, 'μ Sagittarii (Polis) — HYG lacks parallax; upstream data gap'],
]);

function spectClassIndex(firstChar: string): number {
  switch (firstChar) {
    case 'O': return 0;
    case 'B': return 1;
    case 'A': return 2;
    case 'F': return 3;
    case 'G': return 4;
    case 'K': return 5;
    case 'M': return 6;
    case 'C': case 'S': case 'W': case 'N': case 'R': return 7;
    default: return 8;
  }
}

interface SpectralInfo {
  classIdx: number;     // 0-8 per spectClassIndex
  subclass: number;     // 0-9, defaults to 5 when missing
  lumClass: number;     // 0-9 (see table below), 255 if unknown
  isWhiteDwarf: boolean;
  wdSubclass: number;   // only valid if isWhiteDwarf (the digit after D)
}

// Luminosity class encoding — used by the renderer to size/colour by star type.
//   0 = VII / D  (white dwarf)
//   1 = VI / sd  (subdwarf)
//   2 = V        (main sequence dwarf)
//   3 = IV       (subgiant)
//   4 = III      (giant)
//   5 = II       (bright giant)
//   6 = Ib       (less-luminous supergiant)
//   7 = Iab      (intermediate supergiant)
//   8 = Ia       (luminous supergiant)
//   9 = Ia+ / 0  (hypergiant)
// 255 = unknown / not parseable
function parseSpectral(raw: string): SpectralInfo {
  // Strip leading junk colons and quotes; collapse spaces.
  const s = raw.replace(/^["':\s]+/, '').replace(/\s+/g, '').toUpperCase();
  if (!s) {
    return { classIdx: 8, subclass: 5, lumClass: 255, isWhiteDwarf: false, wdSubclass: 0 };
  }

  // White dwarf: starts with "D" followed by another letter (DA, DB, DC, DO,
  // DZ, DQ, DX) and an optional digit. Plain "D" alone (rare) also counts.
  if (s[0] === 'D' && (s.length === 1 || /[A-Z]/.test(s[1]))) {
    const m = s.match(/^D[A-Z]*(\d(?:\.\d)?)?/);
    const wdSub = m && m[1] ? Math.round(Number(m[1])) : 5;
    return {
      classIdx: 8, subclass: 5, lumClass: 0, isWhiteDwarf: true,
      wdSubclass: Math.max(0, Math.min(9, wdSub)),
    };
  }

  // Subdwarf prefix: "sdB", "sdO", etc. — lumClass=1, classIdx from the letter.
  if (s.startsWith('SD')) {
    const letter = s.charAt(2);
    const cls = spectClassIndex(letter);
    const subMatch = s.substring(3).match(/^(\d)/);
    const sub = subMatch ? Number(subMatch[1]) : 5;
    return { classIdx: cls, subclass: sub, lumClass: 1, isWhiteDwarf: false, wdSubclass: 0 };
  }

  // Leading letter is the primary spectral class.
  const firstChar = s.charAt(0);
  const classIdx = spectClassIndex(firstChar);

  // Subclass digit (0-9), optionally with a decimal — take the integer part.
  const subMatch = s.substring(1).match(/^(\d)/);
  const subclass = subMatch ? Number(subMatch[1]) : 5;

  // Luminosity Roman numeral — order from most specific to least so we don't
  // mis-match "II" as "I" etc. Matched anywhere after the first 2-3 chars.
  const afterPrefix = s.substring(1 + (subMatch ? subMatch[0].length : 0));
  let lumClass = 255;
  if (/^(IA\+|0)/.test(afterPrefix)) lumClass = 9;
  else if (/^IAB/.test(afterPrefix)) lumClass = 7;
  else if (/^IA/.test(afterPrefix)) lumClass = 8;
  else if (/^IB/.test(afterPrefix)) lumClass = 6;
  else if (/^III/.test(afterPrefix)) lumClass = 4;
  else if (/^II(?!I)/.test(afterPrefix)) lumClass = 5;
  else if (/^IV/.test(afterPrefix)) lumClass = 3;
  else if (/^VII/.test(afterPrefix)) lumClass = 0;
  else if (/^VI(?!I)/.test(afterPrefix)) lumClass = 1;
  else if (/^V/.test(afterPrefix)) lumClass = 2;
  else if (/^I(?![IV])/.test(afterPrefix)) lumClass = 7; // bare "I" — treat as Iab

  return { classIdx, subclass, lumClass, isWhiteDwarf: false, wdSubclass: 0 };
}

// Effective temperature (Kelvin) by spectral class + subclass for main-sequence
// stars. Giants and supergiants of the same letter+digit run ~10-15% cooler;
// the physical-radius calculation below rides mostly on the *relative* scaling,
// so the MS table is close enough. White dwarfs are handled separately.
const T_TABLE: Record<number, [number, number][]> = {
  0: [[0, 50000], [5, 42000], [9, 34000]],             // O
  1: [[0, 30000], [5, 15200], [9, 10500]],             // B
  2: [[0,  9790], [5,  8180], [9,  7600]],             // A
  3: [[0,  7300], [5,  6650], [9,  6050]],             // F
  4: [[0,  5940], [5,  5560], [9,  5310]],             // G
  5: [[0,  5150], [5,  4410], [9,  3900]],             // K
  6: [[0,  3840], [5,  3170], [9,  2500]],             // M
  7: [[0,  4000], [5,  3000], [9,  2500]],             // C/S/W (cool carbon) — rough
  8: [[0,  5000], [5,  5000], [9,  5000]],             // unknown — neutral default
};

function interpolate(table: [number, number][], key: number): number {
  for (let i = 1; i < table.length; i++) {
    const [k0, v0] = table[i - 1];
    const [k1, v1] = table[i];
    if (key <= k1) {
      const t = (key - k0) / (k1 - k0);
      return v0 + (v1 - v0) * t;
    }
  }
  return table[table.length - 1][1];
}

function tempKelvin(info: SpectralInfo): number {
  if (info.isWhiteDwarf) {
    // WD spectral number is T_eff / 50400 × 10 (inverted from Sion et al.);
    // so T_eff ≈ 50400 / N for N=1..9. N=2 → 25200 K, N=5 → 10080 K, etc.
    const n = Math.max(1, info.wdSubclass);
    return 50400 / n;
  }
  return interpolate(T_TABLE[info.classIdx] ?? T_TABLE[8], info.subclass);
}

// Bolometric correction by spectral class + subclass. Mostly negligible for
// solar-type stars; large negatives for O/B (lots of UV) and M (lots of IR).
const BC_TABLE: Record<number, [number, number][]> = {
  0: [[0, -4.9], [5, -4.4], [9, -3.3]],
  1: [[0, -3.16], [5, -1.46], [9, -0.51]],
  2: [[0, -0.30], [5, -0.15], [9, -0.10]],
  3: [[0, -0.09], [5, -0.14], [9, -0.16]],
  4: [[0, -0.18], [5, -0.21], [9, -0.31]],
  5: [[0, -0.31], [5, -0.72], [9, -1.20]],
  6: [[0, -1.38], [5, -2.73], [9, -4.10]],
  7: [[0, -2.00], [5, -3.00], [9, -4.00]],
  8: [[0,  0.00], [5,  0.00], [9,  0.00]],
};

function boloCorr(info: SpectralInfo): number {
  if (info.isWhiteDwarf) {
    // WDs have large BCs that depend strongly on T; a single value is a lie
    // but good enough for display sizing. Hot DA ≈ -2, cool ≈ 0.
    const T = tempKelvin(info);
    if (T > 30000) return -2.5;
    if (T > 15000) return -1.0;
    if (T > 8000) return -0.2;
    return 0.3;
  }
  return interpolate(BC_TABLE[info.classIdx] ?? BC_TABLE[8], info.subclass);
}

// Compute physical radius in solar radii from absolute magnitude + spectral
// info via Stefan-Boltzmann. Clamped to sane bounds so odd catalog entries
// don't produce absurd values.
const T_SUN = 5778;
const MBOL_SUN = 4.74;
function physicalRadius(absmag: number, info: SpectralInfo): number {
  if (info.isWhiteDwarf) {
    // White dwarfs cluster tightly around 0.01 R☉; slight mass-dependence
    // but absmag doesn't translate reliably into a radius here.
    return 0.013;
  }
  const T = tempKelvin(info);
  const BC = boloCorr(info);
  const Mbol = absmag + BC;
  const L = Math.pow(10, (MBOL_SUN - Mbol) / 2.5); // L/L☉
  if (!Number.isFinite(L) || L <= 0) return 1.0;
  const R = Math.sqrt(L) * (T_SUN / T) * (T_SUN / T);
  // Clamp to the empirical stellar range: red dwarfs bottom around 0.08 R☉,
  // extreme supergiants top around ~2000 R☉. Beyond these is bad catalog data.
  return Math.max(0.08, Math.min(2500, R));
}

function isUpToDate(): boolean {
  if (!existsSync(OUT_BIN) || !existsSync(OUT_CON) || !existsSync(OUT_SEARCH)) return false;
  const binMtime = statSync(OUT_BIN).mtimeMs;
  const srcMtime = statSync(SRC_CSV).mtimeMs;
  const stellariumMtime = existsSync(SRC_STELLARIUM)
    ? statSync(SRC_STELLARIUM).mtimeMs
    : 0;
  const scriptMtime = statSync(__filename).mtimeMs;
  return (
    binMtime > srcMtime && binMtime > scriptMtime && binMtime > stellariumMtime
  );
}

interface Star {
  x: number; y: number; z: number;
  absmag: number;
  ci: number;
  spectClass: number;
  lumClass: number;
  physicalRadius: number;  // solar radii
  conIndex: number;
  flags: number;
  proper: string | null;
  bayer: string | null;
  hip: number | null;
  hd: number | null;
  hr: number | null;
  flam: number | null;
  gl: string | null;
  companionIdx: number;    // assigned later in inferBinaries; -1 = none
}

function parseFloatOrNull(s: string | undefined | null): number | null {
  if (s === '' || s === undefined || s === null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function parseIntOrNull(s: string | undefined | null): number | null {
  const v = parseFloatOrNull(s);
  return v === null ? null : Math.trunc(v);
}

function nonEmpty(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t ? t : null;
}

async function readStars(): Promise<{
  stars: Star[];
  stats: { total: number; dropped: Record<string, number> };
}> {
  const parser = createReadStream(SRC_CSV).pipe(
    parse({ columns: true, skip_empty_lines: true, cast: false })
  );

  const stars: Star[] = [];
  const dropped: Record<string, number> = {
    noCoords: 0,
    noAbsmag: 0,
    tooFar: 0,
    unknownCon: 0,
  };
  let total = 0;

  for await (const row of parser) {
    total++;
    const x = parseFloatOrNull(row.x0);
    const y = parseFloatOrNull(row.y0);
    const z = parseFloatOrNull(row.z0);
    if (x === null || y === null || z === null) {
      dropped.noCoords++;
      continue;
    }
    const absmag = parseFloatOrNull(row.absmag);
    if (absmag === null) {
      dropped.noAbsmag++;
      continue;
    }
    const dist = parseFloatOrNull(row.dist);
    if (dist !== null && dist > MAX_DIST_PC) {
      dropped.tooFar++;
      continue;
    }
    const ci = parseFloatOrNull(row.ci) ?? DEFAULT_CI;

    const spectRaw = (row.spect ?? '').trim();
    const spectInfo = parseSpectral(spectRaw);
    const physRadius = physicalRadius(absmag, spectInfo);

    const conCode: string = (row.con ?? '').trim();
    let conIndex = 255;
    if (conCode) {
      const idx = CON_INDEX.get(conCode.toLowerCase());
      if (idx === undefined) {
        dropped.unknownCon++;
      } else {
        conIndex = idx;
      }
    }

    const proper = nonEmpty(row.proper);
    const bayer = nonEmpty(row.bayer);
    const flam = parseIntOrNull(row.flam);
    const hip = parseIntOrNull(row.hip);
    const hd = parseIntOrNull(row.hd);
    const hr = parseIntOrNull(row.hr);
    const gl = nonEmpty(row.gl);

    const isSol = proper === 'Sol';
    let flags = 0;
    if (proper) flags |= 0x01;
    if (isSol) flags |= 0x02;
    if (bayer) flags |= 0x04;

    stars.push({
      x, y, z, absmag, ci,
      spectClass: spectInfo.classIdx,
      lumClass: spectInfo.lumClass,
      physicalRadius: physRadius,
      conIndex, flags,
      proper, bayer, hip, hd, hr, flam, gl,
      companionIdx: -1,
    });
  }

  return { stars, stats: { total, dropped } };
}

// Spatial-grid nearest-neighbour pass. For each star, find its nearest
// neighbour within BINARY_MAX_SEP_PC; if any is within range, record it as
// this star's companion. Mutual: A→B and B→A pointing at each other (or both
// at a common brightest in a triple) is what we want.
function inferBinaries(stars: Star[]): { pairs: number; primaries: number } {
  const cell = BINARY_MAX_SEP_PC;
  const cellInv = 1 / cell;
  const grid = new Map<number, number[]>(); // hash → star indices
  const n = stars.length;

  const hashKey = (ix: number, iy: number, iz: number): number =>
    // 21 bits per axis → fits in a safe int. Signed range ~±1 million cells
    // (stars are within ~50_000 pc / 0.005 pc = ±10M cells, so this overflows
    // mathematically but TS number is 53-bit mantissa so still unique).
    ix * 73856093 + iy * 19349663 + iz * 83492791;

  for (let i = 0; i < n; i++) {
    const s = stars[i];
    const ix = Math.floor(s.x * cellInv);
    const iy = Math.floor(s.y * cellInv);
    const iz = Math.floor(s.z * cellInv);
    const key = hashKey(ix, iy, iz);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const sepSq = BINARY_MAX_SEP_PC * BINARY_MAX_SEP_PC;
  let pairCount = 0;
  const primaries = new Set<number>();

  for (let i = 0; i < n; i++) {
    const s = stars[i];
    const ix = Math.floor(s.x * cellInv);
    const iy = Math.floor(s.y * cellInv);
    const iz = Math.floor(s.z * cellInv);
    let bestIdx = -1;
    let bestSq = sepSq;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(hashKey(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j === i) continue;
            const t = stars[j];
            const dxv = t.x - s.x;
            const dyv = t.y - s.y;
            const dzv = t.z - s.z;
            const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
            if (d2 < bestSq) {
              bestSq = d2;
              bestIdx = j;
            }
          }
        }
      }
    }
    if (bestIdx !== -1) {
      stars[i].companionIdx = bestIdx;
      // Primary = brighter of the pair (lower absmag).
      const primary = stars[i].absmag <= stars[bestIdx].absmag ? i : bestIdx;
      primaries.add(primary);
      pairCount++;
    }
  }

  // Flag primaries in the flags byte (bit 4) so the renderer can quickly
  // identify the "anchor" of each system.
  for (const idx of primaries) {
    stars[idx].flags |= 0x10;
  }

  return { pairs: pairCount, primaries: primaries.size };
}

// Extracts classical stick-figure lines per IAU constellation from
// Stellarium's modern sky culture `index.json`. Each polyline in the source
// is a list of HIP integers; we resolve each HIP to a record index via
// `hipToIndex`. Missing HIPs are a hard error unless in KNOWN_MISSING_HIPS —
// the whole point of using Stellarium data (vs. fuzzy RA/Dec match) is
// deterministic mapping.
function buildFigureLines(
  hipToIndex: Map<number, number>,
): Map<number, number[][]> {
  const raw = JSON.parse(readFileSync(SRC_STELLARIUM, 'utf8'));
  const source: Array<{ id: string; lines?: number[][] }> = raw.constellations ?? [];

  const out = new Map<number, number[][]>();
  const missing: Array<{ code: string; hip: number }> = [];

  for (const entry of source) {
    if (!entry.lines || entry.lines.length === 0) continue;
    const parts = entry.id.split(/\s+/);
    const code = parts[parts.length - 1];
    const conIndex = CON_INDEX.get(code.toLowerCase());
    if (conIndex === undefined) {
      throw new Error(`Stellarium constellation code not in IAU-88 table: ${code}`);
    }

    const resolved: number[][] = [];
    for (const polyline of entry.lines) {
      const starIndices: number[] = [];
      for (const hip of polyline) {
        const idx = hipToIndex.get(hip);
        if (idx === undefined) {
          if (!KNOWN_MISSING_HIPS.has(hip)) missing.push({ code, hip });
          continue;
        }
        starIndices.push(idx);
      }
      if (starIndices.length >= 2) resolved.push(starIndices);
    }
    if (resolved.length) out.set(conIndex, resolved);
  }

  if (missing.length) {
    const sample = missing.slice(0, 10).map((m) => `${m.code}/HIP ${m.hip}`);
    throw new Error(
      `Stellarium figures reference ${missing.length} HIP(s) not found in catalog and not in KNOWN_MISSING_HIPS. ` +
        `First ${sample.length}: ${sample.join(', ')}. ` +
        `If this is expected, add each HIP to KNOWN_MISSING_HIPS with a justification; otherwise investigate the data mismatch.`,
    );
  }

  return out;
}

async function main() {
  if (!existsSync(SRC_CSV)) {
    console.error(`Source CSV not found: ${SRC_CSV}`);
    process.exit(1);
  }
  if (!existsSync(SRC_STELLARIUM)) {
    console.error(`Stellarium sky culture JSON not found: ${SRC_STELLARIUM}`);
    process.exit(1);
  }

  if (isUpToDate()) {
    console.log('catalog.bin is up to date with source CSV; skipping rebuild.');
    return;
  }

  console.log(`Reading ${SRC_CSV}...`);
  const t0 = Date.now();
  const { stars, stats } = await readStars();
  console.log(`  parsed ${stats.total} rows in ${Date.now() - t0}ms`);
  console.log(`  kept ${stars.length} stars`);
  console.log(`  dropped:`, stats.dropped);

  // Sort by absolute magnitude ascending (brightest first). Record indices
  // are final after this point.
  stars.sort((a, b) => a.absmag - b.absmag);

  // Build HIP → record index map against the post-sort order. Duplicate HIPs
  // are rare (binary companions sharing an identifier); keep the brightest.
  const hipToIndex = new Map<number, number>();
  for (let i = 0; i < stars.length; i++) {
    const h = stars[i].hip;
    if (h !== null && h > 0 && !hipToIndex.has(h)) hipToIndex.set(h, i);
  }

  // Resolve Stellarium stick-figure lines to star indices. Throws if any
  // referenced HIP is missing from the catalog.
  const figureLines = buildFigureLines(hipToIndex);

  // Geometric binary inference.
  console.log('Inferring binary/multiple systems...');
  const tBin = Date.now();
  const binStats = inferBinaries(stars);
  console.log(
    `  ${binStats.pairs} companion assignments (${binStats.primaries} primaries) in ${Date.now() - tBin}ms`,
  );

  // Build name table — just proper names. Bayer/Flam/HIP/etc. go in
  // search-index.json so the main binary stays compact.
  const encoder = new TextEncoder();
  const nameChunks: Uint8Array[] = [];
  const nameOffsets = new Uint32Array(stars.length);
  // Offset 0 is reserved as the "no name" sentinel. Any real name starts at
  // offset ≥ 2 because of the length prefix we write first.
  let nameTableLength = 2;
  nameChunks.push(new Uint8Array([0, 0])); // padding so offset 0 is never a real name
  for (let i = 0; i < stars.length; i++) {
    if (!stars[i].proper) continue;
    const bytes = encoder.encode(stars[i].proper!);
    if (bytes.length > 0xffff) {
      throw new Error(`Name too long: ${stars[i].proper}`);
    }
    nameOffsets[i] = nameTableLength;
    const lenHeader = new Uint8Array(2);
    new DataView(lenHeader.buffer).setUint16(0, bytes.length, true);
    nameChunks.push(lenHeader);
    nameChunks.push(bytes);
    nameTableLength += 2 + bytes.length;
  }

  // Allocate output buffer.
  const recordsLength = stars.length * RECORD_SIZE;
  const totalLength = HEADER_SIZE + recordsLength + nameTableLength;
  const out = new ArrayBuffer(totalLength);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  // Header.
  const magicBytes = encoder.encode('HYG3');
  bytes.set(magicBytes, 0);
  view.setUint32(4, BINARY_VERSION, true);
  view.setUint32(8, stars.length, true);
  view.setUint32(12, HEADER_SIZE + recordsLength, true); // nameTableOffset
  view.setUint32(16, nameTableLength, true);
  // bytes 20-31: reserved.

  // Records.
  let off = HEADER_SIZE;
  let solIndex = -1;
  const NO_COMPANION = 0xffffffff;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    view.setFloat32(off + 0, s.x, true);
    view.setFloat32(off + 4, s.y, true);
    view.setFloat32(off + 8, s.z, true);
    view.setFloat32(off + 12, s.absmag, true);
    view.setFloat32(off + 16, s.ci, true);
    view.setFloat32(off + 20, s.physicalRadius, true);
    view.setUint32(off + 24, s.companionIdx >= 0 ? s.companionIdx : NO_COMPANION, true);
    view.setUint32(off + 28, s.proper ? nameOffsets[i] : 0, true);
    view.setUint8(off + 32, s.spectClass);
    view.setUint8(off + 33, s.lumClass);
    view.setUint8(off + 34, s.conIndex);
    view.setUint8(off + 35, s.flags);
    // off + 36..39: reserved.
    if (s.flags & 0x02) solIndex = i;
    off += RECORD_SIZE;
  }

  // Name table.
  for (const chunk of nameChunks) {
    bytes.set(chunk, off);
    off += chunk.length;
  }

  if (off !== totalLength) {
    throw new Error(`Size mismatch: wrote ${off}, expected ${totalLength}`);
  }

  await writeFile(OUT_BIN, Buffer.from(out));

  // Constellations JSON (unchanged from v1 format).
  const constellationsOut = CONSTELLATIONS.map((c, idx) => {
    const lines = figureLines.get(idx);
    return lines ? { ...c, lines } : { ...c };
  });
  await writeFile(OUT_CON, JSON.stringify(constellationsOut) + '\n');

  // Search index — one entry per star with at least one identifier the user
  // might type. Keys kept short (i/p/b/f/hip/hd/hr/gl) for wire size.
  const searchEntries: Array<Record<string, string | number>> = [];
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    if (!s.proper && !s.bayer && s.hip === null && s.hd === null && s.hr === null && s.flam === null && !s.gl) continue;
    const entry: Record<string, string | number> = { i };
    if (s.proper) entry.p = s.proper;
    if (s.bayer) entry.b = s.bayer;
    if (s.flam !== null) entry.f = s.flam;
    if (s.hip !== null) entry.hip = s.hip;
    if (s.hd !== null) entry.hd = s.hd;
    if (s.hr !== null) entry.hr = s.hr;
    if (s.gl) entry.gl = s.gl;
    if (s.conIndex !== 255) entry.c = s.conIndex;
    searchEntries.push(entry);
  }
  await writeFile(OUT_SEARCH, JSON.stringify(searchEntries) + '\n');

  const figureCount = [...figureLines.values()].reduce(
    (n, arr) => n + arr.length,
    0,
  );
  const mb = (totalLength / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${OUT_BIN} (${mb} MB, ${stars.length} records, v${BINARY_VERSION})`);
  console.log(
    `Wrote ${OUT_CON} (${CONSTELLATIONS.length} constellations, ${figureCount} stick-figure polylines across ${figureLines.size})`,
  );
  const searchMb = (statSync(OUT_SEARCH).size / 1024 / 1024).toFixed(2);
  console.log(`Wrote ${OUT_SEARCH} (${searchEntries.length} searchable entries, ${searchMb} MB)`);
  if (solIndex >= 0) {
    console.log(
      `Sol at record index ${solIndex} (absmag=${stars[solIndex].absmag}, R=${stars[solIndex].physicalRadius.toFixed(3)} R☉)`,
    );
  } else {
    console.warn(`Warning: Sol not found in catalog.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
