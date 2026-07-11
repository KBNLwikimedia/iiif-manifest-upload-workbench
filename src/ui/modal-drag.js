// Draggable modals (OI-83). One delegated pointer handler lets the user move
// any modal by its header (`.modal__head`), so a dialog can be shifted aside to
// reveal the greyed-out main screen behind it.
//
// - The default position is unchanged: modals stay centred by `.modal-backdrop`;
//   dragging just adds a `transform: translate()` offset on the `.modal`.
// - Reset per open: each modal mounts a fresh element, so a reopened modal has
//   no stored offset and is centred again (offsets live in a per-element
//   WeakMap, not persisted).
// - Header controls (the ×, other buttons, inputs) do NOT start a drag, so the
//   dismissal rules (OI-31/OI-70) are untouched — a drag is not a click.
// - Clamped to the viewport so the modal can't be dragged fully off-screen.
//
// Loaded once as a side-effect import from main.jsx; no per-modal wiring.

const offsets = new WeakMap(); // .modal element -> { x, y } current offset
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [contenteditable="true"]';
const KEEP_X = 120; // px of the modal kept visible horizontally
const TOP_MARGIN = 8; // never let the header go above this
const BOTTOM_KEEP = 48; // keep at least this much of the header reachable

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function onPointerDown(e) {
  if (e.button !== 0) return; // left button only
  const head = e.target.closest && e.target.closest('.modal__head');
  if (!head) return;
  // Let interactive header controls behave normally (×, buttons, inputs).
  if (e.target.closest(INTERACTIVE)) return;
  const modal = head.closest('.modal');
  if (!modal) return;

  const start = offsets.get(modal) || { x: 0, y: 0 };
  const rect = modal.getBoundingClientRect();
  const baseLeft = rect.left - start.x;
  const baseTop = rect.top - start.y;
  const w = rect.width;
  const startX = e.clientX;
  const startY = e.clientY;

  const minX = -(w - KEEP_X) - baseLeft;
  const maxX = (window.innerWidth - KEEP_X) - baseLeft;
  const minY = TOP_MARGIN - baseTop;
  const maxY = (window.innerHeight - BOTTOM_KEEP) - baseTop;

  try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  modal.classList.add('modal--dragging');
  e.preventDefault();

  const move = (ev) => {
    const nx = clamp(start.x + (ev.clientX - startX), minX, maxX);
    const ny = clamp(start.y + (ev.clientY - startY), minY, maxY);
    modal.style.transform = `translate(${nx}px, ${ny}px)`;
    offsets.set(modal, { x: nx, y: ny });
  };
  const end = (ev) => {
    try { head.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    modal.classList.remove('modal--dragging');
    head.removeEventListener('pointermove', move);
    head.removeEventListener('pointerup', end);
    head.removeEventListener('pointercancel', end);
  };
  head.addEventListener('pointermove', move);
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', onPointerDown, true);
}
