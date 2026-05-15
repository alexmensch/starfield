import { loadCatalog } from './catalog-loader';
import { DustField, loadDustManifest, loadDustParticles } from './dust-loader';
import { loadClouds } from './cloud-loader';
import { Stellata } from './stellata';
import { bindControls } from './controls';
import { bindSearch, buildStarLabels, buildSpectralMap, buildBayerMap, type SearchEntry } from './search';
import { createConstellationOverlay } from './constellation-overlay';
import { createDiscMask } from './disc-mask';
import { createDistanceVectorOverlay } from './distance-vector-overlay';
import { createFocusRingOverlay } from './focus-ring-overlay';
import { createPoiOverlay } from './poi-overlay';
import { createPlanetLabels } from './planet-labels';
import { createHeliopauseLabel } from './heliopause';
import { createScaleBar } from './scale-bar';
import { createTimeReadout } from './time-readout';
import { bindUnitToggle } from './unit-toggle';
import { registerThemeStellata } from './theme-toggle';
import { bindChartMode } from './chart-mode';
import { bindPanelLayout } from './panel-layout';
import { bindWarpButton } from './warp-button';
import { bindModeToggle } from './mode-toggle';
import { maybeShowInfoModal } from './info-modal';
import { bindBrandModals } from './brand-modal';
import { bindKeyboardShortcuts } from './keyboard-shortcuts';
import { applyFromUrl, startUrlSync, type IdMaps } from './url-state';
import { applyFirstLoadView } from './first-load';
import { fmtDist } from './distance-util';
import { setupDebug } from './debug';
import { escapeHtml } from './dom-util';

const HOVER_DELAY_MS = 280;

async function main() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const loadingBar = document.getElementById('loading-bar')!;
  const loadingStatus = document.getElementById('loading-status')!;
  const topbar = document.getElementById('topbar')!;
  const panel = document.getElementById('panel')!;
  const brandBox = document.getElementById('ui-top-left')!;
  const meta = document.getElementById('meta')!;
  const tooltip = document.getElementById('tooltip')!;

  try {
    const [catalog, searchIndex, cloudCatalog] = await Promise.all([
      loadCatalog(
        `${import.meta.env.BASE_URL}catalog.bin`,
        `${import.meta.env.BASE_URL}constellations.json`,
        ({ bytes, total }) => {
          if (total) {
            const pct = (bytes / total) * 100;
            loadingBar.style.width = pct.toFixed(0) + '%';
            loadingStatus.textContent = `${(bytes / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`;
          } else {
            loadingStatus.textContent = `${(bytes / 1024 / 1024).toFixed(1)} MB`;
          }
        },
      ),
      fetch(`${import.meta.env.BASE_URL}search-index.json`).then(
        (r) => r.json() as Promise<SearchEntry[]>,
      ),
      // Molecular clouds. Fetched in parallel with the catalog —
      // a few hundred KB; null if the artifact is missing (fresh checkout
      // without `npm run build:clouds`).
      loadClouds(`${import.meta.env.BASE_URL}clouds.json`),
    ]);

    loadingStatus.textContent = `Parsed ${catalog.count.toLocaleString()} stars`;
    loadingBar.style.width = '100%';

    const starLabels = buildStarLabels(catalog, searchIndex);
    const spectralMap = buildSpectralMap(searchIndex);
    const bayerMap = buildBayerMap(searchIndex);

    const stellata = new Stellata({ canvas, catalog });
    // Dev-console access: `stellata.setExtinctionStrength(X)` etc. Handy for
    // dust debugging and not worth gating behind an env check on a solo
    // project.
    window.stellata = stellata;
    // Cloud layer is shelved for v1.0 (CLAUDE.md). The fetch and parsing
    // stay so the machinery is verified; the attach is suppressed so the
    // layer doesn't enter the scene. Re-enable by uncommenting the line
    // below.
    // if (cloudCatalog) stellata.attachClouds(cloudCatalog);
    void cloudCatalog;

    // HIP → row-index lookup, used by url-state to encode/decode shared
    // links with stable star IDs that survive a future catalog reorder.
    // Built once over `catalog.hip` (uint32 per row, 0 = no HIP). First-
    // seen wins on collision (matches Stellarium-figure HIP resolution).
    const hipToIndex = new Map<number, number>();
    for (let i = 0; i < catalog.count; i++) {
      const h = catalog.hip[i];
      if (h > 0 && !hipToIndex.has(h)) hipToIndex.set(h, i);
    }
    const idMaps: IdMaps = {
      hipToIndex,
      indexToHip: catalog.hip,
      starCount: catalog.count,
      solIndex: catalog.solIndex,
    };

    const debugTools = setupDebug(stellata, idMaps);

    // Interstellar dust loads in the background — never blocks first paint.
    // Extinction fades in as each voxel chunk lands on the GPU. If the
    // manifest is missing (fresh clone without data/dust/, CI without the
    // preprocessor, etc.) the stellata renders exactly as it did before
    // dust was introduced.
    void (async () => {
      const dustBase = `${import.meta.env.BASE_URL}dust/`;
      const manifest = await loadDustManifest(dustBase);
      if (!manifest) {
        console.info('dust manifest not found; skipping extinction layer');
        return;
      }
      const dust = new DustField(stellata.renderer, dustBase, manifest);
      stellata.attachDust(dust);
      // Particles load in parallel with chunks — they're tiny (~800 KiB)
      // and don't depend on the volumetric texture. The mesh stays
      // hidden (strength 0) until the user opts in via the console.
      if (manifest.particles) {
        loadDustParticles(dustBase, manifest.particles).then((particles) => {
          if (particles) stellata.attachDustParticles(particles);
        });
      }
      await dust.startLoading();
    })();

    bindUnitToggle();
    registerThemeStellata(stellata);
    bindChartMode(stellata, { bayerMap, starLabels });
    bindControls(stellata);
    // null cloudCatalog: cloud layer is shelved for v1.0 (CLAUDE.md), so
    // search shouldn't surface unreachable cloud entries. Pass
    // `cloudCatalog` directly when re-enabling.
    bindSearch(stellata, catalog, searchIndex, starLabels, null);
    createDiscMask(stellata);
    createConstellationOverlay(stellata);
    createDistanceVectorOverlay(stellata, starLabels);
    createFocusRingOverlay(stellata);
    createPoiOverlay(stellata, starLabels);
    createPlanetLabels(stellata);
    createHeliopauseLabel(stellata);
    createScaleBar(stellata, starLabels);
    bindWarpButton(stellata);
    bindModeToggle(stellata);
    // Hide the #overlay SVG (HUD arrows, focus ring, distance vector,
    // POI labels, etc.) while the focus-park lerp is in flight — same
    // body-class hide pattern the warp uses. CSS selector matches
    // `body.warping` so we don't have to duplicate the rule per source.
    stellata.onFocusLerpChange((active) => {
      document.body.classList.toggle('focus-lerping', active);
    });

    // Apply any URL state before starting the URL writer so we don't echo
    // the same params back into history on load. With no `?v=`, fall back
    // to the canonical first-load view (Sol focus, parked at 5 AU aimed at
    // the galactic centre, HUD on, no constellation highlight) — stellata-vjm.
    if (!applyFromUrl(stellata, idMaps)) {
      applyFirstLoadView(stellata, idMaps);
    }
    startUrlSync(stellata, idMaps);

    // Bottom-right meta: catalog count + (when focused on a planet host)
    // the live UTC timestamp the planet positions correspond to. The
    // focused-object name moved into the scale-bar widget's z-axis
    // indicator, where it sits alongside the camera-to-focus distance.
    const countLabel = `${catalog.count.toLocaleString()} stars`;
    meta.innerHTML =
      `<div class="meta-count">${escapeHtml(countLabel)}</div>` +
      `<div id="time-readout" class="time-readout" hidden></div>`;
    // After meta.innerHTML — createTimeReadout binds to the #time-readout
    // child the line above just minted.
    createTimeReadout({
      el: document.getElementById('time-readout')!,
      stellata,
    });

    bindHoverTooltip(canvas, tooltip, stellata, describeStarDetailed);

    await new Promise((r) => requestAnimationFrame(r));
    loading.style.transition = 'opacity 0.4s ease';
    loading.style.opacity = '0';
    setTimeout(() => {
      loading.remove();
      topbar.hidden = false;
      panel.hidden = false;
      brandBox.hidden = false;
      meta.hidden = false;
      bindPanelLayout();
      bindBrandModals();
      bindKeyboardShortcuts(stellata, { toggleDebugPanel: debugTools.panel });
      maybeShowInfoModal(catalog.count);
    }, 400);

    // (describeCloud removed alongside the cloud-shelving cleanup. When
    // re-enabling the cloud layer, restore it from git history and pass it
    // back into bindHoverTooltip so cloud hovers surface a name+axes
    // tooltip the same way star hovers do.)

    // Detailed, multi-line form for the hover tooltip. Line 1 is the star
    // name; subsequent lines progressively disclose: constellation +
    // distance, full spectral classification (from the catalog, preserving
    // composite/peculiar markers), and variability info if any.
    function describeStarDetailed(idx: number): { name: string; lines: string[] } {
      const name = starLabels.get(idx) ?? `Unnamed #${idx}`;
      const conIdx = catalog.constellation[idx];
      const con = conIdx !== 255 ? catalog.constellations[conIdx].name : '';
      const p = catalog.positions;
      const dist = Math.sqrt(
        p[idx * 3] ** 2 + p[idx * 3 + 1] ** 2 + p[idx * 3 + 2] ** 2,
      );
      const lines: string[] = [];
      const ctx = [con, fmtDist(dist)].filter(Boolean).join(' · ');
      if (ctx) lines.push(ctx);
      const spect = spectralMap.get(idx);
      if (spect) lines.push(spect);
      const period = catalog.periodDays[idx];
      const amp = catalog.amplitudeMag[idx];
      if (period > 0 && amp > 0) {
        const periodStr = period >= 10
          ? `${period.toFixed(0)}d`
          : `${period.toFixed(2)}d`;
        lines.push(`Variable · P=${periodStr}, Δ=${amp.toFixed(1)}mag`);
      }
      return { name, lines };
    }
  } catch (err) {
    console.error(err);
    loadingStatus.textContent = `Error: ${(err as Error).message}`;
  }
}

function bindHoverTooltip(
  canvas: HTMLCanvasElement,
  tooltip: HTMLElement,
  stellata: Stellata,
  detailedStar: (i: number) => { name: string; lines: string[] },
) {
  let timer: number | undefined;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const hide = () => {
    tooltip.hidden = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  canvas.addEventListener('pointerdown', () => { dragging = true; hide(); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointerleave', hide);

  canvas.addEventListener('pointermove', (e) => {
    if (dragging) return;
    lastX = e.clientX;
    lastY = e.clientY;
    hide();
    timer = window.setTimeout(() => {
      // Stars are the only hover-tooltip target while the molecular cloud
      // layer is shelved (CLAUDE.md). When clouds re-enable, fall back to
      // pickCloud here for the cloud-name tooltip.
      const starIdx = stellata.pickStar(lastX, lastY, 14);
      const payload = starIdx >= 0 ? detailedStar(starIdx) : null;
      if (!payload) return;
      const { name, lines } = payload;
      const subLines = lines
        .map((l) => `<div class="tt-sub">${escapeHtml(l)}</div>`)
        .join('');
      tooltip.innerHTML = `<div class="tt-name">${escapeHtml(name)}</div>${subLines}`;
      const maxLeft = window.innerWidth - 300;
      const maxTop = window.innerHeight - 96;
      tooltip.style.left = Math.min(lastX + 14, maxLeft) + 'px';
      tooltip.style.top = Math.min(lastY + 14, maxTop) + 'px';
      tooltip.hidden = false;
    }, HOVER_DELAY_MS);
  });
}

main();
