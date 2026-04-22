import { loadCatalog } from './catalog-loader';
import { Starfield } from './starfield';
import { bindControls } from './controls';
import { bindSearch } from './search';
import { createConstellationOverlay } from './constellation-overlay';
import { createDistanceVectorOverlay } from './distance-vector-overlay';
import { createFocusRingOverlay } from './focus-ring-overlay';
import { createScaleBar } from './scale-bar';
import { bindUnitToggle } from './unit-toggle';
import { bindThemeToggle } from './theme-toggle';
import { bindPanelLayout } from './panel-layout';
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
    const catalog = await loadCatalog(
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
    );

    loadingStatus.textContent = `Parsed ${catalog.count.toLocaleString()} stars`;
    loadingBar.style.width = '100%';

    const starfield = new Starfield({ canvas, catalog });
    bindUnitToggle();
    bindThemeToggle(starfield);
    bindControls(starfield);
    bindSearch(starfield, catalog);
    createConstellationOverlay(starfield);
    createDistanceVectorOverlay(starfield);
    createFocusRingOverlay(starfield);
    createScaleBar(starfield);

    // Apply any URL state before starting the URL writer so we don't echo
    // the same params back into history on load.
    applyFromUrl(starfield);
    startUrlSync(starfield);

    const countLabel = `${catalog.count.toLocaleString()} stars · ${catalog.names.size} named`;
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

    bindHoverTooltip(canvas, tooltip, starfield, describeStar);

    await new Promise((r) => requestAnimationFrame(r));
    loading.style.transition = 'opacity 0.4s ease';
    loading.style.opacity = '0';
    setTimeout(() => {
      loading.remove();
      topbar.hidden = false;
      panel.hidden = false;
      meta.hidden = false;
      bindPanelLayout();
      maybeShowInfoModal();
    }, 400);

    function describeStar(idx: number): string {
      const name = catalog.names.get(idx) ?? 'Unnamed';
      const conIdx = catalog.constellation[idx];
      const con = conIdx !== 255 ? catalog.constellations[conIdx].name : '';
      const p = catalog.positions;
      const dist = Math.sqrt(
        p[idx * 3] ** 2 + p[idx * 3 + 1] ** 2 + p[idx * 3 + 2] ** 2,
      );
      return `${name}${con ? ' · ' + con : ''} · ${fmtDist(dist)}`;
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
  describe: (i: number) => string,
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
      const text = describe(idx);
      const [name, ...rest] = text.split(' · ');
      tooltip.innerHTML = `<div class="tt-name">${escapeHtml(name)}</div>${rest.length ? `<div class="tt-sub">${escapeHtml(rest.join(' · '))}</div>` : ''}`;
      const maxLeft = window.innerWidth - 260;
      const maxTop = window.innerHeight - 64;
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
