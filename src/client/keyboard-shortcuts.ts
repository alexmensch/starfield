import type { Starfield } from './starfield';
import { DEFAULT_FOV } from './starfield';
import { bindHelpModal } from './help-modal';

// Single global keydown listener with a small dispatch table. Every
// shortcut is a thin wrapper over an existing public API so future
// behavioural changes propagate automatically — see CLAUDE.md and the
// plan for the rationale.

const MAG_STEP = 0.5;
const MAG_MIN = -2;
const MAG_MAX = 15;

export function bindKeyboardShortcuts(starfield: Starfield) {
  const help = bindHelpModal();

  // The "go" picker reuses the topbar's existing `.search-wrap` widget —
  // whatever inputs `bindSearch` puts there (Focus / To / Location) are
  // what the modal exposes. The "constellation" picker does the same
  // with `#con-typeahead`. We move the live element into the modal card
  // on open, restore it on close — so all wiring (Fuse search, OBSERVE
  // mode handling, blur-pick race) keeps working unchanged.
  const goModal = bindRelocateModal({
    source: () => document.querySelector<HTMLElement>('.search-wrap'),
    focusTarget: () => {
      const toRow = document.getElementById('search-to-row');
      const toInput = document.getElementById('search-to') as HTMLInputElement | null;
      if (toRow && !toRow.hidden && toInput) return toInput;
      return document.getElementById('search-focus') as HTMLInputElement | null;
    },
  });
  const conModal = bindRelocateModal({
    // Move the wrapper rather than just `#con-typeahead` so the panel's
    // existing "reset" link comes along — gives the modal a built-in
    // clear path without re-implementing it.
    source: () => document.getElementById('con-picker'),
    focusTarget: () => document.getElementById('con-input') as HTMLInputElement | null,
  });

  // Capture phase so we observe foreground-modal state BEFORE bubble-phase
  // handlers (brand-modal / info-modal / help-modal) flip `hidden=true` on
  // ESC. Without capture, our cascade would fire after a modal closed itself
  // because the visibility check would already see no modal open.
  window.addEventListener('keydown', (e) => {
    // Don't claim shortcuts when a system modifier is held — Cmd+R /
    // Ctrl+R is browser reload, Cmd+= is zoom-in, etc. Shift is fine
    // (it's how `+` and `?` are typed on US layouts).
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') {
      // Highest priority: an open kb-modal (Go / Constellation) closes
      // even if its input has focus. SearchBox / typeahead bail their own
      // ESC when the dropdown has no results (empty input), so we own ESC
      // for the kb-modal regardless.
      const kbModal = document.getElementById('kb-modal');
      if (kbModal && !kbModal.hidden) {
        goModal.close();
        conModal.close();
        e.preventDefault();
        return;
      }
      // Any other foreground modal (info / about / credits / help) owns
      // its own ESC via its own document listener — stay out of the way
      // so the cascade doesn't run AFTER the modal closes itself.
      if (anyVisibleSelector('.modal')) return;
      // Warp owns ESC via warp-button.ts.
      if (starfield.getWarpActive()) return;
      // Search/typeahead inputs handle ESC themselves (clear dropdown +
      // blur). Skip our cascade in that case.
      if (targetIsEditable(e.target)) return;
      escCascade(starfield);
      return;
    }

    // Non-ESC shortcuts — skip when typing or when any modal is open.
    if (targetIsEditable(e.target)) return;
    if (anyVisibleSelector('.modal') || anyVisibleSelector('.kb-modal')) return;

    switch (e.key) {
      case 'r': case 'R':
        resetCameraSection(starfield);
        e.preventDefault();
        break;
      case 'g': case 'G':
        goModal.open();
        e.preventDefault();
        break;
      case 'c': case 'C':
        // Master toggle gates the picker UI — keep the shortcut quiet too
        // so it doesn't pop a disabled input into a modal.
        if (starfield.getFilter().showConstellation) {
          conModal.open();
          e.preventDefault();
        }
        break;
      case 'h': case 'H':
        starfield.setFilter({ showHud: !starfield.getFilter().showHud });
        e.preventDefault();
        break;
      case 's': case 'S':
        starfield.setFilter({
          showGalacticGrid: !starfield.getFilter().showGalacticGrid,
        });
        e.preventDefault();
        break;
      case 'o': case 'O':
        // Mirror the panel's observe-button enable rule: only valid when
        // a star is focused. setCameraMode no-ops without focus anyway,
        // but bailing here keeps the key from feeling unresponsive.
        if (starfield.getFocusedStar() !== null) {
          starfield.setCameraMode('observe');
          e.preventDefault();
        }
        break;
      case 'm': case 'M':
        // Chart mode toggle. Observe-only — chart needs a focal star and
        // a stable camera (orbit camera doesn't make sense for reading
        // labels). No-op outside observe rather than auto-mode-switching:
        // the user should know they're entering observe before chart
        // engages on top.
        if (starfield.getCameraMode() === 'observe') {
          starfield.setFilter({ chart: !starfield.getFilter().chart });
          e.preventDefault();
        }
        break;
      case '?':
        help.open();
        e.preventDefault();
        break;
      case '+':
        adjustMag(starfield, +MAG_STEP);
        e.preventDefault();
        break;
      case '-':
        adjustMag(starfield, -MAG_STEP);
        e.preventDefault();
        break;
      case '=':
        starfield.applyMagnitudePreset('naked-eye');
        e.preventDefault();
        break;
    }
  }, { capture: true });
}

function adjustMag(starfield: Starfield, delta: number) {
  const cur = starfield.getFilter().maxAppMag;
  const next = clamp(cur + delta, MAG_MIN, MAG_MAX);
  starfield.setFilter({ maxAppMag: next });
}

// R: reset only the sliders living under the panel's "Camera" section —
// star size min/max, dynamic range, FOV, exaggeration. Mirrors the
// per-row "reset" buttons wired in controls.ts:159-176.
function resetCameraSection(starfield: Starfield) {
  starfield.clearSizeOverrides(['sizeMin', 'sizeMax']);
  starfield.clearSizeOverrides(['sizeSpan']);
  starfield.setCameraFov(DEFAULT_FOV);
  starfield.setStarExaggerationK(starfield.getStarExaggerationKDefault());
}

// ESC progression: observe→navigate (keep focus, animated exit), then
// in navigate clear destination if any, else clear focus. A no-op if
// neither is set.
function escCascade(starfield: Starfield) {
  if (starfield.getCameraMode() === 'observe') {
    starfield.setCameraMode('navigate');
    return;
  }
  if (
    starfield.getVectorTo() !== null ||
    starfield.getVectorToCloud() !== null
  ) {
    starfield.setVectorTo(null);
    starfield.setVectorToCloud(null);
    return;
  }
  if (
    starfield.getFocusedStar() !== null ||
    starfield.getFocusedCloud() !== null
  ) {
    starfield.unfocus();
  }
}

interface RelocateModalOptions {
  source: () => HTMLElement | null;
  focusTarget: () => HTMLInputElement | null;
}

// Shared "move existing widget into a centred card" modal. One DOM
// container (#kb-modal) is reused across the two pickers — only one
// can be open at a time anyway. Close triggers: backdrop click, input
// blur (covers ESC-inside-input, click-outside, and pick-then-blur via
// SearchBox.pick()).
function bindRelocateModal(
  opts: RelocateModalOptions,
): { open: () => void; close: () => void } {
  const modal = document.getElementById('kb-modal')!;
  const card = document.getElementById('kb-modal-card')!;
  const backdrop = modal.querySelector<HTMLElement>('.kb-modal-backdrop')!;

  let originalParent: HTMLElement | null = null;
  let originalNextSibling: Node | null = null;
  let openWidget: HTMLElement | null = null;
  let openInput: HTMLInputElement | null = null;
  let pendingClose: number | null = null;

  const onInputBlur = () => {
    // Defer slightly so a result mousedown inside SearchBox.pick() — which
    // calls input.blur() right after firing onSelect — finishes its state
    // changes before we tear down the modal. SearchBox itself uses a 140ms
    // deferral; we sit just after it.
    if (pendingClose !== null) clearTimeout(pendingClose);
    pendingClose = window.setTimeout(() => {
      pendingClose = null;
      close();
    }, 180);
  };
  const onInputFocus = () => {
    // X-clear inside SearchBox refocuses the input synchronously after
    // blurring — cancel the pending close so the modal doesn't disappear
    // mid-edit.
    if (pendingClose !== null) {
      clearTimeout(pendingClose);
      pendingClose = null;
    }
  };

  const close = () => {
    if (!openWidget) return;
    if (pendingClose !== null) {
      clearTimeout(pendingClose);
      pendingClose = null;
    }
    if (openInput) {
      // Detach the modal-specific blur handler before we explicitly blur
      // the input below, so the synthetic blur doesn't re-enter close()
      // through `onInputBlur`'s deferred timer.
      openInput.removeEventListener('blur', onInputBlur);
      openInput.removeEventListener('focus', onInputFocus);
      // Synchronously blur the input so the SearchBox / typeahead
      // restore-on-blur listener fires. Without this, the DOM move below
      // can drop focus silently and the input keeps any half-typed value
      // the user just abandoned with ESC.
      openInput.blur();
      openInput = null;
    }
    backdrop.removeEventListener('click', close);
    if (originalParent) {
      originalParent.insertBefore(openWidget, originalNextSibling);
    }
    openWidget = null;
    originalParent = null;
    originalNextSibling = null;
    modal.hidden = true;
  };

  const open = () => {
    if (openWidget) return;
    const widget = opts.source();
    const input = opts.focusTarget();
    if (!widget || !input || !widget.parentElement) return;

    originalParent = widget.parentElement;
    originalNextSibling = widget.nextSibling;
    card.appendChild(widget);
    openWidget = widget;
    openInput = input;
    modal.hidden = false;

    backdrop.addEventListener('click', close);
    input.addEventListener('blur', onInputBlur);
    input.addEventListener('focus', onInputFocus);

    // Focus on the next frame so the modal show + DOM move settle first.
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  };

  return { open, close };
}

function targetIsEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true;
  return t.isContentEditable;
}

function anyVisibleSelector(selector: string): boolean {
  const nodes = document.querySelectorAll<HTMLElement>(selector);
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].hidden) return true;
  }
  return false;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
