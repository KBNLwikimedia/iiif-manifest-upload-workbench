// Main app — Upload Workbench for Wikimedia Commons

import React from 'react';
import { DropZone } from './ui/dropzone.jsx';
import { EmptyHero } from './ui/empty-hero.jsx';
import { PublishModal, cleanupAfterPublish } from './ui/publish-modal.jsx';
import { BulkPublishModal } from './ui/bulk-publish-modal.jsx';
import { WikitextPreviewModal } from './ui/wikitext-preview-modal.jsx';
import InfoModal from './ui/info-modal.jsx';
import PilingMode from './ui/piling-mode.jsx';
import { Cc0Modal, CC0_ACK_VERSION, shouldShowCc0Modal } from './ui/cc0-modal.jsx';
import { IiifImportModal } from './ui/iiif-import-modal.jsx';
import { DEMO_MODE } from './config.js';
import {
  setDraft,
  deleteDraft,
  rekeyDraft,
  draftKey,
  pickDraftFields,
  getPref,
  setPref,
  hideSha1,
  hideSha1s,
  unhideSha1,
  unhideAllSha1s,
  getHiddenSha1s,
  hideFilekey,
  hideFilekeys,
  unhideFilekey,
  getHiddenFilekeys,
  subscribeStoreStatus,
  getStoreStatus,
  getCachedHistory,
  setCachedHistory,
  updateCachedHistoryItem,
  getPublishedSha1Map,
  getGroups,
  setGroups as persistGroups,
} from './api/user-store.js';
import { fetchHistoryDetailed, fetchHistoryOne } from './api/history.js';
import { findCommonsFileBySha1, fetchStashFileInfo, categoryExists } from './api/commons.js';
import { normalizeStashItem } from './api/normalize.js';
import { subscribeAutocompleteUpdates } from './api/autocomplete.js';
import {
  validateTitleLocal,
  buildFutureFilename,
  getCachedUniqueness,
  checkUniqueness,
  isSequencePlaceholderTitle,
  extractSequenceBasename,
  buildSequencePlaceholderTitle,
} from './api/title-validation.js';
const { useState, useMemo, useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "cozy",
  "cardSize": 240,
  "showFilenames": true,
  "darkMode": false,
  "showThumbsInList": true
} /*EDITMODE-END*/;

// Grid tile size steps, ordered smallest -> largest. Drives `--card-min`
// on `.grid` (the CSS uses `auto-fill, minmax(...)`, so this is the
// *minimum* tile width — actual tile width stretches to fill the row).
// The two largest steps (`xlarge`, `xxlarge`) exist so users can drop the
// view to roughly two tiles per row to inspect images at near-full size,
// per maintainer feedback on T425832. Persisted via localStorage key
// `stashhub.gridSize` as the string key (see App).
const GRID_SIZES = ["small", "medium", "large", "xlarge", "xxlarge"];
const GRID_SIZE_PX = { small: 160, medium: 240, large: 360, xlarge: 540, xxlarge: 800 };

// Default ordered list of fields shown in the detail panel.
// Stored on window so DetailPanel can read it.
const DEFAULT_FIELD_ORDER = [
{ key: "title", label: "Title", required: true, visible: true },
{ key: "description", label: "Caption", required: false, visible: true },
{ key: "categories", label: "Categories", required: false, visible: true },
{ key: "license", label: "License", required: true, visible: true },
{ key: "author", label: "Author", required: true, visible: true },
{ key: "source", label: "Source", required: false, visible: true },
{ key: "institution", label: "Institution", required: false, visible: false },
{ key: "dateTaken", label: "Date & time", required: false, visible: true },
{ key: "location", label: "Location", required: false, visible: true },
{ key: "technical", label: "Technical", required: false, visible: true }];

window.DEFAULT_FIELD_ORDER = DEFAULT_FIELD_ORDER;

// Chooser options for the {{Artwork}} |institution= field. One value for now
// (the KB); more institution templates can be added later — see
// https://commons.wikimedia.org/wiki/Category:Institution_templates
const INSTITUTION_OPTIONS = [
  { value: "{{Institution:Koninklijke Bibliotheek, Den Haag}}", label: "Koninklijke Bibliotheek, Den Haag" },
];
window.INSTITUTION_OPTIONS = INSTITUTION_OPTIONS;

// Some fields cannot be made optional — they're hard requirements for Commons.
const ALWAYS_REQUIRED = new Set(["title", "license", "author", "filename"]);
window.ALWAYS_REQUIRED = ALWAYS_REQUIRED;

// Default user-configurable required set. Filename always required (immutable).
const DEFAULT_REQUIRED = ["title", "license", "author"];

function App({ tweaks, setTweak, user, onLogout, initialItems, initialPrefs, loadErrors }) {
  const [_rawItems, setItems] = useState(initialItems || window.SAMPLE_UPLOADS);
  const [view, setView] = useState("list"); // grid | list
  // Spreadsheet-only display mode: "all" stacks every stash row into a single
  // table; "groups" stacks one mini-table per manual photo group (T425839),
  // with an implicit "Ungrouped" section at the bottom for everything else.
  // Only meaningful when `view === "list"` — Grid view ignores it.
  const [tableMode, setTableMode] = useState("all"); // all | groups
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(null);
  const [histCollapsed, setHistCollapsed] = useState(true);
  // Visual piling mode (T425840) — fullscreen lighttable for tactile group
  // creation. Toggles independently of view/grid mode; when on it covers
  // the rest of the workbench. Group state is shared with the table-view
  // groups feature (T425839) via the same getGroups/setGroups in user-store.
  const [pilingOpen, setPilingOpen] = useState(false);
  // Manual photo groups — ordered list of { id, sha1s[], filekeys[] }
  // mirrored from the user-store. Sha1 is preferred (content-permanent);
  // filekey is the fallback for items whose sha1 isn't yet known. Persisted
  // via persistGroups(), which debounces the actual wiki edit.
  const [groups, setGroupsState] = useState(() => {
    const fromStore = getGroups();
    return Array.isArray(fromStore) ? fromStore : [];
  });
  const updateGroups = React.useCallback((next) => {
    setGroupsState(next);
    persistGroups(next);
  }, []);

  // Lifted column state. Multiple <Table> instances need to stay in sync
  // (Groups view stacks several mini-tables; column visibility/order/widths
  // must be global across all of them per T425839 spec). The user-store
  // persists it cross-device; localStorage is the fast-path on first paint.
  // Always returns a fully-shaped object (never null) so Table can run in
  // controlled mode from the very first render — that's what keeps multiple
  // mini-tables in sync when the user toggles a column.
  const [columnState, setColumnState] = useState(() => {
    const DEFAULT_VISIBLE = window.STASHHUB_DEFAULT_VISIBLE || [
      'title', 'filename', 'description', 'categories', 'depicts', 'license', 'author',
      'dateTaken', 'cameraLocation', 'objectLocation', 'locationOfCreation',
      'size', 'dimensions',
      'camera', 'iso', 'aperture', 'shutter',
    ];
    const fromPrefs = initialPrefs?.columnState;
    if (fromPrefs && Array.isArray(fromPrefs.visible)) {
      return {
        visible: fromPrefs.visible,
        customProps: Array.isArray(fromPrefs.customProps) ? fromPrefs.customProps : [],
        widths: fromPrefs.widths && typeof fromPrefs.widths === 'object' ? fromPrefs.widths : {},
        order: Array.isArray(fromPrefs.order) ? fromPrefs.order : fromPrefs.visible.slice(),
      };
    }
    try {
      const saved = JSON.parse(localStorage.getItem('stashhub.columns.v9') || 'null');
      if (saved && Array.isArray(saved.visible)) {
        return {
          visible: saved.visible,
          customProps: saved.customProps || [],
          widths: saved.widths || {},
          order: Array.isArray(saved.order) ? saved.order : saved.visible.slice(),
        };
      }
    } catch (e) {}
    return { visible: DEFAULT_VISIBLE, customProps: [], widths: {}, order: DEFAULT_VISIBLE.slice() };
  });
  useEffect(() => {
    try { localStorage.setItem('stashhub.columns.v9', JSON.stringify(columnState)); } catch (e) {}
    setPref('columnState', columnState);
  }, [columnState]);

  // Cell clipboard for copy/paste across rows.
  // { field: 'categories'|'license'|'author'|'title'|'description', value: any, count: 0 }
  const [clipboard, setClipboard] = useState(null);

  // Lightbox — currently displayed image item id.
  const [lightboxId, setLightboxId] = useState(null);

  // User-configurable required-field set. The user-store (loaded by Bootstrap)
  // is authoritative; localStorage is the fast-path cache for instant boot
  // before the wiki round-trip completes. Writes update both.
  const [requiredFields, setRequiredFields] = useState(() => {
    if (Array.isArray(initialPrefs?.requiredFields)) return initialPrefs.requiredFields;
    try {
      const saved = JSON.parse(localStorage.getItem("stashhub.required") || "null");
      if (Array.isArray(saved)) return saved;
    } catch (e) {}
    return DEFAULT_REQUIRED;
  });
  useEffect(() => {
    try {localStorage.setItem("stashhub.required", JSON.stringify(requiredFields));} catch (e) {}
    setPref('requiredFields', requiredFields);
  }, [requiredFields]);

  // Stash items get fresh issues every render so StatusDot, cell highlights,
  // sort, and chips always agree. Skip published items — they're view-only in
  // v1 and shouldn't get spurious "missing-*" issues that would, e.g., wrongly
  // show a "No license" chip on every published file with sparse metadata.
  //
  // Stash entries are also COALESCED by sha1: two stash filekeys pointing at
  // the same bytes are folded into a single logical row (latest upload wins
  // for file-derived fields like EXIF / dimensions / expiry; user drafts
  // already merged at the same sha1 key apply to both). See coalesceStashBySha1.
  const items = useMemo(
    () => {
      const coalesced = coalesceStashBySha1(_rawItems);
      return coalesced.map((i) =>
        i.status?.startsWith('stash') ? recomputeIssues(i, requiredFields) : i,
      );
    },
    [_rawItems, requiredFields],
  );

  // T426422 follow-up: auto-promote any caption language found in `items`
  // (typically merged in from the user-store drafts on bootstrap, or after
  // a re-upload of a file the user previously typed captions for) into
  // `columnState.visible` so the caption text is never invisible-but-stored.
  // The maintainer's invariant: "the user should not be able to have caption
  // values linked to a file that is not visible in the table."
  //
  // Bailout: setColState((prev) => prev) when nothing to add. Crucial — the
  // effect re-fires on every items change (cell edits, uploads, refreshes),
  // and a `prev → new object identity` return on the no-op path would loop
  // (per the cell-commit-freeze lesson — see CLAUDE.md).
  useEffect(() => {
    if (!Array.isArray(items) || items.length === 0) return;
    if (!window.collectCaptionLangsFromItems || !window.captionColKeyFromLang || !window.getAllColumns) return;
    const presentLangs = window.collectCaptionLangsFromItems(items);
    if (presentLangs.size === 0) return;
    setColumnState((prev) => {
      const visible = prev.visible || [];
      const order = prev.order || [];
      const allCols = window.getAllColumns(prev.customProps || []);
      const visibleCaptionLangs = new Set(
        visible
          .map((vk) => allCols.find((c) => c.key === vk))
          .filter((c) => c?.caption)
          .map((c) => c.caption.lang),
      );
      const toAdd = [];
      for (const lang of presentLangs) {
        if (!visibleCaptionLangs.has(lang)) {
          const colKey = window.captionColKeyFromLang(lang);
          // Only auto-promote languages our descriptor catalog covers; an
          // unknown SDC label language (something outside the curated 24)
          // would have no column descriptor and the table would crash.
          // Such items still keep their value in `descriptions[<lang>]`,
          // and the column appears the moment the user adds the matching
          // language column manually.
          if (allCols.find((c) => c.key === colKey)) {
            toAdd.push(colKey);
          }
        }
      }
      if (toAdd.length === 0) return prev;
      // Append the new caption columns to the end of visible/order so the
      // user notices them; they don't displace existing column layouts.
      return {
        ...prev,
        visible: [...visible, ...toAdd],
        order: [...order, ...toAdd.filter((k) => !order.includes(k))],
      };
    });
  }, [items]);

  const [columnDefaults, setColumnDefaults] = useState(() => {
    if (initialPrefs?.columnDefaults && typeof initialPrefs.columnDefaults === 'object') {
      return initialPrefs.columnDefaults;
    }
    try {
      const saved = JSON.parse(localStorage.getItem("stashhub.colDefaults") || "null");
      if (saved && typeof saved === "object") return saved;
    } catch (e) {}
    return {};
  });
  useEffect(() => {
    try {localStorage.setItem("stashhub.colDefaults", JSON.stringify(columnDefaults));} catch (e) {}
    setPref('columnDefaults', columnDefaults);
  }, [columnDefaults]);

  // Grid tile size — five stepped sizes, persisted across reloads. Driven
  // through plus/minus buttons that walk `GRID_SIZES`; the two extra steps
  // beyond `large` exist so users can drop to ~two tiles per row to
  // inspect images at near-full size (T425832 feedback).
  // Pure UI pref; lives in localStorage only (not synced to the user-store
  // wiki page — see "Don't persist derived data" rule, which extends to
  // viewport-only prefs that wouldn't be useful cross-device anyway).
  const [gridSize, setGridSize] = useState(() => {
    try {
      const saved = localStorage.getItem("stashhub.gridSize");
      if (GRID_SIZES.includes(saved)) return saved;
    } catch (e) {}
    return "medium";
  });
  useEffect(() => {
    try {localStorage.setItem("stashhub.gridSize", gridSize);} catch (e) {}
  }, [gridSize]);
  const gridCardPx = GRID_SIZE_PX[gridSize] ?? GRID_SIZE_PX.medium;
  const gridSizeIndex = GRID_SIZES.indexOf(gridSize);
  const stepGridSize = (delta) => {
    const next = gridSizeIndex + delta;
    if (next < 0 || next >= GRID_SIZES.length) return;
    setGridSize(GRID_SIZES[next]);
  };

  // Wikitext template selection. Default {{Information}}; user can switch
  // to {{Artwork}} / {{Photograph}} / {{Book}} / a custom template. Stored
  // in user-store Preferences.json via setPref so it roams across devices.
  const [wikitextTemplate, setWikitextTemplate] = useState(() => {
    if (initialPrefs?.wikitextTemplate && typeof initialPrefs.wikitextTemplate === 'object') {
      return initialPrefs.wikitextTemplate;
    }
    try {
      const saved = JSON.parse(localStorage.getItem("stashhub.wikitextTemplate") || "null");
      if (saved && typeof saved === "object") return saved;
    } catch (e) {}
    return { id: 'Information' };
  });
  useEffect(() => {
    try { localStorage.setItem("stashhub.wikitextTemplate", JSON.stringify(wikitextTemplate)); } catch (e) {}
    setPref('wikitextTemplate', wikitextTemplate);
  }, [wikitextTemplate]);

  // Track Cmd/Ctrl held so the Table can switch click-anywhere-on-row -> select.
  useEffect(() => {
    const update = (e) => {
      const on = !!(e.metaKey || e.ctrlKey);
      document.body.classList.toggle("mod-select", on);
    };
    const off = () => document.body.classList.remove("mod-select");
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", off);
    };
  }, []);

  // Paste-mode body class + Esc to cancel.
  useEffect(() => {
    if (!clipboard) return;
    document.body.classList.add("paste-mode");
    document.body.dataset.pasteField = clipboard.field;
    const onKey = (e) => {if (e.key === "Escape") setClipboard(null);};
    // Capture-phase click handler: if the click lands outside a paste-target cell
    // or the paste banner, cancel paste mode and swallow the event so nothing
    // underneath fires (e.g. opening the detail panel, selecting a row, etc.).
    const onCapture = (e) => {
      const inTarget = e.target.closest(".tbl__td--paste-target");
      const inBanner = e.target.closest(".paste-banner");
      const inCopyBtn = e.target.closest(".tag__copy") || e.target.closest(".tbl__td-copy");
      if (!inTarget && !inBanner && !inCopyBtn) {
        setClipboard(null);
        e.stopPropagation();
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onCapture, true);
    return () => {
      document.body.classList.remove("paste-mode");
      delete document.body.dataset.pasteField;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onCapture, true);
    };
  }, [clipboard]);

  // Field order saved across sessions, used by detail panel.
  // refreshLabels(): T425885 follow-up — when we rename a field's UI label
  // (e.g. Description → Caption) we want existing users to pick up the new
  // label without losing their custom ordering. Re-derive .label from
  // DEFAULT_FIELD_ORDER for any matching key while keeping the user's order
  // and any custom-prop entries verbatim.
  const refreshLabels = (saved) => {
    const labelMap = new Map(DEFAULT_FIELD_ORDER.map((f) => [f.key, f.label]));
    return saved.map((f) => (labelMap.has(f.key) ? { ...f, label: labelMap.get(f.key) } : f));
  };
  const [fieldOrder, setFieldOrder] = useState(() => {
    if (Array.isArray(initialPrefs?.fieldOrder)) {
      const known = new Set(initialPrefs.fieldOrder.map((f) => f.key));
      return [
        ...refreshLabels(initialPrefs.fieldOrder),
        ...DEFAULT_FIELD_ORDER.filter((f) => !known.has(f.key)),
      ];
    }
    try {
      const saved = localStorage.getItem("stashhub.fieldOrder");
      if (saved) {
        const parsed = JSON.parse(saved);
        // merge with defaults so any new keys added later still show
        const known = new Set(parsed.map((f) => f.key));
        return [
          ...refreshLabels(parsed),
          ...DEFAULT_FIELD_ORDER.filter((f) => !known.has(f.key)),
        ];
      }
    } catch (e) {}
    return DEFAULT_FIELD_ORDER;
  });
  useEffect(() => {
    try {localStorage.setItem("stashhub.fieldOrder", JSON.stringify(fieldOrder));} catch (e) {}
    setPref('fieldOrder', fieldOrder);
  }, [fieldOrder]);

  useEffect(() => {
    document.documentElement.dataset.theme = tweaks.darkMode ? "dark" : "light";
  }, [tweaks.darkMode]);

  // When live autocomplete results arrive, bump a tick so App re-renders
  // and the cell editors see the freshly-merged window.KNOWN_* pools.
  // Without this, results that arrive AFTER the user stops typing wouldn't
  // appear until the next keystroke.
  const [, setVocabTick] = useState(0);
  useEffect(() => subscribeAutocompleteUpdates(() => setVocabTick((t) => t + 1)), []);

  // History sync state: read from cache initially; updated by refresh actions.
  const [historySyncedAt, setHistorySyncedAt] = useState(() => getCachedHistory().lastSyncedAt);
  const [historyRefreshing, setHistoryRefreshing] = useState(false);
  const [historyLoadMore, setHistoryLoadMore] = useState(false);
  const [refreshingItemId, setRefreshingItemId] = useState(null);

  const refreshHistory = async () => {
    if (!user?.username) return;
    setHistoryRefreshing(true);
    try {
      // Refresh whatever count is currently in cache (so a "Load more"
      // user keeps their bigger view), with 50 as the floor.
      const currentCount = (getCachedHistory().items || []).length || 50;
      const limit = Math.max(currentCount, 50);
      const { items: fresh } = await fetchHistoryDetailed(user.username, { limit });
      if (!fresh) return;
      setCachedHistory(fresh);
      setHistorySyncedAt(new Date().toISOString());
      setItems((prev) => {
        const stashOnly = prev.filter((i) => i.status?.startsWith('stash'));
        return [...stashOnly, ...fresh];
      });
    } catch (e) {
      console.warn('History refresh failed:', e);
    } finally {
      setHistoryRefreshing(false);
    }
  };

  const loadMoreHistory = async () => {
    if (!user?.username) return;
    setHistoryLoadMore(true);
    try {
      const currentCount = (getCachedHistory().items || []).length;
      const limit = currentCount + 50;
      const { items: fresh } = await fetchHistoryDetailed(user.username, { limit });
      setCachedHistory(fresh);
      setHistorySyncedAt(new Date().toISOString());
      setItems((prev) => {
        const stashOnly = prev.filter((i) => i.status?.startsWith('stash'));
        return [...stashOnly, ...fresh];
      });
    } catch (e) {
      console.warn('Load more history failed:', e);
    } finally {
      setHistoryLoadMore(false);
    }
  };

  const refreshOneItem = async (item) => {
    if (item.status !== 'published' || !item.filename) return;
    setRefreshingItemId(item.id);
    try {
      const fresh = await fetchHistoryOne(item.filename);
      if (!fresh) return;
      updateCachedHistoryItem(fresh);
      setItems((prev) => prev.map((i) => (i.id === item.id ? fresh : i)));
    } catch (e) {
      console.warn('Per-item refresh failed:', e);
    } finally {
      setRefreshingItemId(null);
    }
  };

  // Soft-deleted ("hidden") stash files. Two parallel sets during the
  // sha1 migration window: hiddenSha1s is canonical (content-permanent),
  // hiddenFilekeys is a legacy fallback for rows that don't yet have a
  // sha1 known. A row is hidden if EITHER set matches it.
  const [hiddenSha1s, setHiddenSha1s] = useState(() => getHiddenSha1s());
  const [hiddenFilekeys, setHiddenFilekeys] = useState(() => getHiddenFilekeys());
  const isItemHidden = React.useCallback(
    (item) =>
      (item?.sha1 && hiddenSha1s.has(item.sha1)) ||
      (item?.filekey && hiddenFilekeys.has(item.filekey)),
    [hiddenSha1s, hiddenFilekeys],
  );
  const [showHidden, setShowHidden] = useState(false);

  // SHA-1 -> published filename. Lets us mark stash items that are already
  // on Commons (same bytes = same hash) so the user doesn't accidentally
  // re-publish a duplicate. Synchronous coverage is the rich items window
  // (latest ~50) plus any visible published rows in state. Older re-uploads
  // fall through to the findCommonsFileBySha1 effect below, which sets
  // existsOnCommons asynchronously per stash sha1.
  const publishedSha1Map = useMemo(() => {
    const map = getPublishedSha1Map();
    for (const item of items) {
      if (item.status === 'published' && item.sha1 && !map.has(item.sha1)) {
        map.set(item.sha1, item.filename);
      }
    }
    return map;
  }, [items]);

  const findDuplicate = (item) =>
    item?.sha1 && item.status?.startsWith('stash') ? publishedSha1Map.get(item.sha1) : null;

  // (In-stash duplicate detection used to live here. It's gone — coalesceStashBySha1
  // now folds same-sha1 stash entries into a single logical row at the items-derivation
  // step, so by the time anything downstream looks at items there are no duplicates
  // to flag. The publish modal's old "twin in stash" warning and the table/card
  // duplicate banners are dead code paths now; left as no-ops because item.duplicateInStash
  // is never set anymore. T425873 follow-up.)

  // (No auto-unhide on boot. The maintainer's "uploaded again moves it from
  // hidden back to visible" rule is satisfied entirely by replaceUploadItem,
  // which runs when a fresh upload finishes in this session. A retroactive
  // boot-time unhide based on "raw stash has >=2 entries with this sha1" can
  // race against the user's own Discard click on a still-coalescing row, and
  // there's no observable signal to distinguish "two old entries the user
  // never explicitly waved through" from "two entries because the user did
  // re-upload, just from another tab." The hidden section still surfaces
  // such rows with a Restore button — one click instead of zero.)

  // Backfill sha1 for stash items that bootstrap couldn't enrich.
  //
  // fetchStashedFiles fires N parallel fetchStashFileInfo calls; if any fail
  // (rate limit, transient network), the corresponding item lands without a
  // sha1, and the duplicate-check below silently skips it. Retry once per
  // filekey here so duplicate detection actually covers every stash entry
  // — not just the ones whose info call happened to succeed first time.
  const stashRefilledRef = React.useRef(new Set());
  useEffect(() => {
    const missing = items.filter(
      (i) => i.status?.startsWith('stash') && i.filekey && !i.sha1,
    );
    for (const it of missing) {
      if (stashRefilledRef.current.has(it.filekey)) continue;
      stashRefilledRef.current.add(it.filekey);
      const filekey = it.filekey;
      const id = it.id;
      fetchStashFileInfo(filekey)
        .then((info) => {
          if (!info?.sha1) return;
          setItems((prev) =>
            prev.map((row) => {
              if (row.id !== id || row.sha1) return row;
              // Re-run normalize against the original placeholder fields so
              // EXIF-derived bits land too, not just sha1.
              const fresh = normalizeStashItem(
                { filekey: row.filekey, filename: row.filename, size: row.bytes },
                info,
              );
              // Don't clobber draft edits the user may already have made.
              return {
                ...fresh,
                ...row,
                sha1: fresh.sha1,
                width: fresh.width || row.width,
                height: fresh.height || row.height,
                mime: row.mime || fresh.mime,
                thumburl: fresh.thumburl || row.thumburl,
                url: fresh.url || row.url,
              };
            }),
          );
        })
        .catch((e) => console.warn('Stash info backfill failed for', filekey, e));
    }
  }, [items]);

  // Cross-Commons duplicate check for stash items.
  //
  // findDuplicate above only catches the user's own re-uploads. A bigger risk
  // is that *someone else* uploaded the same bytes — either before this stash
  // entry existed, or in the meantime while it was sitting in the 48h stash.
  // We hit allimages?aisha1= once per stash sha1 we haven't checked yet, then
  // mirror the result onto the item so the banner / chip / publish gate pick
  // it up. The check fires on bootstrap (catching anything stashed in a prior
  // session) and again whenever new stash items arrive.
  const dupCheckedRef = React.useRef(new Set());
  useEffect(() => {
    const stashItems = items.filter(
      (i) => i.status?.startsWith('stash') && i.sha1 && !i.existsOnCommons,
    );
    for (const it of stashItems) {
      if (dupCheckedRef.current.has(it.sha1)) continue;
      dupCheckedRef.current.add(it.sha1);
      const sha1 = it.sha1;
      const id = it.id;
      const timeout = new Promise((r) => setTimeout(() => r(null), 8000));
      Promise.race([findCommonsFileBySha1(sha1), timeout])
        .then((hit) => {
          if (hit) {
            console.info('[dup] hit on Commons:', it.filename, '→ File:' + hit.filename, 'by', hit.user);
          } else {
            console.debug('[dup] no match on Commons for', it.filename, sha1);
          }
          if (!hit) return;
          setItems((prev) =>
            prev.map((row) => {
              if (row.id !== id || row.existsOnCommons) return row;
              const issues = row.issues?.includes('exists-on-commons')
                ? row.issues
                : [...(row.issues || []), 'exists-on-commons'];
              return { ...row, existsOnCommons: hit, issues };
            }),
          );
        })
        .catch((e) => console.warn('[dup] check failed for', sha1, e));
    }
  }, [items]);

  // Per-category existence check on Commons (T425950).
  //
  // The tool no longer creates new categories — only attaches existing
  // ones. Whenever a stash row carries a category name we haven't yet
  // verified, hit `prop=info` on `Category:<name>` once. Names that come
  // back missing get pushed onto `item.nonExistingCategories` and the
  // row gets the blocking `categories-not-on-commons` issue, which gates
  // the publish button (see api/publish.js BLOCKING_ISSUE_CODES) and
  // turns the chip red in the table cell + cell editor.
  //
  // Cache is module-level (categoryCheckRef) so we don't re-fetch the
  // same name across many rows in one session; the underlying fetchJSON
  // also caches the HTTP response for 5 minutes via apiCache. Names the
  // user has typed but not yet committed don't enter this loop — the
  // editor still shows them as "unverified" until they're committed onto
  // a row. Empty / whitespace-only names skip both the fetch and the
  // result map (they're stripped on commit anyway).
  const categoryCheckRef = React.useRef(new Map()); // name -> Promise<boolean>
  useEffect(() => {
    const stashItems = items.filter((i) => i.status?.startsWith('stash'));
    // Collect unique names we haven't fetched yet, plus the rows that need
    // re-evaluation (any row with at least one category).
    const toFetch = new Set();
    const rowsWithCats = new Set();
    for (const it of stashItems) {
      const cats = it.categories || [];
      if (!cats.length) continue;
      rowsWithCats.add(it.id);
      for (const raw of cats) {
        const name = String(raw || '').trim();
        if (!name) continue;
        if (!categoryCheckRef.current.has(name)) toFetch.add(name);
      }
    }

    if (toFetch.size === 0 && rowsWithCats.size === 0) return;

    // Kick off any new lookups; record the promise so concurrent rows
    // dedupe to one in-flight request per name.
    const fetchPromises = [];
    for (const name of toFetch) {
      const p = categoryExists(name)
        .then((exists) => exists)
        .catch((e) => {
          // Network error → treat as "unknown / not blocking yet". We
          // intentionally don't cache the failure so a later retry
          // (next mount, next render after a name is added elsewhere)
          // can succeed. Return null so the result-merge step skips this
          // name (rather than flagging a transient outage as a missing
          // category and blocking publish on a network blip).
          console.warn('[categoryExists] failed for', name, e?.message || e);
          categoryCheckRef.current.delete(name);
          return null;
        });
      categoryCheckRef.current.set(name, p);
      fetchPromises.push(p);
    }

    // Once any new lookups settle (or immediately if all names were
    // already cached), recompute the per-row missing-category list from
    // the resolved cache and patch items in place.
    let cancelled = false;
    Promise.all(fetchPromises).then(async () => {
      if (cancelled) return;
      // Resolve all category names referenced by current rows.
      const resolved = new Map(); // name -> boolean | null
      const allNames = new Set();
      for (const it of stashItems) {
        for (const raw of it.categories || []) {
          const name = String(raw || '').trim();
          if (name) allNames.add(name);
        }
      }
      await Promise.all(
        [...allNames].map(async (name) => {
          const p = categoryCheckRef.current.get(name);
          resolved.set(name, p ? await p : null);
        }),
      );
      if (cancelled) return;
      setItems((prev) => {
        // Bail with the same array reference when no row actually mutated.
        // The effect's dep is [items]; without this, prev.map() always
        // returns a new array, which re-fires the effect on every commit
        // (cached path: empty Promise.all resolves on next microtask) and
        // freezes the tab in a setItems→items-memo→effect→setItems loop.
        let changed = false;
        const next = prev.map((row) => {
          if (!row.status?.startsWith('stash')) return row;
          const cats = row.categories || [];
          // A name is "missing" only when we have a definite false from
          // the API; null (unknown / network error) leaves it alone so
          // we don't flap red on a transient blip.
          const missing = cats.filter((c) => {
            const name = String(c || '').trim();
            if (!name) return false;
            // IIIF imports (Q8): the row's pending category is created at
            // publish time by publishOne — don't block publish on it.
            if (name === row.iiifPendingCategory) return false;
            return resolved.get(name) === false;
          });
          const prevMissing = row.nonExistingCategories || [];
          const sameMissing =
            prevMissing.length === missing.length &&
            prevMissing.every((m, i) => m === missing[i]);
          const hadIssue = (row.issues || []).includes('categories-not-on-commons');
          const wantIssue = missing.length > 0;
          if (sameMissing && hadIssue === wantIssue) return row;
          changed = true;
          let issues = row.issues || [];
          if (wantIssue && !hadIssue) issues = [...issues, 'categories-not-on-commons'];
          else if (!wantIssue && hadIssue) issues = issues.filter((c) => c !== 'categories-not-on-commons');
          return { ...row, nonExistingCategories: missing, issues };
        });
        return changed ? next : prev;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [items]);

  // Split into two streams: stash first, history below.
  // Hidden ("soft-deleted") items are NEVER mixed into stashItems — they live
  // in their own block at the bottom of the stash section. Surfacing the same
  // row in both the disclosure list and the table at the same time was
  // confusing and made bulk discard look as if it had failed (the "discarded"
  // rows reappeared in-table as soon as the user opened the disclosure to
  // verify). Treat the hidden block as a strict alternative to the table,
  // never duplicated into it.
  const stashItemsAll = useMemo(() => items.filter((i) => i.status?.startsWith("stash")), [items]);
  const stashItems = useMemo(
    () => stashItemsAll.filter((i) => !isItemHidden(i)),
    [stashItemsAll, isItemHidden],
  );
  const hiddenItems = useMemo(
    () => stashItemsAll.filter((i) => isItemHidden(i)),
    [stashItemsAll, isItemHidden],
  );
  const histItems = useMemo(() => items.filter((i) => i.status === "published"), [items]);

  // Title vocabulary — every distinct title the user has previously used.
  const titleVocab = useMemo(() => {
    const seen = new Set();
    for (const i of items) {
      const t = (i.title || "").trim();
      if (t) seen.add(t);
    }
    return [...seen].sort();
  }, [items]);

  const applyFilters = (list, isStash) => {
    let out = list;
    if (query.trim()) {
      // Search against the rendered text of every column — exactly what the
      // user sees in the table. This means dates ("Aug 15, 14:30"), sizes
      // ("2.3 MB"), dimensions ("1920×1080"), status ("Stashed"/"Published"),
      // EXIF (camera, lens, ISO …), depicts labels+QIDs, and custom-prop
      // values are all matched. The cellSearchText() helper in table.jsx
      // mirrors CellView's per-column branches, so the haystack stays in sync
      // with what's on screen. Fall back to the simple text fields if the
      // table module hasn't loaded yet (defensive — bootstrap order).
      // Whitespace-separated terms are ANDed together: typing two words
      // narrows the result (the natural way to refine), not widens it.
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const cellSearchText = window.cellSearchText;
      const getAllColumns = window.getAllColumns;
      const loadColumnState = window.loadColumnState;
      let columns = null;
      if (cellSearchText && getAllColumns) {
        const colState = loadColumnState ? loadColumnState() : { customProps: [] };
        columns = getAllColumns(colState.customProps);
      }
      const haystackOf = (i) => {
        if (columns) {
          const parts = [];
          for (const col of columns) {
            const t = cellSearchText(col, i);
            if (t) parts.push(t);
          }
          return parts.join(" ").toLowerCase();
        }
        // Fallback (shouldn't normally trigger): minimal text fields.
        return [i.title, i.filename, i.description, i.author].filter(Boolean).join(" ").toLowerCase();
      };
      out = out.filter((i) => {
        const hay = haystackOf(i);
        return terms.every((t) => hay.includes(t));
      });
    }
    if (filter === "needs-attention") out = out.filter((i) => i.issues?.length > 0);else
    if (filter === "complete") out = out.filter((i) => !i.issues?.length);

    out = [...out].sort((a, b) => {
      // Default order is newest first by UPLOAD time (when the file landed in
      // the workbench's view of the world), not the photo's date-taken. A
      // re-upload of a 2015 photo today should appear at the top, not buried
      // 200 rows down between other 2015 photos. Use uploadedAt | publishedAt
      // and only fall back to dateTaken when nothing else is set.
      // Table view's column-header click-to-sort can override this in
      // table.jsx; Grid view uses this baseline order directly.
      const ka = a.uploadedAt || a.publishedAt || a.dateTaken;
      const kb = b.uploadedAt || b.publishedAt || b.dateTaken;
      return new Date(kb) - new Date(ka);
    });
    return out;
  };

  const filteredStash = useMemo(
    () => applyFilters(stashItems, true),
    [stashItems, query, filter],
  );
  const filteredHist = useMemo(() => applyFilters(histItems, false), [histItems, query, filter]);

  // All detected duplicates — flagged by the cross-Commons sha1 check
  // (existsOnCommons set). In-stash same-sha1 dupes are coalesced upstream
  // by coalesceStashBySha1, so they never reach this filter as separate rows.
  // Excludes already-hidden rows even when the "X hidden" disclosure is open,
  // so the count doesn't include items the user has already discarded.
  // Drives the duplicate-status banner + its one-click discard action.
  const duplicateStashItems = useMemo(
    () => stashItemsAll.filter(
      (i) => !isItemHidden(i) && i.existsOnCommons,
    ),
    [stashItemsAll, isItemHidden],
  );
  // Subset of duplicateStashItems that survives the current filter/search.
  // Used only for the "(N visible, M hidden by current filter)" hint —
  // the discard action itself targets the full set, so a filter doesn't
  // accidentally narrow what gets cleaned up.
  const duplicateStashItemsVisible = useMemo(() => {
    if (duplicateStashItems.length === 0) return [];
    const visibleIds = new Set(filteredStash.map((i) => i.id));
    return duplicateStashItems.filter((i) => visibleIds.has(i.id));
  }, [duplicateStashItems, filteredStash]);

  // --- Manual photo groups (T425839) -----------------------------------
  //
  // A group is { id, sha1s[], filekeys[] } persisted to the user-store. To
  // resolve "which group does row X belong to" we check sha1 first (content-
  // permanent), then filekey as a fallback. Each row appears in at most one
  // group; the membership map is built per-render from the authoritative
  // groups[] array so adding/removing/reordering groups is a one-shot setter
  // call, no per-row sync needed.
  const groupOfItem = useMemo(() => {
    const map = new Map(); // itemId -> groupId
    for (const g of groups) {
      const sha1Set = new Set(g.sha1s || []);
      const filekeySet = new Set(g.filekeys || []);
      for (const it of stashItems) {
        if (map.has(it.id)) continue; // earlier groups win on a collision
        if ((it.sha1 && sha1Set.has(it.sha1)) || (it.filekey && filekeySet.has(it.filekey))) {
          map.set(it.id, g.id);
        }
      }
    }
    return map;
  }, [groups, stashItems]);

  // Filtered stash partitioned by groupId. Output order matches `groups`,
  // with an "Ungrouped" pseudo-group at the end. Filter/search/sort are
  // applied first so groups respect the active filters.
  const stashGroupBuckets = useMemo(() => {
    const byGroup = new Map();
    for (const g of groups) byGroup.set(g.id, []);
    const ungrouped = [];
    for (const it of filteredStash) {
      const gid = groupOfItem.get(it.id);
      if (gid && byGroup.has(gid)) byGroup.get(gid).push(it);
      else ungrouped.push(it);
    }
    return { byGroup, ungrouped };
  }, [filteredStash, groupOfItem, groups]);

  // Group from currently selected rows. Selected items already in another
  // group are silently moved to the new group (a photo can only be in one
  // group). Items without a sha1 OR filekey can't be grouped (no stable id).
  const groupSelection = React.useCallback(() => {
    const targets = [...selected]
      .map((id) => stashItemsAll.find((i) => i.id === id))
      .filter((i) => i?.status?.startsWith('stash'));
    if (!targets.length) return;
    const newSha1s = new Set();
    const newFilekeys = new Set();
    for (const it of targets) {
      if (it.sha1) newSha1s.add(it.sha1);
      else if (it.filekey) newFilekeys.add(it.filekey);
    }
    if (!newSha1s.size && !newFilekeys.size) return;
    // Strip the moved sha1s/filekeys from any pre-existing groups so a row
    // is never in two groups simultaneously (per maintainer feedback on
    // T425839 — selecting files from group A and creating a new group must
    // produce a fresh group with those files removed from A). Drop any
    // group that ends up empty after the move.
    const cleaned = groups
      .map((g) => ({
        ...g,
        sha1s: (g.sha1s || []).filter((s) => !newSha1s.has(s)),
        filekeys: (g.filekeys || []).filter((k) => !newFilekeys.has(k)),
      }))
      .filter((g) => (g.sha1s.length + g.filekeys.length) > 0);
    // Assign a stable creation-order seq so the default label ("Group 3")
    // doesn't shift when the user drags groups around (T425839 feedback).
    let nextSeq = 1;
    for (const g of groups) {
      if (typeof g.seq === 'number') nextSeq = Math.max(nextSeq, g.seq + 1);
    }
    const newGroup = {
      id: `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      seq: nextSeq,
      sha1s: [...newSha1s],
      filekeys: [...newFilekeys],
    };
    updateGroups([...cleaned, newGroup]);
    setTableMode('groups'); // jump straight into Groups view so the user sees the result
    setSelected(new Set());
  }, [selected, stashItemsAll, groups, updateGroups]);

  // Ungroup the currently selected rows: each selected file leaves its
  // group (if any) and drops back into the implicit Ungrouped section.
  // Empty groups left behind are pruned. Mirror of groupSelection — paired
  // bulk action per T425839 feedback.
  const ungroupSelection = React.useCallback(() => {
    const targets = [...selected]
      .map((id) => stashItemsAll.find((i) => i.id === id))
      .filter(Boolean);
    if (!targets.length) return;
    const sha1Drop = new Set();
    const fkeyDrop = new Set();
    for (const it of targets) {
      if (it.sha1) sha1Drop.add(it.sha1);
      if (it.filekey) fkeyDrop.add(it.filekey);
    }
    const next = groups
      .map((g) => ({
        ...g,
        sha1s: (g.sha1s || []).filter((s) => !sha1Drop.has(s)),
        filekeys: (g.filekeys || []).filter((k) => !fkeyDrop.has(k)),
      }))
      .filter((g) => (g.sha1s.length + g.filekeys.length) > 0);
    if (JSON.stringify(next) !== JSON.stringify(groups)) updateGroups(next);
    setSelected(new Set());
  }, [selected, stashItemsAll, groups, updateGroups]);

  // True iff at least one currently selected row is a member of some group
  // — used to enable/disable the Ungroup selection button so it's only
  // actionable when it would actually do something.
  const selectionHasGrouped = React.useMemo(() => {
    if (!selected.size) return false;
    for (const id of selected) {
      if (groupOfItem.has(id)) return true;
    }
    return false;
  }, [selected, groupOfItem]);

  // Ungroup-all: dissolve a group entirely. Files keep their data and
  // drop back into Ungrouped. Renamed from "deleteGroup" per T425839
  // feedback — "delete" reads to users as "delete the files inside".
  const ungroupAll = React.useCallback(
    (groupId) => {
      updateGroups(groups.filter((g) => g.id !== groupId));
    },
    [groups, updateGroups],
  );

  // Rename a group. An empty / whitespace-only name resets to the default
  // "Group {seq}" label by stripping the `name` field entirely.
  const renameGroup = React.useCallback(
    (groupId, nextName) => {
      const trimmed = (nextName || '').trim();
      const next = groups.map((g) => {
        if (g.id !== groupId) return g;
        if (!trimmed) {
          // Reset to default label: drop the name field.
          const { name: _drop, ...rest } = g;
          return rest;
        }
        return { ...g, name: trimmed };
      });
      if (JSON.stringify(next) !== JSON.stringify(groups)) updateGroups(next);
    },
    [groups, updateGroups],
  );

  // Remove a single row from whichever group it sits in. Used by the
  // per-row "Remove from group" affordance. Empty groups are pruned.
  const removeItemFromGroup = React.useCallback(
    (item) => {
      if (!item) return;
      const next = groups
        .map((g) => ({
          ...g,
          sha1s: (g.sha1s || []).filter((s) => s !== item.sha1),
          filekeys: (g.filekeys || []).filter((k) => k !== item.filekey),
        }))
        .filter((g) => (g.sha1s.length + g.filekeys.length) > 0);
      if (JSON.stringify(next) !== JSON.stringify(groups)) updateGroups(next);
    },
    [groups, updateGroups],
  );

  // Drag-reorder groups. `from` and `to` are the source/target indices in
  // the groups[] array (Ungrouped is rendered last and isn't reorderable).
  const reorderGroups = React.useCallback(
    (fromIdx, toIdx) => {
      if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
      const next = [...groups];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      updateGroups(next);
    },
    [groups, updateGroups],
  );

  // Auto-prune groups that have no live members in the workbench (T425839
  // feedback: "an empty group should not be possible"). A group becomes
  // empty when its rows leave the stash for any reason — published, soft-
  // deleted (discard), expired from the 48h stash, or otherwise no longer
  // present. We compare each group's stored sha1s/filekeys against the
  // currently visible (non-hidden) stash; if zero overlap, the group goes.
  //
  // Filters do NOT count as "empty" (the rows are still there, just hidden
  // by the current view) — we check membership against `stashItems`, not
  // `filteredStash`. This matches the maintainer's intent: filter-driven
  // emptiness is transient and recoverable; structural emptiness is not.
  //
  // The effect is also a load-time safety net: groups stored on the wiki
  // user-store from a prior session whose files have since expired or been
  // published from another tab get cleaned up on next bootstrap.
  React.useEffect(() => {
    if (!groups.length) return;
    // Build sets of identifiers that still resolve to a live, non-hidden
    // stash row. Cheaper than nested per-group filtering on every render.
    const liveSha1s = new Set();
    const liveFilekeys = new Set();
    for (const it of stashItems) {
      if (it.sha1) liveSha1s.add(it.sha1);
      if (it.filekey) liveFilekeys.add(it.filekey);
    }
    const survivors = groups.filter((g) => {
      const hasLiveSha1 = (g.sha1s || []).some((s) => liveSha1s.has(s));
      if (hasLiveSha1) return true;
      const hasLiveFkey = (g.filekeys || []).some((k) => liveFilekeys.has(k));
      return hasLiveFkey;
    });
    if (survivors.length !== groups.length) updateGroups(survivors);
  }, [groups, stashItems, updateGroups]);

  const needsAttn = stashItems.filter((i) => i.issues?.length > 0).length;

  const toggleSelect = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);else n.add(id);
      return n;
    });
  };
  const setSelectionFor = (ids, makeSelected) => {
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids) {if (makeSelected) n.add(id);else n.delete(id);}
      return n;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const onUpdate = (next) => {
    setItems((prev) => prev.map((i) => i.id === next.id ? next : i));
    // Persist editable fields to the user-store as a draft. Only stash files
    // — published files are view-only in v1 and shouldn't accidentally save
    // edits.
    if (next.status?.startsWith('stash')) {
      const key = draftKey(next);
      if (key) setDraft(key, pickDraftFields(next));
    }
    // Title commit: kick off a Commons uniqueness check (deduped + cached
    // inside checkUniqueness). When it resolves, force a re-render so
    // recomputeIssues picks up the new cached verdict and surfaces a
    // 'title-taken' issue if the title is already in use. The editor's
    // own debounced check covers the live typing case; this catches the
    // commit case (paste, fill-blank, default-overwrite, drafts loaded
    // from the user-store).
    //
    // Sequence placeholders (T425984) skip the check — `Foo #` is not a
    // real Commons filename and the resolver picks a fresh number at
    // publish time. The cell editor's auto-sequence suggestion has its
    // own check on the *basename*, separate from this commit hook.
    if (next.title?.trim() && next.status?.startsWith('stash')
        && !isSequencePlaceholderTitle(next.title)) {
      const localIssue = validateTitleLocal(next.title);
      if (!localIssue || localIssue.severity !== 'error') {
        const future = buildFutureFilename(next.title, next.filename);
        if (future) {
          // Fire-and-forget; checkUniqueness handles its own dedupe + cache.
          checkUniqueness(future).then((result) => {
            // Re-render only if the verdict is one recomputeIssues cares
            // about (i.e. taken). Using a shallow clone of the item is
            // enough to invalidate the memo and trigger a recompute.
            if (result?.state === 'taken') {
              setItems((prev) => prev.map((i) => i.id === next.id ? { ...i } : i));
            }
          });
        }
      }
    }
  };

  // Upload-queue callbacks for <DropZone>.
  //
  // Drop semantics (T425873):
  //   - addUploadItems: render ALL N placeholders in one setState pass on drop,
  //     before any network round-trip, so a 10-file drop puts 10 rows in the
  //     table within the same frame.
  //   - updateUploadItem: the dropzone bumps `progress` and toggles
  //     `status: stash-selected → stash-uploading` as the serial uploader
  //     advances through the queue. This same call also handles upload errors.
  //   - replaceUploadItem: when an upload finalizes, the placeholder is
  //     swapped out for the real normalized item — but any user edits made
  //     while the row was uploading must follow it onto the new id.
  //
  // Two layers of preservation for in-flight edits:
  //   1) In-memory: copy the user-editable fields off the placeholder onto
  //      `real` (using pickDraftFields, which is the same field set onUpdate
  //      already persists). Without this, even with a saved draft, the next
  //      render would briefly show empty cells until the next bootstrap.
  //   2) Persistent: rekey any saved draft from the placeholder's `pending-…`
  //      id onto the new sha1 (or filekey if sha1 isn't yet known). Drafts
  //      saved on a `pending-…` key would otherwise be orphaned on reload.
  //
  // Re-upload-of-hidden semantics (T425873 maintainer feedback): if the user
  // re-uploads bytes whose sha1 is in the soft-delete list, treat the upload
  // as an explicit "wake this back up" gesture — the file moves from the
  // hidden section back to the visible stash. This (combined with the
  // coalesce step in `items`) means a re-upload also restarts the 48h expiry
  // counter via the latest filekey winning, and refreshes file-derived
  // metadata (EXIF/dimensions) via the latest entry. User-edit fields in the
  // saved draft survive because the draft is keyed by sha1.
  // "Import IIIF manifest" wizard (design Phase 2) — feeds the same
  // add/update/replace callbacks as the drag-drop uploader below.
  const [iiifImportOpen, setIiifImportOpen] = React.useState(false);
  // A manifest .json dropped onto the app opens the wizard pre-loaded.
  const [pendingManifestFile, setPendingManifestFile] = React.useState(null);
  const openManifestFile = (file) => { setPendingManifestFile(file); setIiifImportOpen(true); };

  // "Clear stash" confirmation. There is no MediaWiki API to delete stash
  // entries server-side (verified against the Commons action list), so
  // "clear" means: bulk-discard every visible stash row (the existing
  // undoable soft-delete) and point power users at Special:UploadStash for
  // the true server-side wipe. Bytes auto-expire within 48 h regardless.
  const [clearStashOpen, setClearStashOpen] = React.useState(false);

  const addUploadItems = (newItems) =>
    setItems((prev) => [...newItems, ...prev]);
  const updateUploadItem = (id, partial) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...partial } : i)));
  const replaceUploadItem = (oldId, real) => {
    setItems((prev) =>
      prev.map((i) => {
        if (i.id !== oldId) return i;
        // Merge any edits the user made on the placeholder onto the real
        // item. pickDraftFields returns only fields the user can edit; system
        // fields on `real` (sha1, filekey, dimensions, EXIF, thumb urls)
        // always win over the placeholder.
        const userEdits = pickDraftFields(i);
        const merged = { ...real };
        for (const k of Object.keys(userEdits)) {
          const v = userEdits[k];
          if (v == null) continue;
          if (Array.isArray(v) && v.length === 0) continue;
          if (typeof v === 'string' && v === '') continue;
          merged[k] = v;
        }
        return merged;
      }),
    );
    // Persist: re-key any saved draft from the placeholder id onto the new
    // canonical key (sha1 preferred, filekey as fallback). The next reload
    // will then merge the draft onto the same row instead of orphaning it.
    const newKey = real?.sha1 || real?.filekey || real?.id;
    if (newKey && newKey !== oldId) rekeyDraft(oldId, newKey);

    // If the freshly-uploaded sha1 was previously hidden (soft-deleted), wake
    // it back up. The user's gesture of re-uploading the same bytes is read
    // as "I want this back" — same intent as clicking Restore in the hidden
    // list. Both the wiki-persisted set and the local React-state set need to
    // forget this sha1 so the row appears in the visible stash immediately.
    if (real?.sha1 && hiddenSha1s.has(real.sha1)) {
      unhideSha1(real.sha1);
      setHiddenSha1s((s) => {
        const next = new Set(s);
        next.delete(real.sha1);
        return next;
      });
    }
  };

  // Auto-sequence cross-stash collision lookup (T425984). Given the row
  // being edited (identified by `excludeItemId`) and the future filename
  // it would publish to, return the count of OTHER visible stash rows
  // that resolve to the same future filename. The TitleEditor uses this to
  // decide whether to surface the cross-stash collision suggestion.
  //
  // We compare against the same `buildFutureFilename` form the editor
  // uses, so the trigger fires for "title plus extension" collisions that
  // match what Commons would actually see at publish.
  //
  // Sequence-placeholder rows are intentionally excluded from the count —
  // they're already destined for the resolver, so they don't constitute a
  // collision the user needs to resolve. Hidden / soft-deleted rows are
  // excluded too: they aren't going to publish, so they don't collide.
  const getSiblingFutureCollisions = React.useCallback((excludeItemId, future) => {
    if (!future) return [];
    let out = [];
    for (const it of stashItems) {
      if (it.id === excludeItemId) continue;
      const itTitle = (it.title || '').trim();
      if (!itTitle) continue;
      if (isSequencePlaceholderTitle(itTitle)) continue;
      const itFuture = buildFutureFilename(itTitle, it.filename);
      if (itFuture === future) out.push(it);
    }
    return out;
  }, [stashItems]);

  // Auto-sequence accept handler (T425984). The user is editing a row whose
  // title would collide with one or more other titles (other stash rows
  // sharing the same future filename, or a Commons file the user previously
  // published themselves). Accepting the suggestion rewrites every stash
  // row whose `(title, ext)` matches the basename to `<basename> #`. The
  // literal ` #` placeholder lives in the cell until publish, when the
  // sequence resolver substitutes consecutive integers.
  //
  // We rewrite ALL matching rows in one setItems pass, persist each via
  // setDraft (so the rewrites survive a reload before the user-store
  // debounce fires), and return the count so the caller can show a brief
  // "rewrote N rows" status.
  //
  // Already-placeholder rows are left alone (they're already in the right
  // form). Non-stash rows are skipped entirely.
  const onAcceptSequenceSuggestion = React.useCallback((basename, ext) => {
    if (!basename) return 0;
    const placeholderTitle = buildSequencePlaceholderTitle(basename);
    let rewriteCount = 0;
    setItems((prev) => prev.map((it) => {
      if (!it.status?.startsWith('stash')) return it;
      const itTitle = (it.title || '').trim();
      if (!itTitle) return it;
      if (itTitle === placeholderTitle) return it; // already a placeholder
      // Match by future filename — same comparison the cross-stash collision
      // detector uses, so a row that triggered the suggestion gets rewritten.
      const itFuture = buildFutureFilename(itTitle, it.filename);
      const targetFuture = `${basename}${ext || ''}`;
      if (itFuture !== targetFuture) return it;
      rewriteCount += 1;
      const nextRow = { ...it, title: placeholderTitle };
      // Persist immediately so a reload before the wiki-side debounce fires
      // doesn't lose the rewrite. draftKey + pickDraftFields are the same
      // pair onUpdate already uses for single-row commits.
      const key = draftKey(nextRow);
      if (key) setDraft(key, pickDraftFields(nextRow));
      return nextRow;
    }));
    return rewriteCount;
  }, []);

  // Apply current clipboard value to a cell, returning the next item the cell should hold.
  // Categories: append (don't replace). Title/description: append auto-incrementing number.
  // (Issues are auto-recomputed by onUpdate.)
  const pasteIntoItem = (item, targetField) => {
    if (!clipboard || clipboard.field !== targetField) return null;
    const v = clipboard.value;
    if (targetField === "categories") {
      const existing = item.categories || [];
      if (existing.includes(v)) return null;
      // T425950: paste must respect the no-create rule. The source chip
      // (the one the user "copied") was either a known existing category
      // (fine to propagate) or a leftover red chip from a draft made
      // before this rule existed (don't propagate — that just spreads
      // the same bad value to more rows). Allow the paste when the
      // value is in the merged pool; otherwise drop it on the floor.
      // The async per-row check in app.jsx still catches the rare
      // out-of-pool-but-real case (the chip will land red briefly but
      // then turn green once the API confirms — same as the cell
      // editor's tryConfirmAndAdd path).
      if (window.isKnownCategory && !window.isKnownCategory(v)) return null;
      return { ...item, categories: [...existing, v] };
    }
    if (targetField === "depicts") {
      const existing = item.depicts || [];
      if (existing.some((d) => d.qid === v.qid)) return null;
      return { ...item, depicts: [...existing, v] };
    }
    // T426422: any caption column (English `description` or per-language
    // `description:<lang>`) gets the auto-incrementing-suffix paste behaviour
    // and routes through setCaptionValue so the right slot is updated.
    const captionLang = window.captionLangFromColKey ? window.captionLangFromColKey(targetField) : null;
    if (targetField === "title" || captionLang) {
      const n = clipboard.count + 1;
      setClipboard((c) => c ? { ...c, count: n } : c);
      const suffix = n === 1 ? "" : ` ${n}`;
      const next = v + suffix;
      if (captionLang && window.setCaptionValue) {
        return window.setCaptionValue(item, captionLang, next);
      }
      return { ...item, [targetField]: next };
    }
    // license, author: replace.
    return { ...item, [targetField]: v };
  };
  // Track which item is currently being published (drives the modal).
  const [publishingItemId, setPublishingItemId] = useState(null);
  const [bulkPublishItems, setBulkPublishItems] = useState(null); // array or null
  const [infoOpen, setInfoOpen] = useState(false);
  // CC0 acknowledgment modal (T426455). Decision is made at mount time only:
  // a fresh acknowledgment shouldn't make the modal flicker back open if a
  // pref refresh races with another effect, and a "remind me next session"
  // ack should NOT close the dialog and re-show in the same session.
  // Initial value is read once from the (already-loaded) Preferences.json.
  // DEMO_MODE skips the modal entirely — there's no wiki write to consent to.
  const [cc0ModalOpen, setCc0ModalOpen] = useState(() => {
    if (DEMO_MODE) return false;
    return shouldShowCc0Modal(getPref('cc0Acknowledgment'));
  });
  // Wikitext preview modal: { item } or null. Read-only inspection of the
  // assembled wikitext for any single row.
  const [wikitextPreviewItem, setWikitextPreviewItem] = useState(null);
  // Custom column definitions tracked in App so other surfaces (e.g. the
  // table-toolbar column menu) can react to additions/removals. Bubbled up
  // from <Table> via onCustomPropsChange.
  //
  // T426449 dropped the wikitext-template column type entirely; only the
  // Wikidata-property variant survives. Any stored `kind: 'template'`
  // entries are silently ignored at runtime (see getAllColumns()).
  const [customProps, setCustomProps] = useState(() => {
    const cs = window.loadColumnState ? window.loadColumnState() : null;
    return cs?.customProps || [];
  });
  const onPublish = (item) => {
    // Guard: a placeholder row that's still uploading has no filekey yet, so
    // publish would 400. The button is hidden in that state, but a keyboard
    // shortcut or a stray click could still get here — bail quietly.
    if (!item?.filekey) return;
    setPublishingItemId(item.id);
  };
  const onBulkPublish = () => {
    const toPublish = [...selected]
      .map((id) => items.find((i) => i.id === id))
      // Stash items only, AND must have a filekey (rules out placeholders
      // for files still mid-upload — they're not publishable until the
      // upload finalizes and a filekey lands).
      .filter((i) => i?.status?.startsWith('stash') && i?.filekey);
    if (!toPublish.length) return;
    setBulkPublishItems(toPublish);
  };
  const onPublishComplete = (item /* originalItem from before publish */, result) => {
    // Move the item from stash to history locally so the user sees it land
    // in the history section without needing a refetch.
    cleanupAfterPublish(item);
    setItems((prev) => prev.map((i) =>
      i.id === item.id
        ? {
            ...i,
            status: 'published',
            publishedAt: new Date().toISOString(),
            issues: [],
            descriptionurl: result.descriptionurl,
            filename: result.filename,
            id: result.filename, // history items key by filename
          }
        : i,
    ));
    setOpenId(null);
  };
  // Soft-delete: hide a stash file from view. The file stays in the real
  // Commons stash and auto-expires within ~48h. The hidden list is persisted
  // in the user-store so the dismiss roams across devices and survives
  // reload. We prefer sha1 (content-permanent) and fall back to filekey
  // when the row's sha1 isn't yet known.
  const onDelete = (item) => {
    if (item.sha1) {
      hideSha1(item.sha1);
      setHiddenSha1s((s) => new Set(s).add(item.sha1));
    } else if (item.filekey) {
      hideFilekey(item.filekey);
      setHiddenFilekeys((s) => new Set(s).add(item.filekey));
    } else {
      // No identifier (e.g. an in-flight upload that errored) — just drop locally.
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    }
    setOpenId(null);
  };

  // Last bulk-discard receipt — drives the post-action confirmation banner
  // so the user can see exactly which rows were just hidden (and undo it).
  // null when no recent action; { count, names, sha1s, filekeys, at } otherwise.
  const [lastDiscard, setLastDiscard] = useState(null);

  // Discard a set of stash items in one shot. Used by the bulk drawer
  // (current selection) and by the duplicate-banner one-click action
  // (all flagged duplicates, regardless of selection). Centralises the
  // sha1-vs-filekey hide split + state propagation so both callers stay
  // in sync. Pass `clearSel` = false when the action isn't selection-driven
  // (we don't want to wipe the user's unrelated selection).
  //
  // Robust by design: every target with a sha1 is hidden by sha1 (canonical,
  // content-permanent), AND if it also has a filekey we hide by filekey too
  // — defence-in-depth so a future code path that only consults one set still
  // recognises the hide. Idempotent: hideSha1s/hideFilekeys dedupe internally.
  const discardItems = (targets, { clearSel = true } = {}) => {
    if (!targets?.length) return null;
    const stashOnly = targets.filter((i) => i?.status?.startsWith('stash'));
    if (!stashOnly.length) return null;

    // Defensive double-key: hide by sha1 when known (canonical), AND by filekey
    // when known (defensive belt-and-braces). Filekey-only hides remain a
    // fallback for rows whose sha1 hasn't backfilled yet.
    const sha1sToHide = [...new Set(stashOnly.filter((i) => i.sha1).map((i) => i.sha1))];
    const filekeysToHide = [...new Set(stashOnly.filter((i) => i.filekey).map((i) => i.filekey))];

    if (sha1sToHide.length) {
      hideSha1s(sha1sToHide);
      setHiddenSha1s((s) => {
        const next = new Set(s);
        for (const k of sha1sToHide) next.add(k);
        return next;
      });
    }
    if (filekeysToHide.length) {
      hideFilekeys(filekeysToHide);
      setHiddenFilekeys((s) => {
        const next = new Set(s);
        for (const k of filekeysToHide) next.add(k);
        return next;
      });
    }
    if (clearSel) clearSelection();

    // Receipt: capture exactly which rows we just hid so the post-action
    // banner can show "Discarded N: foo.jpg, bar.png …" + an Undo button.
    // Filenames first so the user can verify nothing unexpected was touched.
    const receipt = {
      count: stashOnly.length,
      names: stashOnly.map((i) => i.title || i.filename || i.filekey || '(unnamed)'),
      sha1s: sha1sToHide,
      filekeys: filekeysToHide,
      at: Date.now(),
    };
    setLastDiscard(receipt);
    console.info('[discard]', receipt);
    return receipt;
  };

  const onBulkDiscard = () => {
    const targets = [...selected]
      .map((id) => items.find((i) => i.id === id))
      .filter((i) => i?.status?.startsWith('stash'));
    discardItems(targets);
  };

  // One-click "Discard N duplicates" — selects every flagged duplicate
  // (cross-Commons hit OR same-bytes-as-another-stash-row) and discards
  // them atomically. Independent of the user's current selection so it
  // works no matter what they're actively editing.
  //
  // Scope: ALL detected duplicates, not just those visible under the current
  // filter — the user's mental model is "remove the duplicates from this
  // batch", and a row hidden by a "Needs attention" / search filter is still
  // logically part of that batch. The banner surfaces a "(N hidden by current
  // filter)" hint when those two counts diverge so this isn't a surprise.
  //
  // Re-snapshot duplicates at click time rather than relying on the closed-over
  // memo. Defensive against any race where existsOnCommons would flip true
  // between render and click (e.g. background sha1 backfill arriving).
  const onBulkDiscardDuplicates = () => {
    // Mirror the duplicateStashItems logic — but recomputed against the
    // freshest items + hidden state, so a duplicate that was added or had
    // its sha1 backfilled milliseconds before the click is still picked up.
    const freshDupes = stashItemsAll.filter(
      (i) => !isItemHidden(i) && i.existsOnCommons,
    );
    discardItems(freshDupes, { clearSel: false });
  };

  // Restore the rows from the most-recent discard. Reverses the receipt's
  // sha1 + filekey hides — only those, so any UNRELATED hides the user did
  // before/after stay put. Called by the post-action banner's Undo button.
  const undoLastDiscard = () => {
    if (!lastDiscard) return;
    const { sha1s, filekeys } = lastDiscard;
    if (sha1s?.length) {
      for (const s of sha1s) unhideSha1(s);
      setHiddenSha1s((set) => {
        const next = new Set(set);
        for (const s of sha1s) next.delete(s);
        return next;
      });
    }
    if (filekeys?.length) {
      for (const k of filekeys) unhideFilekey(k);
      setHiddenFilekeys((set) => {
        const next = new Set(set);
        for (const k of filekeys) next.delete(k);
        return next;
      });
    }
    setLastDiscard(null);
  };

  // Auto-clear the post-action banner after ~10s so it doesn't linger forever.
  useEffect(() => {
    if (!lastDiscard) return;
    const t = setTimeout(() => {
      setLastDiscard((cur) => (cur && cur.at === lastDiscard.at ? null : cur));
    }, 10000);
    return () => clearTimeout(t);
  }, [lastDiscard]);

  // Restore one hidden row. Take the whole item so we can clear both
  // sha1 and (legacy) filekey hide entries — whichever was the source.
  const onUnhide = (item) => {
    if (item.sha1) {
      unhideSha1(item.sha1);
      setHiddenSha1s((s) => {
        const next = new Set(s);
        next.delete(item.sha1);
        return next;
      });
    }
    if (item.filekey) {
      unhideFilekey(item.filekey);
      setHiddenFilekeys((s) => {
        const next = new Set(s);
        next.delete(item.filekey);
        return next;
      });
    }
  };

  const onUnhideAll = () => {
    unhideAllSha1s(); // clears both lists in the store
    setHiddenSha1s(new Set());
    setHiddenFilekeys(new Set());
  };

  const openItem = useMemo(
    () => items.find((i) => i.id === openId) || null,
    [items, openId],
  );

  return (
    <div className="app" data-density={tweaks.density}>
      {/* Top bar */}
      <header className="topbar">
        <div className="topbar__brand">
          <img className="topbar__logo" src="/app-logo.png" alt="" width="28" height="28" />
          IIIF Manifest Upload Workbench
          {/* Static version label — just this build's number (the old
              clickable releases/PRs dropdown and the Beta pill were dropped
              2026-07-11; the About modal links to the full changelog). */}
          <span className="version-chip version-chip--static" title="This build's version">
            v{__APP_VERSION__}
          </span>
        </div>
        <div className="topbar__spacer" />
        <button
          type="button"
          className="btn btn--quiet"
          title="About Upload Workbench — version, links, changelog"
          onClick={() => setInfoOpen(true)}
        >
          About
        </button>
        <SaveStatus />
        <UserMenu user={user} onLogout={onLogout} />
      </header>

      {/* Toolbar */}
      <div className="toolbar">
        {/* Primary action leads the toolbar (moved here from the topbar);
            search + view controls cluster on the right. */}
        <button className="btn btn--progressive" onClick={() => setIiifImportOpen(true)} title="Import all pages of a IIIF manifest into your stash">
          <Icon name="upload" size={16} /> Import IIIF manifest
        </button>

        <div className="toolbar__spacer" style={{ flex: 1 }} />

        <div className="search">
          <span className="search__icon"><Icon name="search" size={16} /></span>
          <input
            className="search__input"
            placeholder="Search your files…"
            value={query}
            onChange={(e) => setQuery(e.target.value)} />

        </div>

        <div className="toolbar__group">
          <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)} title="Filter">
            <option value="all">All files</option>
            <option value="needs-attention">
              Needs attention{needsAttn ? ` (${needsAttn})` : ""}
            </option>
            <option value="complete">Ready to publish</option>
          </select>
        </div>

        {view === "grid" && (
          <div className="seg" role="group" aria-label="Grid tile size">
            <button
              className="seg__btn"
              onClick={() => stepGridSize(-1)}
              disabled={gridSizeIndex <= 0}
              aria-label="Smaller tiles"
              title="Smaller tiles">
              <Icon name="minus" size={14} />
            </button>
            <button
              className="seg__btn"
              onClick={() => stepGridSize(1)}
              disabled={gridSizeIndex >= GRID_SIZES.length - 1}
              aria-label="Larger tiles"
              title="Larger tiles">
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}

        {/* Piling mode entry point (T425840). Fullscreen lighttable that
            shares group state with the (in-progress) table-view groups. */}
        <button
          type="button"
          className="btn"
          onClick={() => setPilingOpen(true)}
          title="Open visual piling mode — drag photos together to group them"
        >
          <Icon name="folder" size={14} /> Piling mode{groups.length ? ` (${groups.length})` : ''}
        </button>

        {/* All / Groups toggle — spreadsheet-only. Hidden in Grid view since
            groups are a row-table concept. (T425839) */}
        {view === "list" && (
          <div className="seg" role="group" aria-label="Group mode" title="Toggle between flat and grouped layouts">
            <button
              className="seg__btn"
              aria-pressed={tableMode === "all"}
              onClick={() => setTableMode("all")}
              title="Show every row in one table"
            >
              All
            </button>
            <button
              className="seg__btn"
              aria-pressed={tableMode === "groups"}
              onClick={() => setTableMode("groups")}
              title={
                groups.length
                  ? `Show ${groups.length} group${groups.length === 1 ? '' : 's'} as stacked mini-tables`
                  : "Stack rows into mini-tables once you create groups"
              }
            >
              Groups{groups.length ? ` (${groups.length})` : ''}
            </button>
          </div>
        )}

        <div className="seg" role="group" aria-label="View">
          <button className="seg__btn" aria-pressed={view === "grid"} onClick={() => setView("grid")} title="Grid">
            <Icon name="grid" size={14} /> Grid
          </button>
          <button className="seg__btn" aria-pressed={view === "list"} onClick={() => setView("list")} title="List">
            <Icon name="list" size={14} /> List
          </button>
        </div>
      </div>

      {/* Content */}
      <div className={"content" + (openItem ? "" : " content--no-side")}>
        <main className="content__main">

          {/* Section 1 — Upload stash */}
          <section className="stream">
            <div className="section-head section-head--inline">
              <h1 className="section-head__title section-head__title--limbo">
                Upload stash
              </h1>
              <span className="section-head__right">
                <span className="section-head__sub">
                  {filteredStash.length} of {stashItems.length} · in limbo
                  {stashItems.length > 0 && (() => {
                    const now = Date.now();
                    const minMs = stashItems.reduce((min, i) => {
                      if (!i.expiresAt) return min;
                      const ms = new Date(i.expiresAt) - now;
                      return ms < min ? ms : min;
                    }, Infinity);
                    if (minMs === Infinity || minMs <= 0) return null;
                    const hrs = Math.floor(minMs / (1000 * 60 * 60));
                    const mins = Math.floor(minMs % (1000 * 60 * 60) / (1000 * 60));
                    const label = hrs > 0 ? `${hrs}h` : `${mins}m`;
                    return <span className="section-head__expiry" title="Least time remaining before earliest file expires"> · expires in {label}</span>;
                  })()}
                </span>
                {stashItems.length > 0 && (
                  <button
                    className="btn btn--quiet section-head__clear"
                    onClick={() => setClearStashOpen(true)}
                    title="Clear the stash: via Special:UploadStash (server-side) or by hiding all rows here"
                  >
                    Clear entire stash
                  </button>
                )}
              </span>
            </div>

            {loadErrors?.stash && (
              <div className="load-error" role="alert">
                <Icon name="warn" size={14} /> Couldn't load stash: {loadErrors.stash}
              </div>
            )}

            {duplicateStashItems.length > 0 && (
              <div className="dup-banner" role="status">
                <Icon name="warn" size={14} />
                <span className="dup-banner__text">
                  <strong>
                    {duplicateStashItems.length} duplicate
                    {duplicateStashItems.length === 1 ? '' : 's'}
                  </strong>{' '}
                  detected — same bytes already on Commons or twinned in this stash.
                  {duplicateStashItemsVisible.length < duplicateStashItems.length && (
                    <span className="dup-banner__hint">
                      {' '}({duplicateStashItemsVisible.length} visible,{' '}
                      {duplicateStashItems.length - duplicateStashItemsVisible.length}{' '}
                      hidden by current filter — all will be discarded.)
                    </span>
                  )}
                </span>
                <span className="dup-banner__spacer" />
                <button
                  type="button"
                  className="btn btn--destructive btn--small"
                  onClick={onBulkDiscardDuplicates}
                  title="Hide every flagged duplicate from the workbench in one click. Stash entries auto-expire from Commons within 48h. Restorable from the hidden list."
                >
                  <Icon name="trash" size={12} /> Discard {duplicateStashItems.length} duplicate
                  {duplicateStashItems.length === 1 ? '' : 's'}
                </button>
              </div>
            )}

            {/* Post-discard confirmation: shows exactly which rows were just
                hidden, with an Undo button. Auto-clears after ~10s. Surfaces
                when the user can't immediately tell what changed (rows just
                disappear from view) — important for trust after the maintainer
                reported uncertainty about which rows the bulk action affected. */}
            {lastDiscard && (
              <div className="discard-receipt" role="status" aria-live="polite">
                <Icon name="check" size={14} />
                <span className="discard-receipt__text">
                  Discarded <strong>{lastDiscard.count}</strong>{' '}
                  {lastDiscard.count === 1 ? 'file' : 'files'}
                  {lastDiscard.names.length > 0 && (
                    <span
                      className="discard-receipt__names"
                      title={lastDiscard.names.join('\n')}
                    >
                      {': '}
                      {lastDiscard.names.slice(0, 3).join(', ')}
                      {lastDiscard.names.length > 3 && (
                        <> +{lastDiscard.names.length - 3} more</>
                      )}
                    </span>
                  )}
                  . They stay in the real Commons stash and auto-expire within ~48h.
                </span>
                <span className="discard-receipt__spacer" />
                <button
                  type="button"
                  className="btn btn--quiet btn--small"
                  onClick={undoLastDiscard}
                  title="Restore the rows just discarded"
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="btn btn--quiet btn--small"
                  onClick={() => setLastDiscard(null)}
                  title="Dismiss this message"
                  aria-label="Dismiss"
                >
                  ×
                </button>
              </div>
            )}

            {filteredStash.length === 0 ?
            // Truly-empty stash → big hero CTA (T426377). Filtered-empty
            // (stash has files but the search/filter hides them all) keeps
            // the small inline hint — different message, different intent.
            stashItems.length === 0 ?
            <EmptyHero onImportIiif={() => setIiifImportOpen(true)} /> :
            <EmptyRow
              icon="folder"
              text="No stashed files match your filters." /> :

            view === "grid" ?
            <GridView
              items={filteredStash}
              cardSize={gridCardPx}
              selected={selected}
              onToggleSelect={toggleSelect}
              onOpen={setOpenId}
              showFilenames={tweaks.showFilenames}
              findDuplicate={findDuplicate} /> :

            tableMode === "groups" ?
            <StackedGroupsView
              groups={groups}
              buckets={stashGroupBuckets}
              tableProps={{
                selected,
                onToggleSelect: toggleSelect,
                onSetSelection: setSelectionFor,
                onUpdate,
                onOpen: setOpenId,
                onOpenLightbox: setLightboxId,
                showThumbs: tweaks.showThumbsInList,
                clipboard,
                onCopy: setClipboard,
                onPaste: pasteIntoItem,
                onClearClipboard: () => setClipboard(null),
                titleVocab,
                requiredFields,
                setRequiredFields,
                columnDefaults,
                setColumnDefaults,
                items_all: items,
                colState: columnState,
                setColState: setColumnState,
                selfUsername: user?.username,
                // Auto-sequence (T425984) needs to work in Groups view too —
                // collisions are global across all stash items, so the
                // suggestion can fire from any mini-table cell editor.
                getSiblingFutureCollisions,
                onAcceptSequenceSuggestion,
              }}
              onUngroupAll={ungroupAll}
              onReorderGroups={reorderGroups}
              onRemoveItemFromGroup={removeItemFromGroup}
              onRenameGroup={renameGroup}
            /> :

            <Table
              items={filteredStash}
              selected={selected}
              onToggleSelect={toggleSelect}
              onSetSelection={setSelectionFor}
              onUpdate={onUpdate}
              onOpen={setOpenId}
              onOpenLightbox={setLightboxId}
              showThumbs={tweaks.showThumbsInList}
              clipboard={clipboard}
              onCopy={setClipboard}
              onPaste={pasteIntoItem}
              onClearClipboard={() => setClipboard(null)}
              titleVocab={titleVocab}
              requiredFields={requiredFields}
              setRequiredFields={setRequiredFields}
              columnDefaults={columnDefaults}
              setColumnDefaults={setColumnDefaults}
              selfUsername={user?.username}
              getSiblingFutureCollisions={getSiblingFutureCollisions}
              onAcceptSequenceSuggestion={onAcceptSequenceSuggestion}
              wikitextTemplate={wikitextTemplate}
              setWikitextTemplate={setWikitextTemplate}
              items_all={items}
              onCustomPropsChange={setCustomProps}
              onPreviewWikitext={(it) => setWikitextPreviewItem(it)}
              colState={columnState}
              setColState={setColumnState} />

            }

            {/* Hidden ("soft-deleted") stash files — own block below the
                visible files. Header sits above the body so toggling expand/
                collapse never moves the toggle target itself. Only renders
                when there's something to hide. (T425883) */}
            {hiddenItems.length > 0 && (
              <HiddenStashSection
                items={hiddenItems}
                expanded={showHidden}
                onToggle={() => setShowHidden((v) => !v)}
                onUnhide={onUnhide}
                onUnhideAll={onUnhideAll}
                onOpen={setOpenId}
                onOpenLightbox={setLightboxId}
                findDuplicate={findDuplicate}
              />
            )}
          </section>

          {/* Section 2 — Upload history (collapsible, collapsed by default) */}
          <section className={"stream" + (histCollapsed ? " stream--collapsed" : "")}>
            <div
              className="section-head section-head--clickable"
              onClick={() => setHistCollapsed((c) => !c)}
              role="button"
              aria-expanded={!histCollapsed}>
              
              <span className={"section-head__chevron" + (histCollapsed ? "" : " section-head__chevron--open")}>
                <Icon name="chevron-down" size={14} />
              </span>
              {/* Demoted from <h1>/large to <h2>/small (T426377). The active
                  stash is the workspace; history is a secondary, collapsed-
                  by-default reference and shouldn't visually compete. */}
              <h2 className="section-head__title section-head__title--small">
                <Icon name="clock" size={14} /> Upload history
              </h2>
              <span className="section-head__sub">
                {filteredHist.length} of {histItems.length} published
                {historySyncedAt && (
                  <>
                    {" · synced "}
                    {/* Explicit DD-MM-YYYY HH:MM — "today"-style relative
                        stamps were too coarse to judge staleness. */}
                    <span title={new Date(historySyncedAt).toLocaleString()}>
                      {(() => {
                        const d = new Date(historySyncedAt);
                        const p = (n) => String(n).padStart(2, '0');
                        return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
                      })()}
                    </span>
                  </>
                )}
                {" · "}
                <button
                  className="section-head__hidden-toggle"
                  onClick={(e) => { e.stopPropagation(); refreshHistory(); }}
                  disabled={historyRefreshing}
                  title="Re-fetch history from Commons"
                >
                  {historyRefreshing ? 'refreshing…' : 'refresh'}
                </button>
              </span>
            </div>

            {!histCollapsed && loadErrors?.history && (
              <div className="load-error" role="alert">
                <Icon name="warn" size={14} /> Couldn't load history: {loadErrors.history}
              </div>
            )}

            {!histCollapsed && (filteredHist.length === 0 ?
            <EmptyRow
              icon="image"
              text={histItems.length === 0 ?
              "Nothing published yet." :
              "No published files match your filters."} /> :

            view === "grid" ?
            <GridView
              items={filteredHist}
              cardSize={gridCardPx}
              selected={selected}
              onToggleSelect={toggleSelect}
              onOpen={setOpenId}
              showFilenames={tweaks.showFilenames}
              findDuplicate={findDuplicate} /> :


            <Table
              items={filteredHist}
              selected={selected}
              onToggleSelect={toggleSelect}
              onSetSelection={setSelectionFor}
              onUpdate={onUpdate}
              onOpen={setOpenId}
              onOpenLightbox={setLightboxId}
              showThumbs={tweaks.showThumbsInList}
              clipboard={clipboard}
              onCopy={setClipboard}
              onPaste={pasteIntoItem}
              onClearClipboard={() => setClipboard(null)}
              titleVocab={titleVocab}
              requiredFields={requiredFields}
              setRequiredFields={setRequiredFields}
              columnDefaults={columnDefaults}
              setColumnDefaults={setColumnDefaults}
              selfUsername={user?.username}
              wikitextTemplate={wikitextTemplate}
              setWikitextTemplate={setWikitextTemplate}
              items_all={items}
              onCustomPropsChange={setCustomProps}
              onPreviewWikitext={(it) => setWikitextPreviewItem(it)}
              colState={columnState}
              setColState={setColumnState} />)

            }

            {!histCollapsed && histItems.length > 0 && (
              <div className="load-more">
                <button
                  className="btn btn--quiet"
                  onClick={loadMoreHistory}
                  disabled={historyLoadMore}
                >
                  {historyLoadMore ? 'Loading…' : 'Load more (+50)'}
                </button>
              </div>
            )}
          </section>
        </main>

        {openItem &&
        <aside className="content__side">
            <DetailPanel
            item={openItem}
            onClose={() => setOpenId(null)}
            onUpdate={onUpdate}
            onPublish={onPublish}
            onDelete={onDelete}
            onRefresh={refreshOneItem}
            onPreviewWikitext={(it) => setWikitextPreviewItem(it)}
            isRefreshing={refreshingItemId === openItem.id}
            duplicateOfPublished={findDuplicate(openItem)}
            fieldOrder={fieldOrder}
            requiredFields={requiredFields}
            setRequiredFields={setRequiredFields}
            groupId={groupOfItem.get(openItem.id) || null}
            onRemoveFromGroup={removeItemFromGroup} />

          </aside>
        }
      </div>

      {/* Paste-mode banner */}
      {clipboard &&
      <div className="paste-banner" role="status">
          <span className="paste-banner__icon"><Icon name="copy" size={14} /></span>
          <span className="paste-banner__text">
            Pasting <strong>{labelForField(clipboard.field)}</strong>
            {" : "}
            <span className="paste-banner__value">{previewValue(clipboard.value, clipboard.field)}</span>
            {" — click target cells to apply"}
            {(clipboard.field === "title" || (typeof clipboard.field === "string" && clipboard.field.startsWith("description"))) && clipboard.count > 0 &&
          <span className="paste-banner__hint"> · next: “{clipboard.value} {clipboard.count + 1}”</span>
          }
          </span>
          <span className="paste-banner__spacer" />
          <kbd className="paste-banner__kbd">Esc</kbd>
          <button className="btn btn--quiet btn--small" onClick={() => setClipboard(null)}>
            <Icon name="close" size={12} /> Cancel
          </button>
        </div>
      }

      {/* Bulk drawer */}
      {selected.size > 0 &&
      <div className="drawer">
          <button className="btn btn--quiet btn--icon-only" onClick={clearSelection}><Icon name="close" /></button>
          <span className="drawer__count">{selected.size} selected</span>
          <span className="drawer__sep" />
          <button className="btn btn--progressive" onClick={onBulkPublish}><Icon name="publish" size={14} /> Publish</button>
          <button className="btn btn--destructive" onClick={onBulkDiscard}><Icon name="trash" size={14} /> Discard</button>
          {/* Group selection — bundles the chosen rows into a new manual
              group, switches to Groups view to show the result. (T425839) */}
          <button
            className="btn"
            onClick={groupSelection}
            title="Bundle selected rows into a new group (switches to Groups view). Files already in another group are moved to the new one."
          >
            <Icon name="folder" size={14} /> Group selection
          </button>
          {/* Ungroup selection — paired action: removes the chosen rows
              from whichever group they sit in. Disabled when no selected
              row is currently grouped, so the button is only actionable
              when it would actually do something. (T425839) */}
          <button
            className="btn"
            onClick={ungroupSelection}
            disabled={!selectionHasGrouped}
            title={
              selectionHasGrouped
                ? 'Remove the selected rows from their group; files stay in the workbench'
                : 'None of the selected rows are in a group'
            }
          >
            <Icon name="folder" size={14} /> Ungroup selection
          </button>
          <span className="drawer__hint">Discard hides files from the workbench; they auto-expire from your stash within 48h</span>
          <div className="drawer__spacer" />
        </div>
      }

      {/* Lightbox */}
      {lightboxId &&
      <Lightbox
        item={items.find((i) => i.id === lightboxId)}
        onClose={() => setLightboxId(null)}
        onOpenDetails={() => {setOpenId(lightboxId);setLightboxId(null);}} />

      }

      {/* Drag-drop overlay + hidden file picker (window-level listener) */}
      <DropZone
        onAddItems={addUploadItems}
        onUpdateItem={updateUploadItem}
        onReplaceItem={replaceUploadItem}
        onManifestFile={openManifestFile} />

      {/* IIIF manifest import wizard */}
      {iiifImportOpen && (
        <IiifImportModal
          onClose={() => { setIiifImportOpen(false); setPendingManifestFile(null); }}
          initialFile={pendingManifestFile}
          onAddItems={addUploadItems}
          onUpdateItem={updateUploadItem}
          onReplaceItem={replaceUploadItem}
          onEnsureArtworkTemplate={() => setWikitextTemplate((prev) => (prev?.id === 'Artwork' ? prev : { id: 'Artwork' }))}
        />
      )}

      {/* Clear-stash confirmation */}
      {clearStashOpen && (
        <div className="modal-backdrop" onClick={() => setClearStashOpen(false)}>
          <div className="modal clear-stash-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <header className="modal__head">
              <div>
                <h2 className="modal__title">Clear your upload stash?</h2>
                <p className="modal__sub">{stashItems.length} file{stashItems.length === 1 ? '' : 's'} will be hidden from the workbench.</p>
              </div>
            </header>
            <div className="modal__body">
              <p>
                The real stash lives on Wikimedia Commons. To delete all {stashItems.length} files
                from the server <strong>right now</strong>, open <strong>Special:UploadStash</strong> and
                click <em>“Clear list”</em> there (you must be logged in to Commons in that browser tab —
                MediaWiki offers no API for this, so the app can&apos;t do it for you). Afterwards, reload
                the workbench and the rows disappear.
              </p>
              <p className="clear-stash-modal__hint">
                Alternatively, <em>hide</em> all rows here in the workbench (undoable) and let the files
                auto-expire server-side within <strong>48 hours</strong> — nobody but you can see them
                there anyway.
              </p>
            </div>
            <footer className="modal__foot">
              <div className="clear-stash-modal__actions">
                <a
                  className="btn btn--progressive"
                  href="https://commons.wikimedia.org/wiki/Special:UploadStash"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setClearStashOpen(false)}
                >
                  Open Special:UploadStash ↗
                </a>
                <button
                  className="btn btn--destructive"
                  onClick={() => {
                    discardItems(stashItems);
                    // Rows without sha1/filekey (e.g. failed imports) can't be
                    // hidden by key — drop them from local state directly.
                    setItems((prev) => prev.filter((i) => !(i.status?.startsWith('stash') && !i.sha1 && !i.filekey)));
                    setClearStashOpen(false);
                  }}
                >
                  Hide all {stashItems.length} here
                </button>
              </div>
              <button className="btn" onClick={() => setClearStashOpen(false)}>Cancel</button>
            </footer>
          </div>
        </div>
      )}

      {/* Publish modal */}
      {publishingItemId && (
        <PublishModal
          item={items.find((i) => i.id === publishingItemId)}
          templateConfig={wikitextTemplate}
          onClose={() => setPublishingItemId(null)}
          onPublished={onPublishComplete}
          selfUsername={user?.username}
        />
      )}

      {/* Bulk publish modal */}
      {bulkPublishItems && (
        <BulkPublishModal
          items={bulkPublishItems}
          templateConfig={wikitextTemplate}
          onClose={() => { setBulkPublishItems(null); clearSelection(); }}
          onItemPublished={onPublishComplete}
          selfUsername={user?.username}
        />
      )}

      {/* Per-row wikitext preview (read-only) */}
      {wikitextPreviewItem && (
        <WikitextPreviewModal
          item={wikitextPreviewItem}
          templateConfig={wikitextTemplate}
          onClose={() => setWikitextPreviewItem(null)}
        />
      )}

      {/* Info / version-switcher modal */}
      {infoOpen && <InfoModal onClose={() => setInfoOpen(false)} />}

      {/* CC0 acknowledgment — first-paint consent that workbench drafts/prefs
          are saved to public Commons user-subpages dedicated CC0. (T426455) */}
      {cc0ModalOpen && (
        <Cc0Modal
          username={user?.username}
          onAcknowledge={({ suppressFurther }) => {
            setPref('cc0Acknowledgment', {
              acknowledgedAt: new Date().toISOString(),
              suppressFurther: !!suppressFurther,
              version: CC0_ACK_VERSION,
            });
            setCc0ModalOpen(false);
          }}
          onDismiss={() => setCc0ModalOpen(false)}
        />
      )}

      {/* Visual piling mode — fullscreen lighttable (T425840) */}
      {pilingOpen && (
        <PilingMode
          items={stashItems}
          groups={groups}
          onUpdateGroups={updateGroups}
          onClose={() => setPilingOpen(false)}
        />
      )}

    </div>);

}

// ===== Stacked groups view (T425839) =====
//
// Renders one mini-table per manual photo group, plus an implicit
// "Ungrouped" mini-table at the bottom for everything else. All mini-
// tables share the same column visibility / order / widths (passed via
// `tableProps.colState` + `tableProps.setColState`); per-group sort
// falls out for free because each <Table> instance owns its own sortKey
// internally.
//
// Group reordering is HTML5 drag-and-drop on the group header (matches
// the existing dnd pattern in columns-modal.jsx). Ungrouped is rendered
// last and is NOT draggable.
function StackedGroupsView({
  groups,
  buckets,
  tableProps,
  onUngroupAll,
  onReorderGroups,
  onRemoveItemFromGroup,
  onRenameGroup,
}) {
  const [dragIdx, setDragIdx] = React.useState(null);
  const [dragOverIdx, setDragOverIdx] = React.useState(null);

  // Decide which mini-table shows the Columns toolbar. It needs to be
  // reachable somewhere — easiest is to put it on the first non-empty
  // group (or Ungrouped if all groups are empty / no groups exist). The
  // toolbar opens the same Columns modal Table renders today, and writes
  // land on the lifted column state shared across every mini-table.
  const firstNonEmptyGroupIdx = React.useMemo(() => {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const items = buckets.byGroup.get(g.id) || [];
      if (items.length > 0) return i;
    }
    return -1;
  }, [groups, buckets]);
  const ungroupedHasToolbar = firstNonEmptyGroupIdx === -1;

  const onDragStart = (idx) => (e) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
    // Some browsers refuse the drag without setData. Empty payload is fine —
    // we read source state from React, not the dataTransfer object.
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch (err) {}
  };
  const onDragOver = (idx) => (e) => {
    e.preventDefault();
    if (dragOverIdx !== idx) setDragOverIdx(idx);
  };
  const onDrop = (idx) => (e) => {
    e.preventDefault();
    if (dragIdx != null && dragIdx !== idx) onReorderGroups(dragIdx, idx);
    setDragIdx(null);
    setDragOverIdx(null);
  };
  const onDragEnd = () => {
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const ungrouped = buckets.ungrouped || [];

  if (groups.length === 0 && ungrouped.length === 0) {
    return (
      <EmptyRow
        icon="folder"
        text="No stashed files match your filters."
      />
    );
  }

  return (
    <div className="stacked-groups">
      {groups.length === 0 && (
        <div className="stacked-groups__hint" role="note">
          <Icon name="info" size={14} />
          <span>
            No groups yet. Select rows in the table below and click <strong>Group selection</strong> in
            the bulk action bar to create one.
          </span>
        </div>
      )}

      {groups.map((g, idx) => {
        const items = buckets.byGroup.get(g.id) || [];
        return (
          <div
            key={g.id}
            className={
              'group-block' +
              (dragOverIdx === idx && dragIdx !== idx ? ' group-block--drag-over' : '') +
              (dragIdx === idx ? ' group-block--dragging' : '')
            }
            onDragOver={onDragOver(idx)}
            onDrop={onDrop(idx)}
          >
            {items.length > 0 ? (
              <Table
                {...tableProps}
                items={items}
                hideToolbar={idx !== firstNonEmptyGroupIdx}
                groupHeader={
                  <GroupHeader
                    group={g}
                    total={groups.length}
                    count={items.length}
                    draggable
                    onDragStart={onDragStart(idx)}
                    onDragEnd={onDragEnd}
                    onUngroupAll={() => onUngroupAll(g.id)}
                    onRename={(name) => onRenameGroup(g.id, name)}
                    onRemoveItem={onRemoveItemFromGroup}
                    rows={items}
                  />
                }
              />
            ) : (
              // Every member of this group is hidden by the current search/
              // filter (truly-empty groups are auto-pruned by the effect in
              // App, so reaching this branch means the rows are still in the
              // workbench, just not in the filtered view). Surface the
              // header — so the user can still drag-reorder, rename, or
              // ungroup it — plus a hint that nudges them toward clearing
              // the filter to bring the group back. The .tbl-wrap mirrors
              // the sibling mini-tables' shell so the layout doesn't jolt.
              <div className="tbl-wrap">
                <GroupHeader
                  group={g}
                  total={groups.length}
                  count={0}
                  draggable
                  onDragStart={onDragStart(idx)}
                  onDragEnd={onDragEnd}
                  onUngroupAll={() => onUngroupAll(g.id)}
                  onRename={(name) => onRenameGroup(g.id, name)}
                  onRemoveItem={onRemoveItemFromGroup}
                  rows={items}
                />
                <div className="group-empty">
                  <Icon name="folder" size={14} />
                  <span>All rows in this group are hidden by your current filter. Clear the filter to see them.</span>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Ungrouped — implicit, always rendered last, never draggable. */}
      {ungrouped.length > 0 && (
        <div className="group-block group-block--ungrouped">
          <Table
            {...tableProps}
            items={ungrouped}
            hideToolbar={!ungroupedHasToolbar}
            groupHeader={
              <div className="group-header group-header--ungrouped">
                <span className="group-header__label">
                  <Icon name="folder" size={14} /> Ungrouped
                </span>
                <span className="group-header__count">{ungrouped.length} row{ungrouped.length === 1 ? '' : 's'}</span>
              </div>
            }
          />
        </div>
      )}
    </div>
  );
}

// Per-group strip rendered above each mini-table. Drag handle on the left,
// click-to-rename label in the middle, row count + Ungroup-all button on
// the right. The label uses the stable creation-order seq number ("Group
// 3"), not the group's current display position — so dragging groups
// around doesn't renumber them (T425839 feedback). Users can replace the
// default with a custom name; clearing the input restores the default.
//
// "Ungroup all" (rather than "Delete group") is deliberate naming: users
// reading "delete" worry the rows themselves are removed. The hover
// tooltip reinforces that files stay put — only the grouping is dropped.
function GroupHeader({
  group,
  count,
  draggable,
  onDragStart,
  onDragEnd,
  onUngroupAll,
  onRename,
}) {
  const seq = typeof group?.seq === 'number' ? group.seq : 0;
  const stored = (group?.name || '').trim();
  const defaultLabel = `Group ${seq || ''}`.trim();
  const displayLabel = stored || defaultLabel;

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(stored);
  const inputRef = React.useRef(null);

  // Sync local draft when the upstream value changes (e.g. another tab).
  React.useEffect(() => {
    if (!editing) setDraft(stored);
  }, [stored, editing]);

  React.useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = () => {
    setDraft(stored);
    setEditing(true);
  };
  const commit = () => {
    if (!editing) return;
    setEditing(false);
    if (draft.trim() !== stored) onRename(draft);
  };
  const cancel = () => {
    setDraft(stored);
    setEditing(false);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div
      className="group-header"
      draggable={draggable ? true : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="group-header__handle" title="Drag to reorder this group">
        <Icon name="drag" size={14} />
      </span>
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          className="group-header__name-input"
          value={draft}
          placeholder={defaultLabel}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          // Don't let the drag handler swallow the click on the input.
          draggable={false}
          onDragStart={(e) => { e.stopPropagation(); e.preventDefault(); }}
          aria-label="Group name"
        />
      ) : (
        <button
          type="button"
          className={
            'group-header__label group-header__label--button' +
            (stored ? '' : ' group-header__label--default')
          }
          onClick={startEdit}
          title="Click to rename this group"
        >
          {displayLabel}
        </button>
      )}
      <span className="group-header__count">{count} row{count === 1 ? '' : 's'}</span>
      <span className="group-header__spacer" />
      <button
        type="button"
        className="btn btn--quiet btn--small group-header__ungroup"
        onClick={onUngroupAll}
        title="Ungroup all — dissolves this group; the files themselves stay in the workbench"
      >
        <Icon name="trash" size={12} /> Ungroup all
      </button>
    </div>
  );
}

// ===== Grid view =====
function GridView({ items, cardSize, selected, onToggleSelect, onOpen, showFilenames, findDuplicate }) {
  return (
    <div className="grid" style={{ "--card-min": `${cardSize}px` }}>
      {items.map((item) =>
      <Card
        key={item.id}
        item={item}
        selected={selected.has(item.id)}
        onToggleSelect={onToggleSelect}
        onOpen={onOpen}
        showFilename={showFilenames}
        duplicateOfPublished={findDuplicate?.(item)} />

      )}
    </div>);

}

function Card({ item, selected, onToggleSelect, onOpen, showFilename, duplicateOfPublished }) {
  const aspect = item.width && item.height ? item.width / item.height : 4 / 3;
  const isPortrait = aspect < 0.95;
  const isPano = aspect > 2.5;
  const mediaCls = "card__media" + (isPortrait ? " card__media--portrait" : "") + (isPano ? " card__media--pano" : "");

  return (
    <div
      className={"card" + (selected ? " card--selected" : "") + ((duplicateOfPublished || item.existsOnCommons) ? " card--duplicate" : "")}
      onClick={() => onOpen(item.id)}
      title={
        item.existsOnCommons
          ? `Already on Commons as File:${item.existsOnCommons.filename} (uploaded by ${item.existsOnCommons.user || 'someone else'})`
          : duplicateOfPublished
            ? `Already on Commons as File:${duplicateOfPublished}`
            : undefined
      }
    >
      <div className={mediaCls}>
        <Thumb item={item} ratio={aspect} />

        <div className="card__check" onClick={(e) => {e.stopPropagation();onToggleSelect(item.id);}}>
          <Icon name="check" size={14} />
        </div>

        <div className="card__chips">
          {item.status === "stash-selected" &&
          <span className="chip chip--info" title="Queued — waiting to upload"><Icon name="upload" size={10} /> Queued</span>
          }
          {item.status === "stash-uploading" &&
          <span className="chip chip--info"><Icon name="upload" size={10} /> {item.progress}%</span>
          }
          {item.status === "upload-error" &&
          <span className="chip chip--err" title={item.errorMessage || "Upload failed"}><Icon name="warn" size={10} /> Failed</span>
          }
          {item.existsOnCommons ? (
            <span className="chip chip--warn" title={`Already on Commons as File:${item.existsOnCommons.filename} — uploaded by ${item.existsOnCommons.user || 'someone else'}`}><Icon name="warn" size={10} /> Already on Commons</span>
          ) : duplicateOfPublished && (
            <span className="chip chip--warn" title={`Already on Commons as File:${duplicateOfPublished}`}><Icon name="warn" size={10} /> Already published</span>
          )}
          {item.status === "published" && item.featured &&
          <span className="chip chip--info"><Icon name="star" size={10} /></span>
          }
          {item.issues?.includes("missing-license") && <span className="chip chip--err">No license</span>}
          {item.issues?.includes("categories-not-on-commons") && <span className="chip chip--err" title="One or more categories don't exist on Commons — this row can't be published until you remove them.">Unknown categories</span>}
          {item.issues?.includes("possible-duplicate") && <span className="chip chip--warn">Duplicate?</span>}
          {item.status === "stash-uploading" &&
          <div className="progress__bar" style={{ width: item.progress + "%" }} />
          }
        </div>
      </div>

      <div className="card__body">
        <h3 className={"card__title" + (item.title ? "" : " card__title--muted")}>
          {item.title || (showFilename ? item.filename : "Untitled")}
        </h3>
        <div className="card__meta">
          {item.status === "published" ?
          <>
              {item.dateTaken && <span className="card__meta-item">{formatRelative(item.dateTaken)}</span>}
              {item.usedOn > 0 && <span className="card__meta-item">{item.dateTaken ? "· " : ""}Used on {item.usedOn}</span>}
              {item.views > 0 && <span className="card__meta-item">· {compactNum(item.views)} views</span>}
            </> :

          <>
              <span className="card__meta-item">{formatBytes(item.bytes)}</span>
              {item.expiresAt && <span className="card__meta-item">· expires {timeUntil(item.expiresAt)}</span>}
              {item.issues?.length > 0 && <span className="card__meta-item" style={{ color: "var(--color-warning)" }}>· {item.issues.length} issue{item.issues.length > 1 ? "s" : ""}</span>}
            </>
          }
        </div>
      </div>
    </div>);

}

// ===== List view =====
function ListView({ items, selected, onToggleSelect, onSelectAll, onClearAll, onOpen, showThumbs }) {
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const someSelected = items.some((i) => selected.has(i.id)) && !allSelected;
  return (
    <div className="list">
      <div className="list__row list__row--head">
        <div
          className={"cbox" + (allSelected ? " cbox--checked" : someSelected ? " cbox--mixed" : "")}
          onClick={() => allSelected ? onClearAll() : onSelectAll()}>
          
          {allSelected && <Icon name="check" size={12} />}
        </div>
        <div></div>
        <div>Title / filename</div>
        <div>Categories</div>
        <div>License</div>
        <div className="list__cell--num">Size</div>
        <div className="list__cell--num">Date taken</div>
      </div>
      {items.map((item) =>
      <div
        key={item.id}
        className={"list__row" + (selected.has(item.id) ? " list__row--selected" : "")}
        onClick={() => onOpen(item.id)}>
        
          <div
          className={"cbox" + (selected.has(item.id) ? " cbox--checked" : "")}
          onClick={(e) => {e.stopPropagation();onToggleSelect(item.id);}}>
          
            {selected.has(item.id) && <Icon name="check" size={12} />}
          </div>
          {showThumbs ?
        <div className="list__thumb"><Thumb item={item} ratio={item.width / item.height} /></div> :
        <div />}
          <div className="list__title">
            <span className="list__title-main">{item.title || <em style={{ color: "var(--color-placeholder)" }}>{item.filename}</em>}</span>
            {item.title && <span className="list__title-sub">{item.filename}</span>}
          </div>
          <div className="list__cell">
            {/* Display with "Category:" prefix to match Commons convention (T425912). */}
            {(item.categories || []).slice(0, 2).map((c) => `Category:${c}`).join(", ") || <span className="muted">—</span>}
            {(item.categories || []).length > 2 && <span className="muted"> +{item.categories.length - 2}</span>}
          </div>
          <div className="list__cell">
            {item.license
              ? <span title={window.licenseTitle?.(item.license) || item.license}>{window.licenseShortLabel?.(item.license) || item.license}</span>
              : <span style={{ color: "var(--color-destructive)" }}>missing</span>}
          </div>
          <div className="list__cell list__cell--num">{formatBytes(item.bytes)}</div>
          <div className="list__cell list__cell--num">{item.dateTaken ? formatRelative(item.dateTaken) : <span className="muted">—</span>}</div>
        </div>
      )}
    </div>);

}

// ===== Empty row (in-section) =====
function EmptyRow({ icon, text }) {
  return (
    <div className="empty-row">
      <div className="empty-row__icon"><Icon name={icon} size={18} /></div>
      <span>{text}</span>
    </div>);

}

// ===== Hidden stash files (soft-deleted) =====
//
// Lives below the visible stash files; the toggle target is the section header,
// which sits above the (collapsible) list of hidden cards. Expanding the body
// only grows downward — the visible files above and the toggle in the header
// don't move. (T425883)
function HiddenStashSection({ items, expanded, onToggle, onUnhide, onUnhideAll, onOpen, onOpenLightbox, findDuplicate }) {
  // Earliest-expiring file in the hidden bucket — surfaced on the header so a
  // collapsed hidden block still tells you "you've got 1h before something
  // here disappears for good". Same source as the main stash header.
  const expirySummary = (() => {
    const now = Date.now();
    let minMs = Infinity;
    for (const it of items) {
      if (!it.expiresAt) continue;
      const ms = new Date(it.expiresAt) - now;
      if (ms < minMs) minMs = ms;
    }
    if (minMs === Infinity || minMs <= 0) return null;
    return formatStashRemaining(minMs);
  })();

  return (
    <div className={"hidden-section" + (expanded ? " hidden-section--open" : "")}>
      <div
        className="hidden-section__head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        title={expanded ? "Hide discarded files again" : "Show discarded files"}
      >
        <span className={"hidden-section__chevron" + (expanded ? " hidden-section__chevron--open" : "")}>
          <Icon name="chevron-down" size={14} />
        </span>
        <Icon name="eye-off" size={14} />
        <span className="hidden-section__title">
          {items.length} hidden file{items.length === 1 ? "" : "s"}
        </span>
        {expirySummary && (
          <span
            className="hidden-section__expiry"
            title="Earliest hidden file leaves the stash in this much time. Hidden files still expire from the stash on the normal ~48h schedule."
          >
            · earliest expires in {expirySummary}
          </span>
        )}
        {expanded && (
          <button
            type="button"
            className="btn btn--quiet btn--small hidden-section__restore-all"
            onClick={(e) => { e.stopPropagation(); onUnhideAll(); }}
            title="Restore all hidden files to the visible list"
          >
            Restore all
          </button>
        )}
      </div>

      {expanded && (
        <div className="hidden-section__body" role="list">
          {items.map((it) => (
            <HiddenCard
              key={it.id}
              item={it}
              onUnhide={onUnhide}
              onOpen={onOpen}
              onOpenLightbox={onOpenLightbox}
              duplicateOfPublished={findDuplicate?.(it)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One hidden file: thumbnail + filename + size/dimensions + stash countdown +
// duplicate-state chip + Restore button. Tinted background and "Hidden" chip
// make the soft-deleted state unambiguous. Clicking the thumbnail opens the
// lightbox (big preview); clicking the row body opens the detail panel — same
// split as the visible stash views. Duplicate chips mirror Card so a hidden
// file that's already on Commons (or twinned with a visible stash entry) is
// obvious before the user restores it. (T425883)
function HiddenCard({ item, onUnhide, onOpen, onOpenLightbox, duplicateOfPublished, duplicateInStash }) {
  const aspect = item.width && item.height ? item.width / item.height : 4 / 3;
  const dims = item.width && item.height ? `${item.width} × ${item.height}` : null;
  const expiresMs = item.expiresAt ? new Date(item.expiresAt) - Date.now() : null;
  const expiryLabel =
    expiresMs == null ? null :
    expiresMs <= 0 ? "expired" :
    `expires in ${formatStashRemaining(expiresMs)}`;
  const expiryUrgent = expiresMs != null && expiresMs > 0 && expiresMs < 6 * 60 * 60 * 1000;

  // Mirror Card's three-way precedence: cross-Commons (someone else uploaded
  // it) > in-stash twin (a visible row has the same bytes) > self re-upload
  // (this user already has it on Commons under a different filename).
  const dupChip = item.existsOnCommons ? {
    cls: "chip chip--warn",
    label: "Already on Commons",
    title: `Already on Commons as File:${item.existsOnCommons.filename} — uploaded by ${item.existsOnCommons.user || 'someone else'}`,
  } : duplicateInStash?.length ? {
    cls: "chip chip--warn",
    label: "Twin in stash",
    title: `Same file is also in your stash as: ${duplicateInStash.map((d) => d.filename).join(', ')}`,
  } : duplicateOfPublished ? {
    cls: "chip chip--warn",
    label: "Already published",
    title: `Already on Commons as File:${duplicateOfPublished}`,
  } : null;

  const isDuplicate = !!(item.existsOnCommons || duplicateInStash?.length || duplicateOfPublished);

  return (
    <div
      className={"hidden-card" + (isDuplicate ? " hidden-card--duplicate" : "")}
      role="listitem"
      onClick={() => onOpen?.(item.id)}
      title={dupChip?.title || item.title || item.filename}
    >
      <button
        type="button"
        className="hidden-card__thumb"
        onClick={(e) => { e.stopPropagation(); onOpenLightbox?.(item.id); }}
        title="Show large preview"
        aria-label="Show large preview"
      >
        <Thumb item={item} ratio={aspect} />
      </button>
      <div className="hidden-card__body">
        <div className="hidden-card__title-row">
          <span className="hidden-card__title">
            {item.title || item.filename}
          </span>
          {dupChip && (
            <span className={dupChip.cls + " hidden-card__chip-dup"} title={dupChip.title}>
              <Icon name="warn" size={10} /> {dupChip.label}
            </span>
          )}
          <span className="chip chip--neutral hidden-card__chip" title="This file is hidden from your visible stash list">
            Hidden
          </span>
        </div>
        <div className="hidden-card__meta">
          <span>{formatBytes(item.bytes)}</span>
          {dims && <span> · {dims}</span>}
          {expiryLabel && (
            <span className={"hidden-card__expiry" + (expiryUrgent ? " hidden-card__expiry--urgent" : "")}>
              {" · "}{expiryLabel}
            </span>
          )}
        </div>
      </div>
      <div className="hidden-card__actions">
        <button
          type="button"
          className="btn btn--quiet btn--small"
          onClick={(e) => { e.stopPropagation(); onUnhide(item); }}
          title="Restore this file to the visible list"
        >
          Restore
        </button>
      </div>
    </div>
  );
}

// "47h 12m" / "23h" / "47m" — never days. Stash entries auto-expire within
// ~48h, so even the longest possible countdown fits in two-digit hours and
// "hours" is the unit the user will actually act on ("2d" rounds away the
// urgency that "47h" carries). Mirrors the stash-section header which is
// also hours-only. (T425883)
function formatStashRemaining(ms) {
  if (ms <= 0) return "0m";
  const totalMin = Math.floor(ms / (1000 * 60));
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

// ===== Helpers =====

// Coalesce stash entries that share the same sha1 (content hash) into a single
// logical row. Two filekeys pointing at the same bytes are the same file from
// the user's perspective — surfacing both as separate rows asks the user to
// decide between two identical things, which is never the right choice.
//
// Rules (T425873 maintainer feedback):
//   - The LATEST upload wins as the row's base (longest expiry, freshest
//     server-side EXIF/dimensions/thumb URL). The user's intent in re-
//     uploading is usually to "fix" something (correct metadata, restart the
//     48h counter, restore a hidden file), so the most recent capture of the
//     bytes is the canonical one.
//   - Identity fields (id / filekey / uploadedAt / expiresAt) come from the
//     latest entry. Operations like Publish or Discard route to that filekey;
//     the older filekeys auto-expire from the stash with no further action.
//   - Items without a sha1 (e.g. in-flight upload placeholders, or stash
//     entries whose backfill hasn't completed) are passed through unchanged.
//   - Published items are passed through unchanged.
//   - Sort order of the input is preserved at the row level: the first time
//     a sha1 is seen wins the position; later duplicates collapse onto it,
//     and the latest-upload metadata is applied in-place.
function coalesceStashBySha1(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return rawItems;
  const out = [];
  const positionBySha1 = new Map(); // sha1 -> index in `out`
  const latestBySha1 = new Map(); // sha1 -> the entry currently picked as winner
  for (const item of rawItems) {
    const isStash = item.status?.startsWith('stash');
    const sha1 = isStash ? item.sha1 : null;
    if (!sha1) {
      out.push(item);
      continue;
    }
    const existingIdx = positionBySha1.get(sha1);
    if (existingIdx === undefined) {
      positionBySha1.set(sha1, out.length);
      latestBySha1.set(sha1, item);
      out.push(item);
      continue;
    }
    // Collision — pick whichever was uploaded later as the winner. Compare
    // by uploadedAt; missing values lose to anything dated. The winner's
    // entire shape replaces the slot (same sha1 -> same drafts already
    // merged in, so user-edit fields are identical between candidates;
    // file-derived fields are the bit that varies and the latest wins).
    const current = latestBySha1.get(sha1);
    const currentTs = current.uploadedAt ? new Date(current.uploadedAt).getTime() : -Infinity;
    const itemTs = item.uploadedAt ? new Date(item.uploadedAt).getTime() : -Infinity;
    if (itemTs > currentTs) {
      out[existingIdx] = item;
      latestBySha1.set(sha1, item);
    }
    // else: current is already the latest, drop `item`.
  }
  return out;
}

function recomputeIssues(item, requiredFields) {
  const required = new Set([...(requiredFields || []), ...ALWAYS_REQUIRED]);
  // Re-evaluate the "non-existing categories on Commons" flag (T425950)
  // against the current category list. The async API check populates
  // item.nonExistingCategories elsewhere; here we only keep the issue
  // alive while at least one of those names is still on the row.
  const liveMissingCats = (item.nonExistingCategories || []).filter((c) =>
    (item.categories || []).includes(c),
  );
  const issues = (item.issues || []).filter((i) => {
    if (i === "missing-title") return required.has("title") && !item.title?.trim();
    if (i === "missing-license") return required.has("license") && !item.license;
    if (i === "missing-author") return required.has("author") && !item.author?.trim();
    if (i === "missing-categories") return required.has("categories") && !(item.categories && item.categories.length);
    // T426422: a caption in any language clears the missing-description
    // requirement — the user has fulfilled "this file has a caption".
    if (i === "missing-description") return required.has("description") && !(window.hasAnyCaption ? window.hasAnyCaption(item) : item.description?.trim());
    if (i === "missing-depicts") return required.has("depicts") && !(item.depicts && item.depicts.length);
    if (i === "categories-not-on-commons") return liveMissingCats.length > 0;
    // Title validation issues — derived from validateTitleLocal +
    // getCachedUniqueness, so they're always recomputed below; drop any
    // stale codes.
    if (i === "invalid-title") return false;
    if (i === "title-taken") return false;
    if (i === "title-format-warning") return false;
    return true;
  });
  // Add fresh missing-* issues for newly-required empty fields.
  const checks = [
  ["title", "missing-title", (it) => !it.title?.trim()],
  ["license", "missing-license", (it) => !it.license],
  ["author", "missing-author", (it) => !it.author?.trim()],
  ["categories", "missing-categories", (it) => !(it.categories && it.categories.length)],
  ["description", "missing-description", (it) => !(window.hasAnyCaption ? window.hasAnyCaption(it) : it.description?.trim())],
  ["depicts", "missing-depicts", (it) => !(it.depicts && it.depicts.length)]];

  for (const [key, code, isEmpty] of checks) {
    if (required.has(key) && isEmpty(item) && !issues.includes(code)) issues.push(code);
  }
  // Keep nonExistingCategories consistent with the current category list:
  // any name the user removed shouldn't linger as a missing flag.
  const prunedMissingCats = (item.nonExistingCategories || []).filter((c) =>
    (item.categories || []).includes(c),
  );
  // Title-format validation. Independent of the user's required-fields toggle:
  // an invalid title is always a publish blocker (Commons would reject it). We
  // skip the format check when the title is empty — that's already covered by
  // the missing-title check and the user is mid-edit.
  if (item.title?.trim()) {
    const localIssue = validateTitleLocal(item.title);
    if (localIssue && localIssue.severity === 'error') {
      if (!issues.includes('invalid-title')) issues.push('invalid-title');
    } else {
      // Soft warning — surface camera-default / placeholder names on the cell
      // and in the status tooltip even when the editor isn't open. Doesn't
      // block publish (the server would, eventually, but we let the user
      // decide whether to keep the questionable name).
      if (localIssue && localIssue.severity === 'warn') {
        if (!issues.includes('title-format-warning')) issues.push('title-format-warning');
      }
      // Uniqueness is checked by the title editor on-the-fly and cached via
      // apiCache; we surface the cached "taken" verdict here so it shows up
      // on the StatusDot / blocks publish without asking the editor to be
      // open. If we have no cached answer (user hasn't edited yet, or cache
      // expired), the publish modal's pre-publish duplicate check is the
      // real safety net — we don't block speculatively here.
      //
      // Sequence placeholders (T425984) bypass the uniqueness check entirely:
      // the literal `<basename> #` is not a real Commons filename, and the
      // resolver assigns a fresh `<basename> N` at publish time. Treating the
      // placeholder as "taken" would block publish on a row the user
      // intentionally marked for sequence-resolution.
      if (!isSequencePlaceholderTitle(item.title)) {
        const future = buildFutureFilename(item.title, item.filename);
        const cached = future ? getCachedUniqueness(future) : null;
        if (cached?.state === 'taken') {
          if (!issues.includes('title-taken')) issues.push('title-taken');
        }
      }
    }
  }
  return { ...item, nonExistingCategories: prunedMissingCats, issues };
}

function labelForField(key) {
  // T426422: per-language caption keys ("description:nl") get a "Caption (NL)"
  // label so paste-mode banners and similar surfaces don't show a raw key.
  if (typeof key === "string" && key.startsWith("description:")) {
    const lang = key.slice("description:".length).toUpperCase();
    return `Caption (${lang})`;
  }
  return {
    title: "Title", description: "Caption", categories: "Categories",
    license: "License", author: "Author", depicts: "Depicts"
  }[key] || key;
}
function previewValue(v, field) {
  if (v && typeof v === "object" && v.qid) return `${v.qid} — ${v.label}`;
  if (Array.isArray(v)) {
    // Categories display with "Category:" prefix (T425912).
    if (field === "categories") return v.map((c) => `Category:${c}`).join(", ");
    return v.join(", ");
  }
  let s = String(v ?? "");
  if (field === "categories" && s) s = `Category:${s}`;
  return s.length > 32 ? s.slice(0, 30) + "…" : s;
}

function formatRelative(iso) {
  const ms = new Date() - new Date(iso);
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 60) return "a month ago";
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} months ago`;
  return new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}
function compactNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return n.toString();
}

// ===== Save status indicator =====
// Tiny chip in the topbar reflecting the user-store sync state.
//   idle    — no edits made this session (don't show)
//   pending — debouncing (3s timer running)
//   saving  — wiki write in flight
//   saved   — last save succeeded; "Saved Xs ago"
//   error   — last save failed; tooltip carries the message
function SaveStatus() {
  const status = React.useSyncExternalStore(subscribeStoreStatus, getStoreStatus, getStoreStatus);
  // tick once a minute so the "Saved 2m ago" label stays fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (status.state !== 'saved') return;
    const id = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [status.state]);

  if (status.state === 'idle') return null;

  if (status.state === 'saving') {
    return (
      <span className="save-status save-status--saving" role="status" aria-live="polite">
        <span className="save-status__dot" />
        Saving…
      </span>
    );
  }
  if (status.state === 'pending') {
    return (
      <span className="save-status save-status--pending" role="status" aria-live="polite" title="Edits will save in a few seconds">
        <span className="save-status__dot" />
        Pending
      </span>
    );
  }
  if (status.state === 'error') {
    return (
      <span className="save-status save-status--error" role="status" aria-live="polite" title={status.lastError || 'Save failed'}>
        <Icon name="warn" size={12} />
        Save failed
      </span>
    );
  }
  // saved
  const ago = relativeAgo(status.lastSavedAt);
  return (
    <span className="save-status save-status--saved" role="status" title={`Last saved at ${new Date(status.lastSavedAt).toLocaleTimeString()}`}>
      <Icon name="check" size={12} />
      Saved {ago}
    </span>
  );
}

function relativeAgo(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ===== User menu (avatar dropdown) =====
// Avatar-only in the topbar. Click opens a small popover anchored to the
// avatar with the username at top, links to the User: subpages where this
// app stores its config + draft metadata, and Logout at the bottom.
function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);
  const username = user?.username || 'Unknown';
  const initials = username.slice(0, 2).toUpperCase();

  // Wiki page URLs for the user's stored config + drafts. The pages may not
  // exist yet — Commons will offer to create them when first visited, and
  // Phase 2 will populate them programmatically from the app.
  const userPageRoot = `https://commons.wikimedia.org/wiki/User:${encodeURIComponent(username)}`;
  const prefsUrl = `${userPageRoot}/IIIFManifestUploadWorkbench/Preferences.json`;
  const metadataUrl = `${userPageRoot}/IIIFManifestUploadWorkbench/Metadata.json`;
  const profileUrl = userPageRoot;

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="topbar__user" ref={ref}>
      <button
        className={'topbar__avatar topbar__avatar--btn' + (open ? ' topbar__avatar--open' : '')}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={username}
      >
        {initials}
      </button>
      {open && (
        <div className="user-menu" role="menu">
          <a className="user-menu__header" href={profileUrl} target="_blank" rel="noopener noreferrer">
            <div className="user-menu__name">{username}</div>
            <div className="user-menu__sub">View profile on Commons <Icon name="external" size={10} /></div>
          </a>
          <div className="user-menu__sep" />
          <div className="user-menu__group-label">Stored on Commons</div>
          <a className="user-menu__item" href={prefsUrl} target="_blank" rel="noopener noreferrer" role="menuitem">
            <Icon name="cog" size={14} />
            <span>Preferences</span>
            <Icon name="external" size={10} />
          </a>
          <a className="user-menu__item" href={metadataUrl} target="_blank" rel="noopener noreferrer" role="menuitem">
            <Icon name="edit" size={14} />
            <span>Metadata drafts</span>
            <Icon name="external" size={10} />
          </a>
          {onLogout && (
            <>
              <div className="user-menu__sep" />
              <button className="user-menu__item user-menu__item--danger" onClick={onLogout} role="menuitem">
                <Icon name="external" size={14} />
                <span>Log out</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ===== Lightbox =====
function Lightbox({ item, onClose, onOpenDetails }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  if (!item) return null;
  const aspect = item.width && item.height ? item.width / item.height : 4 / 3;
  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lightbox__inner" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox__media" style={{ aspectRatio: aspect }}>
          <Thumb item={item} ratio={aspect} large />
        </div>
        <div className="lightbox__caption">
          <div className="lightbox__title">{item.title || <em style={{ color: "var(--color-placeholder)" }}>{item.filename}</em>}</div>
          <div className="lightbox__meta">
            <span className="mono">{item.filename}</span>
            <span>·</span>
            <span>{formatBytes(item.bytes)}</span>
            {item.width > 0 && <><span>·</span><span>{item.width.toLocaleString()}×{item.height.toLocaleString()}</span></>}
            {item.license && <><span>·</span><span title={window.licenseTitle?.(item.license) || item.license}>{window.licenseShortLabel?.(item.license) || item.license}</span></>}
          </div>
        </div>
        <div className="lightbox__actions">
          <button className="btn" onClick={onOpenDetails}><Icon name="edit" size={14} /> Edit metadata</button>
          <button className="btn btn--quiet btn--icon-only" onClick={onClose} title="Close (Esc)"><Icon name="close" size={16} /></button>
        </div>
      </div>
    </div>);

}
window.Lightbox = Lightbox;

export { App, TWEAK_DEFAULTS };