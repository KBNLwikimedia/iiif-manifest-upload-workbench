import React from 'react';
import { createPortal } from 'react-dom';
import { buildWikitext } from './api/publish.js';
import { categoryExists } from './api/commons.js';
import {
  validateTitleLocal,
  buildFutureFilename,
  getCachedUniqueness,
  makeUniquenessChecker,
  cleanTitleForCommit,
  isSequencePlaceholderTitle,
  buildSequencePlaceholderTitle,
} from './api/title-validation.js';
import { findOwnedSequenceFiles } from './api/sequence.js';

// Editable / sortable / resizable / hideable table with pop-out cell editor,
// paste-mode, range/drag selection, keyboard nav, vocabulary-driven autocomplete,
// depicts (P180), EXIF columns, lightbox, header default-values, and pill info popovers.

const { useState: useStateT, useMemo: useMemoT, useRef: useRefT, useEffect: useEffectT } = React;

// ===== Caption (SDC label) validation =====
// Wikibase enforces a 250-char limit on labels and disallows newlines/vertical
// whitespace. Captions are plain text — no wikitext, no HTML, no links.
// Surfacing these here means the user sees the same constraints the server
// would reject, instead of getting a publish-time API error.
// See: https://commons.wikimedia.org/wiki/Commons:File_captions
//
// Whitespace handling: leading/trailing whitespace is silently trimmed at
// commit time (see CaptionEditor.commit / CaptionField.commit). The validator
// therefore treats the *trimmed* string as the source of truth — a user
// hitting space mid-edit doesn't get a scary error, and the saved value never
// has dangling whitespace. We do not surface trim-whitespace as an error code.
const CAPTION_MAX_LENGTH = 250;
// At what length we start showing the live counter. Below this, the field
// looks like any other text input — no counter, no nag. The 200/250 split
// matches the maintainer's spec: the user only sees the cap once they're
// approaching it.
const CAPTION_COUNTER_THRESHOLD = 200;

function validateCaption(text) {
  const raw = text == null ? "" : String(text);
  const value = raw.trim();
  const length = [...value].length; // count grapheme code points; matches the limit users perceive
  const errors = [];
  if (length > CAPTION_MAX_LENGTH) {
    // Counter renders the actual N / 250, so we don't repeat the count here.
    errors.push({ code: "too-long", message: `Captions must be under ${CAPTION_MAX_LENGTH} characters.` });
  }
  if (/[\n\r\v\t]/.test(value)) {
    errors.push({ code: "no-newline", message: "Captions must be a single line — remove line breaks and tabs." });
  }
  if (/<[a-zA-Z!\/]/.test(value)) {
    errors.push({ code: "no-html", message: "Captions can't contain HTML — write the text as plain prose." });
  }
  if (/\[\[|\]\]|\{\{|\}\}/.test(value)) {
    errors.push({ code: "no-wikitext", message: "Captions can't contain wikitext markup — drop the [[…]] or {{…}}." });
  }
  if (/\[https?:\/\//i.test(value) || /https?:\/\/\S/i.test(value)) {
    errors.push({ code: "no-url", message: "Captions can't contain URLs — describe the file in plain text instead." });
  }
  return { valid: errors.length === 0, errors, length };
}

// Expose so other modules (publish-modal, app-level guards) can import without a window-global.
window.validateCaption = validateCaption;
window.CAPTION_MAX_LENGTH = CAPTION_MAX_LENGTH;
window.CAPTION_COUNTER_THRESHOLD = CAPTION_COUNTER_THRESHOLD;

// ===== Caption template (T426424) =====
// The Caption (description) column's per-column default value supports a
// `{title}` token that resolves per-row to that row's title. This lets the
// user write a recipe like `Photo of {title}` once and apply it to every row,
// instead of typing the caption per file. The token is the only one in v1;
// the helper is structured so we can grow it (e.g. {filename}, {author}) by
// extending the replacement table.
//
// Numbering exclusion (T425984): when the auto-sequence task adds a trailing
// ` #` placeholder to titles (resolved to a concrete integer at publish
// time), the `{title}` substitution must NOT include that placeholder. Strip
// `\s*#\s*$` before substitution. Forward-compatible: stays a no-op until
// T425984 ships, so wiring it now doesn't depend on T425984's merge order.
const CAPTION_TEMPLATE_TOKEN = "{title}";
const SEQUENCE_PLACEHOLDER_RE = /\s*#\s*$/;

function stripSequencePlaceholder(title) {
  if (title == null) return "";
  return String(title).replace(SEQUENCE_PLACEHOLDER_RE, "").trim();
}

function captionTemplateUsesTitle(template) {
  return typeof template === "string" && template.includes(CAPTION_TEMPLATE_TOKEN);
}

function expandCaptionTemplate(template, item) {
  if (template == null) return "";
  const str = String(template);
  if (!str.includes(CAPTION_TEMPLATE_TOKEN)) return str;
  const titleVal = stripSequencePlaceholder(item && item.title);
  // Use split/join so multiple occurrences are all replaced — String.replace
  // without a /g flag would only swap the first one.
  return str.split(CAPTION_TEMPLATE_TOKEN).join(titleVal);
}

// Expose so app.jsx / columns-modal can apply the same expansion if needed.
window.expandCaptionTemplate = expandCaptionTemplate;
window.captionTemplateUsesTitle = captionTemplateUsesTitle;
window.CAPTION_TEMPLATE_TOKEN = CAPTION_TEMPLATE_TOKEN;

// ===== Static columns =====
// `editable: false` cells render as immutable (size, dimensions, status, EXIF — all derived from the file).
// `requireableKey` maps a column to the field key the required-fields modal toggles.
const TABLE_COLUMNS = [
  { key: "title",       label: "Title",        group: "standard",   sortable: true,  defaultWidth: 220, minWidth: 140, copyable: true,  editable: true,  truncate: "fade" },
  { key: "filename",    label: "Original filename", group: "standard", sortable: true, defaultWidth: 200, minWidth: 140, mono: true,      editable: false, truncate: "middle" },
  { key: "categories",  label: "Categories",   group: "standard",   sortable: true,  defaultWidth: 240, minWidth: 160, copyable: true,  editable: true,  truncate: "fade" },
  { key: "depicts",     label: "Depicts (P180)", group: "structured", sortable: true, defaultWidth: 220, minWidth: 160, copyable: true, editable: true,  truncate: "fade" },
  { key: "license",     label: "License",      group: "standard",   sortable: true,  defaultWidth: 130, minWidth: 100, copyable: true,  editable: true },
  { key: "author",      label: "Author",       group: "standard",   sortable: true,  defaultWidth: 140, minWidth: 100, copyable: true,  editable: true,  truncate: "fade" },
  { key: "source",      label: "Source",       group: "standard",   sortable: true,  defaultWidth: 160, minWidth: 100, copyable: true,  editable: true,  truncate: "fade" },
  // Institution: the {{Artwork}} |institution= value (e.g.
  // {{Institution:Koninklijke Bibliotheek, Den Haag}}). Chosen in the detail
  // panel from a curated list; the grid cell is read-only (editable: false).
  { key: "institution", label: "Institution",  group: "standard",   sortable: true,  defaultWidth: 200, minWidth: 120, copyable: true,  editable: false, truncate: "fade", mono: true },
  // Caption (SDC label). Multi-language by spec on Commons; the workbench
  // surfaces one Caption column per language the user wants to edit, with
  // a no-duplicate-language guard. The bare "description" key is the
  // English column (kept stable for legacy drafts/prefs); other languages
  // surface as "description:<lang>" keys (see CAPTION_COL_TEMPLATE below
  // and getAllColumns). T426422.
  {
    key: "description",
    label: "Caption",
    group: "standard",
    sortable: true,
    defaultWidth: 240,
    minWidth: 140,
    copyable: true,
    editable: true,
    truncate: "fade",
    caption: { lang: "en" },
    headerTooltip: "Caption (SDC label)",
    headerInfo: {
      // Surfaced via an info-icon popover in the header. See HeaderCell below.
      title: "What is a Caption?",
      bullets: [
        "Short plain-text label for the file (≤ 250 characters).",
        "Stored as the file's Wikibase label in Structured Data on Commons.",
        "No line breaks, HTML, wikitext, or links — captions render as plain text.",
        "One per language — add another Caption column for a second language from the column header menu.",
      ],
      link: { href: "https://commons.wikimedia.org/wiki/Commons:File_captions", text: "Commons:File captions" }
    }
  },
  { key: "size",        label: "Size",         group: "standard",   sortable: true,  defaultWidth: 76,  minWidth: 64,  align: "right",  numeric: true,    editable: false, immutable: true },
  { key: "dimensions",  label: "Dimensions",   group: "standard",   sortable: true,  defaultWidth: 110, minWidth: 90,  align: "right",  numeric: true,    editable: false, immutable: true },
  { key: "status",      label: "Status",       group: "standard",   sortable: true,  defaultWidth: 100, minWidth: 80,  editable: false, immutable: true },

  // EXIF / auto-derived structured data — visible by default now but greyed; immutable.
  { key: "camera",   label: "Camera",       group: "exif", tone: "exif", sortable: true, defaultWidth: 140, minWidth: 100, editable: false, immutable: true, truncate: "fade" },
  { key: "lens",     label: "Lens",         group: "exif", tone: "exif", sortable: true, defaultWidth: 180, minWidth: 120, editable: false, immutable: true, truncate: "fade" },
  { key: "focal",    label: "Focal length", group: "exif", tone: "exif", sortable: true, defaultWidth: 80,  minWidth: 60,  align: "right", numeric: true, editable: false, immutable: true },
  { key: "iso",      label: "ISO",          group: "exif", tone: "exif", sortable: true, defaultWidth: 64,  minWidth: 50,  align: "right", numeric: true, editable: false, immutable: true },
  { key: "aperture", label: "Aperture",     group: "exif", tone: "exif", sortable: true, defaultWidth: 70,  minWidth: 56,  align: "right", numeric: true, editable: false, immutable: true },
  { key: "shutter",  label: "Shutter",      group: "exif", tone: "exif", sortable: true, defaultWidth: 76,  minWidth: 60,  align: "right", numeric: true, editable: false, immutable: true },
  { key: "dateTaken",     label: "Date & time",      group: "exif", tone: "exif", sortable: true, defaultWidth: 168, minWidth: 120, align: "right", editable: true },
  { key: "cameraLocation",label: "Camera location",  group: "exif", tone: "exif", sortable: true, defaultWidth: 120, minWidth: 96,  align: "center", editable: true },
  { key: "objectLocation",label: "Object location",  group: "structured",          sortable: true, defaultWidth: 120, minWidth: 96,  align: "center", editable: true },
  { key: "locationOfCreation", label: "Location of creation (P1071)", group: "structured", sortable: true, defaultWidth: 200, minWidth: 140, copyable: true, editable: true, truncate: "fade" },

  // Wikitext preview — read-only column showing a single-line snippet of the
  // assembled wikitext. Click the cell (or its action button) to open the full
  // preview modal. Not navigable as a real cell — it's a launcher disguised as
  // a column so the user can scan/access wikitext without opening the detail
  // panel. Render is gated on a callback being wired by the parent.
  { key: "wikitext",      label: "Wikitext preview", group: "standard", sortable: false, defaultWidth: 220, minWidth: 140, mono: true,      editable: false, immutable: true, truncate: "fade" }
];

// Default column order: editable fields first (the user's primary editing surface),
// then immutable fields. Within each group, the most-used appear first.
// Source is off by default — it auto-resolves from the licence for own-work
// uploads, so most users never need to surface the column. Power users can
// toggle it on via the columns modal.
//
// "filename" (the original/source filename) is intentionally NOT in this list:
// it duplicates the Title column's default value, so we hide it by default and
// surface it as an opt-in column via the columns modal for users who want both
// side-by-side. See T425880.
const DEFAULT_VISIBLE = [
  // Editable
  "title", "description", "categories", "depicts", "license", "author",
  "dateTaken", "cameraLocation", "objectLocation", "locationOfCreation",
  // Immutable
  "size", "dimensions",
  // Wikitext preview launcher — sits between the structured-data columns and
  // the EXIF block so it's discoverable while scrolling right past the
  // editable fields. Not in the editable list above because it's a launcher,
  // not an in-cell editor.
  "wikitext",
  "camera", "iso", "aperture", "shutter"
];

// Cells that are editable (and therefore navigable + pasteable).
const EDITABLE_KEYS = new Set(["title", "categories", "depicts", "license", "author", "source", "description", "dateTaken", "cameraLocation", "objectLocation", "locationOfCreation"]);

// Cells that render as a fixed-EXIF chip pill (T426450). These six EXIF
// fields come from the file's binary metadata block and are immutable from
// the user's POV — the chip can't be removed and the value can't be
// changed. Click the chip → info popover (kind: "exif") explaining the
// "baked into the file" semantics and listing every other raw EXIF tag the
// file is carrying. The cell-level hover lock icon is suppressed for these
// keys (the chip carries its own).
const FIXED_EXIF_KEYS = new Set(["camera", "lens", "focal", "iso", "aperture", "shutter"]);

// Static + dynamic editability check. Dynamic includes:
//   - user-defined wikitext-template columns added at runtime (prop:tpl_*)
//   - per-language Caption columns (description:<lang>) — same editor as
//     the bare "description" column, just bound to a different language slot
function isEditableCol(col) {
  if (!col) return false;
  if (EDITABLE_KEYS.has(col.key)) return true;
  if (col.caption) return true; // per-language caption columns
  return col.editable === true;
}

// v10: drop "filename" from the default visible set (it duplicates the new
// pre-filled Title default — see T425880). v9 saved layouts that include
// "filename" stay intact; only first-time users / cleared storage see the
// new default.
const COL_STORAGE_KEY = "stashhub.columns.v10";
const FOCUS_MODE_STORAGE_KEY = "stashhub.focusMode.v1";

function loadFocusMode() {
  try {
    return localStorage.getItem(FOCUS_MODE_STORAGE_KEY) === "1";
  } catch (e) { return false; }
}
function saveFocusMode(on) {
  try { localStorage.setItem(FOCUS_MODE_STORAGE_KEY, on ? "1" : "0"); } catch (e) {}
}

function loadColumnState() {
  try {
    const v = JSON.parse(localStorage.getItem(COL_STORAGE_KEY) || "null");
    if (v && Array.isArray(v.visible)) {
      // One-shot migration: if a returning user's stored column prefs
      // pre-date the wikitext launcher column, surface it by default so the
      // feature is discoverable without forcing them to dig in the columns
      // modal. Insert it just before the EXIF block (camera) — same position
      // it sits at in DEFAULT_VISIBLE — or append if camera isn't visible.
      let visible = v.visible.slice();
      let order = Array.isArray(v.order) ? v.order.slice() : visible.slice();
      if (!visible.includes("wikitext")) {
        const camIdx = visible.indexOf("camera");
        if (camIdx >= 0) visible.splice(camIdx, 0, "wikitext");
        else visible.push("wikitext");
      }
      if (!order.includes("wikitext")) {
        const camIdx = order.indexOf("camera");
        if (camIdx >= 0) order.splice(camIdx, 0, "wikitext");
        else order.push("wikitext");
      }
      return {
        visible,
        customProps: v.customProps || [],
        widths: v.widths || {},
        order,
      };
    }
  } catch (e) {}
  return { visible: DEFAULT_VISIBLE, customProps: [], widths: {}, order: DEFAULT_VISIBLE.slice() };
}
function saveColumnState(s) {
  try { localStorage.setItem(COL_STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
}

// Build a per-language caption column descriptor that mirrors the
// English "description" column descriptor in TABLE_COLUMNS, but bound to
// a different language slot. Used by getAllColumns to expand the curated
// language catalog into addressable columns.
//
// The bare key "description" is reserved for English (legacy). Every
// other language gets the keyed form "description:<lang>". The resulting
// column descriptor reads/writes via the `caption.lang` field, which the
// Cell / CellEditor switch branches use to look the value up in
// item.descriptions[lang]. (T426422.)
function captionColumnDescriptor(langCode) {
  // Find the static description column to inherit dims/copy/editable etc.
  // — guarantees the per-language columns look identical to the canonical
  // one. If TABLE_COLUMNS ever loses the "description" entry the fallback
  // keeps captions usable, but the test suite (`npm run check:undefs`)
  // would catch the missing reference long before that.
  const base = TABLE_COLUMNS.find((c) => c.key === "description") || {};
  const captionColKey = window.captionColKeyFromLang
    ? window.captionColKeyFromLang(langCode)
    : (langCode === "en" ? "description" : `description:${langCode}`);
  const langLabel = (langCode || "en").toUpperCase();
  return {
    ...base,
    key: captionColKey,
    label: "Caption",
    headerTooltip: `Caption (SDC label) — ${langLabel}`,
    caption: { lang: langCode || "en" },
    // Widths persist per column key in colState.widths via the existing
    // resize machinery; nothing extra needed here.
  };
}

function getAllColumns(customProps) {
  // T426449 dropped the custom-wikitext-template column type. Legacy entries
  // with `kind: 'template'` in stored prefs are silently ignored at runtime
  // (the user's data stays on their Commons user-store JSON page; we just
  // don't render columns for them). Only Wikidata-property columns are
  // surfaced through getAllColumns now.
  const extras = (customProps || [])
    .filter((p) => p && p.kind !== "template")
    .map(p => ({
      key: `prop:${p.pid}`,
      label: `${p.label} (${p.pid})`,
      group: "custom",
      // Wikidata-property columns are user-editable plain-text inputs after
      // T426421 review feedback — the value lives in `item.customProps[pid]`
      // and persists on the item (not yet wired through to SDC writes; that
      // ships as a T426421 follow-up). Marking them editable matches user
      // expectation that "if I added a column I should be able to type in it".
      sortable: true,
      defaultWidth: 180, minWidth: 120,
      truncate: "fade",
      editable: true,
      copyable: true,
      customProp: p,
    }));
  // Per-language Caption columns (T426422). Surface every language in the
  // curated catalog as a known column so columnState.visible can address
  // them, persistence Just Works (column visibility/order/widths flow
  // through the existing state shape), and the columns modal can list them.
  // English is already in TABLE_COLUMNS as the bare "description" key, so
  // we skip it here.
  const captionLangs = window.CAPTION_LANGUAGES || [];
  const captionExtras = captionLangs
    .filter((l) => l && l.code && l.code !== "en")
    .map((l) => captionColumnDescriptor(l.code));
  return [...TABLE_COLUMNS, ...captionExtras, ...extras];
}

function Table({
  items, selected, onToggleSelect, onSetSelection,
  onUpdate, onOpen, onOpenLightbox, showThumbs,
  clipboard, onCopy, onPaste, onClearClipboard,
  titleVocab,
  requiredFields, setRequiredFields, columnDefaults, setColumnDefaults,
  selfUsername,
  // Auto-sequence suggestion (T425984): the title editor surfaces a
  // "Convert to sequence" suggestion when the typed title collides with
  // another stash row OR an existing Commons file uploaded by the same
  // user. Accepting calls back to App, which rewrites every matching
  // stash row's title to `<basename> #`. App owns the rewrite (it's the
  // single source of truth for stash items + draft persistence).
  onAcceptSequenceSuggestion,
  wikitextTemplate, setWikitextTemplate,
  items_all,
  // Callback so App can react to changes in custom-column definitions
  // (the publish modal needs to know which template columns exist so it can
  // assemble their fragments into the per-file wikitext).
  onCustomPropsChange,
  // Opens the wikitext preview modal for a given item. When undefined, the
  // wikitext launcher column renders a passive snippet (no click action).
  onPreviewWikitext,
  // Optional controlled column state. When App lifts colState (so multiple
  // <Table> instances stay in sync — e.g. the stacked mini-tables in Groups
  // view, T425839), it passes both pieces. When omitted, Table falls back
  // to its own internal state and persists to localStorage as before.
  colState: colStateProp,
  setColState: setColStateProp,
  // When true, the columns toolbar above this table is suppressed (Groups
  // view renders one global toolbar above all stacked mini-tables).
  hideToolbar = false,
  // Optional element rendered above this table — used by Groups view to
  // slot a per-group header (drag handle, delete button) per mini-table.
  groupHeader = null,
}) {
  const [colStateInternal, setColStateInternal] = useStateT(loadColumnState);
  const usingControlled = colStateProp != null && setColStateProp != null;
  const colState = usingControlled ? colStateProp : colStateInternal;
  const setColState = usingControlled ? setColStateProp : setColStateInternal;
  // Default to no internal sort — pass items through in the order the parent
  // gave us (filteredHist / filteredStash, which default to newest first).
  // Clicking a column header sets sortKey/sortDir, which then overrides the
  // parent order until the user clicks the same header repeatedly.
  // (Note: per-group sort in Groups view falls out of this for free, since
  // each Table instance keeps its own sortKey/sortDir.)
  const [sortKey, setSortKey] = useStateT(null);
  const [sortDir, setSortDir] = useStateT("desc");
  // colMenuOpen: false | 'columns' | 'templates' — also acts as the modal's
  // initial tab. Clicking the toolbar button opens the Columns tab; the
  // app's Templates entry-point would open the Templates tab instead.
  const [colMenuOpen, setColMenuOpen] = useStateT(false);
  // T426421: when the modal opens via the "+ Add column" popover's "Custom
  // T426449: the "Custom wikitext-template column" entry point on the
  // AddColumnPopover (T426421) was removed alongside the custom-wikitext
  // surface area. The colMenuCustomFormOpen flag is gone — the popover now
  // only routes to "More options (Templates and columns)" or to per-column
  // quick-adds.
  // T426421: state for the "+ Add column" popover (the new discoverable entry
  // point at the end of the table). Stores the anchor element so the popover
  // can position itself relative to the button. null = closed.
  const [addColAnchor, setAddColAnchor] = useStateT(null);
  const [editing, setEditing] = useStateT(null);          // {rowId, colKey}
  const [focusedCell, setFocusedCell] = useStateT(null);  // {rowId, colKey}
  const [headerMenu, setHeaderMenu] = useStateT(null);    // {colKey, anchorEl}
  const [pillInfo, setPillInfo] = useStateT(null);        // {kind:'category'|'depicts', value, anchorEl}
  // Focus mode (T425833): persistent left-edge image panel for the active row.
  // Persisted across reloads so users keep it on as they work.
  const [focusMode, setFocusMode] = useStateT(loadFocusMode);
  // Active row for focus mode. We track this independently of `focusedCell`
  // so a row click activates the panel even when no cell got keyboard focus
  // (e.g. clicking on the photo or status column).
  const [focusActiveRowId, setFocusActiveRowId] = useStateT(null);

  const lastClickedRowRef = useRefT(null);
  const dragRef = useRefT(null);
  const pasteDragRef = useRefT(null);
  const tableRef = useRefT(null);
  const resizeRef = useRefT(null);

  // Only mirror to localStorage when we own the state. Controlled mode
  // (Groups view) leaves persistence to App, which forwards it to the
  // user-store + localStorage in one place.
  useEffectT(() => {
    if (!usingControlled) saveColumnState(colState);
  }, [colState, usingControlled]);

  // Bubble custom-prop changes to the parent so it can pick up any user-
  // defined wikitext-template columns. Fires on mount with the loaded value
  // (so App sees the right list immediately).
  useEffectT(() => {
    onCustomPropsChange?.(colState.customProps || []);
  }, [colState.customProps, onCustomPropsChange]);
  useEffectT(() => { saveFocusMode(focusMode); }, [focusMode]);

  const allColumns = useMemoT(() => getAllColumns(colState.customProps), [colState.customProps]);

  // Build a "required" set merging user-toggled fields with always-required.
  const requiredSet = useMemoT(() => {
    const s = new Set(requiredFields || []);
    (window.ALWAYS_REQUIRED || new Set()).forEach(k => s.add(k));
    return s;
  }, [requiredFields]);

  // Depicts usage frequency across all items — used to suggest ghosts.
  const depictsFrequency = useMemoT(() => {
    const map = new Map();
    for (const it of (items_all || items)) {
      for (const d of (it.depicts || [])) {
        const k = d.qid;
        const e = map.get(k) || { qid: d.qid, label: d.label, count: 0 };
        e.count += 1;
        map.set(k, e);
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [items_all, items]);

  // Same idea for categories — most-used categories across the user's library.
  const categoriesFrequency = useMemoT(() => {
    const map = new Map();
    for (const it of (items_all || items)) {
      for (const c of (it.categories || [])) {
        const e = map.get(c) || { value: c, count: 0 };
        e.count += 1;
        map.set(c, e);
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [items_all, items]);

  const menuRef = useRefT(null);
  // (The old outside-click closer for the inline dropdown was removed — the
  // ColumnsModal has its own backdrop click + Esc close, so we don't need a
  // global mousedown listener here. A stray one would close the modal whenever
  // you mousedown inside it.)

  useEffectT(() => {
    const onUp = () => { dragRef.current = null; pasteDragRef.current = null; };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  // Paste-mode deactivation is handled centrally in app.jsx via a capture-phase
  // click listener. No duplicate handler needed here.

  // Toggle a `data-scrolled-x` attribute on the scroll container when the user
  // scrolls horizontally — used to fade in the right-edge shadow on the frozen
  // column block only when there's content scrolled underneath. (Pure CSS would
  // be cleaner, but there's no `:has(> [scrolled])` selector for scroll state.)
  useEffectT(() => {
    const el = tableRef.current;
    if (!el) return;
    const update = () => {
      el.setAttribute("data-scrolled-x", el.scrollLeft > 0 ? "1" : "0");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // Also re-check on resize, in case columns get added/removed and the
    // scroll state changes without the user touching anything.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro) ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      if (ro) ro.disconnect();
    };
  }, []);

  const visibleColumns = useMemoT(() => {
    const order = colState.order && colState.order.length ? colState.order : colState.visible;
    const byKey = new Map(allColumns.map(c => [c.key, c]));
    const out = [];
    const seen = new Set();
    for (const k of order) {
      if (!byKey.has(k)) continue;
      if (!colState.visible.includes(k)) continue;
      if (seen.has(k)) continue;
      out.push(byKey.get(k));
      seen.add(k);
    }
    for (const c of allColumns) {
      if (seen.has(c.key)) continue;
      if (!colState.visible.includes(c.key)) continue;
      out.push(c);
      seen.add(c.key);
    }
    return out;
  }, [allColumns, colState]);

  // Apply per-column user widths (resizable) on top of defaults.
  const widthFor = (c) => colState.widths?.[c.key] || c.defaultWidth;

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const sorted = useMemoT(() => {
    if (sortKey == null) return items; // honor parent's order (newest-first baseline from applyFilters)
    const list = [...items];
    list.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      let cmp;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [items, sortKey, sortDir]);

  const allSelected = sorted.length > 0 && sorted.every(i => selected.has(i.id));
  const someSelected = sorted.some(i => selected.has(i.id)) && !allSelected;

  // ---- Focus mode active row resolution ----
  // Priority: cell-focused row (keyboard nav) > last clicked row in focus mode
  // > first row in the sorted list. We resolve to an *id* still present in
  // `sorted` so reordering / filtering can't strand the panel on a missing row.
  const activeRowId = useMemoT(() => {
    if (!focusMode || sorted.length === 0) return null;
    const ids = new Set(sorted.map(i => i.id));
    if (focusedCell && ids.has(focusedCell.rowId)) return focusedCell.rowId;
    if (focusActiveRowId && ids.has(focusActiveRowId)) return focusActiveRowId;
    return sorted[0].id;
  }, [focusMode, sorted, focusedCell, focusActiveRowId]);
  const activeItem = useMemoT(
    () => activeRowId ? sorted.find(i => i.id === activeRowId) : null,
    [activeRowId, sorted]
  );

  const toggleColVisible = (key) => {
    setColState(s => {
      const v = s.visible.includes(key) ? s.visible.filter(k => k !== key) : [...s.visible, key];
      return { ...s, visible: v.length ? v : s.visible };
    });
  };
  const addCustomProp = (p) => {
    setColState(s => {
      const exists = (s.customProps || []).some(x => x.pid === p.pid);
      const customProps = exists ? s.customProps : [...(s.customProps || []), p];
      const key = `prop:${p.pid}`;
      const visible = s.visible.includes(key) ? s.visible : [...s.visible, key];
      return { ...s, customProps, visible };
    });
  };
  const removeCustomProp = (pid) => {
    setColState(s => ({
      ...s,
      customProps: (s.customProps || []).filter(p => p.pid !== pid),
      visible: s.visible.filter(k => k !== `prop:${pid}`)
    }));
  };
  // T426449: removed addTemplateColumn — user-defined wikitext-template
  // columns are no longer creatable. Legacy `kind: 'template'` entries in
  // stored prefs are silently filtered out by getAllColumns().

  // Photo column: 56px hover-zoom, then standard cols.
  // Last column: open-detail pop-out icon (zoom/expand) — appears on row hover only.
  // T426421: trailing 120px column slot for the "+ Add column" head button +
  // row placeholder cells. Sits at "the position of the future column" so
  // the affordance literally reads as the spot where a new column would land.
  // Wide enough to show the label inline ("+ Add column"), since the whole
  // point of this affordance is discoverability.
  const gridTemplate = useMemoT(() => {
    const parts = ["24px", "44px", "32px", "56px"];
    visibleColumns.forEach(c => {
      parts.push(`${widthFor(c)}px`);
    });
    parts.push("120px");
    return parts.join(" ");
  }, [visibleColumns, colState.widths]);

  // ---- Column auto-fit (double-click resizer) ----
  const autoFitColumn = (col) => {
    if (!tableRef.current) return;
    const cells = tableRef.current.querySelectorAll(`[data-cell-col="${col.key}"]`);
    // Find the header cell for this column; its index in the head row matches
    // its index in visibleColumns + 4 (status dot, checkbox, open-icon, photo).
    const colIdx = visibleColumns.findIndex(c => c.key === col.key);
    const headRow = tableRef.current.querySelector(".tbl__row--head");
    const headerCell = headRow ? headRow.children[4 + colIdx] : null;

    const measure = (el) => {
      if (!el) return 0;
      const clone = el.cloneNode(true);
      clone.style.position = "absolute";
      clone.style.visibility = "hidden";
      clone.style.width = "auto";
      clone.style.maxWidth = "none";
      clone.style.whiteSpace = "nowrap";
      clone.style.left = "-9999px";
      clone.style.display = "inline-block";
      document.body.appendChild(clone);
      const w = clone.scrollWidth;
      document.body.removeChild(clone);
      return w;
    };

    let max = 0;
    cells.forEach(c => { max = Math.max(max, measure(c)); });
    if (headerCell) max = Math.max(max, measure(headerCell));

    const padding = 24;
    const final = Math.max(col.minWidth || 60, Math.min(560, max + padding));
    setColState(s => ({ ...s, widths: { ...(s.widths || {}), [col.key]: final } }));
  };

  // ---- Column resize ----
  const startResize = (e, col) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthFor(col);
    resizeRef.current = { col, startX, startW };
    document.body.classList.add("col-resizing");

    const onMove = (ev) => {
      const r = resizeRef.current;
      if (!r) return;
      const dx = ev.clientX - r.startX;
      const w = Math.max(r.col.minWidth || 60, Math.round(r.startW + dx));
      setColState(s => ({ ...s, widths: { ...(s.widths || {}), [r.col.key]: w } }));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.body.classList.remove("col-resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ---- Drag-paste ----
  const startPasteDrag = () => {
    if (!pasteDragRef.current) pasteDragRef.current = new Set();
    return pasteDragRef.current;
  };
  const getPasteDrag = () => pasteDragRef.current;

  // ---- Selection ----
  const handleCheckMouseDown = (e, item, idx) => {
    e.preventDefault();
    e.stopPropagation();
    const willSelect = !selected.has(item.id);
    if (e.shiftKey && lastClickedRowRef.current) {
      const from = sorted.findIndex(i => i.id === lastClickedRowRef.current);
      const to = idx;
      if (from >= 0 && to >= 0) {
        const lo = Math.min(from, to), hi = Math.max(from, to);
        const rangeIds = sorted.slice(lo, hi + 1).map(i => i.id);
        onSetSelection(rangeIds, willSelect);
      }
      lastClickedRowRef.current = item.id;
      return;
    }
    onToggleSelect(item.id);
    dragRef.current = { applying: willSelect, ids: new Set([item.id]) };
    lastClickedRowRef.current = item.id;
  };
  const handleCheckMouseEnter = (item) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.ids.has(item.id)) return;
    d.ids.add(item.id);
    if (selected.has(item.id) !== d.applying) onToggleSelect(item.id);
  };
  const handleRowClick = (e, item, idx) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect(item.id);
      lastClickedRowRef.current = item.id;
      return;
    }
    // Focus mode: clicking anywhere on a row promotes it to the active row,
    // even if no editable cell catches focus. Doesn't toggle the checkbox.
    if (focusMode) setFocusActiveRowId(item.id);
  };

  // ---- Keyboard nav ----
  const editableColumns = useMemoT(
    () => visibleColumns.filter(c => isEditableCol(c)),
    [visibleColumns]
  );

  const moveFocus = (rowId, colKey, dRow, dCol) => {
    const ri = sorted.findIndex(i => i.id === rowId);
    const ci = editableColumns.findIndex(c => c.key === colKey);
    if (ri < 0 || ci < 0) return;
    const nr = Math.max(0, Math.min(sorted.length - 1, ri + dRow));
    const nc = Math.max(0, Math.min(editableColumns.length - 1, ci + dCol));
    setFocusedCell({ rowId: sorted[nr].id, colKey: editableColumns[nc].key });
  };

  const onTableKeyDown = (e) => {
    if (editing) return;
    // In focus mode with no cell focused, arrow up/down still moves the active
    // row so the panel image cycles even when the user hasn't drilled into a
    // cell yet (acceptance criterion: "Keyboard up/down moves between rows").
    if (focusMode && !focusedCell && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      if (sorted.length === 0) return;
      e.preventDefault();
      const curId = activeRowId;
      const ri = curId ? sorted.findIndex(i => i.id === curId) : -1;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const ni = ri < 0 ? 0 : Math.max(0, Math.min(sorted.length - 1, ri + dir));
      setFocusActiveRowId(sorted[ni].id);
      return;
    }
    if (!focusedCell) return;
    const { rowId, colKey } = focusedCell;
    if (e.key === "ArrowDown")       { e.preventDefault(); moveFocus(rowId, colKey, 1, 0); }
    else if (e.key === "ArrowUp")    { e.preventDefault(); moveFocus(rowId, colKey, -1, 0); }
    else if (e.key === "ArrowRight") { e.preventDefault(); moveFocus(rowId, colKey, 0, 1); }
    else if (e.key === "ArrowLeft")  { e.preventDefault(); moveFocus(rowId, colKey, 0, -1); }
    else if (e.key === "Tab")        { e.preventDefault(); moveFocus(rowId, colKey, 0, e.shiftKey ? -1 : 1); }
    else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      setEditing({ rowId, colKey });
    }
    else if (e.key === " " && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onToggleSelect(rowId);
      lastClickedRowRef.current = rowId;
    }
  };

  useEffectT(() => {
    if (!focusedCell || !tableRef.current) return;
    const sel = `[data-cell-row="${focusedCell.rowId}"][data-cell-col="${focusedCell.colKey}"]`;
    const el = tableRef.current.querySelector(sel);
    if (el) el.focus({ preventScroll: false });
  }, [focusedCell]);

  // When focus mode is on and no cell has DOM focus, hook the arrow keys at
  // the document level so the panel image cycles. We scope the handler to
  // events that originate inside *this* table's wrap (or its focus panel),
  // so two tables (stash + history) can both have focus mode on without
  // their listeners stepping on each other.
  useEffectT(() => {
    if (!focusMode) return;
    const onWinKey = (e) => {
      if (editing) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const t = e.target;
      const tag = t && t.tagName;
      const isFormControl = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable);
      if (isFormControl) return;
      // If a cell has focus we let the existing per-cell handler run.
      if (t && t.closest && t.closest(".tbl__td--keyfocus")) return;
      // Only react if the event originates inside this Table's wrap. We walk
      // up from the scroll container to the wrap, then check containment.
      const wrap = tableRef.current && tableRef.current.parentElement;
      if (!wrap) return;
      if (!t || !wrap.contains(t)) return;
      if (sorted.length === 0) return;
      e.preventDefault();
      const curId = activeRowId;
      const ri = curId ? sorted.findIndex(i => i.id === curId) : -1;
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const ni = ri < 0 ? 0 : Math.max(0, Math.min(sorted.length - 1, ri + dir));
      setFocusActiveRowId(sorted[ni].id);
    };
    window.addEventListener("keydown", onWinKey);
    return () => window.removeEventListener("keydown", onWinKey);
  }, [focusMode, sorted, activeRowId, editing]);

  // When the active row changes (focus mode), scroll it into view inside the
  // table scroll container so the user can see the highlight follow keys.
  useEffectT(() => {
    if (!focusMode || !activeRowId || !tableRef.current) return;
    const el = tableRef.current.querySelector(`[data-row-id="${activeRowId}"]`);
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [focusMode, activeRowId]);

  return (
    <div className={"tbl-wrap" + (focusMode ? " tbl-wrap--focus" : "")}>
      {!hideToolbar && (
        <div className="tbl-toolbar">
          <div className="tbl-toolbar__spacer" />
          <button
            className="btn btn--small"
            onClick={() => setFocusMode(v => !v)}
            aria-pressed={focusMode}
            title={focusMode ? "Hide focus panel" : "Show large image of selected row in a side panel"}
          >
            <Icon name="image" size={12} /> Focus mode
          </button>
          <div className="tbl-colmenu" ref={menuRef}>
            <button className="btn btn--small" onClick={() => setColMenuOpen('columns')} aria-pressed={!!colMenuOpen}>
              <Icon name="filter" size={12} /> Templates and columns ({visibleColumns.length})
            </button>
          </div>
        </div>
      )}

      {groupHeader}

      {focusMode && (
        <div className="tbl-focus" aria-label="Focus panel">
          {activeItem ? (
            <div className="tbl-focus__media">
              <Thumb item={activeItem} ratio={activeItem.width && activeItem.height ? activeItem.width / activeItem.height : undefined} large />
            </div>
          ) : (
            <div className="tbl-focus__empty">No row selected</div>
          )}
        </div>
      )}

      <div className="tbl-scroll" ref={tableRef} onKeyDown={onTableKeyDown} data-scrolled-x="0">
        <div className="tbl" style={{ "--grid": gridTemplate }}>
          <div className="tbl__row tbl__row--head" style={{ gridTemplateColumns: gridTemplate }}>
            {/* Frozen columns 1–4: stay pinned to the left while metadata
                columns scroll horizontally. See .tbl__frozen* in app.css. */}
            <div
              className={"tbl__frozen tbl__frozen--status tbl__th tbl__th--statusdot tbl__th--statussort" + (sortKey === "status" ? " tbl__th--active" : "")}
              onClick={() => handleSort("status")}
              title={
                sortKey === "status"
                  ? `Sorted by status (${sortDir === "asc" ? "ascending" : "descending"}) — click to flip`
                  : "Sort by upload status"
              }
            >
              {sortKey === "status" && (
                <span className="tbl__th-arrow tbl__th-arrow--active">
                  {sortDir === "asc" ? "▲" : "▼"}
                </span>
              )}
            </div>
            <div className="tbl__frozen tbl__frozen--check">
              <div
                className={"cbox" + (allSelected ? " cbox--checked" : someSelected ? " cbox--mixed" : "")}
                // Toggle scoped to *this table's* rows (the `sorted` items),
                // not the entire workbench. In single-table view the scope
                // *is* the entire stash, so behaviour is unchanged. In Groups
                // view (T425839) each mini-table's checkbox now selects /
                // deselects only its own group's rows, leaving selections
                // in sibling groups untouched. We use the parent-supplied
                // `onSetSelection(ids, makeSelected)` (which add/removes ids
                // without disturbing the rest of the selection) so the
                // global toolbar still reports a unified `selected` count.
                onClick={() => onSetSelection(sorted.map(i => i.id), !allSelected)}
                title={allSelected ? "Deselect all rows here" : "Select all rows here"}
              >
                {allSelected && <Icon name="check" size={12} />}
              </div>
            </div>
            <div className="tbl__frozen tbl__frozen--open tbl__th tbl__th--openbtn" />
            <div className="tbl__frozen tbl__frozen--photo tbl__th tbl__th--photo" />
            {visibleColumns.map((c, ci) => (
              <HeaderCell
                key={c.key}
                col={c}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={() => handleSort(c.key)}
                onHide={() => toggleColVisible(c.key)}
                onResizeStart={(e) => startResize(e, c)}
                onAutoFit={() => autoFitColumn(c)}
                onOpenMenu={(anchorEl) => setHeaderMenu(m => (m && m.colKey === c.key) ? null : { colKey: c.key, anchorEl })}
                hasDefault={!!columnDefaults[c.key]}
                isRequired={requiredSet.has(c.key)}
                isFirstExif={c.tone === "exif" && (ci === 0 || visibleColumns[ci - 1]?.tone !== "exif")}
              />
            ))}
            {/* T426421: full-height "+ Add column" button at the position of
                the future column. The button itself sits in the head cell
                (sticky-top via .tbl__row--head); each row below renders a
                visually-matching empty placeholder cell so the column reads
                as a single tall affordance. */}
            <button
              type="button"
              className={"tbl__th tbl__th--addcol" + (addColAnchor ? " tbl__th--addcol-open" : "")}
              onClick={(e) => {
                e.stopPropagation();
                const btn = e.currentTarget;
                setAddColAnchor((cur) => (cur ? null : btn));
              }}
              aria-haspopup="menu"
              aria-expanded={!!addColAnchor}
              title="Add a column"
            >
              <span className="tbl__th-addcol-icon"><Icon name="plus" size={14} /></span>
              <span className="tbl__th-addcol-label">Add column</span>
            </button>
          </div>

          {sorted.map((item, idx) => (
            <Row
              key={item.id}
              item={item}
              idx={idx}
              columns={visibleColumns}
              gridTemplate={gridTemplate}
              focusedCell={focusedCell}
              setFocusedCell={setFocusedCell}
              selected={selected.has(item.id)}
              isFocusActive={focusMode && activeRowId === item.id}
              showThumbs={showThumbs}
              editing={editing}
              setEditing={setEditing}
              clipboard={clipboard}
              onCopy={onCopy}
              onPaste={onPaste}
              startPasteDrag={startPasteDrag}
              getPasteDrag={getPasteDrag}
              onUpdate={onUpdate}
              onOpen={onOpen}
              onOpenLightbox={onOpenLightbox}
              titleVocab={titleVocab}
              depictsFrequency={depictsFrequency}
              categoriesFrequency={categoriesFrequency}
              requiredSet={requiredSet}
              widthFor={widthFor}
              setPillInfo={setPillInfo}
              selfUsername={selfUsername}
              templateConfig={wikitextTemplate}
              onPreviewWikitext={onPreviewWikitext}
              onCheckMouseDown={(e) => handleCheckMouseDown(e, item, idx)}
              onCheckMouseEnter={() => handleCheckMouseEnter(item)}
              onRowClick={(e) => handleRowClick(e, item, idx)}
            />
          ))}
        </div>
      </div>

      {colMenuOpen && (
        <ColumnsModal
          variant={(window.STASHHUB_TWEAKS && window.STASHHUB_TWEAKS.colsVariant) || "expandable"}
          initialTab={typeof colMenuOpen === 'string' ? colMenuOpen : 'columns'}
          allColumns={allColumns}
          visibleKeys={colState.visible}
          orderKeys={colState.order && colState.order.length ? colState.order : colState.visible}
          requiredFields={requiredFields}
          alwaysRequired={window.ALWAYS_REQUIRED || new Set()}
          columnDefaults={columnDefaults}
          wikitextTemplate={wikitextTemplate}
          setWikitextTemplate={setWikitextTemplate}
          setVisibleKeys={(v) => {
            // T426422 follow-up: when the user toggles off a caption column
            // from the columns modal, we apply the same invariant the header
            // menu enforces:
            //   1. There must always be at least one visible caption column.
            //   2. Hiding a caption column with stored values asks confirm and
            //      clears those values — otherwise the auto-promote sweep
            //      would re-add the column on the next render and the toggle
            //      would feel broken ("I just hid this!").
            const prevVisible = colState.visible || [];
            const removed = prevVisible.filter((k) => !v.includes(k));
            const captionRemoved = removed
              .map((k) => allColumns.find((c) => c.key === k))
              .filter((c) => c?.caption);
            if (captionRemoved.length === 0) {
              setColState(s => ({ ...s, visible: v.length ? v : s.visible }));
              return;
            }
            // Compute caption columns remaining after the removal. Anything
            // less than 1 fails the invariant — refuse the toggle.
            const remainingCaptionCount = (v || [])
              .map((k) => allColumns.find((c) => c.key === k))
              .filter((c) => c?.caption).length;
            if (remainingCaptionCount < 1) {
              const langLabel = captionRemoved[0]?.caption?.lang
                ? (window.captionLanguageLabel
                  ? window.captionLanguageLabel(captionRemoved[0].caption.lang)
                  : captionRemoved[0].caption.lang.toUpperCase())
                : '';
              alert(
                `Can't hide the ${langLabel} caption column — at least one caption column must stay visible. ` +
                `Add a different caption column first, then hide this one.`,
              );
              return;
            }
            // Confirm + clear values for each caption column being removed.
            for (const col of captionRemoved) {
              const lang = col?.caption?.lang;
              if (!lang) continue;
              const affected = window.countItemsWithCaption
                ? window.countItemsWithCaption(items, lang)
                : 0;
              if (affected > 0) {
                const langLabel = window.captionLanguageLabel
                  ? window.captionLanguageLabel(lang)
                  : lang.toUpperCase();
                const ok = confirm(
                  `Hide the ${langLabel} caption column?\n\n` +
                  `${affected} file${affected === 1 ? ' has' : 's have'} caption text in ${langLabel}. ` +
                  `Hiding the column will discard those caption values. ` +
                  `This cannot be undone.`,
                );
                if (!ok) return;
                if (window.clearCaptionFromItem) {
                  for (const it of items) {
                    const cleared = window.clearCaptionFromItem(it, lang);
                    if (cleared !== it) onUpdate(cleared);
                  }
                }
              }
            }
            setColState(s => ({ ...s, visible: v.length ? v : s.visible }));
          }}
          setOrderKeys={(v) => setColState(s => ({ ...s, order: v }))}
          setRequiredFields={(v) => setRequiredFields && setRequiredFields(typeof v === "function" ? v(requiredFields) : v)}
          setColumnDefaults={setColumnDefaults}
          selfUsername={selfUsername}
          selectedCount={(selected && selected.size) || 0}
          customProps={colState.customProps || []}
          onRemoveCustomProp={(pid) => removeCustomProp(pid)}
          onFillBlank={(key, value) => {
            // T426422: caption keys ("description:nl") read/write via
            // item.descriptions[lang], not the bare key. Helper does the
            // right thing for both the bare "description" and keyed caption
            // columns.
            // T426424: any caption column expands `{title}` per row.
            const captionLang = window.captionLangFromColKey ? window.captionLangFromColKey(key) : null;
            const isCaption = key === "description" || captionLang;
            const resolve = (it) => isCaption ? expandCaptionTemplate(value, it) : value;
            for (const it of items) {
              const v = captionLang
                ? (window.getCaptionValue ? window.getCaptionValue(it, captionLang) : (it[key] || ""))
                : it[key];
              const empty = v == null || v === "" || (Array.isArray(v) && v.length === 0);
              if (empty) {
                const next = captionLang && window.setCaptionValue
                  ? window.setCaptionValue(it, captionLang, resolve(it))
                  : { ...it, [key]: resolve(it) };
                onUpdate(next);
              }
            }
          }}
          onOverwriteSelected={(key, value) => {
            const captionLang = window.captionLangFromColKey ? window.captionLangFromColKey(key) : null;
            const isCaption = key === "description" || captionLang;
            const resolve = (it) => isCaption ? expandCaptionTemplate(value, it) : value;
            for (const it of items) {
              if (selected && selected.has(it.id)) {
                const next = captionLang && window.setCaptionValue
                  ? window.setCaptionValue(it, captionLang, resolve(it))
                  : { ...it, [key]: resolve(it) };
                onUpdate(next);
              }
            }
          }}
          onOverwriteAll={(key, value) => {
            const captionLang = window.captionLangFromColKey ? window.captionLangFromColKey(key) : null;
            const isCaption = key === "description" || captionLang;
            const resolve = (it) => isCaption ? expandCaptionTemplate(value, it) : value;
            for (const it of items) {
              const next = captionLang && window.setCaptionValue
                ? window.setCaptionValue(it, captionLang, resolve(it))
                : { ...it, [key]: resolve(it) };
              onUpdate(next);
            }
          }}
          onClose={() => setColMenuOpen(false)}
        />
      )}

      {/* T426421: "+ Add column" popover anchored to the trailing head button.
          Surfaces the most-relevant currently-hidden columns + Wikidata
          property search + an entry-point to the full Templates and columns
          modal. The custom-wikitext-template entry was removed in T426449. */}
      {addColAnchor && (
        <AddColumnPopover
          anchorEl={addColAnchor}
          allColumns={allColumns}
          visibleKeys={colState.visible}
          customProps={colState.customProps || []}
          onAddBuiltin={(key) => toggleColVisible(key)}
          onAddCustomProp={(p) => addCustomProp(p)}
          onOpenFullModal={() => {
            setAddColAnchor(null);
            setColMenuOpen('columns');
          }}
          onClose={() => setAddColAnchor(null)}
        />
      )}

      {/* Per-column header settings menu (chevron-triggered). Set default,
          toggle required, clear-all-values (two-step confirm), apply default
          via split-button (blanks / selected / overwrite-selected /
          overwrite-all), plus column-specific extras like caption columns'
          language-management entries (T426422 — change language, add another
          caption column, remove this caption column). Mirrors the actions
          in the Columns modal so changes from either surface stay in sync. */}
      {headerMenu && (() => {
        // Hoisted helpers — `applyDefault` writes the column default into a
        // single row (collection columns get push semantics, scalar columns
        // get assignment); `hasValue` reports whether the row already has
        // anything for this column. Both are reused by the four apply-scope
        // callbacks below so the per-cell write logic stays in one place.
        const k = headerMenu.colKey;
        const def = columnDefaults[k];
        // Caption-column language (null for non-caption columns). Drives the
        // setCaptionValue / getCaptionValue branches below so per-language
        // Caption columns route their default writes/reads through the
        // descriptions map. (T426422.)
        const headerCol = visibleColumns.find((c) => c.key === k);
        const captionLangForK = headerCol?.caption?.lang || null;
        const hasValue = (it) => {
          if (k === "categories") return (it.categories || []).length > 0;
          if (k === "depicts") return (it.depicts || []).length > 0;
          if (captionLangForK) {
            const v = window.getCaptionValue ? window.getCaptionValue(it, captionLangForK) : (it[k] || "");
            return !!String(v).trim();
          }
          return !!it[k];
        };
        // T425950: refuse to spray an unknown category across rows from the
        // column header. The popover input shows a red warning when the typed
        // value isn't a known category; this is the actual gate. Same
        // behaviour as the cell editor — the tool does not create categories.
        const isCategoryDefaultUnknown = () =>
          k === "categories" &&
          window.isKnownCategory &&
          !window.isKnownCategory(String(def || "").trim());
        // Caption (description) supports `{title}` template substitution
        // (T426424). Resolves per-row so a single default like
        // `Photo of {title}` produces a unique caption per file. Other
        // columns get `def` as-is.
        const resolveDef = (it) => k === "description" ? expandCaptionTemplate(def, it) : def;
        const applyDefault = (it) => {
          if (k === "categories") {
            // Push without duplicate — defaults nudge, never spam.
            const list = it.categories || [];
            if (def && !list.includes(def)) onUpdate({ ...it, categories: [...list, def] });
          } else if (k === "depicts") {
            const list = it.depicts || [];
            if (def && def.qid && !list.some(d => d.qid === def.qid)) {
              onUpdate({ ...it, depicts: [...list, def] });
            }
          } else if (captionLangForK) {
            // Per-language Caption defaults route through setCaptionValue so
            // both the legacy `description` field (for English) and the
            // canonical `descriptions[lang]` slot stay in sync. (T426422.)
            if (window.setCaptionValue) onUpdate(window.setCaptionValue(it, captionLangForK, def));
            else onUpdate({ ...it, [k]: def });
          } else {
            onUpdate({ ...it, [k]: resolveDef(it) });
          }
        };
        const overwriteWithDefault = (it) => {
          if (k === "categories") {
            // Overwrite scope = replace the whole list with the single default.
            onUpdate({ ...it, categories: def ? [def] : [] });
          } else if (k === "depicts") {
            onUpdate({ ...it, depicts: def && def.qid ? [def] : [] });
          } else if (captionLangForK) {
            if (window.setCaptionValue) onUpdate(window.setCaptionValue(it, captionLangForK, def || ""));
            else onUpdate({ ...it, [k]: def });
          } else {
            onUpdate({ ...it, [k]: resolveDef(it) });
          }
        };
        const clearOne = (it) => {
          if (k === "categories") onUpdate({ ...it, categories: [] });
          else if (k === "depicts") onUpdate({ ...it, depicts: [] });
          else if (captionLangForK) {
            if (window.setCaptionValue) onUpdate(window.setCaptionValue(it, captionLangForK, ""));
            else onUpdate({ ...it, [k]: "" });
          }
          else onUpdate({ ...it, [k]: "" });
        };
        // Title-only: restore the per-row default — the original filename
        // sans extension, mirroring the auto-default in normalizeStashItem
        // and the dropzone placeholder. Skip rows with no filename to
        // restore from (defensive — every stash row has one) and skip
        // published items (they aren't editable through drafts; mutating
        // their state would briefly paint a non-persistent change). The
        // restored value is bare — buildFutureFilename reattaches the
        // extension at publish time. See T426428.
        const restoreTitleFromFilename = (it) => {
          if (it.status === "published") return;
          if (!it.filename) return;
          const restored = it.filename.replace(/\.[^.]+$/, "");
          if (it.title === restored) return;
          onUpdate({ ...it, title: restored });
        };
        // T426424: a sample row for the Caption default-value editor's live
        // preview. Picks the first row with a usable title so the preview
        // shows what `{title}`-templated defaults will resolve to before the
        // user clicks "Apply to blank cells".
        const sampleItem = (items || []).find(it => it && (it.title || it.filename))
          || (items && items[0])
          || null;
        // T426424: per-column "Fill blanks from Title" action — exposed in
        // the Caption header dropdown as the column-level equivalent of the
        // per-row link button. Walks every row and fills blank caption cells
        // with that row's title (with the trailing T425984 ` #` sequence
        // placeholder stripped). Independent of the column's stored default
        // value — this is a one-shot action, not a default-template apply.
        const fillCaptionsFromTitles = () => {
          for (const it of items) {
            const cur = it.description;
            const empty = cur == null || cur === "";
            if (!empty) continue;
            const title = stripSequencePlaceholder(it.title);
            if (!title) continue;
            onUpdate({ ...it, description: title });
          }
        };
        return (
          <HeaderMenuPopover
            colKey={k}
            col={visibleColumns.find(c => c.key === k)}
            anchorEl={headerMenu.anchorEl}
            value={def || ""}
            isRequired={requiredSet.has(k)}
            locked={(window.ALWAYS_REQUIRED || new Set()).has(k)}
            selfUsername={selfUsername}
            selectedCount={(selected && selected.size) || 0}
            sampleItem={sampleItem}
            onFillCaptionsFromTitles={fillCaptionsFromTitles}
            onChange={(val) => setColumnDefaults({ ...columnDefaults, [k]: val })}
            onClear={() => {
              const next = { ...columnDefaults };
              delete next[k];
              setColumnDefaults(next);
            }}
            onToggleRequired={() => {
              if ((window.ALWAYS_REQUIRED || new Set()).has(k)) return;
              const next = (requiredFields || []).includes(k)
                ? (requiredFields || []).filter(x => x !== k)
                : [...(requiredFields || []), k];
              setRequiredFields && setRequiredFields(next);
            }}
            onApplyToBlank={() => {
              if (!def) return;
              if (isCategoryDefaultUnknown()) return;
              for (const it of items) {
                if (hasValue(it)) continue;
                applyDefault(it);
              }
            }}
            onApplyToSelected={() => {
              if (!def) return;
              if (isCategoryDefaultUnknown()) return;
              // Fill blanks within the current selection only.
              for (const it of items) {
                if (!selected || !selected.has(it.id)) continue;
                if (hasValue(it)) continue;
                applyDefault(it);
              }
            }}
            onOverwriteSelected={() => {
              if (!def) return;
              if (isCategoryDefaultUnknown()) return;
              for (const it of items) {
                if (!selected || !selected.has(it.id)) continue;
                overwriteWithDefault(it);
              }
            }}
            onOverwriteAll={() => {
              if (!def) return;
              if (isCategoryDefaultUnknown()) return;
              for (const it of items) {
                overwriteWithDefault(it);
              }
            }}
            onClearAllValues={() => {
              for (const it of items) {
                clearOne(it);
              }
            }}
            // Caption-column language management (T426422). Drives the
            // "Change language to…" / "Add another caption column…" menu
            // entries the popover renders only when col.caption is truthy.
            captionLang={captionLangForK}
            captionUsedLangs={(() => {
              if (!captionLangForK) return [];
              const out = [];
              for (const k2 of (colState.visible || [])) {
                const c = allColumns.find((c) => c.key === k2);
                if (c?.caption) out.push(c.caption.lang);
              }
              return out;
            })()}
            captionRemoveAffected={
              captionLangForK && window.countItemsWithCaption
                ? window.countItemsWithCaption(items, captionLangForK)
                : 0
            }
            onChangeCaptionLanguage={(newLang) => {
              if (!captionLangForK || !newLang || newLang === captionLangForK) return;
              const newKey = window.captionColKeyFromLang
                ? window.captionColKeyFromLang(newLang)
                : (newLang === "en" ? "description" : `description:${newLang}`);
              const oldKey = k;
              setColState((prev) => {
                const replace = (arr) => arr.map((x) => x === oldKey ? newKey : x);
                const widths = { ...(prev.widths || {}) };
                if (widths[oldKey] != null && widths[newKey] == null) {
                  widths[newKey] = widths[oldKey];
                  delete widths[oldKey];
                }
                return {
                  ...prev,
                  visible: replace(prev.visible || []),
                  order: replace(prev.order || []),
                  widths,
                };
              });
              setHeaderMenu(null);
            }}
            onAddCaptionLanguage={(newLang) => {
              if (!newLang) return;
              const newKey = window.captionColKeyFromLang
                ? window.captionColKeyFromLang(newLang)
                : (newLang === "en" ? "description" : `description:${newLang}`);
              setColState((prev) => {
                const visible = prev.visible || [];
                const order = prev.order || [];
                if (visible.includes(newKey)) return prev; // duplicate-language guard
                // Insert the new caption column right after the source one,
                // so a Dutch caption added next to the English caption sits
                // visually adjacent rather than dropping off the end of the
                // table — matches the user's intuition that "another caption
                // column" should land near the existing caption.
                const anchorIdx = order.indexOf(k);
                const nextOrder = order.slice();
                if (anchorIdx >= 0) nextOrder.splice(anchorIdx + 1, 0, newKey);
                else nextOrder.push(newKey);
                const nextVisible = [...visible, newKey];
                return { ...prev, visible: nextVisible, order: nextOrder };
              });
              setHeaderMenu(null);
            }}
            onRemoveCaptionColumn={() => {
              if (!captionLangForK) return;
              // Guard: there must always be at least one visible caption
              // column. The "Remove this caption column" entry is also
              // disabled in this case (canRemove=false), so this is a
              // belt-and-braces check for a programmatic invocation.
              const visibleCaptionCount = (colState.visible || [])
                .map((vk) => allColumns.find((c) => c.key === vk))
                .filter((c) => c?.caption).length;
              if (visibleCaptionCount <= 1) return;
              // Count items that carry user-typed text in this language;
              // confirm before discarding. Clearing on remove (rather than
              // just hiding) is what makes the maintainer's "not possible
              // to have caption values linked to a file that is not visible
              // in the table" invariant hold — otherwise the auto-promote
              // sweep on next reload would re-add the same column.
              const affected = window.countItemsWithCaption
                ? window.countItemsWithCaption(items, captionLangForK)
                : 0;
              if (affected > 0) {
                const langLabel = window.captionLanguageLabel
                  ? window.captionLanguageLabel(captionLangForK)
                  : captionLangForK.toUpperCase();
                const ok = confirm(
                  `Remove the ${langLabel} caption column?\n\n` +
                  `${affected} file${affected === 1 ? ' has' : 's have'} caption text in ${langLabel}. ` +
                  `Removing the column will discard those caption values. ` +
                  `This cannot be undone.`,
                );
                if (!ok) return;
                if (window.clearCaptionFromItem) {
                  for (const it of items) {
                    const cleared = window.clearCaptionFromItem(it, captionLangForK);
                    if (cleared !== it) onUpdate(cleared);
                  }
                }
              }
              setColState((prev) => ({
                ...prev,
                visible: (prev.visible || []).filter((x) => x !== k),
                order: (prev.order || []).filter((x) => x !== k),
                widths: Object.fromEntries(Object.entries(prev.widths || {}).filter(([wKey]) => wKey !== k)),
              }));
              setHeaderMenu(null);
            }}
            // Title-only "Restore from original filename" (T426428).
            // Four-scope split-button identical to the default-value
            // pattern; the per-row value is the filename minus the
            // extension (computed by restoreTitleFromFilename above).
            onRestoreTitleBlank={() => {
              for (const it of items) {
                if (it.title && it.title.trim()) continue;
                restoreTitleFromFilename(it);
              }
            }}
            onRestoreTitleSelectedBlank={() => {
              for (const it of items) {
                if (!selected || !selected.has(it.id)) continue;
                if (it.title && it.title.trim()) continue;
                restoreTitleFromFilename(it);
              }
            }}
            onRestoreTitleSelectedAll={() => {
              for (const it of items) {
                if (!selected || !selected.has(it.id)) continue;
                restoreTitleFromFilename(it);
              }
            }}
            onRestoreTitleAll={() => {
              for (const it of items) {
                restoreTitleFromFilename(it);
              }
            }}
            onClose={() => setHeaderMenu(null)}
          />
        );
      })()}

      {/* Pill info popover */}
      {pillInfo && (
        <PillInfoPopover
          info={pillInfo}
          onClose={() => setPillInfo(null)}
        />
      )}
    </div>
  );
}

// ===== Status dot (first column, before checkbox) =====
function StatusDot({ item, requiredSet }) {
  // Lifecycle states (in order of progression):
  //   selected   — queued for upload, not yet started
  //   uploading  — bytes in flight
  //   duplicate  — exact bytes already exist on Commons (overrides everything)
  //   incomplete — uploaded but required metadata missing / has issues
  //   ready      — required metadata complete, awaiting publish
  //   publishing — being committed to Wikimedia Commons
  //   published  — live on Commons (link-out)
  let state;
  if (item.status === "stash-selected")        state = "selected";
  else if (item.status === "stash-uploading")  state = "uploading";
  else if (item.status === "stash-publishing") state = "publishing";
  else if (item.status === "published")        state = "published";
  else if (item.status?.startsWith("stash")) {
    // Duplicate trumps incomplete: a missing title is fixable, but publishing
    // a byte-identical duplicate is the bigger problem and the row needs to
    // visually scream "don't publish me" regardless of metadata state.
    // existsOnCommons (already on commons.wikimedia.org) is the only signal
    // that survives now that same-sha1 stash entries are coalesced into one
    // row at the items-derivation step (T425873).
    if (item.existsOnCommons) state = "duplicate";
    else state = (item.issues?.length > 0) ? "incomplete" : "ready";
  } else {
    state = "ready";
  }

  const titles = {
    selected:   "Selected — waiting to upload",
    uploading:  `Uploading — ${item.progress ?? 0}%`,
    duplicate:  item.existsOnCommons?.filename
      ? `Already on Commons as File:${item.existsOnCommons.filename}`
      : "Already on Commons",
    incomplete: item.issues?.length
      ? `Incomplete — ${item.issues.length} issue${item.issues.length > 1 ? "s" : ""} to fix`
      : "Incomplete — required metadata missing",
    ready:      "Ready to publish",
    publishing: "Publishing to Wikimedia Commons…",
    published:  "Published on Wikimedia Commons",
  };

  // Hover tooltip — anchored, uses fixed positioning so it escapes table clipping.
  const anchorRef = useRefT(null);
  const [hover, setHover] = useStateT(false);
  const [pos, setPos] = useStateT({ left: 0, top: 0 });
  const enter = () => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPos({ left: r.right + 8, top: r.top - 4 });
    setHover(true);
  };
  const leave = () => setHover(false);

  // Visual rendering per state — wrapped in a hoverable span that anchors the
  // tooltip. The tooltip itself is portal-rendered to <body> so it escapes
  // the .tbl__frozen stacking context (z-index: 3) — otherwise sibling
  // frozen cells of later rows paint over it. T425885 (was clipped after
  // T425828 introduced frozen columns).
  const wrap = (inner) => (
    <span
      ref={anchorRef}
      className="tbl__statusind-anchor"
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {inner}
      {hover && createPortal(
        <StatusTooltip
          state={state}
          item={item}
          requiredSet={requiredSet}
          titles={titles}
          pos={pos}
        />,
        document.body
      )}
    </span>
  );

  // Shape per state
  if (state === "duplicate") {
    return wrap(
      <div
        className="tbl__statusind tbl__statusind--duplicate"
        aria-label="Already on Commons"
      >
        <Icon name="warn" size={14} />
      </div>
    );
  }
  if (state === "selected") {
    return wrap(
      <div className="tbl__statusind tbl__statusind--selected">
        <div className="tbl__statusind__bar" />
      </div>
    );
  }
  if (state === "uploading" || state === "publishing") {
    const pct = item.progress ?? 50;
    const r = 6, c = 2 * Math.PI * r;
    const off = c * (1 - pct / 100);
    const tone = state === "uploading" ? "uploading" : "publishing";
    return wrap(
      <div className={`tbl__statusind tbl__statusind--${tone}`}>
        <svg width="16" height="16" viewBox="0 0 16 16" className="tbl__statusind__ring">
          <circle cx="8" cy="8" r={r} className="tbl__statusind__ring-track" />
          <circle cx="8" cy="8" r={r} className="tbl__statusind__ring-fill"
            strokeDasharray={c} strokeDashoffset={off}
            transform="rotate(-90 8 8)" />
        </svg>
      </div>
    );
  }
  if (state === "published") {
    // Live wiki link — opens the file's description page in a new tab. The
    // tooltip text claims this; before the fix `href="#"` made it dead.
    const fileUrl = item.descriptionurl
      || (item.filename
        ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(item.filename)}`
        : null);
    return wrap(
      <a
        className="tbl__statusind tbl__statusind--published"
        href={fileUrl || '#'}
        target={fileUrl ? '_blank' : undefined}
        rel={fileUrl ? 'noopener noreferrer' : undefined}
        onClick={(e) => {
          // Stop the click from also triggering the row's selection / focus
          // handlers; the link itself does the navigation via target=_blank.
          e.stopPropagation();
          if (!fileUrl) e.preventDefault();
        }}
        title="Open file on Commons in a new tab"
      >
        <Icon name="external" size={12} />
      </a>
    );
  }
  return wrap(
    <div className={`tbl__statusind tbl__statusind--${state}`}>
      <span className="tbl__statusind__dot" />
    </div>
  );
}

// Detailed hover tooltip — shows what the status means, plus blocking required
// fields when the row is incomplete. Rendered via a portal-style fixed div.
function StatusTooltip({ state, item, requiredSet, titles, pos }) {
  const meaning = {
    selected:   "This file is queued for upload but bytes haven't started moving yet. It will start as soon as the previous transfer finishes.",
    uploading:  "Bytes are in flight to Wikimedia Commons. The ring fills as progress advances.",
    duplicate:  item.existsOnCommons
      ? "An exact byte-identical copy of this file already exists on Commons. Publishing would create a duplicate — leave it stashed or discard it."
      : "Another row in your stash holds the exact same file. Discard one of them so you don't end up publishing the same bytes twice.",
    incomplete: "The file is uploaded, but required metadata is missing. Fill in the blocking fields below before this row can be published.",
    ready:      "All required fields are present. This row will be published on the next batch run.",
    publishing: "The row is being committed to Commons right now. The ring fills as progress advances.",
    published:  "This file is live on Wikimedia Commons. Click the icon to open it in a new tab.",
  };

  // Map of issue-code → friendly label for the blocking-fields list.
  // `alwaysBlocks` issues bypass the requiredSet filter — they hold up
  // publish even if the underlying field isn't in the user's required
  // set (e.g. T425950: a category that doesn't exist on Commons is
  // always blocking, regardless of whether categories are required).
  const issueToField = {
    "missing-title": { key: "title", label: "Title" },
    "missing-license": { key: "license", label: "License" },
    "missing-author": { key: "author", label: "Author" },
    "missing-categories": { key: "categories", label: "Categories" },
    "missing-description": { key: "description", label: "Caption" },
    "missing-depicts": { key: "depicts", label: "Depicts" },
    "categories-not-on-commons": { key: "categories", label: "Unknown categories", alwaysBlocks: true },
    "invalid-title": { key: "title", label: "Title (invalid for Commons)", alwaysBlocks: true },
    "title-taken": { key: "title", label: "Title (already exists on Commons)", alwaysBlocks: true },
  };
  // Only required-blocking issues (the ones that hold up publish).
  const blocking = (item.issues || [])
    .map(code => issueToField[code] && { code, ...issueToField[code] })
    .filter(Boolean)
    .filter(b => b.alwaysBlocks || !requiredSet || requiredSet.has(b.key));
  // Non-blocking warnings (e.g. format-warning, possible-duplicate).
  const warningCodes = (item.issues || []).filter(c => !issueToField[c]);

  const dotClass = `tbl__statusind tbl__statusind--${state}`;
  return (
    <div className="status-tip" style={{ left: pos.left, top: pos.top }}>
      <div className="status-tip__head">
        <span className={dotClass}>
          {state === "selected" && <span className="tbl__statusind__bar" />}
          {(state === "uploading" || state === "publishing") && (
            <svg width="14" height="14" viewBox="0 0 16 16" className="tbl__statusind__ring">
              <circle cx="8" cy="8" r="6" className="tbl__statusind__ring-track" />
              <circle cx="8" cy="8" r="6" className="tbl__statusind__ring-fill" />
            </svg>
          )}
          {(state === "incomplete" || state === "ready") && <span className="tbl__statusind__dot" />}
          {state === "published" && <Icon name="external" size={11} />}
        </span>
        <span className="status-tip__title">{titles[state]}</span>
      </div>
      <p className="status-tip__meaning">{meaning[state]}</p>
      {state === "incomplete" && blocking.length > 0 && (
        <div className="status-tip__section">
          <div className="status-tip__label">Blocking fields</div>
          <ul className="status-tip__list">
            {blocking.map(b => (
              <li key={b.code} className="status-tip__item status-tip__item--err">
                <Icon name="warn" size={11} />
                <span>{b.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {warningCodes.length > 0 && (
        <div className="status-tip__section">
          <div className="status-tip__label">Warnings</div>
          <ul className="status-tip__list">
            {warningCodes.map(code => (
              <li key={code} className="status-tip__item status-tip__item--warn">
                <Icon name="info" size={11} />
                <span>{warningLabel(code)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function warningLabel(code) {
  switch (code) {
    case "format-warning": return "HEIC accepted but JPEG/PNG preferred";
    case "large-file-warning": return "Large file — upload may take a moment";
    case "possible-duplicate": return "Possibly a duplicate of an existing file";
    case "title-format-warning": return "Title looks like a default device filename — pick something descriptive";
    default: return code;
  }
}

// ===== Header =====

function HeaderCell({ col, sortKey, sortDir, onSort, onResizeStart, onAutoFit, onOpenMenu, hasDefault, isRequired, isFirstExif }) {
  const active = sortKey === col.key;
  const cls = "tbl__th"
    + (col.align === "right" ? " tbl__th--num" : "")
    + (col.tone === "exif" ? " tbl__th--exif" : "")
    + (col.immutable ? " tbl__th--immutable" : "")
    + (isFirstExif ? " tbl__th--exif-first" : "");
  const ref = useRefT(null);
  const chevRef = useRefT(null);
  // Caption columns surface their language as a uppercased two-letter
  // tag in the header label (e.g. "Caption EN", "Caption NL") so the user
  // can tell two captions apart at a glance — and so the existing single-
  // column workflow still reads the same. (T426422.)
  const label = col.caption
    ? `${col.label} ${(col.caption.lang || "en").toUpperCase()}`
    : col.label;
  return (
    <div className={cls} ref={ref}>
      <button
        className="tbl__th-sort"
        onClick={onSort}
        title={col.headerTooltip || "Click to sort"}
      >
        <span className="tbl__th-label">{label}</span>
        {isRequired && <span className="tbl__th-req" title="Required">*</span>}
        {hasDefault && <span className="tbl__th-default" title="Has default value">·</span>}
        <span className={"tbl__th-arrow" + (active ? " tbl__th-arrow--active" : "")}>
          {active ? (sortDir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
      {col.headerInfo && <HeaderInfoIcon info={col.headerInfo} colLabel={col.label} />}
      {col.key === "title" && (
        <a
          className="tbl__th-help"
          href="https://commons.wikimedia.org/wiki/Commons:File_naming"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Commons filename guidance — opens in new tab"
        >
          <Icon name="info" size={12} />
        </a>
      )}
      {/* Chevron sits left of the resize grip; opens the per-column settings
          menu (set default, toggle required, etc.). Click is stopPropagation'd
          so the row's sort-on-click handler doesn't also fire. */}
      <button
        ref={chevRef}
        type="button"
        className="tbl__th-chev"
        onClick={(e) => {
          e.stopPropagation();
          onOpenMenu && onOpenMenu(chevRef.current || e.currentTarget);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Column settings"
        aria-label="Column settings"
      >
        <Icon name="chevron-down" size={12} />
      </button>
      <div
        className="tbl__th-resizer"
        onMouseDown={onResizeStart}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); onAutoFit && onAutoFit(); }}
        title="Drag to resize · double-click to fit"
      />
    </div>
  );
}

// Hover/focus popover that explains a column's rules. Used by the Caption
// header today; the same shape can host other column docs later.
function HeaderInfoIcon({ info, colLabel }) {
  const [open, setOpen] = useStateT(false);
  const anchorRef = useRefT(null);
  return (
    <span className="tbl__th-info-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={anchorRef}
        type="button"
        className="tbl__th-info"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label={`About the ${colLabel} column`}
      >
        <Icon name="info" size={11} />
      </button>
      {open && (
        <div className="tbl__th-info-pop" role="tooltip" onClick={(e) => e.stopPropagation()}>
          <div className="tbl__th-info-pop__title">{info.title}</div>
          <ul className="tbl__th-info-pop__list">
            {info.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
          {info.link && (
            <a className="tbl__th-info-pop__link"
              href={info.link.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {info.link.text} <Icon name="external" size={11} />
            </a>
          )}
        </div>
      )}
    </span>
  );
}

// ===== Row =====
function Row({
  item, idx, columns, gridTemplate, focusedCell, setFocusedCell,
  selected, isFocusActive, showThumbs, editing, setEditing,
  clipboard, onCopy, onPaste, startPasteDrag, getPasteDrag,
  onUpdate, onOpen, onOpenLightbox, titleVocab, depictsFrequency, categoriesFrequency,
  requiredSet, widthFor, setPillInfo, selfUsername,
  templateConfig, onPreviewWikitext,
  // Auto-sequence (T425984): handler + sibling-collision lookup, threaded
  // through to the title cell editor. Both default to undefined when the
  // Table is rendered for non-stash items (history view), in which case
  // the editor simply doesn't surface the suggestion.
  getSiblingFutureCollisions, onAcceptSequenceSuggestion,
  onCheckMouseDown, onCheckMouseEnter, onRowClick
}) {
  return (
    <div
      className={
        "tbl__row" +
        (selected ? " tbl__row--selected" : "") +
        (isFocusActive ? " tbl__row--focus-active" : "") +
        (item.existsOnCommons ? " tbl__row--duplicate" : "")
      }
      style={{ gridTemplateColumns: gridTemplate }}
      data-row-id={item.id}
      onClick={onRowClick}
      onMouseEnter={onCheckMouseEnter}
    >
      {/* Frozen columns 1–4: status, checkbox, open-detail, photo. Pinned via
          CSS sticky so they stay visible while metadata columns scroll
          horizontally. See .tbl__frozen* in app.css. */}
      <div className="tbl__frozen tbl__frozen--status">
        <StatusDot item={item} requiredSet={requiredSet} />
      </div>
      <div className="tbl__frozen tbl__frozen--check">
        <div
          className={"cbox cbox--row" + (selected ? " cbox--checked" : "")}
          onMouseDown={onCheckMouseDown}
          onClick={(e) => { e.stopPropagation(); }}
          title="Drag to multi-select · Shift+click for range · ⌘/Ctrl-click row to toggle"
        >
          {selected && <Icon name="check" size={12} />}
        </div>
      </div>
      <div className="tbl__frozen tbl__frozen--open">
        <div
          className="tbl__open"
          onClick={(e) => { e.stopPropagation(); onOpen(item.id); }}
          title="Open detail panel"
        >
          <Icon name="expand-row" size={13} />
        </div>
      </div>
      <div className="tbl__frozen tbl__frozen--photo">
        <div
          className="tbl__photo"
          onClick={(e) => { e.stopPropagation(); onOpenLightbox && onOpenLightbox(item.id); }}
          title="Click to view photo"
        >
          {showThumbs && <Thumb item={item} ratio={item.width / item.height} />}
          <span className="tbl__photo-zoom"><Icon name="zoom" size={14} /></span>
        </div>
      </div>
      {columns.map((c, ci) => {
        // T426424: per-row Title↔Caption link button on the Caption cell.
        // Visible only when the Title column is the immediate left or right
        // neighbour of Caption in the visible column order. We pass the
        // adjacency edge ("left"/"right"/null) so the cell can pin the icon
        // to the boundary it shares with Title.
        const prev = columns[ci - 1];
        const next = columns[ci + 1];
        let titleAdjacentEdge = null;
        if (c.key === "description") {
          if (prev && prev.key === "title") titleAdjacentEdge = "left";
          else if (next && next.key === "title") titleAdjacentEdge = "right";
        }
        return (
          <Cell
            key={c.key}
            col={c}
            isFirstExif={c.tone === "exif" && (ci === 0 || columns[ci - 1]?.tone !== "exif")}
            item={item}
            width={widthFor(c)}
            isFocused={focusedCell && focusedCell.rowId === item.id && focusedCell.colKey === c.key}
            isEditing={editing && editing.rowId === item.id && editing.colKey === c.key}
            startEdit={() => {
              if (!isEditableCol(c)) return;
              setEditing({ rowId: item.id, colKey: c.key });
              setFocusedCell({ rowId: item.id, colKey: c.key });
            }}
            finishEdit={() => setEditing(null)}
            setFocused={() => isEditableCol(c) && setFocusedCell({ rowId: item.id, colKey: c.key })}
            clipboard={clipboard}
            onCopy={onCopy}
            onPaste={onPaste}
            startPasteDrag={startPasteDrag}
            getPasteDrag={getPasteDrag}
            onUpdate={onUpdate}
            titleVocab={titleVocab}
            depictsFrequency={depictsFrequency}
            categoriesFrequency={categoriesFrequency}
            requiredSet={requiredSet}
            setPillInfo={setPillInfo}
            selfUsername={selfUsername}
            templateConfig={templateConfig}
            onPreviewWikitext={onPreviewWikitext}
            getSiblingFutureCollisions={getSiblingFutureCollisions}
            onAcceptSequenceSuggestion={onAcceptSequenceSuggestion}
            titleAdjacentEdge={titleAdjacentEdge}
          />
        );
      })}
      {/* T426421: empty placeholder cell mirroring the head's "+ Add column"
          button, so the trailing 44px grid track reads as a single tall
          column-shaped affordance. Non-interactive; the head button is the
          only click target. */}
      <div className="tbl__td tbl__td--addcol" aria-hidden="true" />
    </div>
  );
}

// ===== Cell =====
function Cell({ col, item, width, isFocused, isEditing, startEdit, finishEdit, setFocused, clipboard, onCopy, onPaste, startPasteDrag, getPasteDrag, onUpdate, titleVocab, depictsFrequency, categoriesFrequency, requiredSet, setPillInfo, isFirstExif, selfUsername, templateConfig, onPreviewWikitext, getSiblingFutureCollisions, onAcceptSequenceSuggestion, titleAdjacentEdge }) {
  const cellRef = useRefT(null);
  const issues = item.issues || [];
  // Caption columns: lift the per-language value out once, used by both the
  // missing-required check and the read-view render. Bare "description" is
  // English by convention (legacy key); other captions are keyed
  // "description:<lang>". (T426422.)
  const captionLang = col.caption?.lang || null;
  const captionValue = captionLang
    ? (window.getCaptionValue ? window.getCaptionValue(item, captionLang) : (captionLang === "en" ? (item.description || "") : ((item.descriptions || {})[captionLang] || "")))
    : "";
  const isMissing = requiredSet.has(col.key) && (
    (col.key === "title"       && !item.title?.trim()) ||
    (col.key === "license"     && !item.license) ||
    (col.key === "author"      && !item.author?.trim()) ||
    (col.key === "categories"  && !(item.categories && item.categories.length)) ||
    (col.caption               && !captionValue.trim()) ||
    (col.key === "depicts"     && !(item.depicts && item.depicts.length))
  );
  // Title cell carries an extra failure mode beyond "missing": format-invalid
  // or already-taken-on-Commons. Both are blocking issues populated by
  // recomputeIssues; surface them with the same red treatment as missing-required.
  const isInvalidTitle = col.key === "title" && (issues.includes("invalid-title") || issues.includes("title-taken"));
  // Soft warning — title looks like a default device filename. Yellow tone,
  // doesn't block publish; persists when the cell isn't being edited so the
  // user notices the row even at a glance through a long table.
  const hasTitleWarning = col.key === "title"
    && !isInvalidTitle
    && issues.includes("title-format-warning");

  // Persistent error indicator for saved-but-invalid values. Today only
  // Caption columns have client-side rules (length, plain text, no markup);
  // if we add other validators later, branch them here. Without this,
  // blurring out of an over-limit caption made the cell look "ready" — see
  // T425878. Per-language Caption columns share the same validator (T426422).
  const isInvalid = !isEditing
    && col.caption
    && !!captionValue.trim()
    && typeof window.validateCaption === "function"
    && !window.validateCaption(captionValue).valid;

  const isPasteTarget = clipboard && clipboard.field === col.key && isEditableCol(col);
  const editable = col.editable !== false;
  // The wikitext column is a launcher — not editable, but the whole cell is
  // a click target for opening the preview modal. Treat it like a clickable
  // immutable cell so we can intercept onClick without triggering a row open.
  const isWikitextLauncher = col.key === "wikitext" && !!onPreviewWikitext;

  const cls = "tbl__td"
    + (col.align === "right" ? " tbl__td--num" : "")
    + (col.mono ? " tbl__td--mono" : "")
    + (col.numeric ? " tbl__td--tnum" : "")
    + (col.tone === "exif" ? " tbl__td--exif" : "")
    + (col.immutable ? " tbl__td--immutable" : "")
    + (!editable ? " tbl__td--readonly" : "")
    + (isFirstExif ? " tbl__td--exif-first" : "")
    + (isFocused ? " tbl__td--keyfocus" : "")
    + ((isMissing || isInvalidTitle) ? " tbl__td--missing" : "")
    + (isInvalid ? " tbl__td--invalid" : "")
    + (hasTitleWarning ? " tbl__td--title-warn" : "")
    + (isEditing ? " tbl__td--editing" : "")
    + (isPasteTarget ? " tbl__td--paste-target" : "")
    + (isWikitextLauncher ? " tbl__td--wikitext" : "")
    ;

  const doPaste = () => {
    const next = onPaste(item, col.key);
    if (next) onUpdate(next);
  };

  const onMouseDown = (e) => {
    if (!isPasteTarget) return;
    if (e.button !== 0) return;
    if (e.metaKey || e.ctrlKey) return;
    e.stopPropagation();
    e.preventDefault();
    if (!startPasteDrag) return;
    const set = startPasteDrag();
    if (!set.has(item.id)) {
      set.add(item.id);
      doPaste();
    }
  };
  const onMouseEnter = () => {
    if (!isPasteTarget) return;
    const set = getPasteDrag && getPasteDrag();
    if (!set) return;
    if (set.has(item.id)) return;
    set.add(item.id);
    doPaste();
  };

  const onClick = (e) => {
    if (e.metaKey || e.ctrlKey) return;
    if (isPasteTarget) {
      e.stopPropagation();
      if (!getPasteDrag || !getPasteDrag()?.has(item.id)) doPaste();
      return;
    }
    if (isWikitextLauncher) {
      // Open the wikitext preview modal instead of bubbling to the row's
      // open-detail handler. This is the whole point of the column.
      e.stopPropagation();
      onPreviewWikitext(item);
      return;
    }
    if (editable) {
      e.stopPropagation();
      startEdit();
    }
    // immutable cells: do nothing on click — let row click bubble
  };

  if (isEditing) {
    // Editing: render the static cell (for layout reservation) plus a popout
    // that uses position:fixed so it escapes any clipping ancestor (the
    // table wrapper and horizontal scroll container both clip overflow).
    return (
      <div className={cls} data-cell-row={item.id} data-cell-col={col.key} ref={cellRef}>
        <CellView
          col={col}
          item={item}
          isMissing={isMissing}
          hasTitleWarning={hasTitleWarning}
          onCopy={onCopy}
          setPillInfo={setPillInfo}
          templateConfig={templateConfig}
        />
        <FixedPopout
          anchorRef={cellRef}
          minWidth={
            col.key === "depicts" || col.key === "categories"
              ? Math.max(360, width + 80)
              : Math.max(260, width + 60)
          }
          onOutsideClick={finishEdit}
        >
          <CellEditor
            col={col} item={item}
            onCommit={(next) => { onUpdate(next); finishEdit(); }}
            onCancel={finishEdit}
            onCopy={onCopy}
            clipboard={clipboard}
            onPaste={onPaste}
            titleVocab={titleVocab}
            depictsFrequency={depictsFrequency}
            categoriesFrequency={categoriesFrequency}
            selfUsername={selfUsername}
            getSiblingFutureCollisions={getSiblingFutureCollisions}
            onAcceptSequenceSuggestion={onAcceptSequenceSuggestion}
          />
        </FixedPopout>
      </div>
    );
  }

  // Per-cell copy button on hover for scalar editable values.
  const showCopy = col.copyable
    && col.key !== "categories"
    && col.key !== "depicts"
    && hasValue(item, col.key);

  return (
    <div
      className={cls}
      data-cell-row={item.id}
      data-cell-col={col.key}
      // Make the wikitext launcher cell focusable (Enter/Space → open modal)
      // even though it isn't editable, so keyboard users can reach it.
      tabIndex={editable || isWikitextLauncher ? (isFocused ? 0 : -1) : -1}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      onFocus={setFocused}
      onKeyDown={(e) => {
        if (!isWikitextLauncher) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onPreviewWikitext(item);
        }
      }}
      title={titleFor(item, col)}
      role={isWikitextLauncher ? 'button' : undefined}
      aria-label={isWikitextLauncher ? `Open wikitext preview for ${item.title || item.filename || 'this file'}` : undefined}
    >
      <CellView
        col={col}
        item={item}
        isMissing={isMissing}
        hasTitleWarning={hasTitleWarning}
        onCopy={onCopy}
        setPillInfo={setPillInfo}
        templateConfig={templateConfig}
      />
      {showCopy && (
        <button
          className="tbl__td-copy"
          onClick={(e) => { e.stopPropagation(); onCopy({ field: col.key, value: getValue(item, col.key), count: 0 }); }}
          title={`Copy this ${col.label.toLowerCase()}`}
        ><Icon name="copy" size={11} /></button>
      )}
      {/* T426424: per-row Title↔Caption link button. Visible on hover when the
          Title column is the immediate left or right neighbour of this Caption
          cell. Click copies the row's title (with the trailing T425984 ` #`
          sequence placeholder stripped) into the caption cell, replacing
          whatever was there — no menu, no confirmation, single shot. Disabled
          when the title is empty (nothing to copy). The icon pins to the
          boundary the cell shares with Title (left edge if Title is to the
          left, right edge if Title is to the right) and shifts in to avoid
          the per-cell copy button on the right side. */}
      {col.key === "description" && titleAdjacentEdge && !isEditing && (() => {
        const titleVal = stripSequencePlaceholder(item.title);
        const noTitle = !titleVal;
        return (
          <button
            className={"tbl__td-titlelink tbl__td-titlelink--" + titleAdjacentEdge + (showCopy && titleAdjacentEdge === "right" ? " tbl__td-titlelink--shift" : "")}
            onClick={(e) => {
              e.stopPropagation();
              if (noTitle) return;
              onUpdate({ ...item, description: titleVal });
            }}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={noTitle}
            title={noTitle
              ? "Add a title first to copy it into the caption"
              : "Copy this row's title into the caption (replaces any existing caption)"}
            aria-label="Copy title into caption"
          ><Icon name="link" size={11} /></button>
        );
      })()}
      {/* Lock icon for immutable cells — hidden for the wikitext launcher
          which uses an "open" icon instead to signal it triggers a modal,
          and hidden for the fixed-EXIF chip cells (T426450) where the chip
          carries its own inline lock indicator. */}
      {col.immutable && !isWikitextLauncher && !FIXED_EXIF_KEYS.has(col.key) && <span className="tbl__td-lock"><Icon name="lock" size={10} /></span>}
      {isWikitextLauncher && (
        <span className="tbl__td-launch" title="Open wikitext preview">
          <Icon name="expand-row" size={11} />
        </span>
      )}
    </div>
  );
}

function hasValue(item, key) {
  // T426422: caption keys live in item.descriptions[lang] (or item.description
  // for the bare English key). Route through getCaptionValue so the copy
  // button etc. light up for non-English caption columns too.
  const captionLang = window.captionLangFromColKey ? window.captionLangFromColKey(key) : null;
  if (captionLang) {
    const v = window.getCaptionValue ? window.getCaptionValue(item, captionLang) : (item[key] || '');
    return !!(v && String(v).trim().length);
  }
  const v = item[key];
  if (Array.isArray(v)) return v.length > 0;
  return !!(v && String(v).trim().length);
}
function getValue(item, key) {
  // T426422: caption keys map to item.descriptions[lang] (or item.description
  // for English). Other keys fall through to plain field access.
  const captionLang = window.captionLangFromColKey ? window.captionLangFromColKey(key) : null;
  if (captionLang) {
    return window.getCaptionValue ? window.getCaptionValue(item, captionLang) : item[key];
  }
  return item[key];
}

// ===== Cell view (read-only) =====
function CellView({ col, item, isMissing, hasTitleWarning, onCopy, setPillInfo, templateConfig }) {
  if (col.customProp) {
    const v = (item.customProps || {})[col.customProp.pid];
    if (v == null || v === '') {
      // Custom (Wikidata-property) columns are editable, so surface the same
      // "Add value" affordance other editable empty cells use.
      return <span className="tbl__td-placeholder">{isMissing ? 'Add value' : '—'}</span>;
    }
    return <span className="tbl__td-text">{v}</span>;
  }

  // The wikitext column shows a one-line snippet of the assembled wikitext.
  // We collapse all whitespace so the user gets a glimpse of what's there
  // (multi-line strings would otherwise just show a fade after the first
  // line). The full content is reachable via the click-to-open modal.
  if (col.key === 'wikitext') {
    return <WikitextPreviewCell item={item} templateConfig={templateConfig} />;
  }

  // Institution — read-only in the grid; chosen in the detail panel.
  if (col.key === 'institution') {
    if (!item.institution) return <span className="tbl__td-placeholder">—</span>;
    return <span className="tbl__td-text" title={item.institution}>{item.institution}</span>;
  }

  // Caption columns (English `description` and per-language `description:<lang>`).
  // The cell renders the language-specific value with the same SDC validity
  // indicator as the canonical column. (T426422.)
  if (col.caption) {
    const captionValue = window.getCaptionValue
      ? window.getCaptionValue(item, col.caption.lang)
      : (col.caption.lang === "en" ? (item.description || "") : ((item.descriptions || {})[col.caption.lang] || ""));
    if (!captionValue) {
      return <span className="tbl__td-placeholder">{isMissing ? "Add caption" : "—"}</span>;
    }
    // Persistent in-cell indicator when the saved caption violates the SDC
    // rules (over the 250-char cap, contains markup/links/etc). The
    // surrounding cell also gets a tbl__td--invalid class — see Cell —
    // which paints the red ring; the icon is the inline cue when the cell
    // isn't focused. Both the publish modal and the bulk publish modal also
    // gate on this so the user can't sneak past by deselecting.
    const captionErr = window.validateCaption ? !window.validateCaption(captionValue).valid : false;
    return (
      <span className={"tbl__td-text" + (captionErr ? " tbl__td-text--invalid" : "")}
        title={captionErr ? "Caption can't be saved as-is — click to fix" : undefined}
      >
        {captionErr && <Icon name="warn" size={11} />}
        {captionValue}
      </span>
    );
  }

  switch (col.key) {
    case "title":
      if (!item.title) {
        return <span className="tbl__td-placeholder">{isMissing ? "Add title" : "—"}</span>;
      }
      // Inline warning icon — visible without focus, so the user spots
      // questionable titles when scanning a long table. The icon sits to
      // the left of the text and shares the cell's tooltip from titleFor().
      return (
        <span className="tbl__td-text tbl__td-text--with-icon">
          {hasTitleWarning && (
            <span className="tbl__td-warn-icon" aria-hidden="true">
              <Icon name="warn" size={11} />
            </span>
          )}
          <span className="tbl__td-text-inner">{item.title}</span>
        </span>
      );
    case "filename":
      return <MiddleTruncate text={item.filename} />;
    case "categories": {
      const cats = item.categories || [];
      if (!cats.length) return <span className="tbl__td-placeholder">{isMissing ? "Add category" : "—"}</span>;
      // T425950: a name is rendered red when the API has confirmed it
      // does not exist on Commons (item.nonExistingCategories). Until
      // the per-row API check has run we fall back to the local
      // KNOWN_CATEGORIES merged pool so the user gets an instant hint,
      // but the publish gate only fires on the authoritative API
      // verdict tracked in nonExistingCategories.
      const apiResolved = Array.isArray(item.nonExistingCategories);
      const missingSet = new Set(item.nonExistingCategories || []);
      return (
        <div className="tbl__cat-list tbl__cat-list--inline">
          {cats.map(c => {
            const apiSaysMissing = missingSet.has(c);
            const known = window.isKnownCategory && window.isKnownCategory(c);
            // Display with "Category:" prefix to match Commons wikitext
            // convention. Internal storage stays as the bare name. (T425912)
            const display = window.formatCategory ? window.formatCategory(c) : `Category:${c}`;
            const showRed = apiResolved ? apiSaysMissing : !known;
            const title = apiSaysMissing
              ? `${c} — does not exist on Commons; will not be published`
              : !apiResolved && !known
                ? `${c} — checking on Commons…`
                : c;
            return (
              <span
                key={c}
                className={"tag tag--inline" + (showRed ? " tag--unknown" : "")}
                title={title}
                onClick={(e) => {
                  e.stopPropagation();
                  setPillInfo && setPillInfo({ kind: "category", value: c, anchorEl: e.currentTarget });
                }}
              >
                <span className="tag__lbl">{display}</span>
                <span className="tag__hover">
                  <button
                    className="tag__copy"
                    onClick={(e) => { e.stopPropagation(); onCopy({ field: "categories", value: c, count: 0 }); }}
                    title="Copy"
                  ><Icon name="copy" size={9} /></button>
                </span>
              </span>
            );
          })}
        </div>
      );
    }
    case "depicts": {
      const list = item.depicts || [];
      if (!list.length) return <span className="tbl__td-placeholder">{isMissing ? "Add depicts" : "—"}</span>;
      return (
        <div className="tbl__cat-list tbl__cat-list--inline">
          {list.map(d => (
            <span
              key={d.qid}
              className="tag tag--inline tag--wd"
              onClick={(e) => {
                e.stopPropagation();
                setPillInfo && setPillInfo({ kind: "depicts", value: d, anchorEl: e.currentTarget });
              }}
            >
              <span className="tag__lbl">{d.label}</span>
              <span className="tag__qid-sub">{d.qid}</span>
              <span className="tag__hover">
                <button
                  className="tag__copy"
                  onClick={(e) => { e.stopPropagation(); onCopy({ field: "depicts", value: d, count: 0 }); }}
                  title="Copy"
                ><Icon name="copy" size={9} /></button>
              </span>
            </span>
          ))}
        </div>
      );
    }
    case "license": {
      // Show the catalog short label when known (e.g. "CC BY-SA 4.0" rather
      // than the stored id "CC-BY-SA-4.0"); fall back to the raw value for
      // custom wikitext. The full descriptive title is the hover tooltip.
      if (!item.license) {
        return <span className="tbl__td-placeholder">{isMissing ? "Choose…" : "—"}</span>;
      }
      const short = window.licenseShortLabel(item.license);
      const title = window.licenseTitle(item.license);
      return <span className="tbl__td-text" title={title}>{short}</span>;
    }
    case "author":
      return item.author
        ? <span className="tbl__td-text">{item.author}</span>
        : <span className="tbl__td-placeholder">{isMissing ? "Add author" : "—"}</span>;
    case "source": {
      // Source defaults from the licence: own-work licences (CC0 / CC BY 4.0
      // / CC BY-SA 4.0) auto-fill `{{own}}` at publish time when the cell is
      // empty. The cell visualises that with a muted "{{own}} (from licence)"
      // hint so the user can see what will be published without having to
      // type it. Non-own-work licences leave the placeholder blank — the
      // user has to fill the cell in.
      if (item.source) {
        return <span className="tbl__td-text">{item.source}</span>;
      }
      const ownDefault = window.isOwnWorkLicense?.(item.license);
      if (ownDefault) {
        return (
          <span
            className="tbl__td-placeholder"
            title="Will publish as {{own}} because the licence is own-work. Edit to override."
            style={{ fontStyle: 'italic' }}
          >
            {"{{own}}"}<span style={{ marginLeft: 4, opacity: 0.6 }}>(from licence)</span>
          </span>
        );
      }
      return <span className="tbl__td-placeholder" title="Empty source. Add a URL, citation, or pick {{own}} from the cell editor.">{isMissing ? "Add source" : "—"}</span>;
    }
    case "size":
      return <span>{formatBytes(item.bytes)}</span>;
    case "dimensions":
      return item.width > 0
        ? <span>{item.width.toLocaleString()}×{item.height.toLocaleString()}</span>
        : <span className="tbl__td-placeholder">—</span>;
    case "status": {
      const isStash = item.status?.startsWith("stash");
      return (
        <span className={"tbl__status " + (isStash ? "tbl__status--stash" : "tbl__status--ok")}>
          <span className="tbl__status-dot" />
          {isStash ? "Stashed" : "Published"}
        </span>
      );
    }

    // Fixed-EXIF chips (T426450). The value lives in the file's binary EXIF
    // block — the user can't edit, override, or remove it from the workbench
    // (the bytes still ship with the file no matter what). The chip carries
    // its own lock indicator and click-to-info popover; we deliberately render
    // a pill instead of plain text so the affordance reads as "this is a
    // fixed-but-meaningful piece of structured data" rather than "greyed out
    // for some reason". Empty values still render as the inert dash.
    case "camera":   return <FixedExifChip col={col} item={item} value={item.camera}   setPillInfo={setPillInfo} />;
    case "lens":     return <FixedExifChip col={col} item={item} value={item.lens}     setPillInfo={setPillInfo} />;
    case "focal":    return <FixedExifChip col={col} item={item} value={item.focal}    setPillInfo={setPillInfo} />;
    case "iso":      return <FixedExifChip col={col} item={item} value={item.iso}      setPillInfo={setPillInfo} />;
    case "aperture": return <FixedExifChip col={col} item={item} value={item.aperture} setPillInfo={setPillInfo} />;
    case "shutter":  return <FixedExifChip col={col} item={item} value={item.shutter}  setPillInfo={setPillInfo} />;
    case "dateTaken": return item.dateTaken
      ? <span className="tbl__td-datetime">{formatDateTimeShort(item.dateTaken)}</span>
      : <span className="tbl__td-placeholder">{isMissing ? "Add date" : "—"}</span>;
    case "cameraLocation": {
      const loc = item.cameraLocation || item.coords;
      return loc
        ? <MiniMapCell loc={loc} />
        : <span className="tbl__td-placeholder">{isMissing ? "Add" : "—"}</span>;
    }
    case "objectLocation": {
      const loc = item.objectLocation;
      return loc
        ? <MiniMapCell loc={loc} variant="object" />
        : <span className="tbl__td-placeholder">{isMissing ? "Add" : "—"}</span>;
    }
    case "locationOfCreation": {
      const v = item.locationOfCreation;
      if (!v || !v.qid) return <span className="tbl__td-placeholder">{isMissing ? "Add location" : "—"}</span>;
      return (
        <div className="tbl__cat-list tbl__cat-list--inline">
          <span
            className="tag tag--inline tag--wd"
            title={`${v.qid} — ${v.label}`}
            onClick={(e) => {
              e.stopPropagation();
              setPillInfo && setPillInfo({ kind: "locationOfCreation", value: v, anchorEl: e.currentTarget });
            }}
          >
            <span className="tag__lbl">{v.label}</span>
            {onCopy && (
              <button
                className="tag__copy"
                onClick={(e) => { e.stopPropagation(); onCopy({ field: "locationOfCreation", value: v, count: 0 }); }}
                title="Copy"
              ><Icon name="copy" size={9} /></button>
            )}
          </span>
        </div>
      );
    }

    default:
      return <span>—</span>;
  }
}
function scalarOrDash(v) { return v ? <span>{v}</span> : dash(); }
function dash() { return <span className="tbl__td-placeholder">—</span>; }

// Fixed-EXIF chip (T426450).
//
// Renders a non-removable, non-editable chip for a piece of EXIF data
// extracted from the file's binary metadata block (camera, lens, focal,
// ISO, aperture, shutter). Click opens an info popover via the existing
// PillInfoPopover infrastructure (kind: "exif"), which explains the value
// is baked into the file and lists every other raw EXIF entry the file
// carries.
//
// Visual primitive: shares the .chip-pill base introduced by T425887/!54
// for chip-based template editors, with a .chip-pill--fixed modifier that
// swaps the progressive-blue actively-editable tone for a subtle/neutral
// tone (the user can't act on it, the colour shouldn't promise an action).
//
// When the value is missing, falls back to the inert dash placeholder —
// no chip, no popover (nothing to inform about).
function FixedExifChip({ col, item, value, setPillInfo }) {
  if (value == null || value === '') return dash();
  const display = String(value);
  return (
    <span
      className="chip-pill chip-pill--fixed"
      title={`${col.label}: read from the file's embedded EXIF — click for details`}
      onClick={(e) => {
        if (!setPillInfo) return;
        e.stopPropagation();
        setPillInfo({ kind: "exif", value: { col, item }, anchorEl: e.currentTarget });
      }}
    >
      <span className="chip-pill__lock" aria-hidden="true"><Icon name="lock" size={9} /></span>
      <span className="chip-pill__text">{display}</span>
    </span>
  );
}

// Inline preview of the wikitext that would be published for this row. We
// render a single-line, whitespace-collapsed excerpt — enough to show the
// shape of what's there ({{Information|...}}, then categories, then any
// custom-template fragments) without consuming vertical space. The full
// wikitext is reachable via the click-to-open modal on the parent cell.
//
// Memoised on the item + template config so we don't rebuild wikitext for
// every render of every row.
function WikitextPreviewCell({ item, templateConfig }) {
  const snippet = useMemoT(() => {
    try {
      const wt = buildWikitext(item, templateConfig);
      // Collapse newlines + runs of whitespace into single spaces so a
      // multi-line wikitext block flattens into a scannable preview.
      return String(wt || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      // buildWikitext shouldn't throw, but if it does we don't want to take
      // the whole table down with it. Surface a safe placeholder instead.
      return '';
    }
  }, [item, templateConfig]);

  if (!snippet) {
    return <span className="tbl__td-placeholder">—</span>;
  }
  return <span className="tbl__td-text tbl__td-wikitext-snippet">{snippet}</span>;
}

// ===== Fixed-position popout =====
// Cell editor needs to escape the table's clipping ancestors (.tbl-wrap and
// .tbl-scroll both clip overflow). We anchor with position:fixed at the cell's
// rect, then flip horizontally if it would run past the viewport's right edge.
function FixedPopout({ anchorRef, minWidth, onOutsideClick, children }) {
  const ref = useRefT(null);
  const [pos, setPos] = useStateT(null);

  useEffectT(() => {
    const compute = () => {
      const a = anchorRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const w = Math.max(minWidth || 260, rect.width + 60);
      const margin = 8;
      let left = rect.left - 2;
      // flip horizontally if we'd run off the right edge
      if (left + w + margin > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - w - margin);
      }
      setPos({ left, top: rect.top - 2, width: w });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef, minWidth]);

  // Outside-click closer: any mousedown outside the popout (and outside the
  // anchor cell) closes the editor. We DON'T preventDefault — that would block
  // focus from shifting and prevent text editors' onBlur from firing (which is
  // how those editors commit their value). Instead we stopPropagation so the
  // click doesn't reach the underlying cell's onClick/onMouseDown handlers.
  // The blur on the editor input fires its commit; finishEdit closes the
  // popout. We swallow the matching click event too, in case the underlying
  // cell would react to onClick (startEdit).
  useEffectT(() => {
    if (!onOutsideClick) return;
    const isOutside = (e) => {
      const pop = ref.current;
      const anchor = anchorRef.current;
      if (!pop) return false;
      if (pop.contains(e.target)) return false;
      if (anchor && anchor.contains(e.target)) return false;
      return true;
    };
    const onDocDown = (e) => {
      if (!isOutside(e)) return;
      e.stopPropagation();
      // Force any focused editor input inside the popout to commit by blurring
      // it synchronously — its onBlur handler is what saves the value (e.g.
      // DateTimeEditor reads the current input value and calls onCommit).
      const pop = ref.current;
      const focused = pop && pop.contains(document.activeElement) ? document.activeElement : null;
      if (focused && typeof focused.blur === "function") focused.blur();
      onOutsideClick();
    };
    const onDocClick = (e) => {
      if (!isOutside(e)) return;
      e.stopPropagation();
    };
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("click", onDocClick, true);
    return () => {
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("click", onDocClick, true);
    };
  }, [anchorRef, onOutsideClick]);

  if (!pos) return null;
  return (
    <div
      ref={ref}
      className="tbl__td-popout tbl__td-popout--fixed"
      style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
    >
      {children}
    </div>
  );
}

// ===== Click-through icon for autocomplete suggestions =====
// Each suggestion row renders a small icon-button that opens the target page
// (Commons category / Wikidata item) in a new tab. Clicking the icon must NOT
// commit the suggestion, so we stop both mousedown (the row's commit handler
// fires onMouseDown) and click. window.open with noopener+noreferrer for
// link-rel safety.
function AutocompleteLinkButton({ href, title }) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  const open = (e) => {
    stop(e);
    window.open(href, "_blank", "noopener,noreferrer");
  };
  return (
    <button
      type="button"
      className="autocomplete__action"
      onMouseDown={stop}
      onClick={open}
      onKeyDown={(e) => {
        // Don't let Enter/Space on a focused row's icon trip the editor's
        // Enter-commit handler. The icon is mouse-only by design — keyboard
        // users navigate the dropdown with arrows + Enter to commit.
        if (e.key === "Enter" || e.key === " ") stop(e);
      }}
      tabIndex={-1}
      title={title}
      aria-label={title}
    >
      <Icon name="external" size={11} />
    </button>
  );
}

// Convenience wrappers for the two link kinds.
function CategoryLinkButton({ name }) {
  if (!name) return null;
  const href = `https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(String(name).replace(/ /g, "_"))}`;
  return <AutocompleteLinkButton href={href} title={`Open Category:${name} on Commons (new tab)`} />;
}

function WikidataLinkButton({ qid }) {
  if (!qid) return null;
  const href = `https://www.wikidata.org/wiki/${encodeURIComponent(qid)}`;
  return <AutocompleteLinkButton href={href} title={`Open ${qid} on Wikidata (new tab)`} />;
}

// ===== Autocomplete dropdown wrapper =====
// Renders the suggestions popup with viewport-aware placement: prefers below
// the parent .autocomplete (its sole positioned ancestor), flips above when
// there isn't room. Without this the popup stays in its CSS default position
// (top: 100%) and is clipped/hidden when the input sits low in the viewport —
// the user can't see the suggestions but still triggers them on blur.
//
// Usage: replace `<div className="autocomplete__pop autocomplete__pop--scroll">…</div>`
// with `<AutocompletePop scroll>…</AutocompletePop>`.
function AutocompletePop({ scroll, inline, className = "", children }) {
  const ref = useRefT(null);
  const [style, setStyle] = useStateT({ visibility: "hidden" });

  useEffectT(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      // Find the positioned ancestor (.autocomplete) — that's our anchor.
      const anchor = el.parentElement;
      if (!anchor) return;
      const arect = anchor.getBoundingClientRect();
      const popHeight = el.scrollHeight;
      const popWidth = Math.max(anchor.offsetWidth, 280);
      const margin = 8;
      const spaceBelow = window.innerHeight - arect.bottom - margin;
      const spaceAbove = arect.top - margin;
      const flipUp = spaceBelow < Math.min(popHeight, 200) && spaceAbove > spaceBelow;
      // Cap height to whichever direction we end up flowing in.
      const maxH = Math.max(120, Math.min(280, flipUp ? spaceAbove : spaceBelow));
      let left = arect.left;
      // Don't overflow the right edge.
      if (left + popWidth + margin > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - popWidth - margin);
      }
      const next = {
        position: "fixed",
        left: `${left}px`,
        width: `${popWidth}px`,
        maxHeight: `${maxH}px`,
        overflowY: "auto",
        visibility: "visible",
        zIndex: 1200,
      };
      if (flipUp) next.bottom = `${window.innerHeight - arect.top + 2}px`;
      else next.top = `${arect.bottom + 2}px`;
      setStyle(next);
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    // Recompute as content grows/shrinks (e.g. async results, typing).
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
      ro.disconnect();
    };
  }, [children]);

  const cls = "autocomplete__pop"
    + (scroll ? " autocomplete__pop--scroll" : "")
    + (inline ? " autocomplete__pop--inline" : "")
    + (className ? " " + className : "");
  return (
    <div ref={ref} className={cls} style={style}>
      {children}
    </div>
  );
}

// ===== Cell editor =====
function CellEditor({ col, item, onCommit, onCancel, onCopy, clipboard, onPaste, titleVocab, depictsFrequency, categoriesFrequency, selfUsername, getSiblingFutureCollisions, onAcceptSequenceSuggestion }) {
  // User-defined custom columns: free-form text input. T426449 dropped the
  // wikitext-template column kind, so the only surviving customProp is
  // Wikidata-property — value persists on the item via `customProps[pid]`
  // for the user's working notes (SDC write-through is a follow-up of
  // T426421). A textarea would be overkill — keep it single-line matching
  // how author/title are edited.
  if (col.customProp) {
    const pid = col.customProp.pid;
    const initial = (item.customProps || {})[pid] || '';
    return (
      <TextEditor
        initial={initial}
        placeholder={col.customProp.label}
        onCommit={(v) => {
          const next = { ...item, customProps: { ...(item.customProps || {}) } };
          if (v == null || v === '') delete next.customProps[pid];
          else next.customProps[pid] = v;
          onCommit(next);
        }}
        onCancel={onCancel}
      />
    );
  }
  // Caption columns share a single editor; the per-language column writes
  // into its own slot via setCaptionValue. (T426422.)
  if (col.caption) {
    const lang = col.caption.lang;
    const initial = window.getCaptionValue ? window.getCaptionValue(item, lang) : (item.description || "");
    return (
      <CaptionEditor
        initial={initial}
        onCommit={(v) => {
          const next = window.setCaptionValue
            ? window.setCaptionValue(item, lang, v)
            : { ...item, description: v };
          onCommit(next);
        }}
        onCancel={onCancel}
      />
    );
  }
  switch (col.key) {
    case "title":
      return (
        <TitleEditor
          initial={item.title || ""}
          sourceFilename={item.filename}
          vocab={titleVocab}
          itemId={item.id}
          selfUsername={selfUsername}
          getSiblingFutureCollisions={getSiblingFutureCollisions}
          onAcceptSequenceSuggestion={onAcceptSequenceSuggestion}
          onCommit={(v) => onCommit({ ...item, title: v })}
          onCancel={onCancel}
        />
      );
    case "author":
      return <AuthorEditor initial={item.author || ""} selfUsername={selfUsername} onCommit={(v) => onCommit({ ...item, author: v })} onCancel={onCancel} />;
    case "source":
      return <SourceEditor initial={item.source || ""} licenseId={item.license} onCommit={(v) => onCommit({ ...item, source: v })} onCancel={onCancel} />;
    case "license":
      return (
        <LicenseEditor
          initial={item.license || ""}
          onCommit={(v) => onCommit({ ...item, license: v })}
          onCancel={onCancel}
        />
      );
    case "categories":
      return <CategoriesEditor initial={item.categories || []} categoriesFrequency={categoriesFrequency} onCommit={(v) => onCommit({ ...item, categories: v })} onCancel={onCancel} onCopy={onCopy} />;
    case "depicts":
      return <DepictsEditor initial={item.depicts || []} depictsFrequency={depictsFrequency} onCommit={(v) => onCommit({ ...item, depicts: v })} onCancel={onCancel} onCopy={onCopy} />;
    case "dateTaken":
      return <DateTimeEditor initial={item.dateTaken || ""} onCommit={(v) => onCommit({ ...item, dateTaken: v })} onCancel={onCancel} />;
    case "cameraLocation":
      return (
        <LocationEditor
          variant="camera"
          initial={item.cameraLocation || item.coords || null}
          item={item}
          onCommit={(v) => onCommit({ ...item, cameraLocation: v, coords: v })}
          onCancel={onCancel}
        />
      );
    case "objectLocation":
      return (
        <LocationEditor
          variant="object"
          initial={item.objectLocation || null}
          item={item}
          onCommit={(v) => onCommit({ ...item, objectLocation: v })}
          onCancel={onCancel}
        />
      );
    case "locationOfCreation":
      return (
        <WikidataItemEditor
          initial={item.locationOfCreation || null}
          placeholder="Search Wikidata place…"
          onCommit={(v) => onCommit({ ...item, locationOfCreation: v })}
          onCancel={onCancel}
        />
      );
    default:
      return <span className="tbl__td-placeholder">Not editable</span>;
  }
}

// ===== Mini map cell =====
// Tiny stamp-sized map preview rendered in a table cell.
function MiniMapCell({ loc, variant }) {
  // Visual position of the pin based on lon/lat (just within the small thumbnail).
  // We don't pretend to be a real map at this scale — center the pin and dot the
  // surroundings; opening the editor reveals the bigger interactive map.
  return (
    <span className={"minimap minimap--" + (variant === "object" ? "object" : "camera")} aria-hidden="false">
      <span className="minimap__grid" />
      <span className="minimap__pin">
        <Icon name="geo" size={14} />
      </span>
    </span>
  );
}

// ===== Location editor (popover) =====
// Larger interactive map: click to drop the pin, or type lat/lon directly.
// In-map search box, +/- zoom buttons, and a corner drag handle to resize the
// whole popover. For object locations, depicts entries that have known
// coordinates appear as suggestions.
//
// Search index: LOCATION_HINTS keyed by QID + a small static gazetteer for
// places not (yet) referenced by any depicts entry. This is a mock — in a real
// build, the input would query a geocoder.
const SEARCH_GAZETTEER = [
  { label: "Vrijthof, Maastricht",            lat: 50.8489, lon: 5.6886 },
  { label: "Maastricht",                       lat: 50.8514, lon: 5.6909 },
  { label: "Sint-Pietersberg",                 lat: 50.8201, lon: 5.6755 },
  { label: "Saint Servatius Basilica",         lat: 50.8492, lon: 5.6878 },
  { label: "Onze-Lieve-Vrouweplein, Maastricht", lat: 50.8475, lon: 5.6918 },
  { label: "Helpoort, Maastricht",             lat: 50.8431, lon: 5.6906 },
  { label: "Bonnefantenmuseum",                lat: 50.8378, lon: 5.7008 },
  { label: "Roermond railway station",         lat: 51.1942, lon: 5.9869 },
  { label: "Glaspaleis, Heerlen",              lat: 50.8881, lon: 5.9788 },
  { label: "Valkenburg aan de Geul",           lat: 50.8650, lon: 5.8294 },
  { label: "Thorn, Limburg",                   lat: 51.1639, lon: 5.8378 },
  { label: "Drielandenpunt, Vaals",            lat: 50.7544, lon: 6.0208 },
  { label: "Sittard",                          lat: 51.0014, lon: 5.8694 },
  { label: "Rolduc Abbey, Kerkrade",           lat: 50.8633, lon: 6.0697 },
  { label: "Maaseik",                          lat: 51.0997, lon: 5.7858 },
  { label: "Chemelot, Geleen",                 lat: 50.9844, lon: 5.8167 },
  { label: "Amsterdam",                        lat: 52.3676, lon: 4.9041 },
  { label: "Rotterdam",                        lat: 51.9244, lon: 4.4777 },
  { label: "Utrecht",                          lat: 52.0907, lon: 5.1214 },
  { label: "The Hague",                        lat: 52.0705, lon: 4.3007 },
  { label: "Eindhoven",                        lat: 51.4416, lon: 5.4697 },
  { label: "Brussels",                         lat: 50.8503, lon: 4.3517 },
  { label: "Aachen",                           lat: 50.7753, lon: 6.0839 },
  { label: "Liège",                            lat: 50.6326, lon: 5.5797 }
];

// Internal zoom (0..5) maps to OSM tile zoom levels. The OsmTileMap below
// renders real tiles at osmZoom; the search/zoom buttons stay on the
// internal scale so existing UI doesn't change.
const OSM_ZOOM_BY_INTERNAL = [6, 9, 12, 15, 17, 18];
const DEFAULT_ZOOM = 3;

// Web Mercator tile math. Tile size is fixed at 256 px.
const OSM_TILE = 256;
function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * Math.pow(2, z);
}
function tileXToLon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}
function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// ===== OSM tile map =====
// Real OpenStreetMap tiles. Drag to pan; click (without dragging) drops a
// pin at that lat/lon. Wraps tiles around the antimeridian; clamps near
// the polar caps (where Web Mercator breaks down). Pin position is
// computed in tile space so it stays accurate at every zoom level.
const DRAG_CLICK_THRESHOLD = 4; // px — below this, mousedown+up = click, not drag
function OsmTileMap({ center, zoom, pinLoc, onMapClick, onCenterChange }) {
  const ref = useRefT(null);
  const [size, setSize] = useStateT({ w: 0, h: 0 });
  const [dragging, setDragging] = useStateT(false);

  useEffectT(() => {
    if (!ref.current) return;
    const update = () => {
      const r = ref.current.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);

  const z = OSM_ZOOM_BY_INTERNAL[zoom] ?? 14;
  const T = OSM_TILE;
  const max = Math.pow(2, z);
  const cx = lonToTileX(center.lon, z);
  const cy = latToTileY(center.lat, z);

  // Top-left of the viewport, in tile units.
  const x0 = cx - size.w / 2 / T;
  const y0 = cy - size.h / 2 / T;

  const tiles = [];
  if (size.w > 0 && size.h > 0) {
    const tx0 = Math.floor(x0);
    const ty0 = Math.floor(y0);
    const tx1 = Math.floor(x0 + size.w / T);
    const ty1 = Math.floor(y0 + size.h / T);
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (ty < 0 || ty >= max) continue; // skip polar caps
        const wrappedTx = ((tx % max) + max) % max;
        tiles.push({
          key: `${tx}-${ty}-${z}`,
          src: `https://tile.openstreetmap.org/${z}/${wrappedTx}/${ty}.png`,
          left: (tx - x0) * T,
          top: (ty - y0) * T,
        });
      }
    }
  }

  // Pan state lives in refs (not state) so per-pixel mousemoves don't
  // hammer React. The `dragging` boolean is React state purely for the
  // CSS cursor; the actual center updates flow straight to onCenterChange.
  const dragRef = useRefT(null);

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    if (!ref.current) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startCx: cx,
      startCy: cy,
      moved: false,
    };
    setDragging(true);

    const onMove = (ev) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      if (!dragRef.current.moved && (Math.abs(dx) > DRAG_CLICK_THRESHOLD || Math.abs(dy) > DRAG_CLICK_THRESHOLD)) {
        dragRef.current.moved = true;
      }
      if (!dragRef.current.moved) return;
      // Mouse drag right = map content moves right = map center shifts LEFT.
      const newCx = dragRef.current.startCx - dx / T;
      const newCy = dragRef.current.startCy - dy / T;
      onCenterChange?.({
        lat: tileYToLat(newCy, z),
        lon: tileXToLon(newCx, z),
      });
    };

    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const wasDrag = dragRef.current?.moved;
      dragRef.current = null;
      setDragging(false);
      if (!wasDrag && ref.current && onMapClick) {
        // Treat as a click on the underlying map → drop pin at release point.
        const r = ref.current.getBoundingClientRect();
        const px = ev.clientX - r.left;
        const py = ev.clientY - r.top;
        if (px >= 0 && py >= 0 && px <= r.width && py <= r.height) {
          const wx = x0 + px / T;
          const wy = y0 + py / T;
          onMapClick({ lat: tileYToLat(wy, z), lon: tileXToLon(wx, z) });
        }
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  let pinPx = null;
  if (pinLoc && size.w > 0) {
    const px = (lonToTileX(pinLoc.lon, z) - x0) * T;
    const py = (latToTileY(pinLoc.lat, z) - y0) * T;
    if (px >= -20 && px <= size.w + 20 && py >= -20 && py <= size.h + 20) {
      pinPx = { px, py };
    }
  }

  return (
    <div
      className={'osm-tilemap' + (dragging ? ' osm-tilemap--dragging' : '')}
      ref={ref}
      onMouseDown={onMouseDown}
    >
      {tiles.map((t) => (
        <img
          key={t.key}
          src={t.src}
          style={{ position: 'absolute', left: t.left, top: t.top, width: T, height: T }}
          alt=""
          loading="lazy"
          draggable={false}
        />
      ))}
      {pinPx && (
        <div
          className="osm-tilemap__pin"
          style={{ left: pinPx.px, top: pinPx.py }}
          aria-hidden="true"
        >
          <Icon name="geo" size={28} />
        </div>
      )}
      <div className="osm-tilemap__attrib">
        ©{' '}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          onMouseDown={(e) => e.stopPropagation()}
        >
          OpenStreetMap
        </a>
      </div>
    </div>
  );
}

// ===== "Open in" mini-logos =====
// Brand-evoking inline SVGs (not the official trademarks) used in the link
// row of the LocationEditor. Each ~14×14, currentColor-free so brand colors
// are baked in.
function OsmLogo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#7EBC6F" />
      <text x="12" y="16" fontSize="8" fontWeight="700" textAnchor="middle" fill="#fff" fontFamily="system-ui, sans-serif">OSM</text>
    </svg>
  );
}
function GoogleMapsLogo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C8 2 5 5 5 9c0 5.5 7 13 7 13s7-7.5 7-13c0-4-3-7-7-7z" fill="#EA4335" />
      <circle cx="12" cy="9" r="2.7" fill="#fff" />
    </svg>
  );
}
function WikiShootMeLogo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="7" width="18" height="13" rx="2" fill="#36c" />
      <rect x="9" y="4" width="6" height="3" rx="0.5" fill="#36c" />
      <circle cx="12" cy="13.5" r="3.8" fill="#fff" />
      <circle cx="12" cy="13.5" r="2.2" fill="#36c" />
    </svg>
  );
}

function LocationEditor({ variant, initial, item, onCommit, onCancel }) {
  const [loc, setLoc] = useStateT(initial || null);
  const [latStr, setLatStr] = useStateT(initial ? String(initial.lat) : "");
  const [lonStr, setLonStr] = useStateT(initial ? String(initial.lon) : "");
  const fallbackCenter = initial || (item.cameraLocation || item.coords) || { lat: 50.85, lon: 5.69 };
  const [center, setCenter] = useStateT(fallbackCenter);
  const [zoom, setZoom] = useStateT(DEFAULT_ZOOM);
  const [query, setQuery] = useStateT("");
  const [searchOpen, setSearchOpen] = useStateT(false);

  // Resizable popover — width × height in px. Default sized to feel "compact"
  // but big enough to be usable; grabbing the corner handle adjusts these.
  const DEFAULT_W = 380, DEFAULT_H = 420;
  const [size, setSize] = useStateT({ w: DEFAULT_W, h: DEFAULT_H });
  const rootRef = useRefT(null);
  const resizingRef = useRefT(null);

  useEffectT(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Drag-to-resize from the bottom-right corner.
  const onResizeStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const startW = size.w, startH = size.h;
    resizingRef.current = true;
    const onMove = (ev) => {
      const w = Math.max(280, Math.min(900, startW + (ev.clientX - startX)));
      const h = Math.max(280, Math.min(800, startH + (ev.clientY - startY)));
      setSize({ w, h });
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Click on the OSM tile map → set the pin (and update the lat/lon inputs).
  // Doesn't change the map center — the user can pan via search or coords.
  const onMapClick = (latLon) => {
    if (resizingRef.current) return;
    const next = { lat: round5(latLon.lat), lon: round5(latLon.lon) };
    setLoc(next);
    setLatStr(String(next.lat));
    setLonStr(String(next.lon));
  };

  const zoomIn  = () => setZoom(z => Math.min(OSM_ZOOM_BY_INTERNAL.length - 1, z + 1));
  const zoomOut = () => setZoom(z => Math.max(0, z - 1));

  const commit = () => {
    const lat = parseFloat(latStr), lon = parseFloat(lonStr);
    if (!isFinite(lat) || !isFinite(lon)) { onCommit(null); return; }
    onCommit({ lat, lon });
  };
  const clear = () => { onCommit(null); };

  // Search results: filter the gazetteer by substring; depicts hits float to the top.
  const depictsHints = (item.depicts || [])
    .map(d => {
      const hint = (window.LOCATION_HINTS || {})[d.qid];
      return hint ? { label: d.label, lat: hint.lat, lon: hint.lon, fromDepicts: true } : null;
    })
    .filter(Boolean);
  const q = query.trim().toLowerCase();
  const searchResults = q
    ? [
        ...depictsHints.filter(h => h.label.toLowerCase().includes(q)),
        ...SEARCH_GAZETTEER.filter(g => g.label.toLowerCase().includes(q))
      ].slice(0, 8)
    : depictsHints.slice(0, 5);

  const pickResult = (r) => {
    setCenter({ lat: r.lat, lon: r.lon });
    setLoc({ lat: r.lat, lon: r.lon });
    setLatStr(String(r.lat));
    setLonStr(String(r.lon));
    setQuery(r.label);
    setSearchOpen(false);
    setZoom(z => Math.max(z, 4)); // jump in a bit so they can refine
  };

  // Suggestions from depicts (object location only) — kept as quick chips below the map.
  const suggestions = (variant === "object" ? (item.depicts || []) : [])
    .map(d => {
      const hint = (window.LOCATION_HINTS || {})[d.qid];
      return hint ? { qid: d.qid, label: d.label, lat: hint.lat, lon: hint.lon } : null;
    })
    .filter(Boolean);

  // (Pin position + viewport bounds are handled inside OsmTileMap now.)

  return (
    <div
      className="loc-editor loc-editor--resizable"
      ref={rootRef}
      style={{ width: size.w + "px", height: size.h + "px" }}
      onClick={e => e.stopPropagation()}
    >
      <div className="loc-editor__head">
        <strong>{variant === "object" ? "Object location" : "Camera location"}</strong>
        <span className="loc-editor__hint">
          {variant === "object"
            ? "Where is the subject? Search, click the map, or type coordinates."
            : "Where was the photo taken? Search, click the map, or type coordinates."}
        </span>
      </div>

      <div className="loc-editor__map">
        <OsmTileMap
          center={center}
          zoom={zoom}
          pinLoc={loc}
          onMapClick={onMapClick}
          onCenterChange={setCenter}
        />

        {/* Search overlay (top-left of map) */}
        <div className="loc-editor__search" onClick={e => e.stopPropagation()}>
          <div className="loc-editor__search-input-wrap">
            <Icon name="search" size={12} />
            <input
              className="loc-editor__search-input"
              value={query}
              onChange={e => { setQuery(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              placeholder="Search for a place…"
              onKeyDown={e => {
                if (e.key === "Enter" && searchResults[0]) { e.preventDefault(); pickResult(searchResults[0]); }
                else if (e.key === "Escape") { e.stopPropagation(); setSearchOpen(false); }
              }}
            />
            {query && (
              <button
                className="loc-editor__search-clear"
                onClick={() => { setQuery(""); setSearchOpen(false); }}
                title="Clear search"
                aria-label="Clear search"
              >×</button>
            )}
          </div>
          {searchOpen && searchResults.length > 0 && (
            <div className="loc-editor__search-results">
              {searchResults.map((r, i) => (
                <button
                  key={r.label + i}
                  className="loc-editor__search-result"
                  onClick={() => pickResult(r)}
                >
                  <Icon name="geo" size={11} />
                  <span className="loc-editor__search-result-label">{r.label}</span>
                  {r.fromDepicts && <span className="loc-editor__search-result-tag">depicts</span>}
                  <span className="loc-editor__search-result-coords mono">
                    {r.lat.toFixed(3)}, {r.lon.toFixed(3)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Zoom controls (top-right of map) */}
        <div className="loc-editor__zoom" onClick={e => e.stopPropagation()}>
          <button
            className="loc-editor__zoom-btn"
            onClick={zoomIn}
            disabled={zoom >= OSM_ZOOM_BY_INTERNAL.length - 1}
            title="Zoom in"
            aria-label="Zoom in"
          >+</button>
          <div className="loc-editor__zoom-divider" />
          <button
            className="loc-editor__zoom-btn"
            onClick={zoomOut}
            disabled={zoom <= 0}
            title="Zoom out"
            aria-label="Zoom out"
          >−</button>
        </div>

        {/* Crosshair for center */}
        <div className="loc-editor__crosshair" aria-hidden="true">
          <div className="loc-editor__crosshair-h" />
          <div className="loc-editor__crosshair-v" />
        </div>
      </div>

      <div className="loc-editor__inputs">
        <label>Lat<input value={latStr} onChange={e => setLatStr(e.target.value)} placeholder="50.8492" inputMode="decimal" /></label>
        <label>Lon<input value={lonStr} onChange={e => setLonStr(e.target.value)} placeholder="5.6878"  inputMode="decimal" /></label>
      </div>

      {suggestions.length > 0 && (
        <div className="loc-editor__suggest">
          <div className="loc-editor__suggest-head">From depicts:</div>
          <div className="loc-editor__suggest-list">
            {suggestions.map(s => (
              <button
                key={s.qid}
                className="loc-editor__suggest-btn"
                onClick={() => {
                  setCenter({ lat: s.lat, lon: s.lon });
                  setLoc({ lat: s.lat, lon: s.lon });
                  setLatStr(String(s.lat)); setLonStr(String(s.lon));
                }}
                title={`${s.lat}, ${s.lon}`}
              >
                <Icon name="geo" size={12} /> {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {loc && (
        <div className="loc-editor__open-in">
          <span className="loc-editor__open-in-label">Open in</span>
          <a
            className="loc-editor__open-link"
            href={`https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lon}&zoom=${OSM_ZOOM_BY_INTERNAL[zoom] ?? 16}`}
            target="_blank"
            rel="noopener noreferrer"
            title="OpenStreetMap"
          >
            <OsmLogo /> OSM
          </a>
          <a
            className="loc-editor__open-link"
            href={`https://www.google.com/maps?q=${loc.lat},${loc.lon}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Google Maps"
          >
            <GoogleMapsLogo /> Google Maps
          </a>
          <a
            className="loc-editor__open-link"
            href={`https://wikishootme.toolforge.org/#lat=${loc.lat}&lng=${loc.lon}&zoom=16`}
            target="_blank"
            rel="noopener noreferrer"
            title="WikiShootMe — see what's geotagged here on Commons & Wikidata"
          >
            <WikiShootMeLogo /> WikiShootMe
          </a>
        </div>
      )}

      <div className="loc-editor__actions">
        <button className="btn btn--small btn--quiet" onClick={clear}>Clear</button>
        <span style={{ flex: 1 }} />
        <button className="btn btn--small btn--quiet" onClick={onCancel}>Cancel</button>
        <button className="btn btn--small btn--primary" onClick={commit}>Save</button>
      </div>

      {/* Resize handle (bottom-right corner) */}
      <div
        className="loc-editor__resize"
        onMouseDown={onResizeStart}
        title="Drag to resize"
        aria-label="Resize"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M13 5 L5 13 M13 9 L9 13 M13 13 L13 13" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}

function round5(n) { return Math.round(n * 1e5) / 1e5; }

// ===== Date & time editor =====
function DateTimeEditor({ initial, onCommit, onCancel }) {
  const [v, setV] = useStateT(toLocalDateTime(initial));
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); }, []);
  // Read the input's current value at commit time. <input type="datetime-local">
  // returns "" until ALL segments (Y/M/D/H/M) are filled — even if the user has
  // partially typed. So treat empty as "no change" rather than clearing the
  // existing value: cancel out instead of committing "". The user can clear an
  // existing date explicitly via the picker's clear affordance or by deleting
  // and pressing Esc-Enter on a fully empty value (we still allow this when
  // the field was already empty going in, so committing "" is a no-op).
  const commit = () => {
    const raw = ref.current ? ref.current.value : v;
    if (!raw) {
      // No usable value yet — bail without overwriting the existing one.
      onCancel();
      return;
    }
    const d = new Date(raw);
    if (isNaN(d)) { onCancel(); return; }
    onCommit(d.toISOString());
  };
  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  return (
    <input
      ref={ref}
      type="datetime-local"
      className="tbl__edit-input tbl__edit-input--datetime"
      defaultValue={v}
      step={60}
      onChange={e => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  );
}

// Convert ISO -> "YYYY-MM-DDTHH:MM" in LOCAL time for <input type="datetime-local">.
function toLocalDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Compact "29 Apr, 14:42" format for the table cell.
function formatDateTimeShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const date = d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time}`;
}

// ===== Text editor (plain) =====
function TextEditor({ initial, placeholder, textarea, onCommit, onCancel }) {
  const [v, setV] = useStateT(initial);
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); ref.current?.select?.(); }, []);
  const onKey = (e) => {
    if (e.key === "Enter" && !textarea) { e.preventDefault(); onCommit(v); }
    else if (e.key === "Enter" && textarea && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onCommit(v); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };
  const Tag = textarea ? "textarea" : "input";
  return (
    <Tag
      ref={ref}
      className="tbl__edit-input"
      value={v}
      placeholder={placeholder}
      onChange={e => setV(e.target.value)}
      onBlur={() => onCommit(v)}
      onKeyDown={onKey}
      rows={textarea ? 3 : undefined}
    />
  );
}

// ===== Author editor =====
//
// Plain text input plus a "Me (Username)" quick-select that fills the
// canonical Commons own-work form: `[[User:X|X]]`. This is the wikitext
// that ends up inside `{{Information |author=...}}`; the same form is
// detected by buildSdcClaims to emit the matching P170 (creator) SDC
// claim with somevalue + P2093/P4174/P2699 qualifiers. See research
// notes on T425874.
//
// The quick-select only appears when:
//   - we know the current user (selfUsername is set), AND
//   - the field doesn't already contain the canonical self-author form
//     (so we don't redundantly suggest what the user just chose).
function selfAuthorWikitextLocal(username) {
  if (!username) return '';
  return `[[User:${username}|${username}]]`;
}

function AuthorEditor({ initial, selfUsername, onCommit, onCancel }) {
  const [v, setV] = useStateT(initial);
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); ref.current?.select?.(); }, []);

  const selfForm = selfAuthorWikitextLocal(selfUsername);
  const showQuickSelect = !!selfForm && v.trim() !== selfForm;

  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); onCommit(v); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  const accept = (val) => { setV(val); onCommit(val); };

  return (
    <div className="autocomplete">
      <input
        ref={ref}
        className="tbl__edit-input"
        value={v}
        placeholder="Author"
        onChange={e => setV(e.target.value)}
        // Delay so a click on the quick-select pill registers before commit.
        onBlur={() => setTimeout(() => onCommit(v), 120)}
        onKeyDown={onKey}
      />
      {showQuickSelect && (
        <AutocompletePop scroll>
          <div className="autocomplete__hint">Quick select</div>
          <div
            className="autocomplete__item"
            onMouseDown={(e) => { e.preventDefault(); accept(selfForm); }}
            title={`Insert ${selfForm}`}
          >
            <span className="autocomplete__icon"><Icon name="user" size={11} /></span>
            <span className="autocomplete__primary">Me ({selfUsername})</span>
            <span className="autocomplete__secondary">{selfForm}</span>
          </div>
        </AutocompletePop>
      )}
    </div>
  );
}

// ===== Caption editor =====
// Plain-text, single-line input with quiet, threshold-based live char count and
// inline validation against Commons SDC caption rules (250-char Wikibase label
// limit, no markup/links/newlines).
//
// UX rules (per maintainer feedback on T425878):
//   - Counter is hidden below 200 chars (don't nag for short captions).
//   - 200–250: counter visible in neutral grey (e.g. "210 / 250").
//   - >250:    counter turns red (e.g. "300 / 250"); single short error
//              message on the same line — no count repetition.
//   - Trailing/leading whitespace is silently trimmed on commit; we never
//     surface a "trailing whitespace" warning to the user.
//   - Placeholder describes the *goal* of a caption, not the character limit.
//
// The user can still commit an invalid caption (so they're not trapped
// mid-edit), but the cell renders a persistent error indicator afterwards
// (see Cell.invalidCaption) and the publish path will block on it.
function CaptionEditor({ initial, onCommit, onCancel }) {
  const [v, setV] = useStateT(initial || "");
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); ref.current?.select?.(); }, []);

  // Validate against the trimmed value — trailing whitespace while the user is
  // still typing is not an "error", just a transient state we'll clean up at
  // commit time.
  const result = useMemoT(() => validateCaption(v), [v]);
  const overLimit = result.length > CAPTION_MAX_LENGTH;
  const showCounter = result.length >= CAPTION_COUNTER_THRESHOLD;
  const counterCls = "tbl__edit-caption__counter"
    + (overLimit ? " tbl__edit-caption__counter--err" : "");
  const overLimitErr = result.errors.find((e) => e.code === "too-long") || null;
  const otherErrors = result.errors.filter((e) => e.code !== "too-long");

  // Trim leading/trailing whitespace on commit. Validation already ignores
  // whitespace, so this is purely about not persisting the dangling chars.
  const commit = () => onCommit((v || "").trim());

  const onKey = (e) => {
    // Enter commits; Shift+Enter does nothing (no newlines allowed in captions).
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  // Strip newlines/tabs on paste so multi-line clipboard text gets joined into one line
  // rather than silently breaking the caption rules.
  const onChange = (e) => {
    const next = e.target.value.replace(/[\n\r\v\t]+/g, " ");
    setV(next);
  };

  return (
    <div className="tbl__edit-caption">
      <input
        ref={ref}
        type="text"
        className={"tbl__edit-input" + (overLimit ? " tbl__edit-input--err" : "")}
        value={v}
        placeholder="Brief description of the file"
        onChange={onChange}
        onBlur={commit}
        onKeyDown={onKey}
        maxLength={CAPTION_MAX_LENGTH * 2 /* allow paste-through; visible counter handles the cap */}
        aria-invalid={!result.valid}
      />
      <div className="tbl__edit-caption__meta">
        {(showCounter || overLimitErr) && (
          // Counter + over-limit message share one line: counter on the right
          // (red when over), short message on the left (only when over).
          <div className="tbl__edit-caption__line">
            {overLimitErr
              ? <span className="tbl__edit-caption__inline-err">{overLimitErr.message}</span>
              : <span className="tbl__edit-caption__line-spacer" />}
            <span className={counterCls} aria-live="polite">{result.length} / {CAPTION_MAX_LENGTH}</span>
          </div>
        )}
        {otherErrors.length > 0 && (
          <ul className="tbl__edit-caption__errors">
            {otherErrors.map((err) => (
              <li key={err.code}><Icon name="warn" size={11} /> {err.message}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ===== Source editor =====
//
// Free-text input for the `{{Information |source=...}}` field, plus a
// one-click `{{own}}` quick-select (the `Template:Own` shortcut Commons docs
// recommend for self-uploaded works). Custom URLs / citations pass through
// as-is.
//
// Default coupling with licence (T425949): when the row's licence is one of
// the own-work options (CC0, CC BY 4.0, CC BY-SA 4.0) and the cell stays
// empty, the publish step emits `{{own}}` automatically — that resolution
// happens in `effectiveSource()` in api/publish.js, not here, so the user's
// explicit edit (including an explicit blank) is always preserved. The
// editor surfaces a hint about that coupling so the behaviour isn't hidden.
const OWN_WIKITEXT = '{{own}}';

function SourceEditor({ initial, licenseId, onCommit, onCancel }) {
  const [v, setV] = useStateT(initial);
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); ref.current?.select?.(); }, []);

  const ownWork = !!window.isOwnWorkLicense?.(licenseId);
  const showQuickSelect = v.trim() !== OWN_WIKITEXT;

  const onKey = (e) => {
    if (e.key === "Enter") { e.preventDefault(); onCommit(v); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  const accept = (val) => { setV(val); onCommit(val); };

  return (
    <div className="autocomplete">
      <input
        ref={ref}
        className="tbl__edit-input"
        value={v}
        placeholder={ownWork ? "Empty = {{own}} (own-work licence)" : "URL, citation, or {{own}}"}
        onChange={e => setV(e.target.value)}
        // Delay so a click on the quick-select pill registers before commit.
        onBlur={() => setTimeout(() => onCommit(v), 120)}
        onKeyDown={onKey}
        title={
          ownWork
            ? "Source for the {{Information}} template. Leaving this blank will publish as {{own}} because the licence is own-work."
            : "Source for the {{Information}} template. With a non-own-work licence, this should be a URL, citation, or other attribution."
        }
      />
      {showQuickSelect && (
        <AutocompletePop scroll>
          <div className="autocomplete__hint">Quick select</div>
          <div
            className="autocomplete__item"
            onMouseDown={(e) => { e.preventDefault(); accept(OWN_WIKITEXT); }}
            title={`Insert ${OWN_WIKITEXT}`}
          >
            <span className="autocomplete__icon"><Icon name="user" size={11} /></span>
            <span className="autocomplete__primary">{OWN_WIKITEXT}</span>
            <span className="autocomplete__secondary">own work</span>
          </div>
          {ownWork && (
            <div className="autocomplete__hint" style={{ paddingTop: 0 }}>
              Empty publishes as {OWN_WIKITEXT} because the licence is own-work.
            </div>
          )}
        </AutocompletePop>
      )}
    </div>
  );
}

// ===== Title editor with history suggestions + Commons validation =====
//
// Auto-sequence suggestion (T425984): when the typed title would publish to a
// future filename that already exists on Commons (uploaded by the current
// user) OR matches another stash row's future filename, the editor surfaces a
// "Convert to sequence — add ` #`" suggestion below the status row. Accepting
// rewrites every matching stash row to `<basename> #` (the literal placeholder
// form); the publish-time resolver substitutes consecutive integers
// continuing the user's owned `<basename> N` series.
//
// Suppressed when:
//   - the typed title is already a placeholder (no need to re-suggest)
//   - the title fails local validation (the user has a different problem to fix)
//   - the Commons collision is with a file uploaded by *someone else* (per
//     spec: standard title validation handles that path; we don't want the
//     suggestion to imply silent take-over of someone else's basename)
function TitleEditor({
  initial, sourceFilename, vocab, onCommit, onCancel,
  itemId,
  selfUsername,
  getSiblingFutureCollisions,
  onAcceptSequenceSuggestion,
}) {
  const [v, setV] = useStateT(initial);
  const [active, setActive] = useStateT(0);
  const [open, setOpen] = useStateT(false);
  // Uniqueness check state machine: 'idle' | 'checking' | 'done' | 'error'
  const [uniq, setUniq] = useStateT(() => {
    const future = buildFutureFilename(initial, sourceFilename);
    const cached = future ? getCachedUniqueness(future) : null;
    return cached ? { state: 'done', result: cached } : { state: 'idle' };
  });
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); ref.current?.select?.(); }, []);

  // Local (synchronous) validation runs every render — it's cheap.
  const localIssue = useMemoT(() => validateTitleLocal(v), [v]);
  const future = useMemoT(() => buildFutureFilename(v, sourceFilename), [v, sourceFilename]);
  // Whether the current value is a placeholder. Drives the sequence-
  // suggestion gating (don't re-suggest a row that's already in the right
  // form) and silences the "already exists on Commons" status (a `<basename> #`
  // is never a real Commons filename — the resolver picks a fresh number).
  const isPlaceholder = useMemoT(() => isSequencePlaceholderTitle(v), [v]);

  // Uniqueness checker (debounced + cached). Only fires when local validation
  // is clean — no point asking Commons whether "DSC[#]/.." is taken.
  // Placeholder titles bypass the check entirely (the literal `Foo #` would
  // 404 on Commons regardless; the resolver handles uniqueness at publish).
  const checkerRef = useRefT(null);
  useEffectT(() => {
    const checker = makeUniquenessChecker((kind, result) => {
      if (kind === 'idle')     setUniq({ state: 'idle' });
      else if (kind === 'checking') setUniq({ state: 'checking' });
      else if (kind === 'done') setUniq({ state: 'done', result });
    });
    checkerRef.current = checker;
    return () => checker.cancel();
  }, []);
  useEffectT(() => {
    const checker = checkerRef.current;
    if (!checker) return;
    if (localIssue && localIssue.severity === 'error') {
      // Don't send obviously-broken titles to Commons.
      checker.onChange('');
      return;
    }
    if (isPlaceholder) {
      // Sequence placeholder — sender of the check would 404 on `Foo #`,
      // and we explicitly don't want the "Available as File:Foo #.jpg"
      // false-positive UX. Park the checker idle.
      checker.onChange('');
      return;
    }
    checker.onChange(future);
  }, [future, localIssue?.code, localIssue?.severity, isPlaceholder]);

  const suggestions = useMemoT(() => {
    if (!vocab || !vocab.length) return [];
    return window.matchVocab(vocab, v, t => t, 10);
  }, [vocab, v]);

  // Cross-stash collision count: number of OTHER stash rows that resolve to
  // the same future filename. Recomputed whenever the typed value changes
  // (collisions track the live edit, not the persisted title). The lookup
  // is App-level: it walks the freshest stash items via getSiblingFutureCollisions.
  const siblingCollisions = useMemoT(() => {
    if (!getSiblingFutureCollisions) return [];
    if (!future) return [];
    if (isPlaceholder) return []; // placeholder rows aren't collisions
    if (localIssue && localIssue.severity === 'error') return [];
    return getSiblingFutureCollisions(itemId, future);
  }, [getSiblingFutureCollisions, itemId, future, isPlaceholder, localIssue?.code, localIssue?.severity]);

  // Cross-Commons-own-collision: the typed title's future filename already
  // exists on Commons AND was uploaded by the current user. Spec says:
  // suggest sequence only for own files; someone else's file blocks publish
  // via standard title validation (T425880).
  const ownCommonsCollision = useMemoT(() => {
    if (!selfUsername) return false;
    if (uniq.state !== 'done') return false;
    const r = uniq.result;
    if (!r || r.state !== 'taken') return false;
    if (!r.dup?.user) return false; // no uploader info; don't speculate
    return r.dup.user === selfUsername;
  }, [uniq.state, uniq.result, selfUsername]);

  // Sequence suggestion is offered when (a) there's a collision the user can
  // resolve via the placeholder, AND (b) the editor isn't already showing the
  // placeholder. Either kind of collision is sufficient — they may also
  // co-occur (e.g. one stash row + one own-Commons file with the same name).
  const sequenceSuggestion = useMemoT(() => {
    if (!onAcceptSequenceSuggestion) return null;
    if (isPlaceholder) return null;
    if (localIssue && localIssue.severity === 'error') return null;
    const trimmed = String(v || '').trim();
    if (!trimmed) return null;
    if (siblingCollisions.length === 0 && !ownCommonsCollision) return null;
    // The basename is the trimmed typed value (without extension).
    // buildFutureFilename appends the source extension already, so the
    // basename for sequencing is just the trimmed typed string.
    const basename = trimmed;
    const ext = (sourceFilename || '').match(/\.[^.]+$/)?.[0] || '';
    return {
      basename,
      ext,
      // Only used for the inline message wording; counts the current row + siblings.
      stashCount: siblingCollisions.length + 1,
      ownCommons: !!ownCommonsCollision,
    };
  }, [
    onAcceptSequenceSuggestion, isPlaceholder, localIssue?.code, localIssue?.severity,
    v, sourceFilename, siblingCollisions, ownCommonsCollision,
  ]);

  // Always commit the trimmed value — the rest of the rule set already
  // operates on the trimmed form (validateTitleLocal trims internally), and
  // mid-edit trailing whitespace would otherwise round-trip through the
  // user-store and re-surface as an error after reload. T425880 feedback
  // 2026-05-11.
  const commit = (val) => onCommit(cleanTitleForCommit(val));
  const accept = (val) => { setV(val); commit(val); };

  // Accept the sequence suggestion. App's onAcceptSequenceSuggestion rewrites
  // every colliding stash row in one pass, including this one — but the
  // editor's local commit happens via onCommit, not via App's setItems
  // callback. So we both: (1) call App to rewrite the OTHER rows, and
  // (2) commit the placeholder for THIS row through the regular onCommit
  // path so the editor closes and the row's draft persists via onUpdate
  // → setDraft (same persistence path as a regular cell commit). The two
  // paths converge — App's rewrite skips already-placeholder rows, so even
  // if they race, no row gets double-rewritten.
  const acceptSequenceSuggestion = () => {
    if (!sequenceSuggestion) return;
    onAcceptSequenceSuggestion(sequenceSuggestion.basename, sequenceSuggestion.ext);
    accept(buildSequencePlaceholderTitle(sequenceSuggestion.basename));
  };

  // Autocomplete navigation flag: tracks whether the user explicitly used
  // arrow keys to highlight a recent-titles entry. Reset on every keystroke.
  // Drives Enter precedence below: when a sequence chip is present, Enter
  // accepts the chip unless the user has explicitly navigated into the
  // autocomplete (in which case Enter takes the highlighted entry).
  const navRef = useRefT(false);
  const onKey = (e) => {
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setOpen(true);
      setActive(a => Math.min(a + 1, suggestions.length - 1));
      navRef.current = true;
    }
    else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setActive(a => Math.max(a - 1, 0));
      navRef.current = true;
    }
    else if (e.key === "Enter") {
      e.preventDefault();
      // Precedence:
      //   1. Explicitly navigated autocomplete item → take that.
      //   2. Sequence chip is showing → accept it (per maintainer feedback,
      //      the chip is the primary actionable suggestion).
      //   3. Otherwise: commit the typed value as-is.
      if (open && navRef.current && suggestions[active]) {
        accept(suggestions[active]);
      } else if (sequenceSuggestion) {
        acceptSequenceSuggestion();
      } else {
        commit(v);
      }
    }
    else if (e.key === "Escape") {
      e.preventDefault();
      if (infoOpen) setInfoOpen(false);
      else if (open) setOpen(false);
      else onCancel();
    }
    else if (e.key === "Tab") {
      if (open && navRef.current && suggestions[active]) { e.preventDefault(); accept(suggestions[active]); }
    }
  };

  // Worst-issue ranking for the inline status row.
  //   Local error  > taken-on-Commons (other-user) > local warn > checking > free
  //
  // The status box is now reserved for things the user must act on. An
  // own-Commons collision (your own previously-published file) used to
  // surface as a yellow warning + a separate "Convert to sequence" suggestion
  // strip; the maintainer's feedback on T425984 was that the warn box was
  // too intense (a known own-file isn't an error — it's a routine sequence
  // collision the user resolves with one click). The chip below the input
  // now carries that affordance + tooltip + click-info popout, so we drop
  // the box entirely for the own-collision case. Other-user collisions
  // still get the hard-error styling (no sequence suggestion can resolve
  // those — see T425880).
  //
  // Sequence placeholders get a dedicated `info` line so the user understands
  // the cell isn't broken — it'll be resolved at publish time.
  const status = (() => {
    if (localIssue && localIssue.severity === 'error') {
      return { kind: 'error', message: localIssue.message };
    }
    if (isPlaceholder) {
      return {
        kind: 'info',
        message: 'Sequence placeholder — the publish step will assign the next number',
      };
    }
    if (uniq.state === 'done' && uniq.result?.state === 'taken') {
      const dup = uniq.result.dup || {};
      const youOwn = !!selfUsername && dup.user === selfUsername;
      // Own-file collision: don't render the status box. The chip below
      // (sequenceSuggestion) carries the message + the resolution.
      if (youOwn) return null;
      return {
        kind: 'error',
        message: `Already exists on Commons as File:${dup.filename} — pick a different title`,
      };
    }
    if (localIssue && localIssue.severity === 'warn') {
      return { kind: 'warn', message: localIssue.message };
    }
    if (uniq.state === 'checking') {
      return { kind: 'pending', message: 'Checking Commons…' };
    }
    if (uniq.state === 'done' && uniq.result?.state === 'free' && v.trim()) {
      return { kind: 'ok', message: `Available as File:${future}` };
    }
    return null;
  })();

  // Hover tooltip text for the chip — mirrors the wording the old yellow
  // box used, so the user gets the same explanation without the visually
  // intense styling.
  const sequenceTooltip = sequenceSuggestion ? (() => {
    const parts = [];
    if (sequenceSuggestion.ownCommons) {
      const fname = uniq.result?.dup?.filename || `${sequenceSuggestion.basename}${sequenceSuggestion.ext || ''}`;
      parts.push(`You already published File:${fname}.`);
    }
    if (sequenceSuggestion.stashCount > 1) {
      const n = sequenceSuggestion.stashCount;
      parts.push(`${n} stash row${n === 1 ? '' : 's'} share this name.`);
    }
    parts.push(
      `Click to convert ${sequenceSuggestion.stashCount > 1 ? `all ${sequenceSuggestion.stashCount} matching rows` : 'this row'} to "${sequenceSuggestion.basename} #". The publish step picks the next integer in your sequence (or 1 if you don't have one yet). Press Enter to accept.`,
    );
    return parts.join(' ');
  })() : null;

  // Info popout state: showing the list of the user's existing
  // `<basename> N` files. Lazy-fetched on first click — kept locally so
  // re-clicking the chip doesn't re-hit Commons.
  const [infoOpen, setInfoOpen] = useStateT(false);
  const [infoState, setInfoState] = useStateT({ state: 'idle' }); // 'loading' | 'ready' | 'error'
  const infoFetchKeyRef = useRefT(null);

  // Reset the info popout whenever the sequence suggestion's basename
  // changes (the cached list is keyed to the basename). Closing also resets
  // when the suggestion goes away, otherwise a stale popout could linger
  // pointing at a no-longer-relevant basename.
  const sequenceKey = sequenceSuggestion
    ? `${sequenceSuggestion.basename}\x00${sequenceSuggestion.ext || ''}`
    : null;
  useEffectT(() => {
    if (!sequenceKey) {
      setInfoOpen(false);
      setInfoState({ state: 'idle' });
      infoFetchKeyRef.current = null;
    }
  }, [sequenceKey]);

  const openInfo = () => {
    if (!sequenceSuggestion) return;
    setInfoOpen(true);
    // Close the recent-titles autocomplete so it doesn't render on top
    // (its z-index is much higher than our absolute popout).
    setOpen(false);
    // Fetch once per (basename, ext) pair. Mid-flight click = noop.
    if (infoFetchKeyRef.current === sequenceKey) return;
    infoFetchKeyRef.current = sequenceKey;
    setInfoState({ state: 'loading' });
    findOwnedSequenceFiles(
      sequenceSuggestion.basename,
      sequenceSuggestion.ext || '',
      selfUsername || '',
    ).then((res) => {
      if (infoFetchKeyRef.current !== sequenceKey) return; // basename changed mid-flight
      if (res.files == null) {
        setInfoState({ state: 'error' });
        return;
      }
      setInfoState({ state: 'ready', files: res.files, capped: !!res.capped });
    }).catch(() => {
      if (infoFetchKeyRef.current !== sequenceKey) return;
      setInfoState({ state: 'error' });
    });
  };

  return (
    <div className="autocomplete">
      <input
        ref={ref}
        className={"tbl__edit-input" + (status?.kind === 'error' ? ' tbl__edit-input--error' : '')}
        value={v}
        placeholder="Descriptive title"
        onChange={e => {
          setV(e.target.value);
          setOpen(true);
          setActive(0);
          navRef.current = false;
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => commit(v), 100)}
        onKeyDown={onKey}
        aria-invalid={status?.kind === 'error' ? 'true' : 'false'}
      />
      {status && (
        <div className={`title-validate title-validate--${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
          {status.kind === 'pending' && <span className="spinner spinner--inline" />}
          {status.kind === 'error' && <Icon name="warn" size={11} />}
          {status.kind === 'warn' && <Icon name="info" size={11} />}
          {status.kind === 'info' && <Icon name="info" size={11} />}
          {status.kind === 'ok' && <Icon name="check" size={11} />}
          <span>{status.message}</span>
        </div>
      )}
      {sequenceSuggestion && (
        <div className="title-sequence-chip-row" role="group" aria-label="Sequence suggestion">
          <button
            type="button"
            className="title-sequence-chip"
            // mousedown wins over input.onBlur (which would commit and
            // tear down the editor before our click ran).
            onMouseDown={(e) => {
              e.preventDefault();
              // Click on the chip = accept (it's the headline action).
              acceptSequenceSuggestion();
            }}
            title={sequenceTooltip}
            aria-label={`Convert to numbered sequence "${sequenceSuggestion.basename} #". ${sequenceTooltip}`}
          >
            <span className="title-sequence-chip__lead">Add</span>
            <span className="title-sequence-chip__placeholder">{'‘ #’'}</span>
            <span className="title-sequence-chip__hint">Enter</span>
          </button>
          <button
            type="button"
            className="title-sequence-chip-info"
            onMouseDown={(e) => {
              e.preventDefault();
              if (infoOpen) {
                setInfoOpen(false);
              } else {
                openInfo();
              }
            }}
            title="Show files already in this sequence"
            aria-expanded={infoOpen ? 'true' : 'false'}
            aria-label="Show details about this sequence"
          >
            <Icon name="info" size={12} />
          </button>
          {infoOpen && (
            <div className="title-sequence-info" role="dialog" aria-label="Sequence details">
              <div className="title-sequence-info__head">
                <span className="title-sequence-info__title">Sequence: {sequenceSuggestion.basename}</span>
                <button
                  type="button"
                  className="title-sequence-info__close"
                  onMouseDown={(e) => { e.preventDefault(); setInfoOpen(false); }}
                  aria-label="Close sequence details"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
              {sequenceSuggestion.stashCount > 1 && (
                <div className="title-sequence-info__section">
                  <div className="title-sequence-info__section-head">
                    {sequenceSuggestion.stashCount} stash rows share this name
                  </div>
                  <ul className="title-sequence-info__list">
                    {siblingCollisions.slice(0, 8).map((it) => (
                      <li key={it.id} className="title-sequence-info__item">
                        <span className="title-sequence-info__filename">{it.filename || it.title || it.id}</span>
                      </li>
                    ))}
                    {siblingCollisions.length > 8 && (
                      <li className="title-sequence-info__more">+{siblingCollisions.length - 8} more</li>
                    )}
                  </ul>
                </div>
              )}
              {selfUsername && (
                <div className="title-sequence-info__section">
                  <div className="title-sequence-info__section-head">
                    Already on Commons (your files)
                  </div>
                  {infoState.state === 'loading' && (
                    <div className="title-sequence-info__pending">
                      <span className="spinner spinner--inline" />
                      <span>Looking up your files…</span>
                    </div>
                  )}
                  {infoState.state === 'error' && (
                    <div className="title-sequence-info__pending">Couldn't load file list.</div>
                  )}
                  {infoState.state === 'ready' && infoState.files.length === 0 && (
                    <div className="title-sequence-info__empty">
                      {/* The own-collision case guarantees at least one match,
                          but defensively handle the "only stash collisions"
                          case where the user has nothing on Commons yet. */}
                      No prior <code>{sequenceSuggestion.basename} N</code> files — the sequence will start at 1.
                    </div>
                  )}
                  {infoState.state === 'ready' && infoState.files.length > 0 && (
                    <ul className="title-sequence-info__list">
                      {infoState.files.slice(0, 12).map((f) => (
                        <li key={f.n} className="title-sequence-info__item">
                          <a
                            href={`https://commons.wikimedia.org/wiki/File:${encodeURIComponent(f.filename)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="title-sequence-info__link"
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            {f.filename}
                            <Icon name="external" size={10} />
                          </a>
                        </li>
                      ))}
                      {infoState.files.length > 12 && (
                        <li className="title-sequence-info__more">+{infoState.files.length - 12} more</li>
                      )}
                      {infoState.capped && (
                        <li className="title-sequence-info__more">…list capped at scan limit</li>
                      )}
                    </ul>
                  )}
                </div>
              )}
              <div className="title-sequence-info__foot">
                Accepting rewrites the title to <code>{sequenceSuggestion.basename} #</code>. The publish step picks the next integer (continuing your sequence, or starting at 1).
              </div>
            </div>
          )}
        </div>
      )}
      {open && suggestions.length > 0 && (
        <AutocompletePop scroll>
          <div className="autocomplete__hint">Recently used titles</div>
          {suggestions.map((s, i) => (
            <div
              key={s}
              className={"autocomplete__item" + (i === active ? " autocomplete__item--active" : "")}
              onMouseDown={(e) => { e.preventDefault(); accept(s); }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="autocomplete__icon"><Icon name="clock" size={11} /></span>
              <span className="autocomplete__primary">{s}</span>
            </div>
          ))}
        </AutocompletePop>
      )}
    </div>
  );
}

// ===== Select editor (generic) =====
// Currently unused — the licence cell uses LicenseEditor below. Kept around
// as a small generic dropdown editor for future single-select fields.
function SelectEditor({ initial, options, onCommit, onCancel }) {
  const [v, setV] = useStateT(initial);
  const ref = useRefT(null);
  useEffectT(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    try { if (typeof el.showPicker === "function") el.showPicker(); } catch (e) {}
  }, []);
  return (
    <select
      ref={ref}
      className="tbl__edit-input tbl__edit-select"
      value={v}
      onChange={e => { setV(e.target.value); onCommit(e.target.value); }}
      onBlur={() => onCommit(v)}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
    >
      {options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
    </select>
  );
}

// ===== License editor (in-cell) =====
//
// Spreadsheet-cell variant of the licence selector. Compact: a <select> with
// <optgroup>s by work-source (Own / Someone else's / Custom), short labels,
// and per-option `title` so hover reveals the full descriptive name.
//
// Two branches:
//   - Known catalog id → on commit we store the id (e.g. "CC-BY-SA-4.0").
//   - Custom            → flips into a free-form <input> for raw wikitext;
//                         we store whatever the user typed verbatim.
//
// An info button above the input opens the catalog popover (full descriptions,
// per-option "more info" links, and the generic "Help me pick a licence" link).
function LicenseEditor({ initial, onCommit, onCancel }) {
  const known = window.isKnownLicenseId(initial);
  // The select value is the catalog id when known, the custom sentinel
  // when the stored value isn't in the catalog (covers free-form wikitext
  // and pre-existing imports), and "" for "no licence yet".
  const initialSelect = !initial ? "" : (known ? initial : window.CUSTOM_LICENSE_ID);
  const initialCustom = !known && initial ? initial : "";

  const [sel, setSel] = useStateT(initialSelect);
  const [custom, setCustom] = useStateT(initialCustom);
  const [showInfo, setShowInfo] = useStateT(false);
  const selectRef = useRefT(null);
  const inputRef = useRefT(null);

  useEffectT(() => {
    const el = sel === window.CUSTOM_LICENSE_ID ? inputRef.current : selectRef.current;
    if (!el) return;
    el.focus();
    try { if (typeof el.showPicker === "function") el.showPicker(); } catch (e) {}
  }, [sel]);

  const commit = () => {
    if (sel === window.CUSTOM_LICENSE_ID) onCommit(custom.trim());
    else onCommit(sel);
  };

  const onChangeSelect = (e) => {
    const v = e.target.value;
    setSel(v);
    // Auto-commit on plain id picks (matches old SelectEditor UX); the
    // custom branch waits for the user to fill in / confirm the input.
    if (v && v !== window.CUSTOM_LICENSE_ID) onCommit(v);
    else if (!v) onCommit("");
  };

  const groups = window.LICENSE_GROUPS || [];
  const licenses = window.LICENSES || [];

  return (
    <div className="lic-editor" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      <div className="lic-editor__row">
        {sel === window.CUSTOM_LICENSE_ID ? (
          <input
            ref={inputRef}
            className="tbl__edit-input lic-editor__custom"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
            }}
            placeholder="Custom wikitext, e.g. {{PD-because|reason}}"
          />
        ) : (
          <select
            ref={selectRef}
            className="tbl__edit-input tbl__edit-select"
            value={sel}
            onChange={onChangeSelect}
            onBlur={commit}
          >
            <option value="" title="Pick a licence">— Choose —</option>
            {groups.filter(g => g.id !== "custom").map(g => (
              <optgroup key={g.id} label={g.label}>
                {licenses.filter(l => l.group === g.id).map(l => (
                  <option key={l.id} value={l.id} title={l.title}>{l.short}</option>
                ))}
              </optgroup>
            ))}
            <option value={window.CUSTOM_LICENSE_ID} title="Enter a different licence as raw wikitext">
              Custom licence…
            </option>
          </select>
        )}
        <button
          type="button"
          className="lic-editor__info"
          title="About licences on Commons"
          onMouseDown={(e) => { e.preventDefault(); setShowInfo((s) => !s); }}
        >
          <Icon name="info" size={12} />
        </button>
      </div>
      {showInfo && <LicenseInfoPanel selectedId={sel} onClose={() => setShowInfo(false)} />}
    </div>
  );
}

// ===== License info panel =====
//
// Floating popover anchored under the licence editor. Lists every catalog
// entry with its short label, full title, plain-language explainer, and a
// "More info" link to the relevant Commons page. A "Help me pick a licence"
// link at the top points to Commons:Choosing_a_license — the generic guidance
// page.
function LicenseInfoPanel({ selectedId, onClose }) {
  const ref = useRefT(null);
  useEffectT(() => {
    const onDoc = (e) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target)) return;
      onClose();
    };
    setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const groups = window.LICENSE_GROUPS || [];
  const licenses = window.LICENSES || [];

  return (
    <div ref={ref} className="lic-info">
      <div className="lic-info__head">
        <Icon name="info" size={12} />
        <span>About licences</span>
        <a
          className="lic-info__pick"
          href={window.LICENSE_HELP_URL}
          target="_blank"
          rel="noopener noreferrer"
          onMouseDown={(e) => e.stopPropagation()}
        >
          Help me pick a licence <Icon name="external" size={11} />
        </a>
      </div>
      <div className="lic-info__body">
        {groups.filter(g => g.id !== "custom").map(g => (
          <div key={g.id} className="lic-info__group">
            <div className="lic-info__group-label">{g.label}</div>
            {licenses.filter(l => l.group === g.id).map(l => (
              <div
                key={l.id}
                className={"lic-info__item" + (l.id === selectedId ? " lic-info__item--current" : "")}
              >
                <div className="lic-info__item-head">
                  <span className="lic-info__short">{l.short}</span>
                  <span className="lic-info__title">{l.title}</span>
                </div>
                <p className="lic-info__desc">{l.info}</p>
                {l.moreUrl && (
                  <a
                    className="lic-info__more"
                    href={l.moreUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    More info <Icon name="external" size={10} />
                  </a>
                )}
              </div>
            ))}
          </div>
        ))}
        <div className="lic-info__group">
          <div className="lic-info__group-label">Other / custom</div>
          <div className="lic-info__item">
            <div className="lic-info__item-head">
              <span className="lic-info__short">Custom licence</span>
              <span className="lic-info__title">Enter a different licence as raw wikitext</span>
            </div>
            <p className="lic-info__desc">
              For unusual cases (e.g. a specific public-domain claim). Type the licence template
              directly, including the curly braces — the wikitext goes verbatim under the file's
              licence header.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== Categories editor with vocabulary autocomplete =====
//
// T425950: this editor no longer creates new categories. The user can
// only attach existing Commons categories. The editor refuses to add a
// typed name that doesn't resolve to a real category — Enter, Tab,
// blur, and paste all run through the same gate. The user has to pick
// a suggestion from the dropdown (autocomplete is backed by the live
// Commons opensearch API via the autocomplete bridge).
//
// Pre-existing chips that came in via `initial` may still be missing on
// Commons (loaded from a draft saved before this rule existed, or a
// category that got deleted on Commons since the draft was saved). The
// editor flags those red ("does not exist — will not be published") so
// the user can remove or replace them; the publish gate reads the
// per-item `nonExistingCategories` flag set by app.jsx and blocks the
// row until they're gone.
function CategoriesEditor({ initial, categoriesFrequency, onCommit, onCancel, onCopy }) {
  const [list, setList] = useStateT(initial);
  const [input, setInput] = useStateT("");
  const [active, setActive] = useStateT(0);
  const [open, setOpen] = useStateT(false);
  // Per-name existence verdict from the API. undefined = not yet checked
  // / pending; true = exists; false = missing on Commons. Names that
  // came in via `initial` are seeded as undefined so the parent's check
  // (which has already run) drives the chip color until our own check
  // catches up.
  const [existsMap, setExistsMap] = useStateT({});
  // Pending API existence checks for typed-but-not-yet-confirmed names.
  // Lets us distinguish "still checking on Commons" (don't reject yet)
  // from "checked, doesn't exist" (reject + show why). Keyed by the
  // trimmed name → 'pending' | 'exists' | 'missing'.
  const [confirmCheck, setConfirmCheck] = useStateT({});
  // Last rejected typed value, with reason — used to surface a one-line
  // hint under the dropdown ("'Foo' isn't a Commons category"). Cleared
  // whenever the user types or successfully adds something.
  const [rejected, setRejected] = useStateT(null); // { value, reason } | null
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); }, []);

  // Frequently-used categories from the user's library (excluding ones already picked).
  const ghostSuggestions = useMemoT(() => {
    if (!categoriesFrequency) return [];
    return categoriesFrequency
      .filter(g => !list.includes(g.value))
      .slice(0, 6);
  }, [categoriesFrequency, list]);

  const suggestions = useMemoT(() => {
    if (!input.trim()) return [];
    // Strip any "Category:" prefix the user may have typed before matching
    // against the bare-name pool (T425912 — display is prefixed everywhere,
    // but the vocab and storage stay bare).
    const q = window.stripCategoryPrefix ? window.stripCategoryPrefix(input) : input;
    if (!q.trim()) return [];
    const pool = window.KNOWN_CATEGORIES.filter(c => !list.includes(c));
    return window.matchVocab(pool, q, t => t, 10);
  }, [input, list]);

  // Fire an existence check on a freshly-confirmed name. Cached at the
  // commons.js layer (apiCache 5-min TTL) — this is essentially free for
  // names already verified by the parent's per-row check.
  const checkExistence = (name) => {
    const t = String(name || '').trim();
    if (!t) return;
    setExistsMap((m) => (t in m ? m : { ...m, [t]: undefined }));
    categoryExists(t)
      .then((exists) => {
        setExistsMap((m) => ({ ...m, [t]: exists }));
      })
      .catch((e) => {
        // Network blip → leave the verdict undefined so the chip
        // renders neutral (the parent's effect will reconcile when it
        // runs after commit). Don't pretend the category is missing.
        console.warn('[categoriesEditor] existence check failed for', t, e?.message || e);
        setExistsMap((m) => {
          const next = { ...m };
          delete next[t];
          return next;
        });
      });
  };

  // Verify the initial chip list against Commons on mount. Cached at
  // the commons.js layer, so for names the parent's effect has already
  // resolved this is a no-op apart from the cache lookup. Without this
  // the editor relies entirely on the local KNOWN_CATEGORIES fallback
  // for pre-existing chips, which can show false positives (chip looks
  // green even though the category turns out to be missing).
  useEffectT(() => {
    for (const c of initial || []) {
      const t = String(c || '').trim();
      if (t) checkExistence(t);
    }
    // Intentionally only run on mount — `initial` is a stable
    // snapshot from the parent at editor open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a ref of the current list so async resolvers can read the
  // latest value (and forward an updated chip set to the parent) even
  // after the editor has closed.
  const listRef = useRefT(list);
  useEffectT(() => { listRef.current = list; }, [list]);

  // Try to confirm a typed name when neither the local autocomplete pool
  // nor a recent API check has answered yet. Calls categoryExists, then
  // — if confirmed — adds the chip. If the API says "missing" we surface
  // the rejection inline so the user knows why nothing happened. Network
  // errors leave the chip out of the list (we err on the side of safety:
  // if we can't confirm it, we don't add it). We also propagate the
  // confirmed list to the parent via onCommit, so the chip lands even
  // if the editor closed in the meantime (e.g. user clicked outside
  // while the API call was in flight).
  const tryConfirmAndAdd = (name) => {
    const t = String(name || '').trim();
    if (!t) return;
    setConfirmCheck((m) => ({ ...m, [t]: 'pending' }));
    categoryExists(t)
      .then((exists) => {
        setConfirmCheck((m) => ({ ...m, [t]: exists ? 'exists' : 'missing' }));
        if (exists) {
          const cur = listRef.current;
          const next = cur.includes(t) ? cur : [...cur, t];
          if (next !== cur) setList(next);
          // Mirror the addition out to the parent immediately. This is
          // what catches the "user pressed Enter then clicked outside"
          // race — the onBlur handler already committed the old list,
          // so we re-commit with the freshly-added chip.
          onCommit(next);
          setInput((curIn) => (curIn === t ? '' : curIn));
          setActive(0);
          setRejected(null);
          checkExistence(t);
        } else {
          setRejected({ value: t, reason: 'missing' });
        }
      })
      .catch((e) => {
        console.warn('[categoriesEditor] confirm check failed for', t, e?.message || e);
        setConfirmCheck((m) => {
          const next = { ...m };
          delete next[t];
          return next;
        });
        setRejected({ value: t, reason: 'network' });
      });
  };

  // Add path used by every confirm route (Enter, Tab, click on a
  // suggestion, click on a frequently-used pill, click on a typeahead
  // row). The rule is: only known categories pass. Names not yet known
  // locally fall through to an API check (`tryConfirmAndAdd`); the chip
  // is only created if the API confirms the category exists.
  const add = (val) => {
    // Normalize: strip any "Category:" prefix the user may have typed so we
    // store bare names internally (T425912).
    const raw = (val != null ? val : input);
    const t = window.stripCategoryPrefix ? window.stripCategoryPrefix(raw) : String(raw || "").trim();
    if (!t) { setInput(""); setActive(0); return; }
    if (list.includes(t)) { setInput(""); setActive(0); setRejected(null); return; }
    // Local pool already knows about this name (suggestion click,
    // frequently-used pill, or autocomplete bridge filled the live
    // cache). Add immediately and queue a background existence check
    // (cheap — same name is already cached at the API layer for
    // suggestion clicks).
    if (window.isKnownCategory && window.isKnownCategory(t)) {
      setList([...list, t]);
      setInput("");
      setActive(0);
      setRejected(null);
      checkExistence(t);
      return;
    }
    // Not in the local pool — could be a typo, could be a real category
    // we just haven't seen yet (autocomplete debounce hasn't fired, or
    // the user pasted a long-tail name). Fire a one-shot API check; the
    // chip is added only on confirmation.
    tryConfirmAndAdd(t);
  };
  const remove = (c) => setList(list.filter(x => x !== c));

  const onKey = (e) => {
    if (e.key === "ArrowDown" && suggestions.length) { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp" && suggestions.length) { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (open && suggestions[active]) add(suggestions[active]);
      else add();
    }
    else if (e.key === "Tab" && suggestions.length && open) { e.preventDefault(); add(suggestions[active]); }
    else if (e.key === "Escape") { e.preventDefault(); if (open) setOpen(false); else onCommit(list); }
    else if (e.key === "Backspace" && !input && list.length) { setList(list.slice(0, -1)); }
  };

  // Decide chip color: red iff our local check (or the merged-pool
  // fallback before the API has spoken) says the name doesn't exist.
  // Names with verdict=undefined fall back to the local pool so users
  // get instant feedback for obviously-typo'd names while the API call
  // is in flight.
  const chipState = (c) => {
    const verdict = existsMap[c];
    if (verdict === false) return { red: true, title: `${c} — does not exist on Commons; will not be published` };
    if (verdict === true) return { red: false, title: c };
    // Pending or no local check yet → fall back to merged pool.
    const known = window.isKnownCategory && window.isKnownCategory(c);
    if (known) return { red: false, title: c };
    return { red: true, title: `${c} — checking on Commons…` };
  };

  // Hint shown under the dropdown / under the input. Switches based on:
  //   - rejection (something the user just typed wasn't a real category)
  //   - in-flight confirm (we're waiting on the API for the typed name)
  //   - empty match list with a typed query (no suggestions yet)
  // Stays null when the user is just browsing suggestions.
  const trimmedInput = input.trim();
  const inputCheckState = trimmedInput ? confirmCheck[trimmedInput] : undefined;
  const inlineHint = (() => {
    if (inputCheckState === 'pending') {
      return { kind: 'pending', text: `Checking '${trimmedInput}' on Commons…` };
    }
    if (rejected?.value === trimmedInput) {
      if (rejected.reason === 'missing') {
        return { kind: 'reject', text: `'${trimmedInput}' isn't an existing Commons category — pick a suggestion below.` };
      }
      if (rejected.reason === 'network') {
        return { kind: 'reject', text: `Couldn't reach Commons to verify '${trimmedInput}'. Try again.` };
      }
    }
    return null;
  })();

  return (
    <div className="depicts-editor">
      {/* Row 1 — selected categories */}
      <div className="depicts-editor__row depicts-editor__row--selected">
        {list.length === 0 && (
          <span className="depicts-editor__row-empty">No categories yet</span>
        )}
        {list.map(c => {
          const { red, title } = chipState(c);
          // Display with "Category:" prefix (T425912). Storage stays bare.
          const display = window.formatCategory ? window.formatCategory(c) : `Category:${c}`;
          return (
            <span key={c} className={"tag tag--inline" + (red ? " tag--unknown" : "")} title={title}>
              <span className="tag__lbl">{display}</span>
              <button
                className="tag__copy"
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onCopy?.({ field: "categories", value: c, count: 0 }); }}
                title="Copy this category"
              ><Icon name="copy" size={9} /></button>
              <button
                className="tag__x"
                onMouseDown={(e) => { e.preventDefault(); remove(c); }}
                title="Remove"
              ><Icon name="close" size={10} /></button>
            </span>
          );
        })}
      </div>

      {/* Row 2 — frequently-used suggestions */}
      {ghostSuggestions.length > 0 && (
        <div className="depicts-editor__row depicts-editor__row--suggest">
          <span className="depicts-editor__row-label">Frequently used</span>
          <div className="depicts-editor__row-chips">
            {ghostSuggestions.slice(0, 6).map(g => {
              // Display with "Category:" prefix (T425912). g.value stays bare.
              const display = window.formatCategory ? window.formatCategory(g.value) : `Category:${g.value}`;
              return (
                <button
                  key={g.value}
                  className="tag tag--inline tag--ghost"
                  title={`Used ${g.count}× across your library — click to add`}
                  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); add(g.value); }}
                >
                  <Icon name="plus" size={9} />
                  <span className="tag__lbl">{display}</span>
                  <span className="tag__count">{g.count}×</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 3 — search field */}
      <div className="depicts-editor__row depicts-editor__row--search autocomplete autocomplete--inline">
        <Icon name="search" size={13} />
        <input
          ref={ref}
          className={"depicts-editor__input" + (inlineHint?.kind === 'reject' ? ' depicts-editor__input--rejected' : '')}
          value={input}
          onChange={e => {
            setInput(e.target.value);
            setOpen(true);
            setActive(0);
            // Typing invalidates the previous reject hint (the user is
            // editing toward a different value).
            if (rejected) setRejected(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => {
            // Don't try to add the trailing input on blur — that path
            // used to silently create a chip from whatever the user
            // typed. We only commit chips that have already been added
            // via the explicit add() gate (Enter / Tab / suggestion
            // click), and just discard any unconfirmed text. Use the
            // ref so we see any chip an in-flight add() just appended.
            onCommit(listRef.current);
          }, 120)}
          onKeyDown={onKey}
          placeholder="Type to search existing categories…"
        />
        {open && (suggestions.length > 0 || trimmedInput) && (
          <AutocompletePop scroll>
            {suggestions.length === 0 && trimmedInput && !inlineHint && (
              <div className="autocomplete__empty">
                <Icon name="info" size={11} />
                No match yet — keep typing or pick from the list. Only existing
                Commons categories can be added.
              </div>
            )}
            {inlineHint && (
              <div className={"autocomplete__empty" + (inlineHint.kind === 'reject' ? ' autocomplete__empty--reject' : '')}>
                <Icon name={inlineHint.kind === 'reject' ? 'warn' : 'info'} size={11} />
                {inlineHint.text}
              </div>
            )}
            {suggestions.map((s, i) => {
              // Display with "Category:" prefix (T425912). s stays bare.
              const display = window.formatCategory ? window.formatCategory(s) : `Category:${s}`;
              const counts = window.getCategoryCounts ? window.getCategoryCounts(s) : null;
              const showCounts = counts && !counts.missing && (counts.files > 0 || counts.subcats > 0);
              return (
                <div
                  key={s}
                  className={"autocomplete__item" + (i === active ? " autocomplete__item--active" : "")}
                  onMouseDown={(e) => { e.preventDefault(); add(s); }}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="autocomplete__icon"><Icon name="folder" size={11} /></span>
                  <span className="autocomplete__primary">{display}</span>
                  {showCounts && (
                    <span className="autocomplete__counts" title={`${counts.files} files, ${counts.subcats} subcategories`}>
                      F{counts.files} C{counts.subcats}
                    </span>
                  )}
                  <span className="autocomplete__badge">existing</span>
                  <CategoryLinkButton name={s} />
                </div>
              );
            })}
            {/* "Create new" affordance removed (T425950): the tool no
                longer creates categories. */}
          </AutocompletePop>
        )}
      </div>
    </div>
  );
}

// ===== Single Wikidata item editor (e.g. Location of creation P1071) =====
// Single-select; renders the current pick as a chip with a × to clear, plus a
// search box backed by window.KNOWN_DEPICTS. Commits on selection, blur, or Esc.
function WikidataItemEditor({ initial, placeholder, onCommit, onCancel }) {
  const [pick, setPick] = useStateT(initial || null);
  const [input, setInput] = useStateT("");
  const [active, setActive] = useStateT(0);
  const [open, setOpen] = useStateT(true);
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); }, []);

  const suggestions = useMemoT(() => {
    const pool = window.KNOWN_DEPICTS || [];
    return window.matchVocab(pool, input, t => `${t.label} ${t.qid} ${t.desc || ""}`, 10);
  }, [input]);
  const isEmptyQuery = !input.trim();

  const choose = (s) => {
    if (!s) return;
    const next = { qid: s.qid, label: s.label };
    setPick(next);
    setInput("");
    setActive(0);
    setOpen(false);
    onCommit(next);
  };
  const clear = () => {
    setPick(null);
    onCommit(null);
  };

  const onKey = (e) => {
    const showing = suggestions;
    if (e.key === "ArrowDown" && showing.length) { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, showing.length - 1)); }
    else if (e.key === "ArrowUp" && showing.length) { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && showing[active]) { e.preventDefault(); choose(showing[active]); }
    else if (e.key === "Tab" && showing[active] && open) { e.preventDefault(); choose(showing[active]); }
    else if (e.key === "Escape") { e.preventDefault(); onCancel ? onCancel() : onCommit(pick); }
    else if (e.key === "Backspace" && !input && pick) { e.preventDefault(); clear(); }
  };

  return (
    <div className="tbl__edit-tags tbl__edit-tags--expanded">
      {pick && (
        <span className="tag tag--inline tag--wd" title={`${pick.qid} — ${pick.label}`}>
          <span className="tag__lbl">{pick.label}</span>
          <span className="tag__qid-sub">{pick.qid}</span>
          <button
            className="tag__x"
            onMouseDown={(e) => { e.preventDefault(); clear(); }}
            title="Clear"
          ><Icon name="close" size={10} /></button>
        </span>
      )}

      <div className="autocomplete autocomplete--inline">
        <input
          ref={ref}
          className="tbl__edit-tagsinput"
          value={input}
          onChange={e => { setInput(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => { if (open && suggestions[active]) choose(suggestions[active]); else onCommit(pick); }, 120)}
          onKeyDown={onKey}
          placeholder={pick ? "Replace with another…" : (placeholder || "Search Wikidata items")}
        />
        {open && suggestions.length > 0 && (
          <AutocompletePop scroll>
            <div className="autocomplete__hint">{isEmptyQuery ? "Suggestions" : "Wikidata items"}</div>
            {suggestions.map((s, i) => (
              <div
                key={s.qid}
                className={"autocomplete__item" + (i === active ? " autocomplete__item--active" : "")}
                onMouseDown={(e) => { e.preventDefault(); choose(s); }}
                onMouseEnter={() => setActive(i)}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="autocomplete__primary">
                    <span>{s.label}</span>
                    <span className="autocomplete__qid">{s.qid}</span>
                  </div>
                  {s.desc && <div className="autocomplete__secondary">{s.desc}</div>}
                </div>
                <WikidataLinkButton qid={s.qid} />
              </div>
            ))}
          </AutocompletePop>
        )}
      </div>
    </div>
  );
}

// ===== Depicts editor (Wikidata items, with usage-frequency ghosts) =====
function DepictsEditor({ initial, depictsFrequency, onCommit, onCancel, onCopy }) {
  const [list, setList] = useStateT(initial);
  const [input, setInput] = useStateT("");
  const [active, setActive] = useStateT(0);
  const [open, setOpen] = useStateT(false);
  const ref = useRefT(null);
  useEffectT(() => { ref.current?.focus(); }, []);

  // Suggestions: when input is empty, show a "Frequently used" list
  // (most-common depicts across the user's library).
  // When typing, fall back to KNOWN_DEPICTS search.
  const ghostSuggestions = useMemoT(() => {
    if (!depictsFrequency) return [];
    return depictsFrequency
      .filter(d => !list.some(x => x.qid === d.qid))
      .slice(0, 6);
  }, [depictsFrequency, list]);

  const suggestions = useMemoT(() => {
    if (!input.trim()) return [];
    const pool = window.KNOWN_DEPICTS.filter(d => !list.some(x => x.qid === d.qid));
    return window.matchVocab(pool, input, t => `${t.label} ${t.qid}`, 10);
  }, [input, list]);

  const add = (item) => {
    if (!item) return;
    if (list.some(x => x.qid === item.qid)) return;
    setList([...list, item]);
    setInput("");
    setActive(0);
  };
  const remove = (qid) => setList(list.filter(x => x.qid !== qid));

  const onKey = (e) => {
    const showing = suggestions; // arrow keys only navigate the typed-search popup
    if (e.key === "ArrowDown" && showing.length) { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, showing.length - 1)); }
    else if (e.key === "ArrowUp" && showing.length) { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && showing[active]) { e.preventDefault(); add(showing[active]); }
    else if (e.key === "Tab" && showing[active] && open) { e.preventDefault(); add(showing[active]); }
    else if (e.key === "Escape") { e.preventDefault(); if (open) setOpen(false); else onCommit(list); }
    else if (e.key === "Backspace" && !input && list.length) { setList(list.slice(0, -1)); }
  };

  return (
    <div className="depicts-editor">
      {/* Row 1 — selected values */}
      <div className="depicts-editor__row depicts-editor__row--selected">
        {list.length === 0 && (
          <span className="depicts-editor__row-empty">No depicts yet</span>
        )}
        {list.map(d => (
          <span key={d.qid} className="tag tag--inline tag--wd" title={`${d.qid} — ${d.label}`}>
            <span className="tag__lbl">{d.label}</span>
            <span className="tag__qid-sub">{d.qid}</span>
            <button
              className="tag__copy"
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onCopy?.({ field: "depicts", value: d, count: 0 }); }}
              title="Copy"
            ><Icon name="copy" size={9} /></button>
            <button
              className="tag__x"
              onMouseDown={(e) => { e.preventDefault(); remove(d.qid); }}
              title="Remove"
            ><Icon name="close" size={10} /></button>
          </span>
        ))}
      </div>

      {/* Row 2 — suggestions (ghost chips). Always rendered; jump up when picked. */}
      {ghostSuggestions.length > 0 && (
        <div className="depicts-editor__row depicts-editor__row--suggest">
          <span className="depicts-editor__row-label">Frequently used</span>
          <div className="depicts-editor__row-chips">
            {ghostSuggestions.slice(0, 6).map(g => (
              <button
                key={g.qid}
                className="tag tag--inline tag--wd tag--ghost"
                title={`Used ${g.count}× across your library — click to add`}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); add(g); }}
              >
                <Icon name="plus" size={9} />
                <span className="tag__lbl">{g.label}</span>
                <span className="tag__qid-sub">{g.qid}</span>
                <span className="tag__count">{g.count}×</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Row 3 — search field (fixed position relative to its row). */}
      <div className="depicts-editor__row depicts-editor__row--search autocomplete autocomplete--inline">
        <Icon name="search" size={13} />
        <input
          ref={ref}
          className="depicts-editor__input"
          value={input}
          onChange={e => { setInput(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => onCommit(list), 120)}
          onKeyDown={onKey}
          placeholder="Search Wikidata items…"
        />
        {open && input.trim() && suggestions.length > 0 && (
          <AutocompletePop scroll>
            <div className="autocomplete__hint">Wikidata items</div>
            {suggestions.map((s, i) => (
              <div
                key={s.qid}
                className={"autocomplete__item" + (i === active ? " autocomplete__item--active" : "")}
                onMouseDown={(e) => { e.preventDefault(); add(s); }}
                onMouseEnter={() => setActive(i)}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="autocomplete__primary">
                    <span>{s.label}</span>
                    <span className="autocomplete__qid">{s.qid}</span>
                  </div>
                  {s.desc && <div className="autocomplete__secondary">{s.desc}</div>}
                </div>
                <WikidataLinkButton qid={s.qid} />
              </div>
            ))}
          </AutocompletePop>
        )}
      </div>
    </div>
  );
}

// ===== Caption default editor (T426424) =====
//
// Specialized renderer for the Caption (description) column's per-column
// default-value input inside HeaderMenuPopover. Adds:
//
//   - A one-click "Insert {title}" chip that appends the variable token at
//     the current cursor position (or at the end if the input isn't focused).
//   - A live preview line showing the expanded result for a sample row so
//     the user can see what their template will produce before clicking
//     "Apply to blank cells".
//
// `sampleItem` is the first row from the parent's `items` array that has a
// usable title; the preview falls back gracefully when no sample is present.
function CaptionDefaultEditor({ value, onChange, sampleItem }) {
  const inputRef = useRefT(null);
  const insertToken = () => {
    const el = inputRef.current;
    const v = value || "";
    if (el && document.activeElement === el && typeof el.selectionStart === "number") {
      const start = el.selectionStart;
      const end = el.selectionEnd ?? start;
      const next = v.slice(0, start) + CAPTION_TEMPLATE_TOKEN + v.slice(end);
      onChange(next);
      // Restore caret just past the inserted token on the next tick (after
      // React re-renders the input with the new value).
      setTimeout(() => {
        if (inputRef.current) {
          const pos = start + CAPTION_TEMPLATE_TOKEN.length;
          inputRef.current.focus();
          try { inputRef.current.setSelectionRange(pos, pos); } catch (e) {}
        }
      }, 0);
    } else {
      onChange(v + CAPTION_TEMPLATE_TOKEN);
    }
  };
  const usesTitle = captionTemplateUsesTitle(value);
  const previewSrc = usesTitle && sampleItem ? expandCaptionTemplate(value, sampleItem) : null;
  return (
    <>
      <input
        ref={inputRef}
        className="field__input"
        placeholder="Caption template — e.g. Photo of {title}"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="btn btn--small hdr-pop__quickbtn"
        onClick={insertToken}
        title="Insert the {title} variable — resolves per-row to the file's title"
      >
        <Icon name="link" size={11} /> Insert {CAPTION_TEMPLATE_TOKEN}
      </button>
      {usesTitle && (
        <div className="hdr-pop__preview" title={previewSrc != null ? "Preview using a sample row's title" : "Add a row with a title to see the preview"}>
          <span className="hdr-pop__preview-label">Preview:</span>
          {previewSrc != null
            ? <span className="hdr-pop__preview-value">{previewSrc || <em>(empty — sample row has no title)</em>}</span>
            : <span className="hdr-pop__preview-value hdr-pop__preview-value--muted">add a row with a title to see the preview</span>}
        </div>
      )}
    </>
  );
}

// ===== Per-column header settings menu (chevron in the header) =====
//
// Initial action set (T425864):
//   - Set default value      → expands inline to the existing default editor,
//                              with a split-button "Apply" footer that mirrors
//                              the columns-modal apply-scope choices
//                              (blanks / selected / overwrite-selected /
//                              overwrite-all). Default action is "blank cells"
//                              to match the columns-modal default.
//   - Toggle required        → flips the column's required state (asterisk)
//   - Clear all values       → wipes the column for every row in the table.
//                              Two-step confirmation pattern: first click
//                              re-paints the row in the destructive style and
//                              the second click commits.
//   - (caption column)       → "Change language to…" / "Add another caption
//                              column…" / "Remove this caption column"
//                              (T426422 — language-management entries that
//                              surface when col.caption is truthy).
//   - (title column)         → "Restore from original filename" (T426428).
//                              Same four-scope split-button as Set default
//                              value, except the per-row value is computed
//                              from `it.filename` rather than a global
//                              column default. Useful when the user has
//                              edited the auto-prefilled title and wants
//                              the original back.
//
// More actions will land here later — keep additions in the
// `HEADER_MENU_ACTIONS` map below so the rendered list stays declarative.
function HeaderMenuPopover({
  colKey, col, anchorEl, value, isRequired, locked, selfUsername, selectedCount,
  // T426424: a sample row for the Caption default-value editor's live preview;
  // and a callback that fills every blank caption cell with that row's title
  // (column-level mirror of the per-row Title↔Caption link button).
  sampleItem, onFillCaptionsFromTitles,
  onChange, onClear, onToggleRequired,
  onApplyToBlank, onApplyToSelected, onOverwriteSelected, onOverwriteAll,
  onClearAllValues,
  // Caption-column language management (T426422). Only meaningful when the
  // column is a caption column (col.caption truthy); the host wires these
  // unconditionally and the popover hides them when irrelevant.
  captionLang,
  captionUsedLangs,
  // Items whose caption text would be discarded if this column were removed.
  // Drives the "Remove this caption column" entry's tooltip + confirm copy.
  // 0 means a silent remove; >0 means the menu shows a count and the click
  // handler runs a confirm. (T426422 follow-up.)
  captionRemoveAffected,
  onChangeCaptionLanguage,
  onAddCaptionLanguage,
  onRemoveCaptionColumn,
  // Title-only restore actions (T426428). Same four-scope shape as the
  // default-value split-button so the UX vocabulary stays consistent.
  onRestoreTitleBlank, onRestoreTitleSelectedBlank, onRestoreTitleSelectedAll, onRestoreTitleAll,
  onClose,
}) {
  const ref = useRefT(null);
  const [pos, setPos] = useStateT({ left: 0, top: 0 });
  // Inline-expand the default-value editor on demand. Most opens of the menu
  // are for "toggle required" (one click), so the editor stays collapsed by
  // default and the popover starts as a slim action list.
  const [defaultOpen, setDefaultOpen] = useStateT(false);
  // Split-button dropdown state for the "Apply…" footer in the default panel.
  // Closed by default; main click on the button uses the default action
  // (apply-to-blanks). Caret opens this menu so the user can pick a different
  // scope (selected / overwrite).
  const [applyMenuOpen, setApplyMenuOpen] = useStateT(false);
  // Two-step confirm for the destructive "Clear all values" action. The first
  // click flips this flag (and re-paints the row in the destructive style);
  // the second click within the same open of the popover commits. We only
  // reset on close (so accidental click-elsewhere-then-back keeps the warning
  // up) and on a no-op like opening the default editor.
  const [clearConfirming, setClearConfirming] = useStateT(false);
  // Title-only "Restore from original filename" item (T426428). Inline-expand
  // panel just like "Set default value" so the four-scope split-button has
  // somewhere to live. The split-button menu has its own open/closed state so
  // the caret can stay closed when the user clicks the primary action.
  const [restoreOpen, setRestoreOpen] = useStateT(false);
  const [restoreMenuOpen, setRestoreMenuOpen] = useStateT(false);

  useEffectT(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // Right-align under the chevron so the popover doesn't visually drift away
    // from the column it controls. Clamp to the viewport so it never bleeds
    // off-screen on narrow columns near the right edge.
    const width = 280;
    const margin = 8;
    const right = Math.max(margin, Math.min(window.innerWidth - margin, r.right));
    const left = Math.max(margin, right - width);
    setPos({ left, top: r.bottom + 4 });
  }, [anchorEl]);

  useEffectT(() => {
    const onDoc = (e) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target)) return;
      if (anchorEl && anchorEl.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorEl]);

  if (!col) return null;

  // Some columns are immutable / not editable (size, status, EXIF, custom
  // props derived from upstream data). Hide the "set default" action for
  // those — there's nothing the user can fill in.
  const canHaveDefault = !col.immutable && col.editable !== false;
  // Caption columns (T426422) get language-management entries:
  //   - "Change language to…" — replaces this column's lang with another
  //     (per-row caption text follows the new lang slot).
  //   - "Add another caption column…" — inserts a new caption column for a
  //     different language right after the current one.
  // The available languages exclude any already on screen (the no-duplicate-
  // language guard), so the picker can never produce two columns for the
  // same language. When the catalog is exhausted, both submenus are empty
  // and the entries collapse into a hint.
  const isCaption = !!col.caption;
  const captionAvailable = isCaption && window.availableCaptionLanguages
    ? window.availableCaptionLanguages(captionUsedLangs || [])
    : [];
  const captionChangeOptions = isCaption && window.CAPTION_LANGUAGES
    // For "change language", the user can pick any catalog language except
    // those *other* visible caption columns are using; their own current
    // language IS valid (it's a no-op picker self-select).
    ? window.CAPTION_LANGUAGES.filter((l) => l.code === captionLang || !(captionUsedLangs || []).includes(l.code))
    : [];
  // Title-only restore action (T426428). The Title column's per-row
  // "default" is the original filename minus the extension; the action
  // re-derives that and writes it back so users can recover from
  // accidental edits without re-typing.
  const showRestoreFromFilename = col.key === "title";

  const renderEditor = () => {
    switch (col.key) {
      case "license":
        // Default-value picker: stick to known catalog ids (no custom branch
        // here — a default of a free-form wikitext template doesn't really
        // make sense as a per-column auto-fill).
        return (
          <select className="field__input" value={value || ""} onChange={(e) => onChange(e.target.value)}>
            <option value="">— Choose —</option>
            {(window.LICENSE_GROUPS || []).filter(g => g.id !== "custom").map(g => (
              <optgroup key={g.id} label={g.label}>
                {(window.LICENSES || []).filter(l => l.group === g.id).map(l => (
                  <option key={l.id} value={l.id} title={l.title}>{l.short}</option>
                ))}
              </optgroup>
            ))}
          </select>
        );
      case "categories": {
        // T425950: refuse to default to a name we have no positive
        // evidence exists on Commons. The "Apply to blank rows" button
        // would otherwise spread an unknown name across many rows in
        // one click, exactly the wedge we're trying to close. We don't
        // run an API check here — this is a header-popover default and
        // we'd rather keep it synchronous; the merged pool covers
        // anything that's been autocompleted, picked from a chip, or
        // seeded from history. Names not in the pool render the input
        // tinted red and the "Apply" button below gets disabled by
        // its own check (in onApplyToBlank) — no chip lands.
        // T425912: strip a leading "Category:" so storage stays bare.
        const trimmed = String(value || "").trim();
        const isKnown = trimmed && window.isKnownCategory && window.isKnownCategory(trimmed);
        const showWarn = !!trimmed && !isKnown;
        return (
          <>
            <input
              className={"field__input" + (showWarn ? " field__input--rejected" : "")}
              placeholder="Default category to add"
              value={value || ""}
              onChange={(e) => {
                const v = e.target.value;
                // Only strip on a clean leading-prefix match; don't mangle
                // free typing where the user happens to type ":" mid-name.
                const cleaned = /^\s*Category\s*:/i.test(v) && window.stripCategoryPrefix
                  ? window.stripCategoryPrefix(v)
                  : v;
                onChange(cleaned);
              }}
            />
            {showWarn && (
              <div className="hdr-pop__warn">
                <Icon name="warn" size={11} />
                '{trimmed}' isn't an existing Commons category — the tool no
                longer creates new ones. Pick an existing category in a cell
                first to seed the autocomplete pool.
              </div>
            )}
          </>
        );
      }
      case "depicts":
        return (
          <div style={{ fontSize: "var(--font-size-x-small)", color: "var(--color-subtle)" }}>
            Use the depicts editor to set a default Wikidata item.
          </div>
        );
      case "author":
        // Author column gets a "Me" quick-insert below the input. The
        // canonical own-work form is `[[User:X|X]]`. See T425874.
        if (selfUsername) {
          const selfForm = `[[User:${selfUsername}|${selfUsername}]]`;
          return (
            <>
              <input
                className="field__input"
                placeholder={`Default ${col.label.toLowerCase()}`}
                value={value || ""}
                onChange={(e) => onChange(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--small hdr-pop__quickbtn"
                onClick={() => onChange(selfForm)}
                title={`Insert ${selfForm}`}
              >
                <Icon name="user" size={11} /> Me ({selfUsername})
              </button>
            </>
          );
        }
        return (
          <input
            className="field__input"
            placeholder={`Default ${col.label.toLowerCase()}`}
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case "source":
        // Source column gets an "Own work" quick-insert below the input that
        // fills `{{own}}`. Note: the licence-coupling at publish time means
        // own-work licences already publish empty source as `{{own}}` — this
        // default is only useful when the user wants to make that explicit
        // across the whole batch, or to override the default with a fixed
        // attribution string. See T425949.
        return (
          <>
            <input
              className="field__input"
              placeholder={`Default ${col.label.toLowerCase()}`}
              value={value || ""}
              onChange={(e) => onChange(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--small hdr-pop__quickbtn"
              onClick={() => onChange(OWN_WIKITEXT)}
              title={`Insert ${OWN_WIKITEXT}`}
            >
              <Icon name="user" size={11} /> {"{{own}}"}
            </button>
          </>
        );
      case "description":
        // T426424: Caption default supports a `{title}` token that resolves
        // per-row to the file's title (with a trailing T425984 ` #`
        // sequence placeholder stripped). The chip below appends `{title}`
        // at the cursor (or at the end if focus isn't in the input). The
        // preview line shows the expanded value for a sample row so the
        // user can see what their template will produce before they click
        // "Apply to blank cells".
        return <CaptionDefaultEditor value={value} onChange={onChange} sampleItem={sampleItem} />;
      default:
        return (
          <input
            className="field__input"
            placeholder={`Default ${col.label.toLowerCase()}`}
            value={value || ""}
            onChange={(e) => onChange(e.target.value)}
          />
        );
    }
  };

  return (
    <div ref={ref} className="hdr-pop hdr-pop--menu" style={{ left: pos.left, top: pos.top }}>
      <div className="hdr-pop__head">
        <Icon name="cog" size={12} />
        <span>{col.label}</span>
      </div>
      <ul className="hdr-pop__menu" role="menu">
        {canHaveDefault && (
          <li role="none" className={"hdr-pop__menu-item" + (defaultOpen ? " hdr-pop__menu-item--open" : "")}>
            <button
              type="button"
              role="menuitem"
              className="hdr-pop__menu-btn"
              aria-expanded={defaultOpen}
              onClick={() => { setDefaultOpen(o => !o); setClearConfirming(false); setRestoreOpen(false); setRestoreMenuOpen(false); }}
            >
              <span className="hdr-pop__menu-label">
                Set default value
                {value ? <span className="hdr-pop__menu-meta">currently set</span> : null}
              </span>
              <Icon name={defaultOpen ? "chevron-down" : "chevron-right"} size={12} />
            </button>
            {defaultOpen && (
              <div className="hdr-pop__menu-panel">
                <p className="hdr-pop__hint">
                  Auto-fills new uploads. Use "Apply…" to backfill the existing rows now — the caret picks the scope.
                </p>
                {renderEditor()}
                <div className="hdr-pop__foot">
                  <button className="btn btn--small btn--quiet" onClick={onClear}>Clear default</button>
                  {/* Split button — primary action is "apply to blanks" (the
                      most-common, safest choice that mirrors the columns-modal
                      default). The caret opens a small menu with the other
                      three scopes; matches the columns-modal action set so
                      changes from either surface produce the same result. */}
                  <span className={"split-btn" + (applyMenuOpen ? " split-btn--open" : "")}>
                    <button
                      type="button"
                      className="btn btn--small btn--progressive split-btn__main"
                      onClick={() => { setApplyMenuOpen(false); onApplyToBlank && onApplyToBlank(); }}
                      disabled={!value}
                      title="Fill empty cells in this column with the default value"
                    >
                      Apply to blank cells
                    </button>
                    <button
                      type="button"
                      className="btn btn--small btn--progressive split-btn__caret"
                      onClick={() => setApplyMenuOpen(o => !o)}
                      disabled={!value}
                      aria-haspopup="menu"
                      aria-expanded={applyMenuOpen}
                      title="More apply options"
                    >
                      <Icon name="chevron-down" size={11} />
                    </button>
                    {applyMenuOpen && (
                      <ul className="split-btn__menu" role="menu">
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="split-btn__menu-item"
                            onClick={() => { setApplyMenuOpen(false); onApplyToBlank && onApplyToBlank(); }}
                          >
                            Apply to blank cells
                          </button>
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="split-btn__menu-item"
                            disabled={!selectedCount}
                            title={selectedCount ? `Fill blank cells in the ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}` : 'Select rows to enable'}
                            onClick={() => { setApplyMenuOpen(false); onApplyToSelected && onApplyToSelected(); }}
                          >
                            Apply to all selected{selectedCount ? ` (${selectedCount})` : ''}
                          </button>
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="split-btn__menu-item"
                            disabled={!selectedCount}
                            title={selectedCount ? `Overwrite this column for the ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}` : 'Select rows to enable'}
                            onClick={() => { setApplyMenuOpen(false); onOverwriteSelected && onOverwriteSelected(); }}
                          >
                            Overwrite selected{selectedCount ? ` (${selectedCount})` : ''}
                          </button>
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="split-btn__menu-item split-btn__menu-item--destructive"
                            onClick={() => {
                              setApplyMenuOpen(false);
                              if (window.confirm('Overwrite this column for ALL files in the table? This cannot be undone.')) {
                                onOverwriteAll && onOverwriteAll();
                              }
                            }}
                          >
                            Overwrite all
                          </button>
                        </li>
                      </ul>
                    )}
                  </span>
                </div>
              </div>
            )}
          </li>
        )}
        {/* T426424: Caption-only "Fill blanks from Title" — column-level mirror
            of the per-row Title↔Caption link button. One click; no menu, no
            template editor. Walks every row and fills blank caption cells with
            that row's title (with the trailing T425984 ` #` sequence
            placeholder stripped). The advanced `{title}`-template recipe (e.g.
            "Photo of {title}") still lives below in the default-value editor's
            "Insert {title}" chip — this top-level item is the simple path. */}
        {col.key === "description" && onFillCaptionsFromTitles && (
          <li role="none" className="hdr-pop__menu-item">
            <button
              type="button"
              role="menuitem"
              className="hdr-pop__menu-btn"
              onClick={() => {
                setApplyMenuOpen(false);
                setClearConfirming(false);
                onFillCaptionsFromTitles();
                onClose && onClose();
              }}
              title="Copy each row's title into its caption cell, but only where the caption is empty"
            >
              <span className="hdr-pop__menu-label">
                Fill blanks from Title
                <span className="hdr-pop__menu-meta">
                  copies each row's title into its blank caption
                </span>
              </span>
              <Icon name="link" size={12} />
            </button>
          </li>
        )}
        <li role="none" className="hdr-pop__menu-item">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={isRequired}
            className={"hdr-pop__menu-btn" + (isRequired ? " hdr-pop__menu-btn--on" : "")}
            onClick={() => { setApplyMenuOpen(false); setClearConfirming(false); setRestoreOpen(false); setRestoreMenuOpen(false); onToggleRequired && onToggleRequired(); }}
            disabled={locked}
            title={locked ? "Always required for this column" : undefined}
          >
            <span className="hdr-pop__menu-label">
              Toggle required
              <span className="hdr-pop__menu-meta">
                {locked ? "always required" : isRequired ? "currently required" : "currently optional"}
              </span>
            </span>
            <span className={"hdr-pop__menu-checkmark" + (isRequired ? " is-on" : "")}>
              {isRequired ? <Icon name="check" size={12} /> : null}
            </span>
          </button>
        </li>
        {/* Title-only "Restore from original filename" (T426428). Inline-
            expand panel with the same four-scope split-button as Set default
            value — the per-row value is just computed from `it.filename`
            instead of a global default. Sits before Clear all values so
            the value-changing actions are grouped together and the
            destructive clear stays visually last. */}
        {showRestoreFromFilename && (
          <li role="none" className={"hdr-pop__menu-item" + (restoreOpen ? " hdr-pop__menu-item--open" : "")}>
            <button
              type="button"
              role="menuitem"
              className="hdr-pop__menu-btn"
              aria-expanded={restoreOpen}
              onClick={() => { setRestoreOpen(o => !o); setClearConfirming(false); setRestoreMenuOpen(false); }}
            >
              <span className="hdr-pop__menu-label">
                Restore from original filename
                <span className="hdr-pop__menu-meta">resets to the auto-prefilled title</span>
              </span>
              <Icon name={restoreOpen ? "chevron-down" : "chevron-right"} size={12} />
            </button>
            {restoreOpen && (
              <div className="hdr-pop__menu-panel">
                <p className="hdr-pop__hint">
                  Re-derives the title from the original filename (extension stripped). Use the caret to pick the scope.
                </p>
                <div className="hdr-pop__foot">
                  <span className={"split-btn" + (restoreMenuOpen ? " split-btn--open" : "")}>
                    <button
                      type="button"
                      className="btn btn--small btn--progressive split-btn__main"
                      onClick={() => { setRestoreMenuOpen(false); onRestoreTitleBlank && onRestoreTitleBlank(); }}
                      title="Restore the title for rows where it's currently empty"
                    >
                      Apply to blank titles
                    </button>
                    <button
                      type="button"
                      className="btn btn--small btn--progressive split-btn__caret"
                      onClick={() => setRestoreMenuOpen(o => !o)}
                      aria-haspopup="menu"
                      aria-expanded={restoreMenuOpen}
                      title="More restore options"
                    >
                      <Icon name="chevron-down" size={11} />
                    </button>
                    {restoreMenuOpen && (
                      <ul className="split-btn__menu" role="menu">
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="split-btn__menu-item"
                            onClick={() => { setRestoreMenuOpen(false); onRestoreTitleBlank && onRestoreTitleBlank(); }}
                          >
                            Apply to blank titles
                          </button>
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="split-btn__menu-item"
                            disabled={!selectedCount}
                            title={selectedCount ? `Restore blank titles in the ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}` : 'Select rows to enable'}
                            onClick={() => { setRestoreMenuOpen(false); onRestoreTitleSelectedBlank && onRestoreTitleSelectedBlank(); }}
                          >
                            Apply to all selected{selectedCount ? ` (${selectedCount})` : ''}
                          </button>
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="split-btn__menu-item"
                            disabled={!selectedCount}
                            title={selectedCount ? `Overwrite titles for the ${selectedCount} selected row${selectedCount === 1 ? '' : 's'}` : 'Select rows to enable'}
                            onClick={() => { setRestoreMenuOpen(false); onRestoreTitleSelectedAll && onRestoreTitleSelectedAll(); }}
                          >
                            Overwrite selected{selectedCount ? ` (${selectedCount})` : ''}
                          </button>
                        </li>
                        <li role="none">
                          <button
                            type="button"
                            role="menuitem"
                            className="split-btn__menu-item split-btn__menu-item--destructive"
                            onClick={() => {
                              setRestoreMenuOpen(false);
                              if (window.confirm('Restore the original filename as the title for ALL files in the table? Edited titles will be overwritten.')) {
                                onRestoreTitleAll && onRestoreTitleAll();
                              }
                            }}
                          >
                            Overwrite all
                          </button>
                        </li>
                      </ul>
                    )}
                  </span>
                </div>
              </div>
            )}
          </li>
        )}
        {/* Clear all values for the column. Two-step confirm pattern: the
            first click flips the row into the destructive style and changes
            the label to "Confirm" — the second click commits. The state
            lives in this popover only; closing the popover (or opening the
            default-value editor) resets it so the warning never lingers. */}
        {canHaveDefault && (
          <li role="none" className="hdr-pop__menu-item">
            <button
              type="button"
              role="menuitem"
              className={"hdr-pop__menu-btn" + (clearConfirming ? " hdr-pop__menu-btn--confirm" : "")}
              onClick={() => {
                if (clearConfirming) {
                  setClearConfirming(false);
                  onClearAllValues && onClearAllValues();
                } else {
                  setClearConfirming(true);
                }
              }}
              title={clearConfirming
                ? `Click again to wipe ${col.label} for every row`
                : `Wipe ${col.label} for every row in the table`}
            >
              <span className="hdr-pop__menu-label">
                {clearConfirming ? 'Confirm — wipe every row' : 'Clear all values'}
                <span className="hdr-pop__menu-meta">
                  {clearConfirming ? 'click to confirm — cannot be undone' : 'empties this column for every row'}
                </span>
              </span>
              <Icon name="trash" size={12} />
            </button>
          </li>
        )}
        {isCaption && (
          <CaptionLanguageMenuSection
            currentLang={captionLang}
            changeOptions={captionChangeOptions}
            addOptions={captionAvailable}
            onChange={onChangeCaptionLanguage}
            onAdd={onAddCaptionLanguage}
            // The remove entry surfaces only when there's more than one
            // visible caption column — at least one must always remain so
            // captions are never invisible-but-stored. captionUsedLangs is
            // the set of languages on screen; >1 means removing this one
            // still leaves another. (Includes the English column once
            // there's a sibling — the maintainer's invariant is "always at
            // least one", not "always English".) (T426422 follow-up.)
            canRemove={(captionUsedLangs || []).length > 1}
            removeAffected={captionRemoveAffected || 0}
            onRemove={onRemoveCaptionColumn}
          />
        )}
      </ul>
    </div>
  );
}

// Caption-column language management section inside the column header
// popover (T426422). Two collapsible mini-menus:
//   - "Change language to…" — swap this column's language; the cell text
//     follows the new language slot (so the user sees the captions they
//     have for that language).
//   - "Add another caption column…" — insert a new caption column for a
//     different language. Hidden when every catalog language is already
//     in use (the no-duplicate-language guard).
// Both render as nested <ul> radio-ish lists rather than separate popups
// so we keep one click-out target and don't have to manage another
// portal layer.
function CaptionLanguageMenuSection({ currentLang, changeOptions, addOptions, onChange, onAdd, canRemove, removeAffected, onRemove }) {
  const [openSection, setOpenSection] = useStateT(null); // null | 'change' | 'add'
  const noChange = !changeOptions || changeOptions.length <= 1;
  const noAdd = !addOptions || addOptions.length === 0;

  return (
    <>
      <li role="none" className="hdr-pop__menu-sep" />
      {/* Change language — opens an inline list of catalog languages
          (current language is shown as the active radio). Disabled when
          there's nothing else to switch to. */}
      <li role="none" className={"hdr-pop__menu-item" + (noChange ? " hdr-pop__menu-item--disabled" : "")}>
        <button
          type="button"
          role="menuitem"
          className="hdr-pop__menu-btn"
          disabled={noChange}
          aria-expanded={openSection === 'change'}
          onClick={() => setOpenSection((s) => s === 'change' ? null : 'change')}
          title={noChange
            ? "No other languages to switch to — every catalog language is already on screen."
            : "Change which language this caption column edits."}
        >
          <span className="hdr-pop__menu-label">
            Change language
            <span className="hdr-pop__menu-meta">
              currently {(currentLang || 'en').toUpperCase()}
            </span>
          </span>
          <Icon name="chevron-down" size={12} />
        </button>
      </li>
      {openSection === 'change' && !noChange && (
        <li role="none" className="hdr-pop__menu-sub">
          <ul role="menu" className="hdr-pop__sublist">
            {changeOptions.map((opt) => (
              <li key={opt.code} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={opt.code === currentLang}
                  className={"hdr-pop__sublist-btn" + (opt.code === currentLang ? " is-active" : "")}
                  onClick={() => {
                    if (opt.code === currentLang) return;
                    onChange && onChange(opt.code);
                  }}
                  title={`Switch caption to ${opt.label}`}
                >
                  <span className="hdr-pop__sublist-code">{opt.code.toUpperCase()}</span>
                  <span className="hdr-pop__sublist-label">{opt.label}</span>
                  {opt.code === currentLang && <Icon name="check" size={11} />}
                </button>
              </li>
            ))}
          </ul>
        </li>
      )}
      {/* Add another caption column — opens a sister inline list of
          languages NOT yet on screen. Disabled when the catalog is
          exhausted. */}
      <li role="none" className={"hdr-pop__menu-item" + (noAdd ? " hdr-pop__menu-item--disabled" : "")}>
        <button
          type="button"
          role="menuitem"
          className="hdr-pop__menu-btn"
          disabled={noAdd}
          aria-expanded={openSection === 'add'}
          onClick={() => setOpenSection((s) => s === 'add' ? null : 'add')}
          title={noAdd
            ? "Every catalog language already has a caption column on screen."
            : "Add another caption column for a different language."}
        >
          <span className="hdr-pop__menu-label">
            Add another caption column
            <span className="hdr-pop__menu-meta">
              {noAdd ? 'all catalog languages added' : `${addOptions.length} language${addOptions.length === 1 ? '' : 's'} available`}
            </span>
          </span>
          <Icon name="plus" size={12} />
        </button>
      </li>
      {openSection === 'add' && !noAdd && (
        <li role="none" className="hdr-pop__menu-sub">
          <ul role="menu" className="hdr-pop__sublist">
            {addOptions.map((opt) => (
              <li key={opt.code} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="hdr-pop__sublist-btn"
                  onClick={() => onAdd && onAdd(opt.code)}
                  title={`Add a Caption column for ${opt.label}`}
                >
                  <span className="hdr-pop__sublist-code">{opt.code.toUpperCase()}</span>
                  <span className="hdr-pop__sublist-label">{opt.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </li>
      )}
      {canRemove && (
        <li role="none" className="hdr-pop__menu-item">
          <button
            type="button"
            role="menuitem"
            className={"hdr-pop__menu-btn" + (removeAffected > 0 ? " hdr-pop__menu-btn--confirm" : "")}
            onClick={() => onRemove && onRemove()}
            title={removeAffected > 0
              ? `Remove this Caption column. ${removeAffected} file${removeAffected === 1 ? ' has' : 's have'} caption text in ${(currentLang || '').toUpperCase()} that will be discarded.`
              : "Remove this Caption column from the table."}
          >
            <span className="hdr-pop__menu-label">
              Remove this caption column
              <span className="hdr-pop__menu-meta">
                {removeAffected > 0
                  ? `discards ${removeAffected} caption value${removeAffected === 1 ? '' : 's'}`
                  : `no ${(currentLang || '').toUpperCase()} captions to discard`}
              </span>
            </span>
            <Icon name={removeAffected > 0 ? "warn" : "close"} size={12} />
          </button>
        </li>
      )}
    </>
  );
}

// ===== Pill info popover (Wikidata-style preview) =====
function PillInfoPopover({ info, onClose }) {
  const ref = useRefT(null);
  const [pos, setPos] = useStateT({ left: 0, top: 0 });
  // Live category data (file count, lead extract, parents). null = not yet
  // fetched / not applicable; { loading: true } during fetch; otherwise the
  // resolved record from window.fetchCategoryInfo (or { missing: true }).
  const [catData, setCatData] = useStateT(null);

  useEffectT(() => {
    if (!info?.anchorEl) return;
    const r = info.anchorEl.getBoundingClientRect();
    setPos({ left: Math.max(8, r.left), top: r.bottom + 4 });
  }, [info]);
  useEffectT(() => {
    const onDoc = (e) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target)) return;
      if (info?.anchorEl && info.anchorEl.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [info, onClose]);

  // Fetch category info on open. Skips for depicts pills. Cached 5 min by
  // fetchJSON's apiCache, so reopening the same pill in a session is free.
  useEffectT(() => {
    if (!info || info.kind !== "category") { setCatData(null); return; }
    if (typeof window.fetchCategoryInfo !== "function") { setCatData(null); return; }
    const name = info.value;
    let cancelled = false;
    setCatData({ loading: true });
    window.fetchCategoryInfo(name)
      .then((data) => {
        if (cancelled) return;
        setCatData(data || { missing: true });
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("[pill-info] category fetch failed:", e);
        setCatData({ error: true });
      });
    return () => { cancelled = true; };
  }, [info]);

  if (!info) return null;

  if (info.kind === "depicts") {
    return <DepictsPopover value={info.value} popRef={ref} pos={pos} />;
  }

  if (info.kind === "exif") {
    return <ExifChipPopover value={info.value} popRef={ref} pos={pos} />;
  }

  // Category
  const c = info.value;
  const commonsUrl = `https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(c.replace(/ /g, "_"))}`;
  const loading = catData?.loading;
  // Existence: prefer the live API verdict; fall back to the local
  // KNOWN_CATEGORIES merged pool while the request is in flight.
  const exists = catData && !catData.loading && !catData.missing && !catData.error
    ? true
    : catData?.missing
      ? false
      : (window.isKnownCategory && window.isKnownCategory(c));
  // Extract: only render when non-empty (Commons categories often have no
  // /lead text — fall back to the existence-status sentence).
  const hasExtract = exists && catData?.extract;
  const desc = loading
    ? "Loading from Commons…"
    : hasExtract
      ? catData.extract
      : exists
        ? "Existing Commons category."
        : "Does not exist on Commons — this category will not be saved when the file is published.";

  const openOnCommons = () => {
    window.open(commonsUrl, "_blank", "noopener,noreferrer");
  };

  // Display title with "Category:" prefix to match Commons convention (T425912).
  const titleDisplay = window.formatCategory ? window.formatCategory(c) : `Category:${c}`;

  return (
    <div ref={ref} className="pill-info" style={{ left: pos.left, top: pos.top }}>
      <div className="pill-info__head">
        <Icon name="folder" size={14} />
        <span className="pill-info__title">{titleDisplay}</span>
      </div>
      <p className="pill-info__desc">{desc}</p>
      <div className="pill-info__row">
        <span className="pill-info__key">Status</span>
        <span className="pill-info__val">{loading ? "Checking…" : exists ? "Existing" : "Does not exist"}</span>
      </div>
      {exists && catData && !catData.loading && !catData.missing && !catData.error && (
        <>
          <div className="pill-info__row">
            <span className="pill-info__key">Files</span>
            <span className="pill-info__val">{catData.files.toLocaleString()}</span>
          </div>
          {catData.subcats > 0 && (
            <div className="pill-info__row">
              <span className="pill-info__key">Subcategories</span>
              <span className="pill-info__val">{catData.subcats.toLocaleString()}</span>
            </div>
          )}
          {catData.parents?.length > 0 && (
            <div className="pill-info__row" style={{ alignItems: "flex-start" }}>
              <span className="pill-info__key">Parent</span>
              <span className="pill-info__val" style={{ textAlign: "right", maxWidth: "70%" }}>
                {/* Parents are stored bare; display prefixed (T425912). */}
                {catData.parents.slice(0, 3).map((p) => `Category:${p}`).join(", ")}
                {catData.parents.length > 3 ? `, +${catData.parents.length - 3} more` : ""}
              </span>
            </div>
          )}
        </>
      )}
      <div className="pill-info__foot">
        <button className="btn btn--small" onClick={openOnCommons}>
          <Icon name="external" size={11} /> Open on Commons
        </button>
      </div>
    </div>
  );
}

// Renders the depicts (P180) preview popover for a single Q-id. The pill
// click handler only knows the Q-id and whatever label was already on the
// SDC statement, so we hit Wikidata's wbgetentities for the canonical
// label/description and upgrade the popover when it returns. Falls back to
// the local KNOWN_DEPICTS pool while the fetch is in flight (or if it
// fails) so cached items render zero-latency.
function DepictsPopover({ value, popRef, pos }) {
  const d = value || {};
  const known = (window.KNOWN_DEPICTS || []).find((x) => x.qid === d.qid);
  const [live, setLive] = useStateT(null);
  const [loading, setLoading] = useStateT(false);
  useEffectT(() => {
    if (!d.qid || typeof window.fetchWikidataEntity !== "function") return;
    let cancelled = false;
    setLoading(true);
    setLive(null);
    window.fetchWikidataEntity(d.qid)
      .then((ent) => { if (!cancelled) setLive(ent || null); })
      .catch(() => { /* swallowed in helper */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [d.qid]);

  const label = (live?.label) || d.label || known?.label || d.qid;
  const desc = (live?.desc) || known?.desc || "";
  const wikidataUrl = d.qid ? `https://www.wikidata.org/wiki/${encodeURIComponent(d.qid)}` : null;

  return (
    <div ref={popRef} className="pill-info pill-info--wd" style={{ left: pos.left, top: pos.top }}>
      <div className="pill-info__head">
        <span className="pill-info__qid">{d.qid}</span>
        <span className="pill-info__title">{label}</span>
      </div>
      {desc
        ? <p className="pill-info__desc">{desc}</p>
        : (loading
            ? <p className="pill-info__desc" aria-live="polite"><em>Loading from Wikidata…</em></p>
            : null)
      }
      <div className="pill-info__row">
        <span className="pill-info__key">Property</span>
        <span className="pill-info__val">P180 — depicts</span>
      </div>
      <div className="pill-info__row">
        <span className="pill-info__key">Source</span>
        <span className="pill-info__val">Wikidata</span>
      </div>
      <div className="pill-info__foot">
        {wikidataUrl ? (
          <a
            className="btn btn--small"
            href={wikidataUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="external" size={11} /> Open on Wikidata
          </a>
        ) : (
          <button className="btn btn--small" disabled>
            <Icon name="external" size={11} /> Open on Wikidata
          </button>
        )}
      </div>
    </div>
  );
}

// ===== "+ Add column" popover (T426421) =====
//
// Anchored to the trailing head-cell button at the right end of the table.
// Surfaces the most-relevant currently-hidden built-in columns as a one-click
// quick-add list, plus an inline Wikidata-property search, plus entry-points
// to the custom-template form and the full Templates-and-columns modal.
//
// Sits separate from ColumnMenu (dead code) and ColumnsModal (the full
// surface) — this is the discoverable "I just want to add a column"
// affordance, intentionally short.
//
// QUICK_ADD_KEYS: the suggested seed list, ordered by perceived usefulness.
// The popover filters this against `visibleKeys` so already-shown columns
// don't appear. Any column the registry knows about (via `allColumns`) can
// be added here — there's no separate metadata to keep in sync.
const ADDCOL_QUICK_KEYS = [
  "source",
  "filename",
  "lens",
  "focal",
  "dateTaken",
  "cameraLocation",
  "objectLocation",
  "locationOfCreation",
];

function AddColumnPopover({
  anchorEl,
  allColumns,
  visibleKeys,
  customProps,
  onAddBuiltin,         // (key) => void — toggles a built-in column visible
  onAddCustomProp,      // (prop) => void — adds a Wikidata property column
  onOpenFullModal,      // () => void — opens columns modal (Columns tab)
  onClose,
}) {
  const ref = useRefT(null);
  const [pos, setPos] = useStateT({ left: 0, top: 0, visibility: "hidden" });
  const [propQuery, setPropQuery] = useStateT("");
  const [propActive, setPropActive] = useStateT(0);

  // Position right-aligned under the anchor, clamped to the viewport. Mirrors
  // HeaderMenuPopover's positioning logic so the two popovers feel related.
  useEffectT(() => {
    if (!anchorEl) return;
    const place = () => {
      const r = anchorEl.getBoundingClientRect();
      const width = 320;
      const margin = 8;
      const right = Math.max(margin, Math.min(window.innerWidth - margin, r.right));
      const left = Math.max(margin, right - width);
      const top = r.bottom + 4;
      setPos({ left, top, visibility: "visible" });
    };
    place();
    // Re-place if the user resizes or scrolls the viewport — the anchor is
    // inside the table's horizontal-scroll container and may move.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorEl]);

  // Outside-click + Escape close. Defer mousedown listener install one tick
  // so the click that *opened* the popover doesn't immediately close it.
  useEffectT(() => {
    const onDoc = (e) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target)) return;
      if (anchorEl && anchorEl.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const t = setTimeout(() => document.addEventListener("mousedown", onDoc), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorEl]);

  // Quick-add list: seed keys, filtered to hidden + known to the registry.
  const quickAddCols = useMemoT(() => {
    const visibleSet = new Set(visibleKeys || []);
    const byKey = new Map((allColumns || []).map(c => [c.key, c]));
    const out = [];
    for (const k of ADDCOL_QUICK_KEYS) {
      if (visibleSet.has(k)) continue;
      const col = byKey.get(k);
      if (!col) continue;
      out.push(col);
    }
    return out;
  }, [allColumns, visibleKeys]);

  // Wikidata property search — same filter as ColumnMenu (excludes already-
  // taken pids and P180/depicts which has its own first-class column).
  const propMatches = useMemoT(() => {
    const taken = new Set((customProps || []).map(p => p.pid));
    const pool = (window.KNOWN_PROPERTIES || []).filter(p => !taken.has(p.pid) && p.pid !== "P180");
    return window.matchVocab(pool, propQuery, t => `${t.label} ${t.pid}`, 8);
  }, [propQuery, customProps]);

  return createPortal(
    <div
      ref={ref}
      className="addcol-pop"
      role="menu"
      style={{ left: pos.left, top: pos.top, visibility: pos.visibility }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="addcol-pop__head">
        <Icon name="plus" size={12} />
        <span>Add a column</span>
      </div>

      {quickAddCols.length > 0 && (
        <div className="addcol-pop__section">
          <div className="addcol-pop__sechead">Quick add</div>
          <ul className="addcol-pop__list" role="none">
            {quickAddCols.map((col) => (
              <li key={col.key} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="addcol-pop__item"
                  onClick={() => { onAddBuiltin(col.key); onClose(); }}
                >
                  <span className="addcol-pop__item-label">
                    {col.label}
                    {col.tone === "exif" && <span className="addcol-pop__item-tag">EXIF</span>}
                  </span>
                  <span className="addcol-pop__item-add"><Icon name="plus" size={11} /></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="addcol-pop__section">
        <div className="addcol-pop__sechead">Add Wikidata property as column</div>
        <div className="addcol-pop__search autocomplete autocomplete--inline">
          <input
            className="tbl__edit-input addcol-pop__search-input"
            placeholder="Search property (e.g. creator, P170)"
            value={propQuery}
            onChange={(e) => { setPropQuery(e.target.value); setPropActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && propMatches.length) {
                e.preventDefault();
                setPropActive(a => Math.min(a + 1, propMatches.length - 1));
              } else if (e.key === "ArrowUp" && propMatches.length) {
                e.preventDefault();
                setPropActive(a => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && propMatches[propActive]) {
                e.preventDefault();
                onAddCustomProp(propMatches[propActive]);
                setPropQuery("");
                onClose();
              }
            }}
            autoFocus
          />
          {propQuery && propMatches.length > 0 && (
            <AutocompletePop scroll inline>
              {propMatches.map((p, i) => (
                <div
                  key={p.pid}
                  className={"autocomplete__item" + (i === propActive ? " autocomplete__item--active" : "")}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onAddCustomProp(p);
                    setPropQuery("");
                    onClose();
                  }}
                  onMouseEnter={() => setPropActive(i)}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="autocomplete__primary">
                      <span>{p.label}</span>
                      <span className="autocomplete__qid">{p.pid}</span>
                    </div>
                    {p.desc && <div className="autocomplete__secondary">{p.desc}</div>}
                  </div>
                  <AutocompleteLinkButton
                    href={`https://www.wikidata.org/wiki/Property:${encodeURIComponent(p.pid)}`}
                    title={`Open Property:${p.pid} on Wikidata (new tab)`}
                  />
                </div>
              ))}
            </AutocompletePop>
          )}
          {propQuery && propMatches.length === 0 && (
            <div className="autocomplete__empty">No properties match.</div>
          )}
        </div>
      </div>

      <div className="addcol-pop__section addcol-pop__section--last">
        <button
          type="button"
          role="menuitem"
          className="addcol-pop__more"
          onClick={() => { onOpenFullModal(); }}
        >
          More options (Templates and columns) <Icon name="arrow_right" size={11} />
        </button>
      </div>
    </div>,
    document.body
  );
}

// ===== Fixed-EXIF chip info popover (T426450) =====
//
// Click on a fixed-EXIF chip (camera/lens/focal/iso/aperture/shutter)
// opens this popover. It explains what the chip is, where the value comes
// from (the file's binary EXIF block), why it can't be removed from the
// workbench, and lists every other raw EXIF entry the API surfaced for
// this file so the user knows the full picture beyond the visible
// columns.
//
// The "value" prop carries { col, item } from the chip click handler.
//
// `item.rawExif` is populated by extractRawExif() in src/api/normalize.js
// and is derived-runtime data only — never persisted to user-store. If
// rawExif is missing (older items, stale state) we silently render an
// empty list rather than crash.
function ExifChipPopover({ value, popRef, pos }) {
  const { col, item } = value || {};
  const cellValue = col?.key ? item?.[col.key] : null;
  const rawExif = Array.isArray(item?.rawExif) ? item.rawExif : [];

  // The "self" entry — the EXIF tag(s) that this column was derived from —
  // is shown prominently as the chip's own value at the top, so we filter
  // it out of the "other EXIF" list below to avoid duplication. The map
  // below mirrors the curation in extractExif() (src/api/normalize.js).
  const selfEntries = SELF_EXIF_NAMES[col?.key] || [];
  const selfSet = new Set(selfEntries);
  const others = rawExif.filter((e) => !selfSet.has(e.name));

  return (
    <div ref={popRef} className="pill-info pill-info--exif" style={{ left: pos.left, top: pos.top }}>
      <div className="pill-info__head">
        <Icon name="lock" size={12} />
        <span className="pill-info__title">{col?.label || "EXIF"}</span>
      </div>
      <div className="pill-info__row">
        <span className="pill-info__key">Value</span>
        <span className="pill-info__val pill-info__val--strong">{cellValue != null && cellValue !== '' ? String(cellValue) : <em>(empty)</em>}</span>
      </div>
      <p className="pill-info__desc">
        Read directly from the file&rsquo;s embedded EXIF metadata. The workbench can&rsquo;t suppress this when the file is published &mdash;
        the value lives in the file&rsquo;s bytes and travels with it. Commons indexes EXIF, and tools or bots may transcribe parts of it
        to Structured Data later.
      </p>
      <div className="pill-info__exif-section">
        <div className="pill-info__exif-section-label">
          {others.length > 0
            ? `Other EXIF data in this file (${others.length})`
            : "No other EXIF data in this file"}
        </div>
        {others.length > 0 && (
          <div className="pill-info__exif-list" role="list">
            {others.map((e) => (
              <div key={e.name} className="pill-info__exif-row" role="listitem">
                <span className="pill-info__exif-key" title={e.name}>{e.name}</span>
                <span className="pill-info__exif-val" title={e.value}>{e.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Map from a column key to the EXIF tag name(s) that column was derived
// from in extractExif() (src/api/normalize.js). Used by the chip popover
// to suppress the "self" entry from the "other EXIF data" list, so the
// user isn't shown the same value twice.
const SELF_EXIF_NAMES = {
  camera:   ["Make", "Model"],
  lens:     ["LensModel", "Lens"],
  focal:    ["FocalLength"],
  iso:      ["ISOSpeedRatings", "PhotographicSensitivity"],
  aperture: ["FNumber"],
  shutter:  ["ExposureTime"],
};

// ===== Column menu (sectioned + property search) =====
function ColumnMenu({ allColumns, visibleKeys, onToggle, onReset, onAddCustomProp, onRemoveCustomProp, customProps }) {
  const [propQuery, setPropQuery] = useStateT("");
  const [propActive, setPropActive] = useStateT(0);

  const propMatches = useMemoT(() => {
    const taken = new Set((customProps || []).map(p => p.pid));
    const pool = window.KNOWN_PROPERTIES.filter(p => !taken.has(p.pid) && p.pid !== "P180");
    return window.matchVocab(pool, propQuery, t => `${t.label} ${t.pid}`, 8);
  }, [propQuery, customProps]);

  const groups = [
    { id: "standard",   label: "Columns" },
    { id: "structured", label: "Structured data" },
    { id: "exif",       label: "EXIF / camera metadata" },
    { id: "custom",     label: "Custom properties" }
  ];

  return (
    <div className="tbl-colmenu__pop">
      <div className="tbl-colmenu__head">
        <span>Columns</span>
        <button className="btn btn--quiet btn--small" onClick={onReset}>Reset</button>
      </div>

      {groups.map(g => {
        const cols = allColumns.filter(c => c.group === g.id);
        if (!cols.length) return null;
        return (
          <div key={g.id} className="tbl-colmenu__section">
            <div className="tbl-colmenu__sechead">{g.label}</div>
            {cols.map(c => {
              const on = visibleKeys.includes(c.key);
              return (
                <label key={c.key} className="tbl-colmenu__row">
                  <span className={"cbox" + (on ? " cbox--checked" : "")}>
                    {on && <Icon name="check" size={10} />}
                  </span>
                  <span className={"tbl-colmenu__name" + (c.tone === "exif" ? " tbl-colmenu__name--exif" : "")} style={{ flex: 1 }}>
                    {c.label}
                  </span>
                  <button
                    className="btn btn--quiet btn--small"
                    onClick={(e) => { e.preventDefault(); onToggle(c.key); }}
                  >{on ? "Hide" : "Show"}</button>
                  {c.customProp && (
                    <button
                      className="btn btn--quiet btn--icon-only btn--small"
                      onClick={(e) => { e.preventDefault(); onRemoveCustomProp(c.customProp.pid); }}
                      title="Remove custom column"
                    ><Icon name="close" size={11} /></button>
                  )}
                </label>
              );
            })}
          </div>
        );
      })}

      <div className="tbl-colmenu__section">
        <div className="tbl-colmenu__sechead">Add Wikidata property as column</div>
        <div className="autocomplete autocomplete--inline" style={{ padding: "0 10px 8px" }}>
          <input
            className="tbl__edit-input"
            placeholder="Search property (e.g. creator, P170)"
            value={propQuery}
            onChange={(e) => { setPropQuery(e.target.value); setPropActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && propMatches.length) { e.preventDefault(); setPropActive(a => Math.min(a + 1, propMatches.length - 1)); }
              else if (e.key === "ArrowUp" && propMatches.length) { e.preventDefault(); setPropActive(a => Math.max(a - 1, 0)); }
              else if (e.key === "Enter" && propMatches[propActive]) { e.preventDefault(); onAddCustomProp(propMatches[propActive]); setPropQuery(""); }
            }}
          />
          {propQuery && propMatches.length > 0 && (
            <AutocompletePop scroll inline>
              {propMatches.map((p, i) => (
                <div
                  key={p.pid}
                  className={"autocomplete__item" + (i === propActive ? " autocomplete__item--active" : "")}
                  onMouseDown={(e) => { e.preventDefault(); onAddCustomProp(p); setPropQuery(""); }}
                  onMouseEnter={() => setPropActive(i)}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="autocomplete__primary">
                      <span>{p.label}</span>
                      <span className="autocomplete__qid">{p.pid}</span>
                    </div>
                    {p.desc && <div className="autocomplete__secondary">{p.desc}</div>}
                  </div>
                  <AutocompleteLinkButton
                    href={`https://www.wikidata.org/wiki/Property:${encodeURIComponent(p.pid)}`}
                    title={`Open Property:${p.pid} on Wikidata (new tab)`}
                  />
                </div>
              ))}
            </AutocompletePop>
          )}
          {propQuery && propMatches.length === 0 && (
            <div className="autocomplete__empty">No properties match.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== Middle truncation (used only for filename now) =====
function MiddleTruncate({ text }) {
  if (!text) return null;
  if (text.length <= 16) return <span className="tbl__td-text">{text}</span>;
  const tail = Math.min(10, Math.max(6, Math.floor(text.length / 3)));
  const front = text.slice(0, text.length - tail);
  const back = text.slice(-tail);
  return (
    <span className="midtrunc" title={text}>
      <span className="midtrunc__front">{front}</span>
      <span className="midtrunc__back">{back}</span>
    </span>
  );
}

// ===== Helpers =====
function sortValue(item, key) {
  if (key.startsWith("prop:")) return ((item.customProps || {})[key.slice(5)] || "").toString().toLowerCase();
  // Caption columns sort by their per-language text (T426422). The bare
  // "description" key keeps its English-string sort behaviour via the
  // switch case below; the keyed "description:<lang>" form lands here.
  if (key.startsWith("description:")) {
    const lang = key.slice("description:".length);
    const v = (item.descriptions || {})[lang] || "";
    return String(v).toLowerCase();
  }
  switch (key) {
    case "title":       return (item.title || "").toLowerCase();
    case "filename":    return (item.filename || "").toLowerCase();
    case "categories":  return ((item.categories || [])[0] || "").toLowerCase();
    case "depicts":     return ((item.depicts || [])[0]?.label || "").toLowerCase();
    case "locationOfCreation": return (item.locationOfCreation?.label || "").toLowerCase();
    case "license":     return (item.license || "").toLowerCase();
    case "author":      return (item.author || "").toLowerCase();
    case "source":      return (item.source || "").toLowerCase();
    case "description": return (item.description || "").toLowerCase();
    case "size":        return item.bytes || 0;
    case "dimensions":  return (item.width || 0) * (item.height || 0);
    case "status":      return statusLifecycleRank(item);
    case "camera":      return (item.camera || "").toLowerCase();
    case "lens":        return (item.lens || "").toLowerCase();
    case "focal":       return parseInt(item.focal) || 0;
    case "iso":         return item.iso || 0;
    case "aperture":    return parseFloat(String(item.aperture || "").replace(/[^\d.]/g, "")) || 0;
    case "shutter":     return item.shutter || "";
    case "dateTaken":   return item.dateTaken ? new Date(item.dateTaken).getTime() : 0;
    case "cameraLocation": { const c = item.cameraLocation || item.coords; return c ? c.lat : 0; }
    case "objectLocation": return item.objectLocation ? item.objectLocation.lat : 0;
    default:            return "";
  }
}
// Status sorted by lifecycle progression, not alphabetically.
//   0 selected → 1 uploading → 2 incomplete → 3 ready → 4 publishing → 5 published
// Within "uploading" we secondary-sort by progress so a row at 80% sorts after
// one at 20%.
function statusLifecycleRank(item) {
  const s = item.status;
  if (s === "stash-selected")   return 0;
  if (s === "stash-uploading")  return 1 + (item.progress ?? 0) / 1000; // 1.000–1.100
  if (s === "stash-publishing") return 4 + (item.progress ?? 0) / 1000;
  if (s === "published")        return 5;
  // Any other "stash-*" — incomplete if it has issues, otherwise ready.
  if (s?.startsWith("stash"))   return (item.issues?.length > 0) ? 2 : 3;
  return 3;
}
function titleFor(item, col) {
  // Categories render with the "Category:" prefix in the cell (T425912) — keep
  // the hover tooltip consistent with what's on screen.
  if (col.key === "categories") return (item.categories || []).map(c => `Category:${c}`).join(", ");
  if (col.key === "depicts") return (item.depicts || []).map(d => `${d.qid} — ${d.label}`).join(", ");
  if (col.key === "filename") return item.filename;
  if (col.key === "title") {
    const issues = item.issues || [];
    if (issues.includes("invalid-title")) {
      // Use the validator's specific message so the tooltip is actionable
      // (e.g. "Forbidden character: ':'", not just "invalid").
      const localIssue = validateTitleLocal(item.title);
      return localIssue?.message || "Invalid for Commons — click to fix";
    }
    if (issues.includes("title-taken")) {
      return "Already exists on Commons — click to pick a different title";
    }
    if (issues.includes("title-format-warning")) {
      // Soft warning — surfaced both via the cell tint and this hover tooltip,
      // so the user notices even when the cell isn't focused.
      return "Looks like a default device filename (DSC, IMG, ZOOM…) — click to pick a more descriptive title";
    }
  }
  return undefined;
}

// Return the visible text a cell would render for (col, item), as a plain
// string. Used to build the toolbar search haystack so what the user sees in
// the table is exactly what's searchable — including formatted values like
// "2.3 MB" (size), "1920×1080" (dimensions), "Aug 15, 14:30" (dateTaken),
// "Stashed"/"Published" (status), and EXIF columns. Mirrors CellView's
// per-key branches; missing values yield "" (placeholders like "—" or
// "Add date" are intentionally skipped — those are UI affordances, not
// content the user is searching for).
function cellSearchText(col, item) {
  if (!col || !item) return "";
  if (col.customProp) {
    const v = (item.customProps || {})[col.customProp.pid];
    return v != null ? String(v) : "";
  }
  // Caption columns: search the per-language text. (T426422.)
  if (col.caption) {
    if (window.getCaptionValue) return window.getCaptionValue(item, col.caption.lang) || "";
    return col.caption.lang === "en" ? (item.description || "") : ((item.descriptions || {})[col.caption.lang] || "");
  }
  switch (col.key) {
    case "title":       return item.title || "";
    case "filename":    return item.filename || "";
    case "categories": {
      // Match both the bare name and the "Category:Name" form so the user
      // can search for either (T425912). The chip displays "Category:Name",
      // but legacy muscle memory of typing the bare name should still hit.
      const cats = item.categories || [];
      return cats.map(c => `${c} Category:${c}`).join(" ");
    }
    case "depicts":     return (item.depicts || []).map(d => `${d.label || ""} ${d.qid || ""}`).join(" ");
    case "license": {
      // CellView shows the catalog short label (e.g. "CC BY-SA 4.0" rather
      // than the stored id "CC-BY-SA-4.0"). Match the same label here so
      // typing what the user sees finds the row. Include the raw id too —
      // some users will still type "CC-BY-SA-4.0" by habit.
      const id = item.license || "";
      const short = window.licenseShortLabel ? window.licenseShortLabel(id) : id;
      return id === short ? id : `${short} ${id}`;
    }
    case "author":      return item.author || "";
    case "source":      return item.source || "";
    // "description" is intentionally absent: caption columns are handled
    // by the col.caption early-return above (covers both English and
    // per-language caption keys). T426422.
    case "size":        return item.bytes ? formatBytes(item.bytes) : "";
    case "dimensions":  return item.width > 0 ? `${item.width.toLocaleString()}×${item.height.toLocaleString()}` : "";
    case "status": {
      // CellView renders "Stashed" or "Published" — match that.
      const isStash = item.status?.startsWith("stash");
      return isStash ? "Stashed" : (item.status === "published" ? "Published" : "");
    }
    case "camera":      return item.camera || "";
    case "lens":        return item.lens || "";
    case "focal":       return item.focal || "";
    case "iso":         return item.iso ? String(item.iso) : "";
    case "aperture":    return item.aperture || "";
    case "shutter":     return item.shutter || "";
    case "dateTaken":   return item.dateTaken ? formatDateTimeShort(item.dateTaken) : "";
    // Camera/object locations render as a pin only — no visible text. Skip.
    case "cameraLocation": return "";
    case "objectLocation": return "";
    case "locationOfCreation": return item.locationOfCreation?.label || "";
    default: return "";
  }
}

window.cellSearchText = cellSearchText;
window.getAllColumns = getAllColumns;
window.loadColumnState = loadColumnState;
window.Table = Table;
