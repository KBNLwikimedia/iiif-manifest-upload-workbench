# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

**IIIF Manifest Upload Workbench** is a frontend-only React app that ingests **IIIF Presentation manifests** (starting with the KB's medieval manuscripts) and turns them into **Wikimedia Commons uploads**: manifest in → metadata parsed → full-res images derived → items land in a spreadsheet-style workbench → prefilled `{{Artwork}}` wikitext + structured data → review → publish.

It is a **fork of [upload-workbench](https://gitlab.wikimedia.org/daanvr/upload-workbench)** by Daanvr (Daan van Ramshorst), forked at v0.39.0. The upstream tool is a general-purpose bulk-upload cockpit (stash + history as a spreadsheet); this fork adds the IIIF ingestion funnel on top of it. Architecture, most modules, and the lessons learned below are inherited from upstream and still apply.

Maintainer of this fork: **Olaf Janssen** (KB, national library of the Netherlands — Wikimedia user [OlafJanssen](https://commons.wikimedia.org/wiki/User:OlafJanssen), GitHub org [`KBNLwikimedia`](https://github.com/KBNLwikimedia)).

## The IIIF ingestor (current focus)

**The approved design and build plan live in [`__inputs/iiif-ingestor-design.md`](__inputs/iiif-ingestor-design.md)** — read it before touching ingestor code. It contains the 6-phase roadmap (Phase 0 spikes → parser → wizard UI → mapping → pipeline → SDC → verify/ship) and the full decision log (all 14 design questions answered 2026-07-07).

**Open issues, deferred decisions and known data defects are tracked as [GitHub Issues](https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench/issues)** (migrated 2026-07-08 from [`__inputs/open-issues.md`](__inputs/open-issues.md), which stays as the annotated origin/archive — each `OI-NN` id links 1:1 to issue `#NN`). File **new** items as GitHub issues, labelled with the existing taxonomy (`severity: *`, `security`, `code-review`, `decision`, `upstream-data`, `verified`, `tech-debt`, `bug`, `enhancement`); on resolving one, close its issue referencing the commit. The `open-issues.md` narrative is still worth reading for the rich per-entry context and the phase-blocking notes (e.g. OI-01 `formatDate()` truncation blocks Phase 5.2) — keep it roughly in sync, but GitHub Issues is authoritative for open/closed state.

**Status (2026-07-10, v0.40.0 tagged):** Phases 0–5.2 complete — the import funnel works **end-to-end in the browser**: manifest (URL or dropped `.json`) → validate → review step (full-canvas **thumbnail carousel + lightbox**, placeholder-field review with ⚠️/✕, raw-**JSON inspector**, grouped **Categories** section with editable/resettable-default parent category, grouped **Wikidata** section with auto-lookup by signature incl. Q-id-redirect resolution and Gallery/Category links) → canvas gallery (selection, per-tile native dims + full-res links, `>25 MP` badges) → download → SHA-1 → dedupe → stash, landing as prefilled rows with a **fully-wired `{{Artwork}}`** (medium/dimensions/accession number/date wikitext — Phase 5.2 / OI-01+OI-02) + `{{PD-Art|PD-old-100-expired}}` + per-manuscript category (created at *publish* time, on explicit approval — and **OI-68**: existing category variants under other names are discovered via Wikidata P373/P935 + naming conventions + KB-parent-verified search, offered for adoption instead of creating duplicates). **Phase 5 remaining:** SDC statements (`buildSdcClaims` extension — P6243/P180/P195+P217/P6216/P275/P7482, mind the 250-char caption cap OI-44). **Phase 6:** end-to-end publish verification (also where the OI-26 publish-path retry lands). The 2026-07-08 multi-agent code review's hardening pass closed the Critical (OI-25 — batched draft writes, **confirmed in production**) plus the top High/Medium items (OI-26 import-path retry/backoff, OI-27 wikitext injection, OI-30 stale Q-id, OI-34 Choice bodies, OI-35 filename collisions, OI-38 `Metadata.json` dedup + 2 MB guard, OI-65 Back-button guard). Designed-and-parked: OI-67 (KB-catalogue enrichment — blocked on a `jsru.kb.nl` CORS ask). **Post-v0.40.0 wizard-polish round (2026-07-10, on `main`):** "pages" → "images" wording throughout (a canvas is a photograph — KW 73 J 6 has 96 canvases as two-page spreads vs 89 folia; the passport's *Aantal folia* row explains this via a hover-ⓘ); persistent identity header ("Title — N images in this manifest") on every step; select step = pinned 25 MP note (dismissible ×) + pinned toolbar with the selection counter, only the grid scrolls (`grid-auto-rows: max-content` is load-bearing — auto rows collapse in the shrunk flex context); Wikidata section redesigned as a match panel (P935/P373 provenance spelled out, Category-namespace sitelinks rerouted to the category slot); Esc/backdrop close only on the `done` step (OI-31/OI-70); hover-zoom 250 ms intent delay + scroll dismissal (OI-47); manifest title row atop the passport; input step names the 3.0-only support; feedback-form issues auto-labelled `user feedback` (URL labels need triage rights — OI-73 tracks the issue-template route); README got a screenshot gallery. Data-quality survey of all 25 corpus manifests → issue #71 (per-manifest defect map, incl. the May-2025 delivery-spec comparison); image-server `maxArea` ask → #72 (774/4,806 canvases arrive downscaled). Verification notes: local dev needs `VITE_OWNER_ACCESS_TOKEN` in `.env.local`; without it the app sits on the login screen (owner-only consumers can't do the PKCE flow — OI-09). Vite serves source modules, so API modules can be exercised for real in an unauthenticated tab (`import('/src/api/…')` from DevTools); after editing the import-modal, also **mount-test it** (render `IiifImportModal` in isolation) — esbuild and the undef-scanner don't catch use-before-init/TDZ ordering bugs.

Design highlights:

- Manifest entry via **URL or dropped .json**; **IIIF Presentation 3.0 only** in v1.
- Wikitext template: **`{{Artwork}}`** (best field-level match for the KB manifest metadata). License: **`{{PD-Art|PD-old-100-expired}}`** (Q4, revised by Olaf 2026-07-07).
- SDC: captions (nl + machine-drafted en, reviewed before publish) + core statements P6243 / P180 / P195(+P217) / P6216 / P275 / P7482. Manuscript Wikidata item auto-found by signature (P217 SPARQL) with manual override.
- Filenames: **manifest Title + per-canvas label, verbatim** (sanitized only for forbidden chars; positional fallback). Canvas labels are authoritative — canvas *position* can disagree with label numbering (seen in real KB manifests).
- Per-manuscript category: tool suggests a name, user accepts/edits, tool **creates the subcategory** under `Category:Medieval manuscripts from Koninklijke Bibliotheek`.
- Duplicates (sha1 already on Commons): stash anyway + flag (`exists-on-commons`), user decides. Drafts persist to the user-store. Accept the image server's 25 MP cap. Manifests can reach **500+ canvases** — slice import, abort/resume, and memory hygiene are hard requirements.

The ingestor modules (ESM, not window-globals — all built): `src/api/iiif.js` (fetch/validate/parse), `src/api/iiif-map.js` (manifest → workbench fields), `src/api/iiif-pipeline.js` (download→hash→dedupe→stash, OI-25/26/38 hardened), `src/api/wikidata.js` (P217 lookup + P373/P935 + Q-id redirect resolution), `src/api/retry.js` (error classification + backoff), `src/ui/iiif-import-modal.jsx` (the wizard, UI name "Import IIIF manifest"). Still to build: extending `buildSdcClaims()` in `src/api/publish.js` (Phase 5 SDC).

### KB IIIF endpoints (verified 2026-07-07)

- **Canonical base since June 2026: `https://iiif.bibliotheken.nl/<slug>`** (e.g. `…/kw-129-a-24`) — live, Presentation 3.0, manifests self-identify with this base. The older `presentation-api.dlc.services/32/<slug>` host still works in parallel (collection index at `…/32`: ~29 manifests + sub-collections `topstukken`, `fragmenten`); the even older `/32/middeleeuwse-manuscripten/<slug>` URLs are **dead**. Treat manifest URLs as opaque, never hard-code a base. The maintained overview of available manifests is an Excel on the KB SharePoint (De Werkplaats, via Tamara Kiewiet — see the Notion/Obsidian project page).
- **CORS is open** (`Access-Control-Allow-Origin: *`) on both manifest hosts and on the image API (`dlc.services/iiif-img/…`), including full-res JPEGs — the browser fetches everything directly, no backend needed. (Note: the ACAO header is only emitted when the request carries an `Origin` header — probe accordingly.)
- Image service enforces `maxArea: 25000000`; `/full/max/0/default.jpg` returns native resolution below 25 MP, server-side downscale above.
- 25 sample manifests are checked in under `__inputs/manifests/` (named `<signature> - <short title>.json`). Known upstream data defects to guard against: all-"Lorem ipsum" metadata, empty summaries, manifests with **zero canvases** (KW 79 K 21), canvas order ≠ label numbering (KW 76 E 5).
- Machine note: on the KB Windows machine, `curl` needs `--ssl-no-revoke` (corporate network blocks revocation checks) and `iiif.kb.nl` doesn't resolve on the internal DNS.

## Repository & deployment

| Concern | Location |
|---|---|
| Source code | GitHub, public repo [`KBNLwikimedia/iiif-manifest-upload-workbench`](https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench) |
| On-wiki (Commons) | Homepage/docs: [`Commons:IIIF Manifest Upload Workbench`](https://commons.wikimedia.org/wiki/Commons:IIIF_Manifest_Upload_Workbench). Project category: [`Category:IIIF Manifest Upload Workbench`](https://commons.wikimedia.org/wiki/Category:IIIF_Manifest_Upload_Workbench). Uploaded files (hidden tracking subcat, applied by `publish.js`): [`Category:Uploaded with IIIF Manifest Upload Workbench`](https://commons.wikimedia.org/wiki/Category:Uploaded_with_IIIF_Manifest_Upload_Workbench). Edit summaries link to the homepage as a wikilink. |
| Upstream | `gitlab.wikimedia.org/daanvr/upload-workbench` (GitLab; live at https://upload-workbench.toolforge.org/). This fork does **not** push there. |
| Deployment | **Local dev only for now** (`npm run dev` + `VITE_OWNER_ACCESS_TOKEN`). Own Toolforge tool + own OAuth consumer registration are deferred until the ingestor works end-to-end. Upstream's `.gitlab-ci.yml` is archived at `docs/upstream-gitlab-ci.yml` for reference — do not resurrect it as-is; it rsyncs to *Daanvr's* Toolforge project. |
| Issue tracking | GitHub issues on the fork repo (upstream uses Phabricator `#tool-upload-workbench` — that board is for upstream work only, don't file fork tasks there) |
| Design doc / project inputs | `__inputs/` (design doc, sample manifests, sample images, original product-vision conversation) |
| OAuth registration docs | `docs/oauth-registration.md` (upstream's; will need a fork-specific consumer when Toolforge deployment happens) |

### Identity (fork rebrand — mostly done 2026-07-08)

The app is rebranded to **IIIF Manifest Upload Workbench** across the user-facing surfaces: `index.html` `<title>` + favicon + local logo (`public/app-logo.png`), topbar brand, login screen, About modal (`info-modal.jsx`, GitHub links, GitLab/Toolforge version+MR sections removed), Feedback modal (→ GitHub issues), `src/config.js` `APP_USER_AGENT` + `attributionSuffix()` (→ plain-text GitHub URL, no Toolforge interwiki), the user-store subpages (`User:<u>/IIIFManifestUploadWorkbench/*.json`, auto-migrating from the old `UploadWorkbench/` folder), and the publish tracking category (`Category:Uploaded with IIIF Manifest Upload Workbench` — page not yet created on Commons, see open-issues). Every modal header shows the app icon via `.modal__head::before`.

**Still pointing at upstream** (tracked in OI-10): `src/ui/version-chip.jsx` (topbar build dropdown — fetches upstream GitLab MRs/changelog, links Toolforge version URLs), `src/ui/error-report-modal.jsx` ("Report this error" flow — Phabricator/GitLab), and `docs/oauth-registration.md`. The OAuth consumer registration itself waits for OI-09 (Toolforge deployment).

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
  - `iiif.js` — IIIF Presentation 3.0 fetch/validate/parse (defensive; zero imports so Node runs it — `scripts/test-iiif-parser.mjs`)
  - `iiif-map.js` — manifest → workbench draft fields + `{{Artwork}}` params + SDC inputs (`scripts/test-iiif-map.mjs`)
  - `iiif-pipeline.js` — sequential download → SHA-1 → dedupe → stash, with retry/backoff, save-suspension checkpoints, shared-draft dedup
  - `wikidata.js` — P217 signature lookup (+ P373 category / P935 gallery / sitelink), `resolveQid()` redirect resolution
  - `retry.js` — pure error-classification + `withRetry` backoff (badtoken/auth/transient/fatal)
  - `commons.js` also gained the OI-68 helpers: `findManuscriptCategoryVariants()`, `searchCategoriesFullText()`, `categoryParents()`, `createCategoryPage()`
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
   - `User:<self>/IIIFManifestUploadWorkbench/Preferences.json` — `requiredFields`, `columnDefaults`, `fieldOrder`, custom props
   - `User:<self>/IIIFManifestUploadWorkbench/Metadata.json` — `drafts` (per-file edits, keyed by sha1/filekey), `filenames` (filekey → readable name), `hiddenFilekeys`, `history` (cache: `lastSyncedAt` + `items[]`)
   - Loaded once on bootstrap; writes are **debounced 3 s** then `action=edit`.
   - IIIF-imported drafts ride this same mechanism (design decision Q11) — batched, never one edit per draft.

### Authentication

OAuth 2.0 with PKCE (Authorization Code flow, public client), authorization server `meta.wikimedia.org`. Token storage prefix `uwb_`.

- **Local dev (current mode):** set `VITE_OWNER_ACCESS_TOKEN` in `.env.local` to short-circuit the PKCE flow entirely (owner-only consumer token). Without any `VITE_OAUTH_CLIENT_ID`, the app boots in `DEMO_MODE` against `SAMPLE_UPLOADS`.
- **Owner-only consumers cannot serve the "Log in with Wikimedia" (PKCE) flow** — the authorize endpoint rejects them with *"Client authentication failed (unknown client / unsupported authentication method)"* (verified 2026-07-07). The interactive login needs a **public** consumer ("for use only by [owner]" **unchecked**), which requires Wikimedia admin review (days–2 weeks). Until one is approved, local dev uses the owner token.
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
| Read user-store page | `action=query&titles=User:<U>/IIIFManifestUploadWorkbench/Metadata.json&prop=revisions&rvprop=content&rvslots=main` |
| Write user-store page | `action=edit&title=User:<U>/IIIFManifestUploadWorkbench/Metadata.json&contentmodel=json` |
| CSRF token | `action=query&meta=tokens&type=csrf` |
| IIIF manifest (KB) | `GET https://presentation-api.dlc.services/32/<slug>` (CORS `*`) |
| IIIF full-res image | `GET {imageService}/full/max/0/default.jpg` (CORS `*`, 25 MP cap) |
| Wikidata item by signature | SPARQL `?item wdt:P217 "<sig>"` on query.wikidata.org |

## Observability — finding edits made by the tool

- Edits made via `VITE_OWNER_ACCESS_TOKEN` (the current dev mode) do **not** carry an OAuth CID tag — they show up under your username with only MW's automatic tags, plus the edit-summary attribution suffix (`attributionSuffix()` in `src/config.js`).
- The change tag **`OAuth CID: 18016`** belongs to *upstream's* production consumer — useful when studying upstream-made edits, irrelevant to this fork until it registers its own consumer.
- A user-store page's history (`?action=history` on `User:<U>/IIIFManifestUploadWorkbench/Metadata.json`) is a debug log of how drafts/cache evolved over time.

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
- **Content blockers kill the IIIF pipeline with a bare "Failed to fetch".** NoScript blocked the cross-origin image downloads from dlc.services and made 79/79 imports fail while the identical import ran clean in an unextended browser. The import report lists per-error breakdowns precisely for this class of problem; when every page fails instantly with `Failed to fetch`, suspect the user's browser extensions/tracking protection before the code. (Support case, 2026-07-07.)
