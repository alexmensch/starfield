import { loadCatalog } from './catalog-loader';
import { Starfield } from './starfield';
import { bindControls } from './controls';
import { bindSearch, buildStarLabels, buildSpectralMap, type SearchIndexEntry } from './search';
import { createConstellationOverlay } from './constellation-overlay';
import { createDiscMask } from './disc-mask';
import { createDistanceVectorOverlay } from './distance-vector-overlay';
import { createFocusRingOverlay } from './focus-ring-overlay';
import { createScaleBar } from './scale-bar';
import { bindUnitToggle } from './unit-toggle';
import { bindThemeToggle } from './theme-toggle';
import { bindPanelLayout } from './panel-layout';
import { bindWarpButton } from './warp-button';
import { maybeShowInfoModal } from './info-modal';
import { applyFromUrl, startUrlSync } from './url-state';
import { fmtDist, onUnitChange } from './distance-util';

const HOVER_DELAY_MS = 280;

async function main() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const loading = document.getElementById('loading')!;
  const loadingBar = document.getElementById('loading-bar')!;
  const loadingStatus = document.getElementById('loading-status')!;
  const topbar = document.getElementById('topbar')!;
  const panel = document.getElementById('panel')!;
  const meta = document.getElementById('meta')!;
  const tooltip = document.getElementById('tooltip')!;

  try {
    const [catalog, searchIndex] = await Promise.all([
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
    ]);

    loadingStatus.textContent = `Parsed ${catalog.count.toLocaleString()} stars`;
    loadingBar.style.width = '100%';

    const starLabels = buildStarLabels(catalog, searchIndex);
    const spectralMap = buildSpectralMap(searchIndex);

    const starfield = new Starfield({ canvas, catalog });
    bindUnitToggle();
    bindThemeToggle(starfield);
    bindControls(starfield);
    bindSearch(starfield, catalog, searchIndex, starLabels);
    createDiscMask(starfield);
    createConstellationOverlay(starfield);
    createDistanceVectorOverlay(starfield);
    createFocusRingOverlay(starfield);
    createScaleBar(starfield);
    bindWarpButton(starfield);

    // Apply any URL state before starting the URL writer so we don't echo
    // the same params back into history on load.
    applyFromUrl(starfield);
    startUrlSync(starfield);

    const countLabel = `${catalog.count.toLocaleString()} stars`;
    let lastSelected: number | null = starfield.getFocusedStar();
    const renderMeta = () => {
      meta.textContent = lastSelected !== null
        ? `${describeStar(lastSelected)} · ${countLabel}`
        : countLabel;
    };
    renderMeta();
    starfield.onFocusChange((idx) => {
      lastSelected = idx;
      renderMeta();
    });
    onUnitChange(renderMeta);

    bindHoverTooltip(canvas, tooltip, starfield, describeStarDetailed);

    await new Promise((r) => requestAnimationFrame(r));
    loading.style.transition = 'opacity 0.4s ease';
    loading.style.opacity = '0';
    setTimeout(() => {
      loading.remove();
      topbar.hidden = false;
      panel.hidden = false;
      meta.hidden = false;
      bindPanelLayout();
      maybeShowInfoModal(catalog.count);
    }, 400);

    // Short one-line form — used in the meta bar where horizontal space
    // is tight.
    function describeStar(idx: number): string {
      const name = starLabels.get(idx) ?? `Unnamed #${idx}`;
      const conIdx = catalog.constellation[idx];
      const con = conIdx !== 255 ? catalog.constellations[conIdx].name : '';
      const p = catalog.positions;
      const dist = Math.sqrt(
        p[idx * 3] ** 2 + p[idx * 3 + 1] ** 2 + p[idx * 3 + 2] ** 2,
      );
      return `${name}${con ? ' · ' + con : ''} · ${fmtDist(dist)}`;
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
  detailed: (i: number) => { name: string; lines: string[] },
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
      const idx = starfield.pickStar(lastX, lastY, 14);
      if (idx < 0) return;
      const { name, lines } = detailed(idx);
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
