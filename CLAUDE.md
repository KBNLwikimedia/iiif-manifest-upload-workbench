# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**IIIF Commons Upload Workbench** is a frontend-only React app that ingests **IIIF Presentation manifests** (starting with the KB's medieval manuscripts) and turns them into **Wikimedia Commons uploads**: manifest in → metadata parsed → full-res images derived → items land in a spreadsheet-style workbench → prefilled `{{Artwork}}` wikitext + structured data → review → publish.

It is a **fork of [upload-workbench](https://gitlab.wikimedia.org/daanvr/upload-workbench)** by Daanvr (Daan van Ramshorst), forked at v0.39.0. The upstream tool is a general-purpose bulk-upload cockpit (stash + history as a spreadsheet); this fork adds the IIIF ingestion funnel on top of it. Architecture, most modules, and the lessons learned below are inherited from upstream and still apply.

Maintainer of this fork: **Olaf Janssen** (KB, national library of the Netherlands — Wikimedia user [OlafJanssen](https://commons.wikimedia.org/wiki/User:OlafJanssen), GitHub org [`KBNLwikimedia`](https://github.com/KBNLwikimedia)).

## The IIIF ingestor (current focus)

**The approved design and build plan live in [`__inputs/iiif-ingestor-design.md`](__inputs/iiif-ingestor-design.md)** — read it before touching ingestor code. It contains the 6-phase roadmap (Phase 0 spikes → parser → wizard UI → mapping → pipeline → SDC → verify/ship) and the full decision log (all 14 design questions answered 2026-07-07). Highlights:

- Manifest entry via **URL or dropped .json**; **IIIF Presentation 3.0 only** in v1.
- Wikitext template: **`{{Artwork}}`** (best field-level match for the KB manifest metadata). License: PD-Art-style combo (exact template settled in Phase 0.3 research).
- SDC: captions (nl + machine-drafted en, reviewed before publish) + core statements P6243 / P180 / P195(+P217) / P6216 / P275 / P7482. Manuscript Wikidata item auto-found by signature (P217 SPARQL) with manual override.
- Filenames: **manifest Title + per-canvas label, verbatim** (sanitized only for forbidden chars; positional fallback). Canvas labels are authoritative — canvas *position* can disagree with label numbering (seen in real KB manifests).
- Per-manuscript category: tool suggests a name, user accepts/edits, tool **creates the subcategory** under `Category:Medieval manuscripts from Koninklijke Bibliotheek`.
- Duplicates (sha1 already on Commons): stash anyway + flag (`exists-on-commons`), user decides. Drafts persist to the user-store. Accept the image server's 25 MP cap. Manifests can reach **500+ canvases** — slice import, abort/resume, and memory hygiene are hard requirements.

Planned new modules (ESM, not window-globals): `src/api/iiif.js` (fetch/validate/parse), `src/api/iiif-map.js` (manifest → workbench fields), `src/api/wikidata.js` (P217 lookup), `src/ui/iiif-import-modal.jsx` (the wizard, UI name "Import IIIF manifest"); plus extending `buildSdcClaims()` in `src/api/publish.js` and the `{{Artwork}}` field map in `src/wikitext-templates.js`.

### KB IIIF endpoints (verified 2026-07-07)

- Collection index: `https://presentation-api.dlc.services/32` (~29 manifests + sub-collections `topstukken`, `fragmenten`). Manifests live directly under `/32/<slug>`; the older `/32/middeleeuwse-manuscripten/<slug>` URLs are **dead**. KB plans a move to `iiif.kb.nl` (not live yet) — treat manifest URLs as opaque, never hard-code the base.
- **CORS is open** (`Access-Control-Allow-Origin: *`) on both the presentation API and the image API (`dlc.services/iiif-img/…`), including full-res JPEGs — the browser fetches everything directly, no backend needed.
- Image service enforces `maxArea: 25000000`; `/full/max/0/default.jpg` returns native resolution below 25 MP, server-side downscale above.
- 25 sample manifests are checked in under `__inputs/manifests/` (named `<signature> - <short title>.json`). Known upstream data defects to guard against: all-"Lorem ipsum" metadata, empty summaries, manifests with **zero canvases** (KW 79 K 21), canvas order ≠ label numbering (KW 76 E 5).
- Machine note: on the KB Windows machine, `curl` needs `--ssl-no-revoke` (corporate network blocks revocation checks) and `iiif.kb.nl` doesn't resolve on the internal DNS.

## Repository & deployment

| Concern | Location |
|---|---|
| Source code | GitHub, public repo [`KBNLwikimedia/iiif-commons-upload-workbench`](https://github.com/KBNLwikimedia/iiif-commons-upload-workbench) |
| Upstream | `gitlab.wikimedia.org/daanvr/upload-workbench` (GitLab; live at https://upload-workbench.toolforge.org/). This fork does **not** push there. |
| Deployment | **Local dev only for now** (`npm run dev` + `VITE_OWNER_ACCESS_TOKEN`). Own Toolforge tool + own OAuth consumer registration are deferred until the ingestor works end-to-end. Upstream's `.gitlab-ci.yml` is archived at `docs/upstream-gitlab-ci.yml` for reference — do not resurrect it as-is; it rsyncs to *Daanvr's* Toolforge project. |
| Issue tracking | GitHub issues on the fork repo (upstream uses Phabricator `#tool-upload-workbench` — that board is for upstream work only, don't file fork tasks there) |
| Design doc / project inputs | `__inputs/` (design doc, sample manifests, sample images, original product-vision conversation) |
| OAuth registration docs | `docs/oauth-registration.md` (upstream's; will need a fork-specific consumer when Toolforge deployment happens) |

### Pending identity renames (do together, once, in a dedicated commit)

The code still identifies as upstream in a few places. When the fork gets its own OAuth consumer / deployment (not before — the attribution currently correctly points at the code lineage), update:
- `src/config.js` → `APP_USER_AGENT` and `attributionSuffix()` (points at `toolforge:upload-workbench`)
- `index.html` → `<title>`
- `package.json` → already renamed to `iiif-commons-upload-workbench`

## Build & run

```bash
npm install
npm run dev        # http://localhost:5175/
npm run build      # outputs dist/
npm run preview
```

No test runner. Verification is by build (`npm run build`) + manual exercise in DevTools.

`npm run build` runs `scripts/check-undefined-refs.mjs` first — a small AST scanner that flags any reference to an identifier not bound in scope, not in the allowlist of `window.X = X` exports (`scripts/window-globals.json`), and not a standard JS / browser / Vite-define global. Catches the cross-branch orphan-ref bug class that crashed upstream v0.10.0 → v0.23.1 on first render (see "Lessons learned"). Add new entries to `scripts/window-globals.json` whenever a new `window.X = X` (or `globalThis.X = X`) export is added in `src/`; the scanner refuses to run if the JSON and the actual exports diverge.

`npm run check:undefs` runs the scanner on its own (without building). `npm run build:nocheck` skips the scanner — emergency escape hatch only.

## Architecture

### Source layout

- `src/main.jsx` — entry: wires React/ReactDOM globals, side-effect imports, mounts `<Root>` → `<AuthGate>` → `<Bootstrap>` → `<App>`. Owns the bootstrap effect that loads user profile, stash, history cache, and triggers background refresh.
- `src/app.jsx` — `App` component (~3200 lines): grid/list views, lightbox, bulk drawer, the per-stash duplicate-on-Commons effect, sort/filter, draft persistence wiring.
- `src/table.jsx` — spreadsheet view (~6500 lines, the single biggest file): cell editor, column defaults, paste mode, location editor with OSM tiles. Cross-references many `window.X` globals.
- `src/detail.jsx`, `src/columns-modal.jsx`, `src/icons.jsx`, `src/thumb.jsx` — leaf UI helpers.
- `src/ui/` — modal components (regular ESM imports, not window-globals): `dropzone.jsx`, `publish-modal.jsx`, `bulk-publish-modal.jsx`, `wikitext-preview-modal.jsx`, feedback/info/error modals, etc. **New IIIF UI goes here.**
- `src/api/`
  - `oauth.js` — PKCE flow, token storage (prefix `uwb_`), refresh, owner-token bypass via `VITE_OWNER_ACCESS_TOKEN`
  - `commons.js` — Commons API wrapper (stash list, CSRF, sha1 lookup `findCommonsFileBySha1`, vocab search, `addStructuredData`)
  - `history.js` — `fetchHistoryDetailed` (latest N rich items), `fetchHistoryOne` (per-row refresh)
  - `upload.js` — stash upload (`uploadFile`: single POST up to ~100 MB; chunked upload not yet implemented). `sanitizeFilename()`
  - `publish.js` — stash → published (`publishOne`/`publishMany`), `buildWikitext`, `buildSdcClaims` (P170/P180/P625/P1071/P571 today; IIIF adds P6243/P195/P6216/P275/P7482), `makeFinalFilename`, blocking-issue codes
  - `user-store.js` — cross-device persistence: reads/writes two JSON pages on Commons (see below)
  - `local-store.js` — `localStorage` fast-path for filename cache; key `uwb.localStash.v1`
  - `autocomplete.js` — bridges live wiki vocab into the design's `window.KNOWN_*` pools
  - `normalize.js` — shapes raw API responses (allimages, stashimageinfo, SDC) into uniform item objects
  - `sequence.js`, `title-validation.js`, `gitlab.js` — auto-sequence titles, Commons title rules, changelog fetching
  - **planned:** `iiif.js`, `iiif-map.js`, `wikidata.js` (see the design doc)
- `src/wikitext-templates.js` — template registry + renderer for the 8 primary Commons file-description templates ({{Information}}, {{Artwork}}, {{Book}}, {{Map}}, …); field-map per template drives publish wikitext.
- `src/licenses.js` — license catalog (single source of truth for license templates), `src/captions.js` — per-language caption columns.
- `src/data.js` — `SAMPLE_UPLOADS` (only used in DEMO_MODE). `src/vocabulary.js` — mock vocab pools.
- `src/codex-tokens.css`, `src/app.css` — Codex-inspired tokens + app styles.
- `src/config.js` — env-var-backed config. `DEMO_MODE = !CLIENT_ID`.
- `src/utils.js` — `fetchJSON` / `fetchWithAuth` + `apiCache` (5-min default TTL).

### The design's window-globals pattern

The original upstream handoff loaded each `.jsx` file as a separate `<script>` and shared dependencies through `window.X = X`. That pattern is preserved in the Vite port:

- `main.jsx` exposes `React` and `ReactDOM` on `globalThis` before any design file loads.
- Side-effect imports run in dependency order (data → vocab → leaf components → composites → app).
- Each legacy `.jsx` file ends with `window.X = X` so siblings can read it.

If you need to add a new shared symbol used across multiple *design* files, follow the window-global pattern. New self-contained features (like `src/ui/` and everything IIIF) use regular ESM imports — don't rewrite the design files into ESM unless you have time to chase down every cross-file reference in `table.jsx`.

### Bootstrap flow

1. `start()` in `main.jsx` calls `handleCallback()` (consumes any pending OAuth redirect) before mounting React.
2. `<AuthGate>` checks `isAuthenticated()`; renders `<Login>` or `<Bootstrap>`.
3. `<Bootstrap>`:
   - `fetchUserProfile()` → username
   - `Promise.allSettled([loadStores(username), fetchStashedFiles()])` — user-store + live stash in parallel
   - Pulls cached history items from the user-store (instant first paint)
   - If `shouldAutoRefreshHistory()` (no `lastSyncedAt` or stale > 7 days) → background `fetchHistoryDetailed(limit: 50)` → `setCachedHistory(fresh)` → re-render
4. `<App>` takes over; per-stash `findCommonsFileBySha1` effect runs to flag duplicates on Commons.

The IIIF import wizard is an explicit user gesture *after* bootstrap — it must never add API calls to the bootstrap path.

### Persistence model (3 layers)

1. **Volatile** — React state in `<App>`. Lost on reload.
2. **`localStorage`** (per-browser) — fast-path cache that survives reload. Keys: `uwb_*` (OAuth tokens, in `oauth.js`), `uwb.localStash.v1` (filename cache, in `local-store.js`), `stashhub.required` / `stashhub.colDefaults` / `stashhub.fieldOrder` / `stashhub.columns` (UI prefs, in `app.jsx`).
3. **Commons wiki user-subpages** (cross-device, authoritative) — managed by `user-store.js`:
   - `User:<self>/UploadWorkbench/Preferences.json` — `requiredFields`, `columnDefaults`, `fieldOrder`, custom props
   - `User:<self>/UploadWorkbench/Metadata.json` — `drafts` (per-file edits, keyed by sha1/filekey), `filenames` (filekey → readable name), `hiddenFilekeys`, `history` (cache: `lastSyncedAt` + `items[]`)
   - Loaded once on bootstrap; writes are **debounced 3 s** then `action=edit`.
   - IIIF-imported drafts ride this same mechanism (design decision Q11) — batched, never one edit per draft.

### Authentication

OAuth 2.0 with PKCE (Authorization Code flow, public client), authorization server `meta.wikimedia.org`. Token storage prefix `uwb_`.

- **Local dev (current mode):** set `VITE_OWNER_ACCESS_TOKEN` in `.env.local` to short-circuit the PKCE flow entirely (owner-only consumer token). Without any `VITE_OAUTH_CLIENT_ID`, the app boots in `DEMO_MODE` against `SAMPLE_UPLOADS`.
- **Required grants** (for a future fork-specific consumer): `editpage`, `editmyuserjs` (user-store JSON pages — MediaWiki specially protects `User:<self>/*.json`), `createeditmovepage` (also needed for the category creation of design decision Q8), `uploadfile`, `uploadeditmovefile`. See `docs/oauth-registration.md`.

### Key API endpoints

| Operation | API call |
|---|---|
| List stashed files | `action=query&list=mystashedfiles&msfprop=size\|type` |
| Stash file info | `action=query&prop=stashimageinfo&siifilekey=<KEY>` |
| List user history | `action=query&list=allimages&aiuser=<USER>&aisort=timestamp&aidir=older` |
| Cross-Commons sha1 lookup | `action=query&list=allimages&aisha1=<HEX>` (used by `findCommonsFileBySha1`) |
| Publish from stash | `action=upload&filekey=<KEY>&filename=<NAME>&text=<WIKITEXT>` |
| Structured data write | `action=wbeditentity` on the file's `M<pageid>` entity |
| Edit published file description | `action=edit&title=File:<NAME>&text=<WIKITEXT>` |
| Read user-store page | `action=query&titles=User:<U>/UploadWorkbench/Metadata.json&prop=revisions&rvprop=content&rvslots=main` |
| Write user-store page | `action=edit&title=User:<U>/UploadWorkbench/Metadata.json&contentmodel=json` |
| CSRF token | `action=query&meta=tokens&type=csrf` |
| IIIF manifest (KB) | `GET https://presentation-api.dlc.services/32/<slug>` (CORS `*`) |
| IIIF full-res image | `GET {imageService}/full/max/0/default.jpg` (CORS `*`, 25 MP cap) |
| Wikidata item by signature | SPARQL `?item wdt:P217 "<sig>"` on query.wikidata.org |

## Observability — finding edits made by the tool

- Edits made via `VITE_OWNER_ACCESS_TOKEN` (the current dev mode) do **not** carry an OAuth CID tag — they show up under your username with only MW's automatic tags, plus the edit-summary attribution suffix (`attributionSuffix()` in `src/config.js`).
- The change tag **`OAuth CID: 18016`** belongs to *upstream's* production consumer — useful when studying upstream-made edits, irrelevant to this fork until it registers its own consumer.
- A user-store page's history (`?action=history` on `User:<U>/UploadWorkbench/Metadata.json`) is a debug log of how drafts/cache evolved over time.

## Constraints

- **No backend** — PKCE flow, no embedded secrets. Everything (manifest fetch, image download, hashing, upload) runs in the browser. The "client secret" registered with OAuth is treated as public (see `docs/oauth-registration.md`, Phabricator T323855).
- **48-hour stash expiry** — files auto-delete from the stash. A 500-canvas import cannot linger unpublished; re-import is cheap and the sha1 dup-check makes it idempotent.
- **CORS** — authenticated Wikimedia requests need `crossorigin=` (empty) on the URL; unauthenticated use `origin=*`. `fetchWithAuth` in `utils.js` adds it automatically. dlc.services endpoints are `Access-Control-Allow-Origin: *`.

### API politeness / rate limits

The Wikimedia API — and the KB's IIIF image server — are shared infrastructure. Rules:

- **No bulk paginated reads on bootstrap.** A first-load handler must not chain >2 API calls without an explicit user gesture. The IIIF import is behind a button — keep it that way.
- **Wiki edits are the most expensive operation.** Wiki user-store pages hold user-authored state only (drafts, prefs, filenames cache). Never persist derived data (manifest JSON, canvas lists) the app can recompute.
- **Sequential, not parallel** for image downloads, stash uploads, and publishes. One 500-canvas import must not hammer dlc.services or Commons with parallel requests.
- **Cap pagination, but treat the cap as a smell.** Prefer per-record APIs (e.g. `aisha1=`) over scanning lists.
- **Use the existing `apiCache` 5-minute TTL** for any read that might fire repeatedly (e.g. Wikidata signature lookups).
- **Send a descriptive `Api-User-Agent`** (set in `utils.js`).
- **Thumbnails in the wizard use the manifest's purpose-built thumb sizes** (`/full/400,/…`), never full-res.

## Working with the codebase

- Always work on a feature branch off `main`; commit convention `feat: …`, `Fix: …`, `docs: …`, `chore: …` with the "why" in the body.
- Versioning: SemVer continues from the upstream fork point (v0.39.0). Bump `package.json` (and `src/config.js` `APP_USER_AGENT` MAJOR.MINOR) at meaningful milestones and promote `[Unreleased]` in `CHANGELOG.md` — there is no auto-deploy, so a "release" is just a tagged, changelogged state.
- For UI changes, actually run `npm run dev` and exercise the feature path — a green build doesn't catch a UI regression.
- When investigating publish behaviour, a user-store page history plus the file's on-wiki history are usually faster than re-deriving state from logs.

## Lessons learned

Inherited from upstream (all still apply to this codebase) plus fork-specific additions. Keep entries short, durable, oldest → newest.

- **Don't persist derived data to wiki user-store pages.** Wiki edits are visible forever, rate-limited harder than reads, and a heavy uploader can balloon a derived-data field into a multi-hundred-KB write. Recompute from the API instead. (Upstream `sha1Index` 933 KB incident.)
- **Identify stash files by sha1, not filekey.** `filekey` is a per-stash-entry token, not stable across re-uploads or expiry-and-re-add. Key all cross-session state by sha1; fall back to filekey only when sha1 isn't yet known. (Upstream [T425756](https://phabricator.wikimedia.org/T425756).)
- **MediaWiki list APIs silently cap at the default limit if `*limit` is unset.** Always set an explicit `*limit` and follow `*continue` in a loop with a safety cap. (Upstream [T425756](https://phabricator.wikimedia.org/T425756).)
- **Cross-branch conflicts can leave undefined-identifier orphans that esbuild doesn't catch.** Vite/esbuild bundles syntax-valid JSX without scope validation. `npm run build` runs `scripts/check-undefined-refs.mjs` first; when merging branches, run the build against the *merge result* locally. (Upstream v0.12.1 / v0.23.1 / v0.23.2.)
- **A `setState((prev) => prev.map(...))` inside a `useEffect` with the array as a dep must return `prev` (same reference) when no element mutated, or it loops forever** — potentially freezing the tab inside the microtask queue. Track a per-row `changed` flag and bail with the original array. (Upstream [T426404](https://phabricator.wikimedia.org/T426404).)
- **KB IIIF manifest quality varies — validate before ingesting.** Real defects seen: all-"Lorem ipsum" metadata, empty summaries, a manifest with zero canvases, metadata label spelling drift (5 variants of "Afmetingen"), canvas order disagreeing with canvas-label numbering. The import wizard's validation report is a feature, not polish. (Manifest survey, 2026-07-07.)
- **Canvas labels are authoritative for page identity; canvas position is not.** Filenames and page numbers derive from the canvas `label` (verbatim, sanitized), with positional index only as fallback. (Example-titles exercise, 2026-07-07.)
