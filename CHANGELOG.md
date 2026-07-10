# Changelog

All notable changes. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [SemVer](https://semver.org/) (`MAJOR.MINOR.PATCH`).

> **Fork note (2026-07-07):** from this point on this changelog tracks **IIIF Manifest Upload Workbench**, Olaf Janssen's fork of [upload-workbench](https://gitlab.wikimedia.org/daanvr/upload-workbench), forked at **v0.39.0**. Every entry from v0.39.0 down is upstream history by Daanvr — their MR/Phabricator links point at the upstream GitLab/Phabricator projects, and those releases auto-deployed to upload-workbench.toolforge.org. The fork has no auto-deploy; a release is a tagged, changelogged state. See `CLAUDE.md` → "Working with the codebase".

## [Unreleased]

### Fixed

- **Esc / backdrop-click no longer destroy the import wizard** (OI-31 #31, OI-70 #70) — both dismissed the whole modal on any step, silently discarding the manifest, lookups and edits (or, on step 1, a typed URL). They now close only on the `done` step; everywhere else the explicit × is the only way out (same policy as the lightbox).
- **"Gallery" link no longer shown for a `Category:` sitelink** — a Wikidata item whose only Commons link is a category-namespace sitelink (e.g. Q114989690 / KW 70 H 19) was presented as having a gallery; the sitelink is now rerouted to the category slot.
- **"Choose a manifest .json file" label text vertically centered** — the `.iiif-file-btn` display override dropped `.btn`'s flex centering.
- **Stale header comment in `iiif-map.js`** (OI-61 #61) — cited the pre-revision Q4 license and described the Phase 5.2 Artwork extras as future work; both now match the shipped code.
- **Hover-zoom no longer bursts rendition requests** (OI-47 #47) — the gallery's 700 px zoom panel now waits for a ~250 ms intent delay (sweeping the grid fires zero requests), dismisses on scroll (it went stale over the wrong tile), and clears on step change.

### Changed

- **Select step: pinned header, scrolling grid** — the >25 MP note and the Select all/none/invert toolbar stay put; only the thumbnail grid scrolls. The note is now dismissible (small ×, returns on the next manifest load) and its lead clause ("N of M images are larger than 25 megapixels") is bold. Step title: "Select images for importing into Wikimedia Commons".
- **Ready-to-import header restructured** — identity line, blank line, then "**N images** will be downloaded…" and "An **estimate of ~X MB** will be transferred." each on their own line; header identity line reads "… — N images in this manifest".
- **Wizard: the "N of M images selected" counter moved into the select-step toolbar**, right-aligned next to Select all / Select none / Invert selection; the header stays identity-only there.
- **Wizard: hoverable ⓘ on the "Aantal folia" row** explaining folium (physical leaf, recto + verso) vs the manifest's image count (covers/flyleaves photographed too; some manuscripts digitized as two-page spreads).
- **Wizard input step now states that only IIIF Presentation 3.0 is supported for now** — 2.x support will be added in the future (OI-07 #7).
- **Wizard wording: "pages" → "images" everywhere** — a canvas is a photograph, not a manuscript page (KW 73 J 6: 96 canvases, 89 folia — digitized as two-page spreads), so "N pages" misled about what gets uploaded. Renamed in step titles, header lines, buttons, 25 MP notes, lightbox, progress and pipeline/report messages.
- **Feedback-form issues are now labelled `user feedback`** on GitHub (plus the type label bug/enhancement), so form-originated reports are traceable — new repo label created.
- **Wizard: manifest title shown as the first row of the metadata passport** (above Summary), so the review table is self-contained.
- **Wizard header: the manuscript identity line ("Title (signature) — N pages") now stays on every step** past input; step-specific info (selection count, transfer estimate, progress) moved to a second line.
- **Wizard, Wikidata section redesigned** — the cramped "Found by signature: ✓ Q… · Gallery ↗ · Category ↗" line became a structured match panel (blue-tinted sibling of the amber existing-category box): "Found on Wikidata by signature ⓘ" head (tooltip explains the P217 match), a "✓ in use" chip or a real "Use this item" button per candidate, the Q-id + label as one Wikidata link, and an explicit provenance line "This Wikidata item also links to: its gallery on Commons (P935) · its category on Commons (P373)". The no-match message now names the signature it searched for.
- **Wizard, Wikidata section**: removed the "Feeds digital representation of (P6243) + depicts (P180)" hint — developer-facing property plumbing that added noise to the review step.

---

## [0.40.0] — 2026-07-10

The IIIF-ingestor milestone: the import funnel is complete and hardened end-to-end (design Phases 0–5.2), the wizard's review step got a full UX overhaul, and the backlog moved to GitHub Issues. Everything below is fork work on top of upstream v0.39.0.

### Added

- **Review-step overhaul (2026-07-09/10)** — the "Check the manifest" step restructured for clarity and inspection:
  - **Grouped sections**: all category controls in a legended **Categories** fieldset; the Wikidata item + candidates in a **Wikidata** fieldset (the P6243/P180 "feeds" note moved under the found-by-signature line).
  - **Editable parent category** with the same Commons autosuggest as the main field, **Set as default** (persisted in `localStorage`) / **Reset to default** with the current default shown — the chosen parent flows through to the publish-time category creation.
  - **Thumbnail carousel** over *all* canvases (lazy-loaded, page-numbered 1…N, compact ‹ › nav), with a **lightbox**: click to enlarge (1200 px IIIF rendition), ‹ ›/arrow-key navigation, ±2 neighbour preloading so stepping feels instant, a delay-gated loading spinner, close via × only.
  - **"View manifest (JSON)"** — a raw-manifest inspector (pretty-printed, scrollable, Copy button).
  - Polish: "Suggested category for this manuscript" label; the "already exists on Commons" hint links to the category; the 25 MP downscale note is stated once (with counts, on the select step); the empty report box is hidden when there's nothing to report.
- **Find the manuscript's existing Commons category under another name (OI-68)** — the suggested per-manuscript category often doesn't exist while the manuscript already has one under a different name. When the suggestion is missing, the Categories panel searches three verified sources and leads with the result ("**This manuscript seems to already have a Category:Armorial de Beyeren on Commons** — use it instead of creating a new category …", with a real **Use this category** button): (A) the Wikidata item's **P373** (most authoritative — e.g. KW 76 E 5 → `Den Haag KB 76 E 5`), (B) generated KB **naming-convention variants** existence-checked on Commons, and (C) a **full-text category search** (by title + signature) filtered to only categories filed under the KB parent — which kills search noise and finds cases the suggestion/P217-lookup can't, e.g. KW 79 K 11 → `Bout Psalter-Hours KB 79K11` (its P217 is "KB 79 K11", so the signature lookup alone misses it). Each hit carries a plain-language source badge with an explanatory tooltip (via Wikidata / via name match / via search); adopting one replaces the suggestion (a manuscript gets exactly one category, decided 2026-07-09); keeping the suggestion is framed as the explicit fallback ("…it'll be created for you when you publish the first page"), so the old contradictory "does not exist / already exists" messaging is gone. Wikidata candidates link their **Gallery ↗** (P935, the dedicated Commons-gallery property, sitelink as fallback) and **Category ↗** (P373). Manually-entered Q-ids are resolved through Wikidata redirects (merged items, e.g. Q114990994 → Q16641064) to the canonical item, and a failed Wikidata lookup is retry-able instead of reading as a false "no item found".
- **Placeholder-field review in the import wizard** — instead of silently dropping metadata whose value looks like a placeholder ("Lorem ipsum", "Onbekend", "-", …), the manifest passport now shows every field, marks the placeholder-looking ones with an orange ⚠️, and gives each a ✕ toggle to drop it from the import (↺ to restore). Such fields are imported by default (nothing is lost) but one click removes the junk ones from the mapped wikitext/SDC. The review step also gained a first-page preview thumbnail.
- **IIIF ingestor project started** — fork established (GitHub, `iiif-commons-upload-workbench`), design document with approved 6-phase build plan and full decision log at [`__inputs/iiif-ingestor-design.md`](__inputs/iiif-ingestor-design.md); 25 sample KB manuscript manifests under `__inputs/manifests/`.
- **IIIF manifest parser** (`src/api/iiif.js`) — fetch/validate/parse for IIIF Presentation 3.0 with a three-level validation report; corpus harness `scripts/test-iiif-parser.mjs` (24/25 KB manifests parse clean, the zero-canvas one is correctly rejected).
- **IIIF → workbench metadata mapper** (`src/api/iiif-map.js`) — manuscript- and canvas-level mapping to draft fields: derived short titles, `Title - KW sig - canvas-label` filenames (collision-safe), per-manuscript category proposal, `{{PD-Art|PD-old-100-expired}}` license, `{{other date|…}}` date conversion, `{{Size}}` dimensions, `{{unknown|author}}` handling, compact nl captions, and SDC statement inputs under `item.iiif`. Corpus harness `scripts/test-iiif-map.mjs`.
- **Wikidata signature lookup** (`src/api/wikidata.js`) — finds the manuscript's Q-id by shelfmark (P217 SPARQL, cached), returning candidates for user confirmation.
- **"Import IIIF manifest" wizard** (`src/ui/iiif-import-modal.jsx` + topbar button) — five steps: URL/file entry, validation report + manuscript passport + editable title/category/Wikidata settings, canvas gallery with IIIF thumbnails and selection, confirm recap, sequential import run with progress/abort/report.
- **IIIF import pipeline** (`src/api/iiif-pipeline.js`) — per selected canvas: download full-res → browser SHA-1 → Commons duplicate check (stash anyway + flag) → stash upload → normalized table row with all prefills persisted as sha1-keyed drafts. Imported rows show real previews via the public IIIF thumbnails. Idempotent re-imports (same sha1 coalesces).
- **Category creation** (`createCategoryPage()` in `src/api/commons.js`) — the per-manuscript home category under *Medieval manuscripts from Koninklijke Bibliotheek* is created **at publish time**, right before the first approved page goes live (never at import), and only after an **explicit approval checkbox** in the confirm step. An aborted/discarded import leaves nothing on Commons.
- **Wizard polish** — canvas gallery full-detail tooltips (label + target filename + delivered size) and a hover-zoom preview (larger IIIF rendition); the confirm step lists **every** target filename in a scrollable box; the manifest **summary** shows in the passport; license/date/template recap; clickable license URLs; the Wikidata candidate links to the item.
- **Commons-style category combobox** — the category field live-checks existence on Commons (grayed while checking; green-bold "already exists"), and offers a dropdown of matching existing category names with progressive-trim prefix search (keyboard + mouse selectable).
- **PD-Art license as a first-class option** — `{{PD-Art|PD-old-100-expired}}` is now a licence-catalog entry (the IIIF import default), with a **"Reset to default"** action in the detail-panel licence field. Imported rows use the **{{Artwork}}** template (switched on Start import).
- **Institution field** — a curated chooser for the `{{Artwork}}` `|institution=` parameter (one value for now: `{{Institution:Koninklijke Bibliotheek, Den Haag}}`), available as a column and in the detail panel.
- **Clear entire stash** — a header action that bulk-hides all stash rows (undoable) and links to `Special:UploadStash` for a true server-side wipe (MediaWiki has no stash-delete API). "Import IIIF manifest" also appears on the empty-stash hero.

### Changed

- **IIIF-only entry point (2026-07-08)** — removed the general-purpose "Browse files" upload buttons from the topbar and the empty-stash hero; "Import IIIF manifest" is now the single blue primary action in both places, and the empty-hero copy is reoriented around importing a IIIF Presentation 3.0 manifest. (Window-level drag-drop of plain images still works pending a follow-up.)
- **Repo renamed to match the tool name (2026-07-08)** — the GitHub repository, local folder, and `package.json` `name` moved from `iiif-commons-upload-workbench` to **`iiif-manifest-upload-workbench`**, so the slug matches the tool's name *IIIF Manifest Upload Workbench* (GitHub keeps permanent redirects from the old URL). In-code GitHub URLs (`src/main.jsx`, `src/ui/feedback-modal.jsx`, `src/ui/info-modal.jsx`), the `APP_USER_AGENT` repo URL (`src/config.js`), `urls.txt`, `CLAUDE.md`, and `README.md` updated to the new slug. Historical decision-log and changelog entries keep the original slug on purpose (the fork *was* created as `iiif-commons-upload-workbench` on 2026-07-07).
- **Repo identity updated for the fork** — `CLAUDE.md` and `README.md` rewritten (fork lineage, IIIF focus, GitHub/local-dev workflow replacing upstream's GitLab/Phabricator/Toolforge workflow); `package.json` renamed to `iiif-commons-upload-workbench`; `urls.txt` refreshed; upstream's `.gitlab-ci.yml` archived to `docs/upstream-gitlab-ci.yml` (it deploys to Daanvr's Toolforge project and must not run for this fork). In-app identity (`APP_USER_AGENT`, `index.html` title, `attributionSuffix()`) deliberately unchanged until the fork registers its own OAuth consumer — see `CLAUDE.md` → "Pending identity renames".
- **KB IIIF endpoint update** — the canonical manifest base is now `https://iiif.bibliotheken.nl/<slug>` (June 2026); `presentation-api.dlc.services/32/<slug>` still works in parallel. The parser is base-agnostic.
- **Fork rebrand to "IIIF Manifest Upload Workbench" (2026-07-08)** — `index.html` title + favicon + local logo (`public/app-logo.png`, in every modal header); topbar brand + "Browse files"/"Import IIIF manifest" buttons; login screen and About modal (GitHub links, GitLab/Toolforge version+MR sections removed); Feedback button → GitHub issues; `APP_USER_AGENT` + `attributionSuffix()` → GitHub; publish tracking category → `Uploaded with IIIF Manifest Upload Workbench`. User-store pages moved to `User:<u>/IIIFManifestUploadWorkbench/*.json` with automatic migration from the old folder.
- **Licence + template for IIIF imports** — `{{PD-Art|PD-old-100-expired}}` is a first-class licence-catalog option (detail panel gains "Reset to default"); imports auto-select the `{{Artwork}}` template.
- **Category creation deferred to publish time** — the per-manuscript category is created only when the first page is published, on explicit approval in the wizard (never at import).
- **Import wizard polish** — drop a manifest `.json` onto the app to open the wizard; wider responsive modal; Invert selection; per-tile native dimensions + full-res links; `>25 MP` badge overlay + plain-language downscale explanation; Commons-style category autosuggest dropdown with live existence check (immediate first check + timeout guard); linked Wikidata properties + clickable recap links.

### Fixed

- **Published `{{Artwork}}` now carries the full manuscript metadata (OI-01 + OI-02, Phase 5.2)** — the mapper derived `medium` (Materiaal), `dimensions` (`{{Size}}` from Afmetingen), the accession number (signature), and date wikitext (`{{other date|circa|1538}}`) all along, but none of it could reach the rendered wikitext: the params had `key: null`, and `formatDate()` truncated every date to 10 characters (which would mangle date wikitext to `{{other da`). Now: only ISO dates are cut to day precision (anything else passes through untouched); `medium`/`dimensions`/`accession number`/`department` have real keys backed by first-class draft fields (persisted, and deduped across a batch by the shared-record mechanism); and the accession param is spelled `accession number` — the form Commons' {{Artwork}} actually recognises (the inherited `accession_number` was never a valid alias, but also never rendered). `department` stays empty for KB manifests (no source field — a future OI-67 catalogue-enrichment candidate).
- **Large imports survive transient failures (OI-26, import path)** — the IIIF import pipeline used to have no resilience: one network drop, HTTP 5xx, `ratelimited`, `maxlag` replag, or a rotated CSRF token at page 300/500 failed that page *and every page after it*, and an expired session surfaced as hundreds of identical errors. Now each download and stash upload retries transient failures with exponential backoff (honouring `Retry-After`); the CSRF token refreshes once on `badtoken`; uploads send `maxlag=5`; an auth failure aborts the whole batch with a single "Session expired — log in and re-run; stashed pages are kept" message; and the run stops after 5 consecutive failures instead of grinding through all 500 pages. A re-run skips already-stashed pages (sha1 dedupe). New `src/api/retry.js` (20 unit tests). *(The publish path `publishMany` still needs the same treatment — tracked on OI-26.)*
- **Browser Back no longer silently jumps to the OAuth approval screen (OI-65)** — because the PKCE login navigates the tab to meta.wikimedia.org, the OAuth approval page sat in history behind the app, and pressing Back at any stage landed on it silently (breaking the workflow, risking in-progress import work). The app now shows the browser's "Leave site?" confirmation on **any** leave attempt — Back, reload, or closing the tab — so leaving is always a deliberate choice; Cancel keeps you in the workbench. Already-stashed files were never at risk (they live server-side); this protects the in-flight import and the current view.
- **Manifest text can no longer inject wikitext (OI-27, security)** — manifest-derived caption, author, and source-URL text reached the rendered `{{Artwork}}` with the wiki structural characters `{ } [ ] |` unescaped, so a hostile `Inhoud`/author like `foo}}[[Category:Hoax]]{{Delete|1=x}}` could publish those templates and categories into the file description. Free text is now entity-encoded at the right layer: captions at the wikitext render boundary (the stored/editable/SDC value stays raw), author names and the source URL at the mapper. Values that also feed structured data (accession/inventory number → P217) and mapper-authored templates are deliberately left untouched, so clean metadata renders exactly as before.
- **Wrong Wikidata item can no longer attach from a stale lookup (OI-30)** — loading one manifest, going back, and loading another could let the first (slower) signature lookup resolve last and stamp its Q-id onto the second manifest, or overwrite a Q-id typed by hand. The lookup is now tokened per parse and only auto-fills an empty field.
- **Manifests with `Choice` image bodies now import (OI-34)** — a IIIF v3 painting annotation may wrap alternate image versions in a `{type:'Choice', items:[…]}` body; the parser tested the wrapper for `type:'Image'`, never descended, and skipped the canvas — so a spec-valid manifest could import zero canvases. It now flattens the Choice, and also accepts an image annotation that omits `motivation` (while still excluding non-painting motivations like `supplementing`).
- **Duplicate canvas labels can no longer collide into one filename (OI-35)** — the collision-suffix counter checked the pre-suffix base but never registered the suffixed result, so labels like `["p1","p1","p1 (2)"]` produced two identical `… p1 (2).jpg` targets (a publish-time `fileexists` or wrong-page overwrite). Uniqueness is now checked against the final name.
- **`Metadata.json` no longer balloons on bulk imports — and can't fail silently at the 2 MB cap (OI-38)** — manuscript-level fields (author, source, license, institution, categories…) used to be duplicated into every canvas draft (~1 KB × 500 canvases); they're now stored once per import as a `sharedDrafts` record, with each canvas draft holding only its own deltas (title, caption, thumb URL) plus a `_shared` pointer. `setDraft` strips redundant fields on any write path (user edits included), reads expand transparently, and orphaned records are pruned after publish. ~2.2× smaller (500 canvases: 439 → 196 KB), raising the unpublished-draft ceiling from ~2,200 to ~5,000 canvases under MediaWiki's 2 MiB page cap. A new size guard also fails a too-large store fast with an actionable message in the save-status chip instead of the previous silent `contenttoobig` API failure.
- **Bulk imports no longer spam `Metadata.json` with ~500 edits (OI-25, Critical)** — `setDraft`'s 3 s debounce used to fire in the gap between every imported canvas, so a 500-page manifest wrote ~500 wiki edits. The user-store now supports `suspendSaves()`/`resumeSaves()` (ref-counted, with a per-store `dirty` flag); the import pipeline suspends saves for the whole batch, flushes once in a `finally`, and checkpoints every 25 items — ~21 edits for 500 canvases instead of ~500, honouring design Q11 and CLAUDE.md's "wiki edits are the most expensive operation".
- **IIIF previews survive reloads** — imported rows persist the public IIIF thumbnail (`iiifThumbUrl` draft field), so they don't fall back to placeholder tiles after a reload (the stash's own thumb URLs require session auth an `<img>` can't send).
- **License no longer flags "missing" on import** — the mapper now sets the row's `license` to the PD-Art catalog id (recognised by the dropdown) instead of raw wikitext.

### Notes / known issues

- The backlog lives in **[GitHub Issues](https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench/issues)** (migrated 2026-07-08 from `__inputs/open-issues.md`, which stays as the annotated archive; `OI-NN` ↔ `#NN` line up 1:1). The 2026-07-08 multi-agent code review recorded 37 findings; the hardening pass in this release closed the Critical (OI-25, confirmed in production) and the highest-value High/Medium items (see *Fixed*). Notable still-open items: OI-26's publish-path retry (lands with Phase 6), OI-28/29/31/32/33 (import edge cases + bootstrap request storms), OI-44/OI-48.
- **Phase 5 remaining:** SDC statements (`buildSdcClaims` extension — P6243/P180/P195+P217/P6216/P275/P7482 + captions). **Phase 6:** end-to-end publish verification. Designed-and-parked: OI-67 (KB-catalogue enrichment via P528/PPN — blocked on a CORS ask for `jsru.kb.nl`).
- Not authenticated interactively: owner-only OAuth consumers can't serve the PKCE "Log in with Wikimedia" flow — a public consumer (admin review) is needed (OI-09). Local dev uses `VITE_OWNER_ACCESS_TOKEN`.

---

## [0.39.0] — 2026-05-16

- **MR**: [!59](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/59)
- **Phabricator**: [T426449](https://phabricator.wikimedia.org/T426449)

### Added

- **Four new built-in wikitext templates: `{{Map}}`, `{{Art photo}}`, `{{Specimen}}`, `{{Musical work}}`** ([T426449](https://phabricator.wikimedia.org/T426449)). The Templates tab now covers the eight primary Commons file-description templates instead of four — `Information`, `Photograph`, `Artwork`, `Book`, `Map`, `Art photo`, `Specimen`, `Musical work`, ordered by prevalence. Each new template carries its full named-parameter list from the docs page (e.g. `{{Map}}` exposes ~36 params including `projection`, `scale`, `warp status`, `latitude/longitude`); params that map to existing workbench columns (`description`, `author`, `dateTaken`, `objectLocation`, `source`) auto-fill at publish, the rest stay unmapped (rendered as documented-but-empty rows in the parameter table). The published-wikitext renderer is unchanged — `renderTemplateBlock` walks `fields[]` for whichever id is selected.
- **Templates tab redesigned as an expandable list** ([T426449](https://phabricator.wikimedia.org/T426449)). The previous radio-card grid is replaced by an inline list where each row collapses to `{{Name}} — one-line use-case`; clicking expands to a "Use this template" action, a live wikitext preview rendered against sample data, a per-parameter table (`|param=` → workbench column + required/optional badge + the docs-page expected-value hint), and a deep link to the Commons docs page (`Template:<Name>`, with per-param `#<param>` anchors). The currently-selected template auto-expands on open and carries a left-rail indicator + "selected" pill in collapsed state so the active choice is always scannable. The recommended-columns + "Add N columns" suggestion block lives inside each expanded row, so the Add-flow is contextual rather than detached.

### Removed

- **The custom-wikitext-template escape hatch is gone** ([T426449](https://phabricator.wikimedia.org/T426449)). Four surfaces deleted: the `Custom template` radio card in the Templates tab, the inline `+ Add custom wikitext-template column` form at the bottom of the Columns tab (`CustomColumnCreator`), the "Custom wikitext-template column" entry-point on the "+ Add column" popover that shipped in v0.32.0 ([T426421](https://phabricator.wikimedia.org/T426421)/!49), and the user-creatable `kind: 'template'` custom-column path. The enumerable-templates catalogue above is now the only way to control the wrapper wikitext — no more "type wikitext template syntax manually" UX. Back-compat for users with a stored `wikitextTemplate = { id: 'Custom', body, fields }`: `resolveTemplate` silently falls back to `{{Information}}` on load, and any `customProps` of `kind: 'template'` are filtered out of `getAllColumns` at render time (their JSON stays on the user's Preferences.json wiki page — nothing is deleted server-side, the user can recover values by inspecting the page if they ever need to). Touches: `src/wikitext-templates.js` (removed Custom branch in `resolveTemplate` + the `placeholder` relation kind), `src/columns-modal.jsx` (deleted `CustomColumnCreator` + redesigned `TemplatesPanel` + dropped the `initialCustomFormOpen`/`onAddTemplateColumn` props), `src/table.jsx` (removed `addTemplateColumn` + the template-column cell editor + the template-column CellView placeholder branch + the AddColumnPopover custom-wikitext entry), `src/api/publish.js` (deleted `buildCustomTemplateWikitext` and the `templateColumns` plumbing through `buildWikitext`/`publishOne`/`publishMany`), `src/app.jsx` + `src/ui/{publish-modal,bulk-publish-modal,wikitext-preview-modal}.jsx` (dropped the `templateColumns` prop everywhere it was passed).

---

## [0.38.0] — 2026-05-16

- **MR**: [!56](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/56)
- **Phabricator**: [T426454](https://phabricator.wikimedia.org/T426454)

### Added

- **Always-visible Feedback button** ([T426454](https://phabricator.wikimedia.org/T426454)). A floating "Feedback / Beta" pill anchored to the **top-centre** of the viewport (sitting just inside the topbar area on the main app, standalone on login / boot-error screens) opens a feedback modal with an encouraging "the tool is in beta — your feedback is unusually valuable" prompt. The modal reuses the same `window.open` plumbing as the v0.28.0 "Report this error" flow ([T426408](https://phabricator.wikimedia.org/T426408)) — two submission paths (pre-filled Phabricator task with `projects=tool-upload-workbench`, or section-new edit form on `User talk:Daanvr` on Commons with the body copied to clipboard since MediaWiki's URL pre-fill for body content uses `preload=` rather than literal text), no new OAuth scopes, body editable before submitting. Differences from the error-report flow: encouraging tone instead of "report this error", submit buttons disabled until the user types something. The modal includes:
  - A **Type of feedback** radio-group (Bug / Suggestion / Question / Praise) that shapes the heading in the body, the textarea placeholder, and the set of inspirational prompts surfaced above the input. Bug is the default.
  - **Inspirational-question chips** above the textarea (e.g. "What I was doing", "What I expected", "What happened instead", "How to reproduce" for the Bug type) — clicking a chip inserts a small Markdown-flavoured scaffold at the cursor so a user who isn't sure what to type still ends up with a structured report instead of a one-liner.
  - **Richer auto-attached environment context** for troubleshooting: build/version + deploy target, current URL, signed-in username, stash item count, history item count, viewport size, browser language, timezone, timestamp, full user agent, plus any non-fatal load errors from the current session (stash or history fetch failures).
  - The Phabricator task title is now prefixed with the chosen feedback type — e.g. `[Bug] caption …` — so the workboard surfaces report kinds at a glance.

  A small `window.uwbDiagnostics` getter exposed from `<Bootstrap>` lets the modal pull a current snapshot of user/items/loadErrors without React-prop wiring (the FAB is mounted at `<Root>` outside `<ErrorBoundary>` so it survives a render crash). The button is mounted at the `<Root>` level so it's visible on every screen — login, loading, the main app, and even when the boot-error panel is shown (overlaps with the existing "Report this error" button there, which is intentional — both channels are useful for different framings of the same complaint). Narrow viewport (≤640px) collapses to icon + Beta pill only.

---

## [0.37.0] — 2026-05-16

- **MR**: [!52](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/52)
- **Phabricator**: [T426422](https://phabricator.wikimedia.org/T426422)

### Added

- **Per-language Caption columns** ([T426422](https://phabricator.wikimedia.org/T426422)). The Caption column header chevron menu now offers "Change language" (swap this column to a different language) and "Add another caption column" (insert a new Caption column for a second / third / … language); both pickers hide languages already on screen so two visible Caption columns can never share a language. Any caption column can be removed from the table (via the header menu's "Remove this caption column" entry, or the columns modal eye toggle), with a confirmation that surfaces the count of files whose caption text in that language will be discarded — guarding against silent data loss while still letting the user trim columns they don't need. At least one caption column must always remain visible (the menu entry hides itself, and the eye toggle refuses with an explanatory alert, when this is the only one). Re-uploading a file whose previous edits included captions in additional languages auto-promotes those languages back to visible columns on first paint, so the user can never end up with caption values stored against a file that isn't visible in the table. The published wikitext emits one `{{<lang>|1=…}}` block per non-empty caption language, in the order shown in the table; rows that already carried multilingual SDC labels (M-entity captions) populate every language slot on first paint. Per-language captions are persisted via the existing `Preferences.json` + `Metadata.json` user-store pages — column visibility/order/widths flow through `columnState` exactly like any other column, and per-language draft text rides on the new `descriptions` map in the row draft, so the choice + count + edits all roam across reloads and devices. Curated v1 catalog covers 24 common Commons languages; expandable as needed.

---

## [0.36.0] — 2026-05-15

- **MR**: [!58](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/58)
- **Phabricator**: [T426450](https://phabricator.wikimedia.org/T426450)

### Changed

- **Read-only EXIF cells (camera, lens, focal length, ISO, aperture, shutter) now render as fixed chip pills** ([T426450](https://phabricator.wikimedia.org/T426450)) — replacing the previous greyed-out "uneditable" rendering with a chip-shaped affordance that visually aligns with the chip primitive landing in [T425887](https://phabricator.wikimedia.org/T425887)/!54. The chip can't be removed and can't be edited (the value is baked into the file's binary EXIF block — the workbench has no way to suppress it), and clicking it opens an info popover that names the field, shows the value, explains why it can't be removed, and lists every other raw EXIF tag the API surfaced for the file. `src/api/normalize.js` now preserves the full `{name, value}` raw EXIF list on each item as `rawExif` (derived-runtime only — never persisted to the user-store wiki page).

---

## [0.35.0] — 2026-05-15

- **MR**: [!57](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/57)
- **Phabricator**: [T426455](https://phabricator.wikimedia.org/T426455)

### Added

- **One-time CC0 acknowledgment modal** ([T426455](https://phabricator.wikimedia.org/T426455)). On first paint after login the workbench now shows a small dialog explaining that drafts and preferences are saved to two public Commons user-subpages (`User:<self>/UploadWorkbench/Preferences.json` and `Metadata.json`), and that this content is dedicated CC0 by intent of the maintainer. Two buttons: **"I agree — remind me next session"** records the acknowledgment but reprompts on the next session, and **"I agree — don't remind me again"** records it permanently. Pressing Esc / clicking the backdrop dismisses without recording — the modal will reappear on the next session. Persisted as a single new key on `Preferences.json`: `cc0Acknowledgment: { acknowledgedAt: <ISO>, suppressFurther: <bool>, version: 1 }`. The version field allows future copy/scope changes to re-prompt previously-suppressed users by bumping `CC0_ACK_VERSION` in `src/ui/cc0-modal.jsx`. DEMO_MODE skips the modal entirely (no auth, no wiki writes). Pre-existing users see the modal once on next visit — intentional, so they get a chance to acknowledge retroactively.

---

## [0.34.0] — 2026-05-15

- **MR**: [!50](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/50)
- **Phabricator**: [T426424](https://phabricator.wikimedia.org/T426424)

### Added

- **Caption column ↔ Title column linking** ([T426424](https://phabricator.wikimedia.org/T426424)). A small chain icon appears on the **Caption cell of every row** when the Title column sits immediately adjacent to it (in either direction). Clicking it copies that row's title straight into the caption — no menu, no template, no confirmation — so the user can seed the caption from the title in one click and edit from there. The trailing ` #` sequence placeholder ([T425984](https://phabricator.wikimedia.org/T425984)) is stripped from the substitution. The Caption column header dropdown gets a matching "Fill blanks from Title" item as the always-available column-level path: one click fills every blank caption cell with its row's title. The Caption column's per-column default value also supports a `{title}` template token (resolved per-row at apply time) for advanced recipes like `Photo of {title}`, with a one-click "Insert {title}" chip and a live preview in the default-value editor.

---

## [0.33.0] — 2026-05-15

- **MR**: [!51](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/51)
- **Phabricator**: [T425984](https://phabricator.wikimedia.org/T425984)

### Added

- **Auto-sequence suggestion: convert duplicate titles to a numbered sequence** ([T425984](https://phabricator.wikimedia.org/T425984)). When the title cell editor detects a collision — either with another stash row sharing the same future filename, or with a Commons file the current user previously published — it surfaces an inline ghost-style chip below the input ("Add ` #` Enter") with a hover tooltip explaining the situation. Accepting (click chip, or Enter when the autocomplete dropdown isn't actively navigated) rewrites every matching stash row's title to the literal placeholder `<basename> #`. A small (i) button next to the chip opens an info popout listing the user's existing `<basename> N` files on Commons (with external links) plus the colliding stash rows. At publish time, a new sequence resolver (`src/api/sequence.js`) queries Commons for the user's existing `<basename> N.<ext>` files (filtered to the current user via `list=allimages&aiprefix=…&aiprop=user`), finds the highest `N`, and assigns each placeholder row `N+1`, `N+2`, … in queue order. The placeholder is allowed by `validateTitleLocal` as a special case (the local-rules forbidden-char check still rejects any other use of `#`); the cell editor's uniqueness check skips placeholder titles entirely (the literal `Foo #` would 404). Suggestion is suppressed when the Commons collision is with a different user's file (per spec — that path stays under standard title validation). Both the single-publish modal and the bulk-publish modal show the resolved `<basename> N` in their previews and pass the resolved title through to `publishOne` via a new `resolvedTitle` option (which also patches the wikitext templates that reference `|title=` like `{{Artwork}}` / `{{Photograph}}` / `{{Book}}`). The uniqueness-check API call now also fetches the uploader's username (cache key bumped to `-v2`) so the editor can distinguish own-file from someone-else's-file collisions. Post-feedback (2026-05-15): the previous design used a yellow warning box + a separate progressive-tinted suggestion strip below it; the warn box has been dropped for own-file collisions (those aren't errors, just routine sequence collisions) and replaced with the ghost chip + tooltip + click-info popout described above. Other-user collisions still surface as a hard error (no sequence suggestion can resolve those).

---

## [0.32.0] — 2026-05-15

- **MR**: [!49](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/49)
- **Phabricator**: [T426421](https://phabricator.wikimedia.org/T426421)

### Added

- **"+ Add column" button at the right end of every table** ([T426421](https://phabricator.wikimedia.org/T426421)). Adds a discoverable, full-height column-shaped affordance after the last visible column — clicking it opens a popover with (a) a quick-add list of currently-hidden built-in columns most users want to surface (`Source`, `Original filename`, `Lens`, `Focal length`, `Date taken`, `Camera location`, `Object location`, `Location of creation (P1071)`, filtered to those still hidden), (b) an inline Wikidata-property search powered by `window.KNOWN_PROPERTIES` + the live autocomplete pool (mirrors the existing autocomplete pattern from the dead-code `ColumnMenu`), (c) a "Custom wikitext-template column" entry-point that opens the Templates-and-columns modal at the Columns tab with the inline custom-form auto-expanded and scrolled into view, and (d) a "More options →" link to the full Templates-and-columns modal. The existing "Templates and columns" toolbar button keeps working unchanged. The trailing 120px column slot is added to the head row + each row's grid template — the head cell is the click target, each row renders a non-interactive placeholder cell so the column reads as one tall affordance with a dashed-left border. `ColumnsModal` now accepts an `initialCustomFormOpen` prop that bubbles through to `CustomColumnCreator` so the popover's "Custom wikitext-template column" path lands the user directly on the label input. Adding a column was previously buried inside the "Templates and columns" modal, where most users never look.

### Changed

- **Wikidata-property columns are now editable** ([T426421](https://phabricator.wikimedia.org/T426421)). Picking a Wikidata property from the "+ Add column" popover (or via the Templates-and-columns modal) used to render the resulting cells with a disabled-grey background and no click-to-edit — the column was visually present but inert, which the maintainer flagged as misleading after the new prominent button surfaced it. They're now ordinary editable text cells (same behaviour as user-defined wikitext-template columns), and values land in `item.customProps[pid]`. Persistence: `customProps` was added to the user-store `DRAFT_FIELDS` set, so values survive a reload like every other editable cell. SDC write-through at publish remains a follow-up — typed values persist on the file's draft but aren't yet emitted as `wbeditentity` claims.

---

## [0.31.0] — 2026-05-15

- **MR**: [!48](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/48)
- **Phabricator**: [T426428](https://phabricator.wikimedia.org/T426428)

### Added

- **"Restore from original filename" action in the Title column header dropdown** ([T426428](https://phabricator.wikimedia.org/T426428)). Stash files land with their Title cell pre-filled from the original filename (sans extension); a user who edits the title and later wants the original back previously had no way to recover it without re-typing (the "Original filename" column has been hidden by default since v10 of the table layout). The new menu item under the Title column's chevron-triggered `HeaderMenuPopover` re-derives `title = filename.replace(/\.[^.]+$/, '')` per row and follows the same four-scope split-button pattern as "Set default value": **Apply to blank titles** (primary, restores only empty rows), **Apply to all selected** + **Overwrite selected** (selection-scoped), **Overwrite all** (`window.confirm` gated). Action is rendered only on the Title column and skips published rows so it doesn't briefly paint a non-persistent change onto view-only items. Restored values flow through the existing `onUpdate` plumbing so drafts persist to the user-store and the title-uniqueness check fires automatically.

---

## [0.30.0] — 2026-05-15

- **MR**: [!53](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/53)
- **Phabricator**: [T426439](https://phabricator.wikimedia.org/T426439)

### Changed

- **Spreadsheet column "Wikitext" is now labelled "Wikitext preview"** ([T426439](https://phabricator.wikimedia.org/T426439)) to make clear that the cell is a click-to-open launcher for the read-only wikitext preview modal, not the editable wikitext that the publish modal exposes. Display label only — the underlying column key is unchanged, so saved column preferences (visibility, order, width) on `Preferences.json` continue to round-trip without churn.

---

## [0.29.0] — 2026-05-15

- **MR**: [!55](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/55)
- **Phabricator**: [T426443](https://phabricator.wikimedia.org/T426443)

### Added

- **Topbar version/MR-preview chip + dropdown navigator** ([T426443](https://phabricator.wikimedia.org/T426443)). The brand row now ends in a colour-coded build pill instead of the static "· Wikimedia Commons" sub-title — green when on the live release (`__DEPLOY_TARGET__ === 'main'`), yellow when viewing an older `/v<X.Y.Z>/` archive, blue when previewing an unmerged MR (`/mr-<IID>/`), grey for `npm run dev`. The chip's *label* also varies with the deploy target — `main` and archived builds show `vX.Y.Z`, MR previews show `MR !<IID>`, local dev shows `dev` — so a user landing on a preview URL sees the MR identifier directly, not the underlying version number (which is just whatever the MR was built against and isn't the build the user is on). Click the chip → small dropdown with the latest 5 releases (parsed from CHANGELOG.md) and every open merge request (from GitLab's MR API), each linkable to the matching Toolforge URL. The currently-active build is marked "you are here". Esc / click-outside closes. Both data feeds reuse the existing `apiCache`-wrapped `fetchOpenMergeRequests()` / `fetchChangelogRaw()` helpers (5min TTL), so the dropdown is effectively free after first open. The `Beta` chip stays in the topbar to the right of the version selector — its CSS-driven hover/focus tooltip ("Beta — many things are not yet working well. All feedback is very welcome!") appears instantly and is reachable on keyboard focus.
- **About modal: Commons-category link.** New "Files uploaded with this tool (on Commons)" entry in the Links section, pointing at [Category:Uploaded with Upload Workbench](https://commons.wikimedia.org/wiki/Category:Uploaded_with_Upload_Workbench) — the hidden tracking category already auto-appended to every published file by `publish.js` ([T426405](https://phabricator.wikimedia.org/T426405) / v0.26.0). Lets a user browse all the files uploaded with the workbench (their own and everyone else's) without leaving the modal.

### Changed

- **About modal: compact accordion versions, MRs no longer buried** ([T426443](https://phabricator.wikimedia.org/T426443)). The Versions section is now a foldable accordion (default-open) showing the latest 5 releases as a compact list; each release row is itself click-to-expand to inline-show that version's Added/Changed/Fixed/Removed bullets — a row click *only* expands (read first), and an explicit "Open this version → /v<X.Y.Z>/" CTA inside the expanded panel is the navigation affordance. A "Show N older releases" disclosure under the latest 5 reveals the rest of the history in the same shape. The standalone "Full changelog" wall-of-text section is removed — its content is reachable per-version via the accordion above. Net effect: scrolling past the version block to reach the open-MR list now takes one click, not a couple of screens of changelog text.
- **CHANGELOG parser extracted to `src/ui/changelog-parse.jsx`** so both the new VersionChip dropdown (latest 5 only) and the About modal (full list with per-version expansion) share the same grammar. No behaviour change for the modal.

### Fixed

- **Beta chip hover tooltip on the topbar wasn't displaying** ([T426443](https://phabricator.wikimedia.org/T426443)). The intended tooltip used the browser-native `title=` attribute, which delays ~700 ms before appearing on hover, doesn't surface on keyboard focus at all, and is invisible on touch — so most users never saw it. Replaced with a CSS pseudo-element (`::after`) on `:hover` / `:focus-visible`, which appears instantly, is keyboard-reachable via the chip's existing `tabIndex={0}`, and styles to match the rest of the UI. `aria-label` on the chip keeps the message accessible to screen readers.

---

## [0.28.0] — 2026-05-15

- **MR**: [!47](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/47)
- **Phabricator**: [T426408](https://phabricator.wikimedia.org/T426408)

### Added

- **"Report this error" button on the hard-error panels** ([T426408](https://phabricator.wikimedia.org/T426408)). When the app shows either "Couldn't start" (bootstrap failed) or "Something broke" (top-level `ErrorBoundary` caught a render error), a new button alongside Reload opens a modal that pre-fills an error report with the timestamp, tool version + deploy target, error message + stack, user agent, and current URL, plus a free-text comment field. The user can submit it via one of two routes — **Open Phabricator task** (`window.open` to the Maniphest create-task form, with `title` and `description` query params pre-filled and the project pinned to `tool-upload-workbench`), or **Post to User talk:Daanvr** (`window.open` to the Commons edit-section-new form with `preloadtitle` pre-filled, plus the body copied to the clipboard since MediaWiki's URL pre-fill for body content uses `preload=<wiki-template-page>` rather than a literal string). No new OAuth scopes — both buttons are user-action `window.open`s. The body is shown in an editable textarea so users can redact filenames or trim the stack trace before submitting.

---

## [0.27.0] — 2026-05-15

- **MR**: [!38](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/38)
- **Phabricator**: [T425978](https://phabricator.wikimedia.org/T425978)

### Changed

- **Every Commons edit and upload now self-identifies in its edit summary** with a wikilink to the tool homepage and the exact version that wrote it: `[[:toolforge:upload-workbench|with Upload Workbench]] v<MAJOR.MINOR.PATCH>`. Applies to all three write paths — `action=upload` (stash → publish), `action=wbeditentity` (Structured Data on file pages), and `action=edit` (user-store JSON pages under `User:<self>/UploadWorkbench/`). Independent of the existing `OAuth CID: 18016` change tag, which is consumer-level and only visible via tag filtering — the suffix is what someone reading a page history sees inline. The version string is the full SemVer pulled from `package.json` at build time via the `__APP_VERSION__` Vite define (not the truncated `APP_USER_AGENT` MAJOR.MINOR string), so post-hoc debugging of a published file's edit summary can pinpoint the exact behavior at the time of the edit. (MW edit summaries silently strip external URLs — `[[URL|text]]` is parsed as an internal page-title link to the literal URL string and renders as a redlink, and `[URL text]` renders as plain text — so the suffix uses the `toolforge:` interwiki prefix instead, which renders as a clickable extiw link and 301-redirects via `iw.toolforge.org/upload-workbench` to the live tool root for free.)

---

## [0.26.0] — 2026-05-15

- **MR**: [!45](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/45)
- **Phabricator**: [T426405](https://phabricator.wikimedia.org/T426405)

### Added

- **Hidden tracking category on every published file** ([T426405](https://phabricator.wikimedia.org/T426405)). `buildWikitext` now appends `[[Category:Uploaded with Upload Workbench]]` to every file published via the tool, joining the existing on-wiki [Category:Uploaded with Upload Workbench](https://commons.wikimedia.org/wiki/Category:Uploaded_with_Upload_Workbench) (which is `__HIDDENCAT__`). The append is idempotent (case-insensitive match on the category name), and a user who hand-edits the wikitext in the publish modal can still strip it — we don't re-inject after manual edits.

---

## [0.25.3] — 2026-05-15

- **MR**: [!46](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/46)
- **Phabricator**: [T426403](https://phabricator.wikimedia.org/T426403)

### Fixed

- **"Cannot read properties of undefined (reading 'value')" when clicking Review in the bulk publish drawer** ([T426403](https://phabricator.wikimedia.org/T426403)). `bulkPublishClaimSummary` in the bulk-publish modal blindly dereferenced `c.mainsnak.datavalue.value` for every claim, but `buildSdcClaims` emits the P170 (creator) self-author claim as a `somevalue` mainsnak with no `datavalue` — so any row where the user is the canonical self-author crashed Review and tripped the top-level ErrorBoundary ("Something broke"). Mirrored the safer shape used by `PublishModal`'s `ClaimSummary`: branch on `snaktype === 'somevalue'` first (rendering the username from the P4174 qualifier), and optional-chain the `datavalue?.value` lookup for the value-typed snaks.

---

## [0.25.2] — 2026-05-15

- **MR**: [!44](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/44)
- **Phabricator**: _n/a_ (chore)

### Changed

- **Resync `package-lock.json` to match `package.json`.** The lockfile had been quietly drifting since v0.24.0 — neither the v0.25.0 nor the v0.25.1 release commit regenerated it, leaving the lockfile pinned at `"version": "0.24.0"` while `package.json` advanced. No transitive-dependency or runtime change; npm install / build behaved correctly throughout, but the mismatch was a recurring eyesore and would eventually trip a CI lockfile check. Pure hygiene fix. Going forward, release commits should run `npm install` after the version bump so the lockfile travels with the new version.

---

## [0.25.1] — 2026-05-15

- **MR**: [!43](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/43)
- **Phabricator**: [T426404](https://phabricator.wikimedia.org/T426404)

### Fixed

- **Tab freezes after committing a cell value** ([T426404](https://phabricator.wikimedia.org/T426404)). The per-category Commons-existence check (`6bb990f`, T425950 follow-up) had a `setItems((prev) => prev.map(...))` inside its `Promise.all().then()` that always returned a new array reference, even when no row mutated. Combined with the effect's `[items]` dependency, this fired an infinite render loop on every cell commit (the cached path resolves `Promise.all([])` on the next microtask → setItems → items memo recomputes → effect re-fires). Once any row carried a category that was already in the existence-check cache, every subsequent commit froze the tab and forced a Chromium "kill page". Fix: track a `changed` flag inside the map and return `prev` (same reference) when no row actually mutated, so React's `Object.is` bails and breaks the loop.

---

## [0.25.0] — 2026-05-15

- **MR**: [!42](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/42)
- **Phabricator**: [T426377](https://phabricator.wikimedia.org/T426377)

### Added

- **Empty-stash hero CTA** ([T426377](https://phabricator.wikimedia.org/T426377)). When the workbench loads with no files in the stash, the small "No files in stash" hint is replaced by a centred drop-zone hero — large upload icon, "Drop files here to start uploading" headline, "Browse files" primary button, and a reminder that files can be dropped anywhere on the window. Mirrors the existing dropzone-overlay's dashed progressive-blue language so the affordance reads consistently across empty-state and active-drag.

### Changed

- **Demoted "Upload history" heading** ([T426377](https://phabricator.wikimedia.org/T426377)). The history section heading drops from `<h1>` (large, bold, emphasized) to `<h2>` (medium, normal weight, subtle colour) so the active stash workspace dominates the page. The collapsed-by-default behaviour is unchanged.

---

## [0.24.0] — 2026-05-12

- **MR**: [!41](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/41)
- **Phabricator**: _n/a_ (infra)

### Added

- **Undefined-identifier scanner** (`scripts/check-undefined-refs.mjs`) chained into `npm run build`. Walks every `.jsx`/`.js` in `src/` with `@babel/parser`, flags any identifier reference not bound in scope and not in the project allowlist (`scripts/window-globals.json`) or the standard browser/JS/Vite-define globals. Fails the build when something doesn't resolve — catches the cross-MR orphan-ref bug class that crashed v0.10.0 → v0.23.1 on first render (`sort`, `stashDupesById`, `findStashDuplicate`). Validated against all three historical broken commits — three for three. `npm run check:undefs` runs the scanner standalone; `npm run build:nocheck` is an emergency escape hatch.

### Fixed

- **Missing imports for `publishFromStash` and `addStructuredData` in `src/api/publish.js`.** Surfaced by the new scanner: both functions are exported from `src/api/commons.js` but were referenced without an import. The publish path was relying on the live tool running in DEMO_MODE (which tree-shakes the call sites out via the `DEMO_MODE = !CLIENT_ID` branch in `vite.config.js` env evaluation). Adding the explicit imports closes a latent runtime crash for any future production build that keeps those call sites live.

---

## [0.23.2] — 2026-05-12

- **MR**: [!40](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/40)
- **Phabricator**: _n/a_ (hotfix)

### Fixed

- **Runtime crash when the Hidden files section renders** (`Uncaught ReferenceError: findStashDuplicate is not defined`). Three references in `src/app.jsx` to the in-stash duplicate detector that [T425873](https://phabricator.wikimedia.org/T425873) / `77179d5` removed (`coalesceStashBySha1` now folds same-sha1 entries upstream so there's nothing to detect). Refs were added concurrently by [T425883](https://phabricator.wikimedia.org/T425883) / `bb90195` (Hidden files UX) and slipped through the v0.15.0 merge. Same class as v0.12.1 (`sort`) and v0.23.1 (`stashDupesById`).

---

## [0.23.1] — 2026-05-12

- **MR**: [!39](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/39)
- **Phabricator**: _n/a_ (hotfix)

### Fixed

- **Runtime crash on every page load** (`Uncaught ReferenceError: stashDupesById is not defined`). Two locations in `src/app.jsx` (the `duplicateStashItems` memo and `onBulkDiscardDuplicates` action, both added by [T425884](https://phabricator.wikimedia.org/T425884) / !29) still referenced the in-stash duplicate map that [T425873](https://phabricator.wikimedia.org/T425873) / !22 removed when it switched to coalescing same-sha1 entries upstream. The cross-MR conflict slipped through the v0.16.0 merge. Both refs collapse to just `i.existsOnCommons` now (in-stash dupes can't reach the filter post-coalesce). Same class of bug as the v0.12.1 sort-orphan hotfix.

---

## [0.23.0] — 2026-05-11

- **MR**: [!20](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/20)
- **Phabricator**: [T425839](https://phabricator.wikimedia.org/T425839)

### Added

- **Manual photo groups in the spreadsheet view ([T425839](https://phabricator.wikimedia.org/T425839)).** When you have natural sub-batches inside a bigger upload (e.g. five photos of the same church among twenty), you can now bundle them into a manual group: select the rows, hit **Group selection** in the bulk action bar, and the table flips into Groups view — one stacked mini-table per group with a thick separator between them. Column visibility, order, and widths are global (set once, applied across all groups); sorting is per-group (clicking a column header sorts only that group). Drag a group header to reorder; **Ungroup all** on a group sends its rows back into the implicit "Ungrouped" section (the files themselves stay put — the wording is deliberate so it can't be misread as deleting the photos). Group labels are renamable (click the label to edit; clear it to restore the default), and the default label uses the group's stable creation-order number — dragging groups around no longer renumbers them. A paired **Ungroup selection** bulk action lets you pull arbitrary rows out of their groups in one shot. A new toolbar toggle (**All / Groups**) flips between flat and stacked layouts. Groups persist to your wiki user-store so they roam across devices. Empty groups can no longer linger: once the last live member of a group leaves the workbench (published, discarded, or expired from the 48h stash), the group itself is pruned automatically — no stale empty placeholder. The select-all checkbox in each mini-table's header is now scoped to that group only — clicking it selects/deselects only the rows in that group, leaving selections in sibling groups (and the implicit Ungrouped section) untouched, so each mini-table reads as its own unit. Per-column "Fill empty cells" / "Overwrite all" / "Overwrite selected" actions in the Templates and columns modal continue to operate on the rows of whichever mini-table you opened the modal from.

---

## [0.22.0] — 2026-05-11

- **MR**: [!28](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/28)
- **Phabricator**: [T425880](https://phabricator.wikimedia.org/T425880)

### Added

- **Title column validation against Commons filename rules.** As the user edits a Title cell the editor now runs live validation: hard errors for forbidden characters (`#`, `<`, `>`, `[`, `]`, `|`, `{`, `}`, `/`, `\`, `:`, control chars, percent-hex sequences, runs of three-or-more tildes), structural problems (just-dots, leading colon), runs of two-or-more spaces, and length over 240 UTF-8 bytes (the Commons cap, leaving room for date prefixes on file revisions). Soft warnings flag camera-default names — list extended from ~13 to ~80 patterns, covering DSC/IMG/PXL/MVIMG/Screenshot/WhatsApp/Snapchat camera prefixes, audio recorder prefixes (Zoom, Tascam DR, Sony PCM, Olympus DM/WS, etc.), camcorder/dashcam containers, action/360/drone naming, mobile-app patterns, and pure-junk titles ("untitled", "Scan 2023-…"). The warning surfaces in the cell tint and the row's status-dot tooltip even when the cell isn't focused, so the user notices without clicking in. A debounced (~400 ms), cached uniqueness check (`apiCache`, 5-min TTL) hits Commons' `prop=info&titles=File:...` endpoint and surfaces "Already exists on Commons as File:X" as a hard error before publish. Inline errors render below the cell with actionable wording; the cell goes red. Publish (single + bulk) is blocked while a Title cell carries a validation error. A help-icon link in the Title column header opens [Commons:File naming](https://commons.wikimedia.org/wiki/Commons:File_naming) in a new tab.

### Changed

- **Title column now defaults to the original filename (sans extension)** instead of being blank. New uploads, normalized stash items, and the optimistic placeholder during upload all pre-fill Title from the source filename. The "Original filename" column (renamed from "Filename") is still available — it's hidden by default in the columns modal and can be re-enabled if you want to see both side-by-side. Storage key bumped (`stashhub.columns.v9` → `v10`) so first-time users / cleared local state get the new default; existing saved layouts that include "filename" stay intact.
- **Trailing/leading whitespace in Title is silently auto-trimmed instead of flagged red.** Typing a word, hitting space, then typing the next word no longer flashes red between the two words. The `whitespace-edge` error code is removed entirely; `whitespace-double` (mid-string runs of 2+ spaces) stays as a hard error. The Title editor commits the trimmed value via a `cleanTitleForCommit` helper, so a stray trailing space typed mid-edit doesn't get persisted to the user-store as a draft. The detail-panel title input mirrors the same trim-on-blur behaviour.

---

## [0.21.0] — 2026-05-11

- **MR**: [!36](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/36)
- **Phabricator**: [T425949](https://phabricator.wikimedia.org/T425949)

### Added

- **Source column** — new optional spreadsheet column for the `{{Information |source=...}}` field, toggleable in the columns modal. The cell editor offers free-text input plus an `{{own}}` quick-select that fills the canonical Commons wikitext. The same quick-insert is wired into the columns-modal default-value cell and the per-header default-value popover, so a whole batch can be auto-populated. The Detail panel's Source field gets the same quick-insert button. **Default coupling with licence:** when the chosen licence is one of the own-work options (CC0 / CC BY 4.0 / CC BY-SA 4.0) and the cell is empty, the publish step emits `{{own}}` automatically — the cell visualises that with a muted "{{own}} (from licence)" hint and a tooltip so the implicit behaviour isn't hidden. Non-own-work licences (PD claims, third-party CC, GFDL, custom) leave the cell blank for the user to fill in (a URL, citation, etc.) — we deliberately don't auto-emit `{{own}}` for those because attributing a third-party / PD work as own work would be factually wrong. Per maintainer feedback, every quick-select button is labelled `{{own}}` (the actual wikitext that gets inserted) instead of "Own work" so the displayed label matches what gets stored.

---

## [0.20.0] — 2026-05-11

- **MR**: [!35](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/35)
- **Phabricator**: [T425950](https://phabricator.wikimedia.org/T425950)

### Changed

- **The tool no longer creates new categories on Commons — typed unknown names are refused outright.** Users can only attach categories that already exist. The "+ Create new category" affordance is removed from the cell editor's autocomplete dropdown, and the "your new category will be created" copy is gone from the chip popover and editor hints. Enter, Tab, suggestion-list click, and the detail-panel suggestion buttons all funnel through one gate: if the name is in the merged autocomplete pool (mock vocab + live opensearch hits), it's added; otherwise the editor fires `action=query&prop=info&titles=Category:<name>` and adds the chip only when Commons confirms the page exists. Names that come back missing surface a red one-line hint right under the input (`'<name>' isn't an existing Commons category — pick a suggestion or try a different spelling.`) and the input itself tints red. Blur no longer auto-commits the trailing typed text, the column-header default-value popover refuses to apply unknown defaults to blank rows (with the same red warning), and intra-app paste of category chips drops values that aren't in the merged pool. Pre-existing red chips loaded from older drafts still render red and still block publish (via the new blocking issue code `categories-not-on-commons`) — the user has to remove or replace them. Existence checks are deduped per-name across rows and cached for 5 minutes via the existing `apiCache`. Network errors during the check leave the chip in its neutral state — we don't flap a category red on a transient blip.

---

## [0.19.0] — 2026-05-11

- **MR**: [!34](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/34)
- **Phabricator**: [T425912](https://phabricator.wikimedia.org/T425912)

### Changed

- **Category values now display with the `Category:` prefix everywhere they're rendered** — the table cell chips, the inline category editor (selected pills, frequently-used suggestions, autocomplete suggestions, "Create…" hint, "no match" hint), the list-view category column, the lightbox/detail editor pills, the pill-info popover (title and parent list), the paste-banner preview, and table cell hover tooltips. This matches Commons wikitext convention (`[[Category:Mountains]]`) and reduces ambiguity when a category name happens to look like an unrelated word. Internal storage stays as the bare name, so search still matches when you type "Mountains" — and it now also matches if you type "Category:Mountains". Typing a `Category:` prefix into the editor input is silently stripped before saving so storage stays bare.

---

## [0.18.0] — 2026-05-11

- **MR**: [!33](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/33)
- **Phabricator**: [T425871](https://phabricator.wikimedia.org/T425871)

### Added

- **Click-through icons + category counts on autocomplete suggestions.** Each Category and Wikidata-item suggestion now carries a small icon button (right edge of the row) that opens the target page in a new tab — `Category:<name>` on Commons, `Q<id>` on Wikidata, `Property:P<id>` on Wikidata for the column-menu property picker. Clicking the icon does **not** select the suggestion (the rest of the row still does). Category suggestions also display `F<n> C<n>` (file count / subcategory count) inline, fetched via a single batched `prop=categoryinfo` request appended to each `searchCategories` round-trip — no per-keystroke fan-out, results cached for the session and via `apiCache`'s 5-min TTL. Lets the user verify a category's relevance against their photo before committing.

---

## [0.17.0] — 2026-05-11

- **MR**: [!32](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/32)
- **Phabricator**: [T425840](https://phabricator.wikimedia.org/T425840)

### Added

- **Visual piling mode.** New "Piling mode" toolbar button opens a fullscreen lighttable surface where every stash photo is rendered as a draggable thumbnail (~116-128px, big enough to recognise the shot at a glance). Already-grouped photos appear as overlapping piles in their own bordered zones; ungrouped photos sit loose on the surface. Drag a photo onto another loose photo to form a new pile; drag onto an existing pile to join it; drag onto an always-visible "New group" placeholder pile to start a single-photo group in one gesture; drag onto a thumbnail inside the same pile to **reorder** the photos within it (the order becomes the default display order in the table-view group); drag a photo back out onto the loose surface to ungroup it. Each pile carries an editable name — click the label to rename. Default names are sequential ("New Group 1", "New Group 2", …) computed against the names already in use, so deleting a group never leaves a gap in the count. Esc closes the mode and returns to the prior view. Group state (membership, name, order) is shared with the table-view groups feature ([T425839](https://phabricator.wikimedia.org/T425839)) — both speak to the same `groups[]` field in the user-store, so changes made in either mode round-trip through the wiki and roam cross-device.

---

## [0.16.0] — 2026-05-11

- **MR**: [!29](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/29)
- **Phabricator**: [T425884](https://phabricator.wikimedia.org/T425884)

### Added

- **One-click "Discard N duplicates" bulk action.** When the duplicate-detection effect flags one or more stash rows (cross-Commons sha1 hit and/or same-bytes twin within this stash), a status banner appears above the stash table with a destructive button that discards every flagged row in one click — no per-row selection needed. Action targets all detected duplicates regardless of the current filter; if any flagged rows are hidden by the filter, the banner surfaces a "(N visible, M hidden by current filter — all will be discarded.)" hint so the scope isn't a surprise. Discards are reversible from the existing "X hidden" disclosure. (This codebase uses a single soft-hide operation labelled "Discard" — the spec's "Discard / Hide" pair maps onto that one button here.)
- **Post-discard confirmation banner with Undo.** Every bulk-discard now surfaces a transient receipt above the stash table listing the count + the first few filenames it just hid, and an Undo button that restores exactly those rows (no other prior hides). Auto-clears after 10 s. Removes the prior uncertainty about which rows the action affected — the user can now read the names and click Undo before they age out. Logged to the console as `[discard]` for support diagnostics.

### Changed

- **Bulk discard now hides rows by sha1 *and* filekey together** when both are known, instead of choosing one. A stash row's filekey is per-entry and not stable across MediaWiki re-issues, so a sha1-only hide that's later filtered through any filekey-only path could lose track of the row; defence-in-depth across both keys removes that fragility. Items still missing a sha1 (info backfill pending) continue to be hidden by filekey alone.
- **Duplicate set is re-snapshotted at click time** for the banner's bulk action, so a duplicate that arrived (or had its sha1 backfilled) milliseconds before the click is still hidden. Closes a window where the closed-over memo could lag the freshest items.

### Fixed

- **Hidden stash rows no longer appear simultaneously in the table and the "X hidden" disclosure list.** Opening the disclosure used to inject the hidden rows back into the table view, so they were rendered twice — visually identical to "the discard didn't work" and the trigger for a bulk-discard bug report (rows seemed to come back partially after restore). Hidden rows are now strictly outside the table at all times; the disclosure shows them in its own list above the table without duplicating them into the spreadsheet.

---

## [0.15.0] — 2026-05-11

- **MR**: [!30](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/30)
- **Phabricator**: [T425883](https://phabricator.wikimedia.org/T425883)

### Changed

- **Hidden ("soft-deleted") stash files get their own block at the bottom of the stash section, with a thumbnail-rich preview.** Each hidden row now shows the file thumbnail, filename, size and dimensions, a "Hidden" chip, and the same hours/minutes stash-expiry countdown surfaced in the section header — so a hidden file about to disappear from the stash is visible at a glance. Toggle target ("Show / Hide hidden") now lives in the hidden block's own header above the body; expanding or collapsing the body only grows downward, so the toggle button no longer shifts under the user's cursor between clicks. Hidden rows now show a duplicate-state chip (Already on Commons / Twin in stash / Already published) with the same warn-tone styling as visible cards. Clicking the thumbnail opens the lightbox; clicking the row body opens the detail panel — same split as the visible stash views. Stash expiry countdowns are always in hours, never days. Also fixes a latent bug where toggling Show hidden would briefly render the hidden items twice (once mixed into the visible list, once in the hidden block).

---

## [0.14.0] — 2026-05-11

- **MR**: [!27](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/27)
- **Phabricator**: [T425879](https://phabricator.wikimedia.org/T425879)

### Added

- **Per-row wikitext preview.** A new "Preview wikitext" button in the detail panel (for both stashed and published files) opens a read-only modal showing exactly the wikitext that would be generated for that row, plus a copy-to-clipboard helper. Useful for spot-checking how a row's metadata maps to wikitext before committing.
- **In-table Wikitext column.** A new column (visible by default, between the structured-data block and the EXIF block) renders a single-line monospace snippet of the assembled wikitext and acts as a click-to-open launcher for the read-only preview modal. Keyboard-reachable (Tab → Enter/Space) with role=button + aria-label. Existing users get the column auto-inserted into their stored column prefs on next load via a one-shot migration in `loadColumnState`.
- **Custom wikitext-template columns.** A new "+ Add custom wikitext-template column" entry in the Columns modal lets the user define a column whose definition is a wikitext template (e.g. `{{Photograph|description=__VALUE__}}`). The cell becomes a free-text input; at publish time the entered value replaces the `__VALUE__` placeholder and the resulting wikitext is appended to the file's page. Sortable like other columns; supports per-column defaults and bulk-fill via the existing column controls. Templates persist with the rest of the column state (localStorage `stashhub.columns.v9`).
- **Editable wikitext + SDC review at publish.** The publish-confirmation modal now shows the assembled wikitext as an editable `<textarea>` (monospace, scrollable) so the user can patch any last-minute issues by hand before the upload commits. SDC is shown alongside as a read-only payload so the user can sanity-check the structured data going up. The bulk-publish modal grows a per-row "Review" disclosure that does the same — expand any queued row to see and edit its wikitext + SDC, with a Reset button to fall back to the auto-generated wikitext.

---

## [0.13.0] — 2026-05-11

- **MR**: [!19](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/19)
- **Phabricator**: [T425864](https://phabricator.wikimedia.org/T425864)

### Added

- **Per-column settings dropdown in the spreadsheet header.** Each column header now shows a chevron (left of the resize grip) that opens a small popover with **Set default value** (mirrors / replaces the old default-only popover that was wired to the header), **Toggle required** (same effect as the asterisk / Columns modal), and **Clear all values** (wipes the column for every row in the table; uses a two-step confirmation pattern — first click flips the row destructive-red and re-labels it "Confirm"). The default-value editor's footer is a split-button: the primary action is "Apply to blank cells" (matches the columns-modal default) and the caret opens a menu with "Apply to all selected", "Overwrite selected", and "Overwrite all" so the four columns-modal apply scopes are reachable inline. The Description column header also appends the current language code (`Description EN`) and adds a greyed-out "Add language" placeholder for the future multi-language descriptions feature. Existing header behaviors — click to sort, double-click resize handle to fit, drag to resize, asterisk for required — are unchanged.

### Added

- **Manual photo groups in the spreadsheet view ([T425839](https://phabricator.wikimedia.org/T425839)).** When you have natural sub-batches inside a bigger upload (e.g. five photos of the same church among twenty), you can now bundle them into a manual group: select the rows, hit **Group selection** in the bulk action bar, and the table flips into Groups view — one stacked mini-table per group with a thick separator between them. Column visibility, order, and widths are global (set once, applied across all groups); sorting is per-group (clicking a column header sorts only that group). Drag a group header to reorder; **Ungroup all** on a group sends its rows back into the implicit "Ungrouped" section (the files themselves stay put — the wording is deliberate so it can't be misread as deleting the photos). Group labels are renamable (click the label to edit; clear it to restore the default), and the default label uses the group's stable creation-order number — dragging groups around no longer renumbers them. A paired **Ungroup selection** bulk action lets you pull arbitrary rows out of their groups in one shot. A new toolbar toggle (**All / Groups**) flips between flat and stacked layouts. Groups persist to your wiki user-store so they roam across devices. Empty groups can no longer linger: once the last live member of a group leaves the workbench (published, discarded, or expired from the 48h stash), the group itself is pruned automatically — no stale empty placeholder. The select-all checkbox in each mini-table's header is now scoped to that group only — clicking it selects/deselects only the rows in that group, leaving selections in sibling groups (and the implicit Ungrouped section) untouched, so each mini-table reads as its own unit. Per-column "Fill empty cells" / "Overwrite all" / "Overwrite selected" actions in the Templates and columns modal continue to operate on the rows of whichever mini-table you opened the modal from.

---

## [0.12.1] — 2026-05-11

- **MR**: [!37](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/37)
- **Phabricator**: _n/a_ (hotfix)

### Fixed

- **Runtime crash on every page load** (`Uncaught ReferenceError: sort is not defined`). Two `useMemo` dependency arrays in `src/app.jsx` still referenced the `sort` state variable that was removed in v0.6.3 ([T425836](https://phabricator.wikimedia.org/T425836)). The orphaned references slipped through during a v0.10.0 rebase and broke every release from v0.10.0 through v0.12.0.

---

## [0.12.0] — 2026-05-11

- **MR**: [!26](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/26)
- **Phabricator**: [T425881](https://phabricator.wikimedia.org/T425881)

### Added

- **Selectable wikitext template for published files.** A new "Templates" tab inside the renamed "Templates and columns" modal lets users pick which Commons template wraps their published wikitext: `{{Information}}` (default), `{{Artwork}}`, `{{Photograph}}`, `{{Book}}`, or a fully-custom user-defined body. The choice persists per user via `Preferences.json` so it roams across devices. Switching to a template that uses workbench columns the user hasn't enabled yet surfaces a one-click "Add N columns" suggestion (encouraged, not enforced — empty params are dropped from the rendered wikitext anyway). Custom templates support `{{field:KEY}}` placeholders that interpolate any workbench column value, with a live preview against sample data.
- **Per-column template badges in the Columns tab.** Each column row now shows a small badge surfacing its relationship to the currently-selected template — `|description=` for direct field mappings, `custom` for `{{field:KEY}}` placeholders in a custom template body, `recommended` for "commonly used with this template" hints — so the user can see at a glance which columns matter for the active template.
- **"In <Template>" filter chip on the Columns tab.** Quick way to hide columns that aren't used by the chosen template; counts the in-template columns next to the chip label like the other legend filters.
- **Column ↔ template parameter map on the Templates tab.** "Columns this template uses" now lists each column with its template parameter (e.g. *Description → `|description=`*) and a green/grey dot showing whether the column is currently enabled, instead of bare key codes. Recommended-only columns are listed separately under "Also commonly used with this template", so the user can tell mapped fields apart from the broader recommendations.
- **"Added X, Y, Z" feedback when the Templates tab adds columns.** Clicking "Add N columns" now switches to the Columns tab pre-filtered to the active template, shows a banner naming the columns that were just enabled, and flash-highlights those rows for ~4 seconds — so the user can see exactly which columns the action touched (previously the action ran silently with no visible confirmation).

### Changed

- **The "Columns" toolbar button is now "Templates and columns".** Same modal, same Columns tab, plus the new Templates tab as the global complement to per-column settings.
- **Missing-columns suggestion on the Templates tab uses human labels** (e.g. *Date & time*, *Location of creation (P1071)*) instead of raw column keys (`dateTaken`, `locationOfCreation`), so the list reads as a sentence the user can scan.

---

## [0.11.0] — 2026-05-11

- **MR**: [!25](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/25)
- **Phabricator**: [T425878](https://phabricator.wikimedia.org/T425878)

### Added

- **Quiet, threshold-based caption validation in the cell editor and the detail panel.** The Caption editor stays out of the user's way until they're approaching the SDC label cap: the live `N / 250` character counter only appears once the value reaches 200 chars, sits in neutral grey from 200–250, and turns red over 250 with a single short error line beside it (no count repetition). Other rule violations — line breaks / tabs, HTML, wikitext markup (`[[…]]` / `{{…}}`), and URLs — are still surfaced inline as actionable errors. Trailing/leading whitespace is silently trimmed on commit (no scary "trailing whitespace" warning while typing). Pasted multi-line text is joined into a single line on input. The placeholder describes the goal of a caption ("Brief description of the file"), not the limit.
- **Header info icon on the Caption column** — hover or focus the icon to see a short summary of the caption rules and a link to [Commons:File captions](https://commons.wikimedia.org/wiki/Commons:File_captions).
- **Persistent in-cell error indicator for invalid captions.** A saved-but-invalid caption (over the cap, contains markup, etc.) renders the cell with a red background and a warning icon — the user can no longer "lose" the warning by clicking out of the cell. The bulk-publish and single-publish modals also gate on caption validity, surfacing the specific reason before the upload is attempted instead of waiting for the Wikibase API to reject it server-side.

### Changed

- **Caption column rename now extends to the cell editor, header info, and validation pipeline.** The "Description" → "Caption" rename (already applied to history rows in v0.8.1) now reaches the stash-side cell editor, header tooltip/info popover, and validation messages. The internal field name stays `description` so persisted drafts and existing publish-path wikitext are unaffected.

---

## [0.10.0] — 2026-05-11

- **MR**: [!22](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/22)
- **Phabricator**: [T425873](https://phabricator.wikimedia.org/T425873)

### Changed

- **Drag-drop upload now renders all rows up front.** Dropping (or picking) N files inserts N placeholder rows into the table in a single render pass — before any network round-trip — so a 10-file batch is visible at a glance instead of trickling in one row at a time as the serial uploader advances. Each row starts as `Queued`, flips to a per-row progress ring once the uploader reaches it, and finalizes to a normal stash row when bytes land. Edits the user makes on a still-uploading row (title, description, categories, depicts, license, author, source, date, location) are preserved when the row finalizes, and the saved draft is re-keyed from the placeholder id onto the row's sha1 so it survives a reload too. Bulk publish skips rows that don't yet have a filekey, and the per-row Publish button bails quietly on placeholder rows.
- **Same-sha1 stash entries are now coalesced into a single logical row.** Two stash filekeys pointing at the same bytes used to surface as two separate rows side-by-side, asking the user to choose between two identical things. They now collapse into one row at the items-derivation step: the **latest upload wins** as the row's base, so the row carries the freshest server-side EXIF / dimensions / thumb, the longest stash-expiry countdown, and the latest filekey for Publish/Discard to operate on. The older filekey just auto-expires from the stash. User-edit fields (title, description, categories, depicts, license, author, source, date, location) are unaffected — drafts are keyed by sha1 and were already shared between the two rows. As a side effect, a **re-upload of the same bytes now restarts the 48-hour expiry counter** (the new filekey wins) and lets the user **fix EXIF/file-derived metadata by re-uploading a corrected file** (the new entry's EXIF replaces the old). The "Twin in stash" warning chip / banner / publish-modal block is gone (it can no longer fire).
- **Re-uploading a previously hidden file now wakes it back up.** When a fresh upload finishes and its sha1 matches an entry in the soft-delete list, the sha1 is unhidden in the same gesture — the row appears in the visible stash automatically rather than landing back in the "hidden" section. The hidden-set unhide flows through the wiki user-store the same way an explicit Restore click does, so the change persists across devices. The boot-time / refresh-time path is intentionally not auto-unhiding (it can't tell "user re-uploaded from another tab" apart from "two old entries the user never explicitly waved through"); rows like that still surface in the hidden section with a one-click Restore button.

---

## [0.9.0] — 2026-05-11

- **MR**: [!16](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/16)
- **Phabricator**: [T425832](https://phabricator.wikimedia.org/T425832)

### Added

- **Resizable grid view tiles.** Grid view now exposes a pair of plus / minus buttons (visible in the toolbar only while Grid is active) that step through five tile sizes — `small` (160px) / `medium` (240px, default) / `large` (360px) / `xlarge` (540px) / `xxlarge` (800px). The two largest steps drop the layout to roughly two tiles per row so users can inspect images at near-full size without leaving Grid view. Picking a size re-flows the tiles immediately (the CSS `--card-min` driving `auto-fill, minmax(...)` is updated live) and the choice persists across reloads via `localStorage` key `stashhub.gridSize`, following the existing UI-pref pattern. The plus / minus buttons disable at the boundaries.

---

## [0.8.1] — 2026-05-11

- **MR**: [!31](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/31)
- **Phabricator**: [T425885](https://phabricator.wikimedia.org/T425885)

### Added

- **Camera location (P1259), object location (P9149 fallback), creator (P170), and license (P275) read from SDC.** When the uploader has explicitly set these on the file via Structured Data, the SDC value wins over the equivalent extmetadata / wikitext field — even when both agree — because SDC is the authoritative declaration. Camera location (P1259) wins over EXIF GPS for the same reason. Creator parsing handles the common `somevalue` snak shape with a `P2093` (author name string) qualifier.
- **History rows surface coordinates (P625/P9149), location of creation (P1071), inception (P571), and EXIF camera fields.** `fetchHistoryDetailed` now requests `commonmetadata` alongside `extmetadata`, so camera/lens/ISO/aperture/shutter/focal/GPS appear on history rows for files where they were previously blank — the raw EXIF tags don't surface in `extmetadata`. Same pagination/throttling — no extra per-row fetches beyond the QID-label batch.

### Changed

- **"Description" column is now labelled "Caption" and reads from SDC labels.** The Commons UI calls this field a *file caption* (the multilingual short description on the M-entity); we now use the same name. The cell value is the SDC caption when present, falling back to the legacy `extmetadata.ImageDescription` (the wikitext `{{Information|description=…}}` template) when the file has no SDC caption yet. The underlying field key (`description`) is unchanged so existing drafts and required-fields prefs keep working. Saved field-order preferences pick up the new label automatically on next load.

### Fixed

- **Description column no longer renders `[object Object]` on history rows.** When a published file's description has multiple language variants, MediaWiki returns `extmetadata.ImageDescription.value` as a `{en: '...', nl: '...', _type: 'lang'}` bag even with `iiextmetadatamultilang=0` — the previous `String(obj)` path produced the literal `[object Object]`. The normalizer now picks a best-effort string (preferred language → English → first available). A read-time sanitizer also strips the broken value from existing cached history items so users see `—` until the next background refresh repopulates the cache with real text.
- **Status-column tooltip is no longer clipped behind frozen columns.** After T425828 introduced sticky frozen columns, the popover's `position: fixed` + `z-index: 9000` was no longer enough — sibling frozen-cell wrappers of later rows (z-index: 3 each, in their own stacking contexts) painted over it. The tooltip is now rendered via `createPortal(..., document.body)` so it escapes the table's stacking contexts entirely.
- **"Open file on Commons" status icon now actually opens the file.** The published-state status icon previously had `href="#"` with `preventDefault`, despite the tooltip claiming "click to open in a new tab". Wired to `item.descriptionurl` with `target="_blank"`.
- **SDC fields (depicts, object location, inception, location of creation) now actually populate on history rows.** The previous SDC parsers read `entity.claims.PXX` — but `wbgetentities` returns MediaInfo (M-page) entities with their statements under the `statements` key, not `claims`. Only Item / Property entities use `claims`. Every SDC parser silently got an empty array, so depicts pills, object-location coordinates, the inception date and the location-of-creation Q-id all rendered as missing even when present on the underlying file. Parsers now read `statements` with a `claims` fallback for forward-compat. Cached history blobs are stamped with a `schemaVersion`; older blobs trigger an immediate background refresh on next load instead of waiting up to 7 days.
- **Depicts pills now render real Q-id labels instead of `Q123456`.** History fetch now collects every Q-id referenced by depicts/creator/license/location-of-creation statements and resolves their labels in one batched Wikidata `wbgetentities` call, so cells render with the human-readable label up front (no hover required).

---

## [0.8.0] — 2026-05-11

- **PR**: [!24](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/24)
- **Phabricator**: [T425874](https://phabricator.wikimedia.org/T425874)

### Added

- **"Me (Username)" quick-select for the Author field.** The Author cell editor now surfaces a one-click "Me (Username)" pill below the input that fills the canonical Commons own-work form `[[User:<your-username>|<your-username>]]`. The same quick-insert button is also available in the Author column's default-value editor (both the Columns modal and the per-header default popover), so a whole batch can be auto-populated. At publish time, an Author whose value matches that canonical self-author wikitext now also emits the matching Structured Data on Commons claim — `creator (P170)` with snaktype `somevalue` and qualifiers `P2093` (author name string), `P4174` (Wikimedia username), `P2699` (URL to the user page) — matching the on-wiki shape of real own-work uploads. Free-text authors ("Acme Co.", a non-self real name, etc.) stay wikitext-only and don't get a P170 claim.

### Added

- **Click-through icons + category counts on autocomplete suggestions.** Each Category and Wikidata-item suggestion now carries a small icon button (right edge of the row) that opens the target page in a new tab — `Category:<name>` on Commons, `Q<id>` on Wikidata, `Property:P<id>` on Wikidata for the column-menu property picker. Clicking the icon does **not** select the suggestion (the rest of the row still does). Category suggestions also display `F<n> C<n>` (file count / subcategory count) inline, fetched via a single batched `prop=categoryinfo` request appended to each `searchCategories` round-trip — no per-keystroke fan-out, results cached for the session and via `apiCache`'s 5-min TTL. Lets the user verify a category's relevance against their photo before committing.

---

## [0.7.0] — 2026-05-11

- **PR**: [!23](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/23)
- **Phabricator**: [T425876](https://phabricator.wikimedia.org/T425876)

### Changed

- **Broadened the licence selector to match the Upload Wizard's option set.** The dropdown now offers Own work (CC0 / CC BY 4.0 / CC BY-SA 4.0), Someone else's work (CC BY/BY-SA 2.5–4.0 + PD claims: PD-old-70, PD-US-expired, PD-USGov, PD-USGov-NASA, GFDL), and a "Custom licence…" option that reveals a free-form wikitext input for unusual cases (e.g. specific PD tags). Each option carries the short label by default with the full descriptive title on hover, and an info icon next to the cell editor opens a popover listing every catalog entry with a plain-language explainer, a "More info" link to the relevant Commons template page, and a generic "Help me pick a licence" link to [`Commons:Choosing_a_license`](https://commons.wikimedia.org/wiki/Commons:Choosing_a_license). Same option set is now used by the spreadsheet cell editor, detail panel, header default-value popover, and columns-modal default cell — single source of truth lives in `src/licenses.js` (also wired into `api/publish.js` so the wikitext template generated at publish time stays in sync). Existing draft licence values (`CC-BY-SA-4.0`, `CC-BY-4.0`, `CC0`, `PD-old-70`, `GFDL`) are preserved unchanged.

---

## [0.6.4] — 2026-05-11

- **PR**: [!21](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/21)
- **Phabricator**: [T425825](https://phabricator.wikimedia.org/T425825)

### Removed

- **Dead three-dot button at the end of every list-view row.** The `<button>` had a no-op `onClick={(e) => e.stopPropagation()}` handler and no menu wired up — it was a click target that did nothing. Removed in favour of re-introducing the button later if/when an actual per-row context menu is scoped (list rows already open the lightbox/edit on row click, so users are not blocked from any action).

---

## [0.6.3] — 2026-05-11

- **PR**: [!18](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/18)
- **Phabricator**: [T425836](https://phabricator.wikimedia.org/T425836)

### Removed

- **Toolbar Sort dropdown.** The `Newest first / Oldest first / Name / Size` `<select>` next to the filter dropdown duplicated and silently conflicted with the table's column-header click-to-sort. Removed it; column headers are now the single sort affordance for the table view, and the Grid view defaults to newest-first by upload time.

---

## [0.6.2] — 2026-05-11

- **PR**: [!17](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/17)
- **Phabricator**: [T425837](https://phabricator.wikimedia.org/T425837)

### Changed

- **Detail panel "Refresh metadata from Commons" button now fails loudly if its `onRefresh` prop is missing.** The render was previously gated on `onRefresh && item.status === "published"`, which meant a future refactor that dropped the prop would silently hide the button instead of erroring. The `&& onRefresh` guard is removed, so a missing prop now throws "onRefresh is not a function" at click time — surfacing the regression immediately rather than turning the affordance into an invisible no-op.

---

## [0.6.1] — 2026-05-11

- **PR**: [!15](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/15)
- **Phabricator**: [T425831](https://phabricator.wikimedia.org/T425831)

### Removed

- **Debug `console.log` chatter from the autocomplete bridge.** Six leftover `[autocomplete] …` log calls in `src/api/autocomplete.js` (fetch start/return for categories and depicts, bridge install, `matchVocab` call) were firing on every category/depicts type-ahead and visible to anyone with DevTools open. The two `console.warn` calls for actual fetch failures are kept — they surface real errors.

---

## [0.6.0] — 2026-05-10

- **PR**: [!14](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/14)
- **Phabricator**: [T425833](https://phabricator.wikimedia.org/T425833)

### Added

- **Focus mode in the table view.** A new toolbar toggle opens a persistent left-edge image panel that shows the large preview of the active row. As the user clicks rows or moves with arrow up/down, the panel updates and the active row is highlighted with a strong left accent. Toggle preference is remembered across reloads (`stashhub.focusMode.v1` localStorage key). Useful when filling metadata across many rows: the row you're describing stays visible at full size on the left while you edit on the right. Panel column is fixed-width (~640px desktop, scaling down at 1400/1100/800px breakpoints) and the image renders at its natural aspect ratio with no placeholder letterbox.

---

## [0.5.1] — 2026-05-10

- **PR**: [!13](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/13)
- **Phabricator**: [T425834](https://phabricator.wikimedia.org/T425834)

### Fixed

- **Toolbar search now matches every column's rendered text — exactly what the user sees in the table.** Previously the predicate matched only `title` / `filename` / `categories`, so typing a word from a caption (or a date, or a camera model) silently returned no results. The haystack is now built per-row by re-using the table's per-cell renderer, so it covers the same formatted strings the user reads on screen: `title`, `filename`, `categories`, `depicts` labels and QIDs, `license`, `author`, `description`, `size` ("4.5 MB"), `dimensions` ("1,920×1,080"), `status` ("Stashed"/"Published"), every EXIF column (`camera`, `lens`, `focal`, `iso`, `aperture`, `shutter`), `dateTaken` ("Aug 15, 14:30"), `locationOfCreation`, and any custom-property values. Whitespace-separated terms are ANDed (typing two words narrows the result, the natural way to refine), not widened.

---

## [0.5.0] — 2026-05-09

- **PR**: [!11](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/11)
- **Phabricator**: [T425828](https://phabricator.wikimedia.org/T425828)

### Added

- **Frozen leftmost columns in the spreadsheet view.** Status indicator, selection checkbox, open-detail button, and photo thumbnail now stay pinned to the left edge while metadata columns scroll horizontally underneath, so the row's identity stays visible no matter how far you scroll. A subtle right-edge shadow appears once content is scrolled to mark the freeze boundary; it fades out at scroll position 0.

---

## [0.4.3] — 2026-05-09

- **PR**: [!10](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/10)
- **Phabricator**: [T425829](https://phabricator.wikimedia.org/T425829)

### Fixed

- **Category pill popover now shows real Commons data.** Clicking a category pill previously rendered a placeholder description and a dead "Open on Commons" footer button. The popover now fetches `categoryinfo|extracts|categories` for `Category:<name>` (cached 5 min via `apiCache`), surfaces the lead extract / file count / subcategory count / parent categories when the category exists, falls back to "will be created" when it doesn't, and the "Open on Commons" button opens `https://commons.wikimedia.org/wiki/Category:<name>` in a new tab.

---

## [0.4.2] — 2026-05-09

- **PR**: [!9](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/9)
- **Phabricator**: [T425827](https://phabricator.wikimedia.org/T425827)

### Fixed

- **Depicts pill info popover now shows real Wikidata data and a working "Open on Wikidata" link.** The popover was rendering placeholder content sourced from the local `KNOWN_DEPICTS` mock pool — items not in that pool had no description, and the "Open on Wikidata" footer button had no `onClick` / href. The depicts popover now fetches the canonical label + description for the Q-id from Wikidata's `wbgetentities` (cached 5 min via the existing `apiCache`), falls back to the local pool while loading or on error, and renders the footer as an anchor pointing to `https://www.wikidata.org/wiki/<QID>`. Adds `fetchWikidataEntity` in `src/api/commons.js` and exposes it on `window` via the autocomplete bridge.

---

## [0.4.1] — 2026-05-09

- **PR**: [!12](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/12)
- **Phabricator**: [T425851](https://phabricator.wikimedia.org/T425851)

### Fixed

- **Per-MR preview deploys (`/mr-<iid>/`) and the per-version archives (`/v<X.Y.Z>/`) now actually serve their own builds** at `https://upload-workbench.toolforge.org/`. Toolforge's static-files frontend runs `vercel/serve -s` (the SPA-fallback flag) which prepends an unconditional `**` → `/index.html` rewrite — so every directory request was hijacked into the *root* `index.html`, with the root's asset paths. A new `public/serve.json` ships with the build and uses `redirects` (which run **before** `rewrites` in `serve-handler`) to 301 `/mr-<digits>` and `/v<X.Y.Z>` to their explicit `/<subdir>/index.html` before the SPA fallback fires. `cleanUrls: false` keeps the second-hop URL hitting a real file. Unblocks [T425827](https://phabricator.wikimedia.org/T425827), [T425828](https://phabricator.wikimedia.org/T425828), [T425829](https://phabricator.wikimedia.org/T425829).

---

## [0.4.0] — 2026-05-08

- **PR**: [!8](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/8)
- **Phabricator**: _n/a_

### Added

- **In-app info modal** opened from a new top-right info button. Replaces the previous separate Phabricator and GitLab icon buttons (their links moved into the modal's Links section). The modal surfaces: the current build's version + deploy target, an About blurb, all relevant external links, a list of past releases with one-click rollback, a list of open merge requests with one-click preview, and a pretty-rendered live copy of `CHANGELOG.md`.
- **Permanent per-version archives.** Every push to `main` now publishes the build twice: once to the webroot (`/`, the live version everyone sees) and once to a permanent `/v<X.Y.Z>/` URL. Archives are kept indefinitely, so users can always navigate back to a previous release from inside the info modal.
- **Per-merge-request preview deploys.** Every MR pipeline now publishes a preview build to `/mr-<iid>/`. GitLab's `environment.on_stop` hook removes the directory automatically when the MR is merged or closed. The MR list inside the info modal links to each preview.
- `src/api/gitlab.js` — small unauthenticated read-only GitLab API helper for fetching open merge requests and the latest `CHANGELOG.md` (verified CORS-enabled).

### Changed

- `vite.config.js` now reads `VITE_BASE_PATH` for the build's `base` and exposes `__APP_VERSION__` (from `package.json`) and `__DEPLOY_TARGET__` (`main` / `v<X.Y.Z>` / `mr-<iid>` / `dev`) as compile-time defines so the running app can identify itself.
- `.gitlab-ci.yml` restructured around three deploy jobs (`deploy:main`, `deploy:mr`, `cleanup:mr`). Each job builds inline with its own `VITE_BASE_PATH` rather than sharing an artifact. The root deploy now uses `--exclude='/v*/' --exclude='/mr-*/'` so the new sibling directories are preserved under `--delete`.

---

## [0.3.2] — 2026-05-08

- **PR**: [!6](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/6)
- **Phabricator**: [T425819](https://phabricator.wikimedia.org/T425819)

### Fixed

- **Status dot now reflects required-field state on freshly-loaded rows.** The leftmost StatusDot decided green/red from `item.issues?.length > 0`, but `item.issues` was only refreshed by `recomputeIssues()` inside the cell-edit handler. Items fetched from the API were initialised with `issues: []`, so a stash row missing title/license/author showed a green dot while its cells correctly rendered red — the dot lied until the user typed into the row. Same root cause silently affected the "No license" chip and "· N issues" card meta, plus the status sort rank. `issues` is now derived state at the App level via `useMemo`, so all consumers (dot, chips, sort, tooltip) see fresh issues without each having to remember to call `recomputeIssues`. Published items pass through untouched.
- **`recomputeIssues` and the StatusTooltip's blocking-fields list now handle `depicts`.** Closes a parallel gap where the cell-level `isMissing` check already painted depicts cells red, but no `missing-depicts` issue code existed, so the dot stayed green when only depicts was missing.

---

## [0.3.1] — 2026-05-08

- **PR**: [!7](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/7)
- **Phabricator**: _n/a_

### Changed

- **Release workflow** in `CLAUDE.md`: deferred the version-bump commit to just before merge. Branches no longer carry a baked-in `## [X.Y.Z]` section or a bumped `package.json` while their PR is open — the merge order determines the version, so committing one early creates rebase churn whenever another PR slips ahead.

---

## [0.3.0] — 2026-05-08

- **PR**: [!4](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/4)
- **Phabricator**: [T425756](https://phabricator.wikimedia.org/T425756)

### Fixed

- **Stash list now paginates through all stashed files.** `fetchStashedFiles` made a single `mystashedfiles` API call without `msflimit`; MediaWiki's hard default of 10 silently truncated the workbench. The function now uses `msflimit=500` and follows `msfcontinue` until exhausted, with a 5000-item safety cap.
- **Soft-delete state is keyed by sha1 (content hash) instead of MediaWiki's per-stash-entry filekey.** Filekey was unstable across stash regenerations / re-uploads, so a hide could vanish on the next reload. Now the canonical store is `hiddenSha1s`; legacy `hiddenFilekeys` entries are migrated on bootstrap by joining with the current stash's filekey→sha1 map. `hiddenSha1s` is content-permanent and never auto-pruned: a re-upload of the same bytes inherits any prior soft-delete.
- **Re-upload after publish clears prior hides cleanly.** `cleanupAfterPublish` now unhides by both sha1 and filekey, so a future re-upload of the same bytes shows up visible.

### Changed

- Soft-delete buttons (`onDelete`, `onBulkDiscard`, `onUnhide`) now operate on the whole item (so they can clear both sha1 and legacy filekey hide entries) rather than just a filekey.

---

## [0.2.0] — 2026-05-05

- **PR**: [!1](https://gitlab.wikimedia.org/daanvr/upload-workbench/-/merge_requests/1)
- **Phabricator**: [T425587](https://phabricator.wikimedia.org/T425587)

### Added

- "Beta" pill in the topbar and on the login screen.
- Topbar icon-link buttons that open the Phabricator project (`#tool-upload-workbench`, for filing bugs) and the GitLab source repo in a new tab. Replaces the previously dead Help button.
- Login-screen hint linking the Phabricator project and the GitLab repo.
- README "Reporting bugs / feature requests" section.

### Changed

- README refreshed: status set to Beta with the live Toolforge URL; tech-stack section reflects the actual Toolforge deploy via `.gitlab-ci.yml`; OAuth setup section defers to `docs/oauth-registration.md` instead of duplicating the walkthrough.

---

## [0.1.0] — pre-versioning baseline

The state up to and including commit `c0b736e` is treated as `0.1.0`. No prior CHANGELOG entries — this is the starting point of the formal release process.
