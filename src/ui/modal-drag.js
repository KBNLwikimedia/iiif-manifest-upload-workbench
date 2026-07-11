// Draggable + resizable modals (OI-83). One global set of pointer handlers
// lets the user move a modal by its header and resize it by dragging any edge
// or corner, so a dialog can be shifted aside and grown to read the content /
// the greyed-out main screen behind it.
//
// - Default position + size are unchanged: modals start centred by
//   `.modal-backdrop` at their CSS width. On the first drag/resize the modal is
//   "detached" to `position: fixed` at its current spot (so changing the width
//   no longer re-centres it, keeping the opposite edge anchored). Nothing is
//   persisted — each modal mounts a fresh element, so a reopened modal is
//   centred at its default size again.
// - Header controls (×, buttons, inputs) and any interactive element don't
//   start a drag or resize, so the dismissal rules (OI-31/OI-70) are untouched.
// - Clamped to the viewport: a modal can't be dragged off-screen, and resize is
//   bounded by a minimum size and the viewport edges.
//
// Loaded once as a side-effect import from main.jsx; no per-modal wiring.

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]';

const EDGE = 8;        // px band around the border that starts a resize
const MIN_W = 320;
const MIN_H = 160;
const MARGIN = 8;      // keep the modal at least this far inside the viewport
const KEEP_X = 120;    // px kept visible horizontally when dragging
const BOTTOM_KEEP = 48;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let active = false; // a drag/resize is in progress

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

// Which edges (if any) the pointer is over, for a given modal.
function edgesAt(modal, x, y) {
  const r = modal.getBoundingClientRect();
  if (x < r.left - EDGE || x > r.right + EDGE || y < r.top - EDGE || y > r.bottom + EDGE) return null;
  const e = {
    l: x - r.left <= EDGE,
    r: r.right - x <= EDGE,
    t: y - r.top <= EDGE,
    b: r.bottom - y <= EDGE,
  };
  return (e.l || e.r || e.t || e.b) ? e : null;
}

function cursorFor(e) {
  if ((e.l && e.t) || (e.r && e.b)) return 'nwse-resize';
  if ((e.r && e.t) || (e.l && e.b)) return 'nesw-resize';
  if (e.l || e.r) return 'ew-resize';
  return 'ns-resize';
}

function begin(e, modal, handle, onMove) {
  detach(modal);
  try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  modal.classList.add('modal--dragging');
  active = true;
  e.preventDefault();
  const end = (ev) => {
    try { handle.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    modal.classList.remove('modal--dragging');
    active = false;
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function startResize(e, modal, edges) {
  // Anchors captured once, in viewport coords (fixed positioning after detach).
  const r0 = (detach(modal), modal.getBoundingClientRect());
  const L = r0.left;
  const T = r0.top;
  const R = r0.right;
  const B = r0.bottom;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const move = (ev) => {
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
  };
  begin(e, modal, modal, move);
}

function startDrag(e, modal, head) {
  const r0 = (detach(modal), modal.getBoundingClientRect());
  const L = r0.left;
  const T = r0.top;
  const w = r0.width;
  const startX = e.clientX;
  const startY = e.clientY;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const move = (ev) => {
    const left = clamp(L + (ev.clientX - startX), -(w - KEEP_X), vw - KEEP_X);
    const top = clamp(T + (ev.clientY - startY), MARGIN, vh - BOTTOM_KEEP);
    modal.style.left = `${Math.round(left)}px`;
    modal.style.top = `${Math.round(top)}px`;
  };
  begin(e, modal, head, move);
}

function onPointerDown(e) {
  if (e.button !== 0) return; // left button only
  const modal = e.target.closest && e.target.closest('.modal');
  if (!modal) return;
  if (e.target.closest(INTERACTIVE)) return; // never hijack a control

  const edges = edgesAt(modal, e.clientX, e.clientY);
  if (edges) { startResize(e, modal, edges); return; }

  const head = e.target.closest('.modal__head');
  if (head) startDrag(e, modal, head);
}

// Hover feedback: show the resize cursor when the pointer is near an edge.
let hovered = null;
function onHover(e) {
  if (active) return;
  const modal = e.target.closest && e.target.closest('.modal');
  if (hovered && hovered !== modal) { hovered.style.cursor = ''; hovered = null; }
  if (!modal) return;
  const edges = (e.target.closest(INTERACTIVE)) ? null : edgesAt(modal, e.clientX, e.clientY);
  modal.style.cursor = edges ? cursorFor(edges) : '';
  hovered = modal;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onHover, true);
}
