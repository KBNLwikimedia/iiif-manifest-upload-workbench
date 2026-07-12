// Draggable + resizable modals (OI-83). One global set of pointer handlers
// lets the user move a modal by its header and resize it by dragging any edge
// or corner, so a dialog can be shifted aside and grown to read the content /
// the greyed-out main screen behind it.
//
// - Default position + size are unchanged: modals start centred by
//   `.modal-backdrop` at their CSS width. On the first drag/resize the modal is
//   "detached" to `position: fixed` at its current spot (so changing the width
//   no longer re-centres it, keeping the opposite edge anchored). Nothing is
//   persisted — a reopened modal is a fresh element, centred at default size.
// - The resize band spans a few px on BOTH sides of the border, so an edge is
//   grabbable from just *outside* the modal too (over the backdrop). That's the
//   fix for a vertical scrollbar sitting on the right edge: you can't change the
//   cursor over a native scrollbar or reliably start a drag on it, so the
//   grab-zone just outside the border keeps the right edge resizable.
// - Header controls (×, buttons, inputs) and any interactive element don't
//   start a drag or resize, so the dismissal rules (OI-31/OI-70) are untouched;
//   an outside-edge resize also suppresses the backdrop's close-on-click.
// - Clamped to the viewport: min size + can't be dragged/grown off-screen.
//
// Loaded once as a side-effect import from main.jsx; no per-modal wiring.

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]';
// Text elements in the header: pressing these should SELECT text, not start a
// drag (so a user can copy the manuscript title / signature). Dragging still
// works from the header's padding, grip, and thumbnail (non-text targets).
const HEADER_TEXT = 'h1, h2, h3, h4, h5, h6, p, span, code, strong, em, b, i';

const EDGE = 9;        // px band on each side of the border that starts a resize
const MIN_W = 320;
const MIN_H = 160;
const MARGIN = 8;      // keep the modal at least this far inside the viewport
const KEEP_X = 120;    // px kept visible horizontally when dragging
const BOTTOM_KEEP = 48;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let active = false;   // a drag/resize is in progress
let hovered = null;   // element whose inline cursor we last set

// Pin the modal at its current on-screen box with position:fixed, so later
// width/height/position changes are explicit (no flex re-centring). Idempotent.
function detach(modal) {
  if (modal.dataset.floating === '1') return;
  const r = modal.getBoundingClientRect();
  const s = modal.style;
  s.position = 'fixed';
  s.left = `${Math.round(r.left)}px`;
  s.top = `${Math.round(r.top)}px`;
  s.width = `${Math.round(r.width)}px`;
  s.height = `${Math.round(r.height)}px`;
  s.margin = '0';
  s.maxWidth = 'none';
  s.maxHeight = 'none';
  s.transform = 'none';
  modal.dataset.floating = '1';
}

// Which edges (if any) the pointer is over — within EDGE on either side of the
// modal's border, so grabbing just outside the modal counts too.
function edgesAt(modal, x, y) {
  const r = modal.getBoundingClientRect();
  if (x < r.left - EDGE || x > r.right + EDGE || y < r.top - EDGE || y > r.bottom + EDGE) return null;
  const e = {
    l: Math.abs(x - r.left) <= EDGE,
    r: Math.abs(x - r.right) <= EDGE,
    t: Math.abs(y - r.top) <= EDGE,
    b: Math.abs(y - r.bottom) <= EDGE,
  };
  return (e.l || e.r || e.t || e.b) ? e : null;
}

function cursorFor(e) {
  if ((e.l && e.t) || (e.r && e.b)) return 'nwse-resize';
  if ((e.r && e.t) || (e.l && e.b)) return 'nesw-resize';
  if (e.l || e.r) return 'ew-resize';
  return 'ns-resize';
}

// Resolve the pointer to a modal, whether it's over the modal itself or just
// outside it over the backdrop.
function resolve(e) {
  const el = e.target;
  if (!el || !el.closest) return null;
  const inside = el.closest('.modal');
  if (inside) return { modal: inside, host: inside, interactive: !!el.closest(INTERACTIVE), outside: false };
  const bd = el.closest('.modal-backdrop');
  if (bd) {
    const modal = bd.querySelector('.modal');
    if (modal) return { modal, host: bd, interactive: false, outside: true };
  }
  return null;
}

function begin(e, modal, onMove) {
  detach(modal);
  modal.classList.add('modal--dragging');
  active = true;
  e.preventDefault();
  const move = (ev) => onMove(ev);
  const end = () => {
    modal.classList.remove('modal--dragging');
    active = false;
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', end, true);
    document.removeEventListener('pointercancel', end, true);
  };
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
}

function startResize(e, modal, edges) {
  const r0 = (detach(modal), modal.getBoundingClientRect());
  const L = r0.left, T = r0.top, R = r0.right, B = r0.bottom;
  const vw = window.innerWidth, vh = window.innerHeight;
  begin(e, modal, (ev) => {
    const s = modal.style;
    if (edges.r) s.width = `${Math.round(clamp(ev.clientX - L, MIN_W, vw - MARGIN - L))}px`;
    if (edges.b) s.height = `${Math.round(clamp(ev.clientY - T, MIN_H, vh - MARGIN - T))}px`;
    if (edges.l) {
      const left = clamp(ev.clientX, MARGIN, R - MIN_W);
      s.left = `${Math.round(left)}px`;
      s.width = `${Math.round(R - left)}px`;
    }
    if (edges.t) {
      const top = clamp(ev.clientY, MARGIN, B - MIN_H);
      s.top = `${Math.round(top)}px`;
      s.height = `${Math.round(B - top)}px`;
    }
  });
}

function startDrag(e, modal) {
  const r0 = (detach(modal), modal.getBoundingClientRect());
  const L = r0.left, T = r0.top, w = r0.width;
  const startX = e.clientX, startY = e.clientY;
  const vw = window.innerWidth, vh = window.innerHeight;
  begin(e, modal, (ev) => {
    modal.style.left = `${Math.round(clamp(L + (ev.clientX - startX), -(w - KEEP_X), vw - KEEP_X))}px`;
    modal.style.top = `${Math.round(clamp(T + (ev.clientY - startY), MARGIN, vh - BOTTOM_KEEP))}px`;
  });
}

// Stop the backdrop's close-on-click that would otherwise fire after an
// outside-edge resize (pointer down + up over the backdrop).
function suppressNextBackdropClick(bd) {
  const kill = (ev) => { ev.stopPropagation(); ev.preventDefault(); bd.removeEventListener('click', kill, true); };
  bd.addEventListener('click', kill, true);
  setTimeout(() => bd.removeEventListener('click', kill, true), 400);
}

function onPointerDown(e) {
  if (e.button !== 0) return; // left button only
  const res = resolve(e);
  if (!res || res.interactive) return;
  const edges = edgesAt(res.modal, e.clientX, e.clientY);
  if (edges) {
    if (res.outside) suppressNextBackdropClick(res.host);
    startResize(e, res.modal, edges);
    return;
  }
  if (!res.outside) {
    const head = e.target.closest('.modal__head');
    // Don't start a drag when pressing header text — let the browser select it.
    if (head && !e.target.closest(HEADER_TEXT)) startDrag(e, res.modal);
  }
}

// Hover feedback: show the matching resize cursor near an edge (inside or just
// outside the modal), so the affordance survives a right-edge scrollbar.
function onHover(e) {
  if (active) return;
  const res = resolve(e);
  const host = res && res.host;
  if (hovered && hovered !== host) { hovered.style.cursor = ''; hovered = null; }
  if (!res) return;
  const edges = res.interactive ? null : edgesAt(res.modal, e.clientX, e.clientY);
  res.host.style.cursor = edges ? cursorFor(edges) : '';
  hovered = res.host;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onHover, true);
}
