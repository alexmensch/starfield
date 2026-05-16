import { loadCatalog } from './catalog-loader';
import { DustField, loadDustManifest, loadDustParticles } from './dust-loader';
import { loadClouds } from './cloud-loader';
import { loadLocalGroup } from './local-group-loader';
import { createLocalGroupLabels, createMilkyWayLabel } from './local-group';
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
import { setupDebug } from './debug';
import { escapeHtml } from './dom-util';
import { createHoverEngine } from './hover/hover-engine';
import { createStarHoverProvider } from './hover/star-hover-provider';
import { createPlanetHoverProvider } from './hover/planet-hover-provider';
import { createLocalGroupHoverProvider } from './hover/local-group-hover-provider';
import { createHeliopauseHoverProvider } from './hover/heliopause-hover-provider';
import type { HoverProvider } from './hover/hover-types';

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
    const [catalog, searchIndex, cloudCatalog, lgCatalog] = await Promise.all([
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
      // Local Group wireframes (stellata-38m). ~20 KB JSON; null if
      // the artifact is missing (fresh checkout without
      // `npm run build:local-group`). No-op layer in that case —
      // outlines simply don't render.
      loadLocalGroup(`${import.meta.env.BASE_URL}local-group.json`),
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

    // Local Group wireframes. Always-on when the artifact is present —
    // same model as the MW disc, no toggle / URL flag.
    if (lgCatalog) stellata.attachLocalGroup(lgCatalog);

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
    // Milky Way label fades in once the camera sits past ~10 kpc from the
    // galactic centre. Independent of attachLocalGroup — the MW label
    // anchors at GALACTIC_CENTRE_PC, not at a Local Group catalog entry.
    createMilkyWayLabel(stellata);
    // Per-object Local Group labels. Mints SVG <text> children under
    // #lg-labels for each catalog object that carries a labelThresholdPc;
    // no-op when the layer didn't attach (missing artifact).
    if (stellata.localGroup) createLocalGroupLabels(stellata, stellata.localGroup);
    createScaleBar(stellata, starLabels);
    bindWarpButton(stellata);
    bindModeToggle(stellata);
    // Hide the #overlay SVG (HUD arrows, focus ring, distance vector,
    // POI labels, etc.) while the focus-park lerp is in flight — same
    // body-class hide pattern the warp uses. CSS selector matches
    // `body.warping` so we don't have to duplicate the rule per source.
    stellata.on('focusLerp', (active) => {
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

    // Hover-label engine (stellata-lo5). Star, planet, heliopause apex,
    // and (when the catalog is present) Local Group providers register
    // here. Every provider mirrors the renderer's "is this drawn?"
    // predicate as its visibility gate — visibility ⇒ hoverable per
    // stellata-lo5-hover-conventions Rule 2; no focus / mode gates.
    // Provider order is irrelevant — the disambiguator picks the winner
    // across all providers per the prime>fallback / closest-camera-wins
    // rule.
    const starHoverProvider = createStarHoverProvider({
      stellata,
      context: {
        starLabels,
        spectralMap,
        positions: catalog.positions,
        constellation: catalog.constellation,
        constellations: catalog.constellations,
        periodDays: catalog.periodDays,
        amplitudeMag: catalog.amplitudeMag,
      },
    });
    const planetHoverProvider = createPlanetHoverProvider({ stellata });
    const heliopauseHoverProvider = createHeliopauseHoverProvider({ stellata });
    const hoverProviders: HoverProvider[] = [
      starHoverProvider,
      planetHoverProvider,
      heliopauseHoverProvider,
    ];
    // LG provider only registers when the build artifact loaded — fresh
    // checkouts without `npm run build:local-group` leave stellata.localGroup
    // null and the wireframes don't render; no provider in that case.
    if (lgCatalog) {
      hoverProviders.push(createLocalGroupHoverProvider({
        stellata,
        context: { objects: lgCatalog.objects },
      }));
    }
    createHoverEngine({
      canvas,
      tooltip,
      initialProviders: hoverProviders,
    });

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
    // re-enabling the cloud layer, build a CloudHoverProvider per the
    // lo5 engine contract — the cloud formatter exists already as part
    // of lo5.7 but its provider is unregistered while the layer is
    // shelved.)
  } catch (err) {
    console.error(err);
    loadingStatus.textContent = `Error: ${(err as Error).message}`;
  }
}

main();
