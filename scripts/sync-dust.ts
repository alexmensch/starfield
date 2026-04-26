// Copies data/dust/* → public/dust/ so Vite + the Cloudflare static-asset
// build serve the voxel chunks without the Python preprocessor having to
// know about two locations.
//
// Canonical source of truth is data/dust/ (LFS-tracked); public/dust/ is a
// gitignored mirror. Run this on every `npm run dev` / `npm run build` so
// a fresh checkout with LFS data "just works" without having to re-run
// build-dust.py. A missing data/dust/ is not an error — dust is optional
// and the loader handles its absence.

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'data/dust');
const DST = resolve(ROOT, 'public/dust');

function main() {
  if (!existsSync(SRC)) {
    console.log('data/dust/ not found; skipping dust sync.');
    return;
  }
  mkdirSync(DST, { recursive: true });

  let copied = 0;
  let skipped = 0;
  for (const name of readdirSync(SRC)) {
    // Skip dotfiles. build-dust.py emits .voxels.npy as a 512 MiB
    // intermediate that lives alongside the chunks; it has no business
    // in public/ (Cloudflare Workers caps assets at 25 MiB).
    if (name.startsWith('.')) continue;
    const srcPath = resolve(SRC, name);
    const dstPath = resolve(DST, name);
    const srcStat = statSync(srcPath);
    if (!srcStat.isFile()) continue;
    if (existsSync(dstPath)) {
      const dstStat = statSync(dstPath);
      if (dstStat.size === srcStat.size && dstStat.mtimeMs >= srcStat.mtimeMs) {
        skipped++;
        continue;
      }
    }
    copyFileSync(srcPath, dstPath);
    copied++;
  }
  console.log(`dust sync: ${copied} copied, ${skipped} up-to-date`);
}

main();
