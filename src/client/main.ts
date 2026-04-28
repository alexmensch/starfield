import { loadCatalog } from './catalog-loader';
import { DustField, loadDustManifest, loadDustParticles } from './dust-loader';
import { loadClouds } from './cloud-loader';
import { Starfield } from './starfield';
import { bindControls } from './controls';
import { bindSearch, buildStarLabels, buildSpectralMap, type SearchIndexEntry } from './search';
import { createConstellationOverlay } from './constellation-overlay';
import { createDiscMask } from './disc-mask';
import { createDistanceVectorOverlay } from './distance-vector-overlay';
import { createFocusRingOverlay } from './focus-ring-overlay';
import { createScaleBar } from './scale-bar';
import { bindUnitToggle } from './unit-toggle';
import { registerThemeStarfield } from './theme-toggle';
import { bindPanelLayout } from './panel-layout';
import { bindWarpButton } from './warp-button';
import { maybeShowInfoModal } from './info-modal';
import { bindBrandModals } from './brand-modal';
import { applyFromUrl, startUrlSync } from './url-state';
import { fmtDist, onUnitChange } from './distance-util';
import { setupDebug } from './debug';

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
        (r) => r.json() as Promise<SearchIndexEntry[]>,
      ),
      // Molecular clouds (Phase 3a). Fetched in parallel with the catalog —
      // a few hundred KB; null if the artifact is missing (fresh checkout
      // without `npm run build:clouds`).
      loadClouds(`${import.meta.env.BASE_URL}clouds.json`),
    ]);

    loadingStatus.textContent = `Parsed ${catalog.count.toLocaleString()} stars`;
    loadingBar.style.width = '100%';

    const starLabels = buildStarLabels(catalog, searchIndex);
    const spectralMap = buildSpectralMap(searchIndex);

    const starfield = new Starfield({ canvas, catalog });
    // Dev-console access: `starfield.setExtinctionStrength(X)` etc. Handy for
    // dust debugging and not worth gating behind an env check on a solo
    // project.
    (window as unknown as { starfield: Starfield }).starfield = starfield;
    if (cloudCatalog) starfield.attachClouds(cloudCatalog);
    setupDebug(starfield);

    // Interstellar dust loads in the background — never blocks first paint.
    // Extinction fades in as each voxel chunk lands on the GPU. If the
    // manifest is missing (fresh clone without data/dust/, CI without the
    // preprocessor, etc.) the starfield renders exactly as it did before
    // dust was introduced.
    void (async () => {
      const dustBase = `${import.meta.env.BASE_URL}dust/`;
      const manifest = await loadDustManifest(dustBase);
      if (!manifest) {
        console.info('dust manifest not found; skipping extinction layer');
        return;
      }
      const dust = new DustField(starfield.renderer, dustBase, manifest);
      starfield.attachDust(dust);
      // Particles load in parallel with chunks — they're tiny (~800 KiB)
      // and don't depend on the volumetric texture. The mesh stays
      // hidden (strength 0) until the user opts in via the console.
      if (manifest.particles) {
        loadDustParticles(dustBase, manifest.particles).then((particles) => {
          if (particles) starfield.attachDustParticles(particles);
        });
      }
      await dust.startLoading();
      console.info(
        `dust loaded: ${manifest.totalChunks} chunks, synthetic=${manifest.synthetic}`,
      );
    })();

    bindUnitToggle();
    registerThemeStarfield(starfield);
    bindControls(starfield);
    bindSearch(starfield, catalog, searchIndex, starLabels, cloudCatalog);
    createDiscMask(starfield);
    createConstellationOverlay(starfield);
    createDistanceVectorOverlay(starfield, starLabels);
    createFocusRingOverlay(starfield);
    createScaleBar(starfield);
    bindWarpButton(starfield);

    // Apply any URL state before starting the URL writer so we don't echo
    // the same params back into history on load.
    applyFromUrl(starfield);
    startUrlSync(starfield);

    const countLabel = `${catalog.count.toLocaleString()} stars`;
    const renderMeta = () => {
      // Two-line layout: focused name + classifier on top, total count
      // beneath. Distance from Sol used to live here but is now in the Sol
      // locator arrow's label, so it'd be redundant — skip it.
      // Star and cloud focus are mutually exclusive in Starfield, so at
      // most one of these is non-null.
      const starIdx = starfield.getFocusedStar();
      const cloudIdx = starfield.getFocusedCloud();
      let focusLine = '';
      if (starIdx !== null) {
        const name = starLabels.get(starIdx) ?? `Unnamed #${starIdx}`;
        const conIdx = catalog.constellation[starIdx];
        const con = conIdx !== 255 ? catalog.constellations[conIdx].name : '';
        focusLine = con
          ? `${escapeHtml(name)} · ${escapeHtml(con)}`
          : escapeHtml(name);
      } else if (cloudIdx !== null && cloudCatalog) {
        const c = cloudCatalog.clouds[cloudIdx];
        focusLine = `${escapeHtml(c.name)} · Molecular cloud`;
      }
      if (!focusLine) {
        meta.innerHTML = `<div class="meta-count">${escapeHtml(countLabel)}</div>`;
        return;
      }
      meta.innerHTML =
        `<div class="meta-focus">${focusLine}</div>` +
        `<div class="meta-count">${escapeHtml(countLabel)}</div>`;
    };
    renderMeta();
    starfield.onFocusChange(renderMeta);
    starfield.onCloudFocusChange(renderMeta);
    onUnitChange(renderMeta);

    bindHoverTooltip(canvas, tooltip, starfield, describeStarDetailed, describeCloud);

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
      maybeShowInfoModal(catalog.count);
    }, 400);

    // Cloud hover description — shares the same {name, lines} shape as the
    // star tooltip so bindHoverTooltip can render either through one path.
    function describeCloud(idx: number): { name: string; lines: string[] } | null {
      const cat = starfield.getCloudCatalog();
      if (!cat) return null;
      const c = cat.clouds[idx];
      if (!c) return null;
      const lines: string[] = ['Molecular cloud'];
      lines.push(`Distance · ${fmtDist(c.distanceFromSol)}`);
      // For Z2021 ellipsoid clouds the three axes carry useful shape info;
      // for Z2020 spheres axes[0..2] are equal so we collapse to a single
      // radius.
      const [ax, ay, az] = c.axes;
      const axEq = Math.abs(ax - ay) < 0.05 && Math.abs(ay - az) < 0.05;
      lines.push(
        axEq
          ? `Radius · ${ax.toFixed(0)} pc`
          : `Axes · ${ax.toFixed(0)} × ${ay.toFixed(0)} × ${az.toFixed(0)} pc`,
      );
      return { name: c.name, lines };
    }

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
  starfield: Starfield,
  detailedStar: (i: number) => { name: string; lines: string[] },
  detailedCloud: (i: number) => { name: string; lines: string[] } | null,
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
      // Stars take priority — they're the primary interaction target. If
      // no star is under the cursor, fall back to a cloud hit so users
      // can identify Taurus / Orion / etc. by hovering.
      const starIdx = starfield.pickStar(lastX, lastY, 14);
      let payload: { name: string; lines: string[] } | null = null;
      if (starIdx >= 0) {
        payload = detailedStar(starIdx);
      } else {
        const cloudIdx = starfield.pickCloud(lastX, lastY);
        if (cloudIdx !== null) payload = detailedCloud(cloudIdx);
      }
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

main();
