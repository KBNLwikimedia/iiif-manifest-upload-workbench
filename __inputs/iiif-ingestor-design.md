# IIIF Manifest Ingestor — Design & Build Plan

**Goal:** add a IIIF-manifest ingestor to the existing Upload Workbench React app, so that:
**manifest in → metadata parsed → full-res images derived → items land in the stash/workbench flow → prefilled wikitext + structured data → review → publish to Commons.**

- Date: 2026-07-07
- Inputs read: `__inputs/conversation.md` (product vision, minus the Flask approach), `__inputs/manifests/` (25 live KB manifests), the Upload Workbench source (`src/`), `CLAUDE.md` (architecture, lessons learned, API-politeness rules), and the live Commons reference file [De reizen van Jan van Mandeville - KB 131 B 14 - 03.jpg](https://commons.wikimedia.org/wiki/File:De_reizen_van_Jan_van_Mandeville_-_KB_131_B_14_-_03.jpg) (wikitext **and** structured data, fetched via API).
- Status: ✅ **APPROVED 2026-07-07** — all 14 questionnaire items decided by Olaf (answers recorded inline below); the 6-phase build plan is approved as the roadmap. Next action: Phase 0.
- Open issues / deferred items / upstream data defects: tracked with stable ids in **[`open-issues.md`](open-issues.md)** — check its section A before starting a phase.

## Decision log (summary)

| # | Decision |
|---|---|
| Q1 | Manifest entry via **URL and .json file drop** |
| Q2 | **IIIF Presentation 3.0 only** in v1 (defensive parsing; other institutions later, KB first) |
| Q3 | **{{Artwork}}** template (field-level analysis beat the {{Book}} exemplars) |
| Q4 | **PD-Art-style combo license** (exact template settled in Phase 0.3 research) |
| Q5 | **Core SDC statements** + captions (P6243, P180, P195+P217, P6216, P275, P7482) |
| Q6 | Wikidata item: **auto-lookup by signature (P217 SPARQL) + manual override** |
| Q7 | Filenames = **manifest Title + per-canvas label, verbatim** (sanitized only for forbidden chars; positional fallback; preview before upload) |
| Q8 | Category: **suggest → user accepts/edits → tool creates the subcat** under `Medieval manuscripts from Koninklijke Bibliotheek` |
| Q9 | **Accept the 25 MP** `full/max` delivery cap |
| Q10 | Duplicates: **stash anyway and flag** (`exists-on-commons` chip); user decides per file |
| Q11 | Drafts **persist to the Metadata.json user-store** (batched/debounced writes) |
| Q12 | **Independent fork on GitHub**: repo `KBNLwikimedia/iiif-commons-upload-workbench` (org), **public**. **Local dev first** (`VITE_OWNER_ACCESS_TOKEN`); own Toolforge tool + OAuth consumer deferred until the ingestor works end-to-end |
| Q13 | **Dutch verbatim + machine-drafted English**, marked for review before publish |
| Q14 | Up to **500+ canvases** per manifest; UI name **"Import IIIF manifest"**; thin-milestone question revisited after Phase 1 |

---

## 1. Why this slots in cleanly: what already exists

The Workbench already implements almost the entire *back half* of the pipeline from `conversation.md`. We are building the **front half of the funnel** and reusing everything else:

| Pipeline step (from conversation.md) | Status in the codebase |
|---|---|
| Upload manifest (file or URL) | **NEW** — this project |
| Validate IIIF manifest | **NEW** — this project |
| Metadata summary of manifest | **NEW** — this project |
| Preview all images | **NEW** (import wizard) + existing grid/table views after import |
| SHA1 duplicate check against Commons | ✅ exists — `findCommonsFileBySha1()` in `src/api/commons.js`; per-stash dup effect in `app.jsx` |
| Select images for upload | **NEW** in import wizard; existing row selection afterwards |
| Category suggestion | Partially — category autocomplete + existence validation exist; *suggestion from manifest* is NEW |
| Wikitext template per image | ✅ exists — `src/wikitext-templates.js` registry ({{Information}}, {{Artwork}}, {{Book}}, …8 templates), rendered by `renderTemplateBlock()` |
| Structured data per image | ✅ largely exists — `buildSdcClaims()` in `src/api/publish.js` emits P170/P180/P625/P1071/P571 via `wbeditentity`; per-language captions (v0.37.0) |
| Side-by-side preview image + wikitext | ✅ exists — `src/ui/wikitext-preview-modal.jsx`, publish modals |
| Batch upload with progress | ✅ exists — serial uploader in `src/ui/dropzone.jsx` + `publishMany()` |
| Upload report | ✅ exists — bulk publish modal per-row status |

**Key architectural fit:** ingested IIIF images become *ordinary stash items*. Once an image is downloaded in the browser and stash-uploaded, every existing feature (drafts, spreadsheet editing, column defaults, sha1 dup flagging, publish flow, user-store persistence) applies with zero modification. The ingestor is an *on-ramp*, not a parallel pipeline.

---

## 2. Verified facts (spikes already done)

These were tested live on 2026-07-07, not assumed:

1. **CORS is open on dlc.services** — both `presentation-api.dlc.services` (manifests) and `dlc.services/iiif-img` (images, incl. full-res JPEG) return `Access-Control-Allow-Origin: *`. The browser can fetch everything directly. **The frontend-only (no Flask, no backend) approach is confirmed viable.**
2. **Manifest URL scheme changed — twice.** Manifests moved from `…/32/middeleeuwse-manuscripten/<slug>` (dead) to `…/32/<slug>`, and since June 2026 the **canonical base is `https://iiif.bibliotheken.nl/<slug>`** (verified live + CORS-open 2026-07-07; manifests self-identify with this base). The dlc.services host works in parallel for now; its collection index `https://presentation-api.dlc.services/32` lists all manifests machine-readably. ⇒ never hard-code the base URL; treat any pasted/fetched manifest URL as opaque. The parser is base-agnostic by construction.
3. **The reference Commons file uses `{{Book}}`, not `{{Artwork}}`** — with `{{Creator:Jean de Mandeville}}`, `|Source=` KB resolver link + `{{Koninklijke Bibliotheek}}`, `|Homecat=` a per-manuscript category, `|Wikidata=Q131620507`, license `{{PD-old-70}}`. (Questionnaire Q3/Q4.)
4. **The reference file's SDC** (M-entity): captions nl+en; P6216 copyright status = public domain (Q19652); P195 collection = KB (Q1526131); **P6243 digital representation of = the manuscript's Wikidata item**; P180 depicts = same item; P921 main subject; P7482 source of file = "file available on the internet" (Q74228490); P4082 captured with = scanner. Plus bot-added technical claims (dimensions, mime, sha1) we should NOT emit ourselves.
5. **Manuscript Wikidata items exist and are findable by signature** — SPARQL on P217 (inventory number) resolves e.g. "130 E 1" → Q114991159, "71 G 55" → Q114989895. Items are stubs (label + P31=manuscript), but they give us the Q-id for P6243/P180.
6. **Manifest quality varies** — of 26 manifests: 1 was 100% "Lorem ipsum" placeholder (KW 71 G 55, deleted), 1 had zero content metadata (KW 130 E 1), 4 share the generic title "Gebedenboek". Metadata labels are Dutch and *mostly* consistent (`Signatuur`, `Plaats van origine`, `Datum van origine`, `Kopiist`, `Illuminator`, `Materiaal`, `Aantal folia`, `Afmetingen…`, `Schrift`, `Taal`, `Herkomst`, licenses) but not guaranteed (some manifests have `Beeldlicentie`, others `Objectlicentie`). The parser must be defensive and the UI must show what was/wasn't extracted.
7. **Image sizes:** canvases range ~4,800×5,700 px to ~12,000×8,400 px. The image service enforces `maxArea: 25000000` (25 MP) — `/full/max/0/default.jpg` returns native resolution below 25 MP, server-side downscale above it. Sample downloads ran 6–21 MB each.
8. **`uploadFile()` posts the whole file in one request** (`src/api/upload.js` — chunked upload is still "deferred to v2", contrary to CLAUDE.md's summary). Fine for 6–21 MB files; MediaWiki accepts ~100 MB this way.

---

## 3. Architecture: where each piece goes

Follows the repo's conventions: new self-contained features use plain ESM under `src/ui/` and `src/api/` (NOT the window-globals pattern — that's only for the legacy design files). No new npm dependencies needed.

```
src/api/iiif.js            NEW  fetch + validate + parse manifest (Pres. API 3.0)
                                → { label, summary, metadata[], rights, canvases[] }
                                canvas → { label, width, height, thumbUrl, fullResUrl, serviceId }
src/api/iiif-map.js        NEW  manifest metadata → workbench fields
                                (per-item drafts: title, description, date, source,
                                 author, license, categories, captions, SDC extras)
src/api/wikidata.js        NEW  P217 signature → Q-id lookup (SPARQL, cached via apiCache)
src/ui/iiif-import-modal.jsx NEW  the wizard (entry → validate → summary → gallery
                                → select → mapping preview → run pipeline)
src/api/publish.js         EXTEND buildSdcClaims(): P6243, P195, P6216, P7482 (opt-in
                                per item fields; existing claims untouched)
src/app.jsx / topbar       TOUCH  one "Import IIIF manifest" entry point (button
                                next to Upload; optionally also recognise a
                                dropped .json manifest in dropzone.jsx)
```

**The pipeline engine** (inside the modal, modeled on `dropzone.jsx`'s serial `enqueue()` loop):

```
for each selected canvas (sequential — Commons rate-limits, dlc politeness):
  1. fetch fullResUrl → Blob                     (browser, CORS OK)
  2. sha1 = WebCrypto SubtleCrypto digest        (no dependency needed)
  3. findCommonsFileBySha1(sha1)                 (existing)
       hit → mark "already on Commons", SKIP stash upload (saves the
             expensive write), still listed in the report
  4. new File([blob], targetFilename) → uploadFile(file, csrf)   (existing)
  5. setStashedFilename(); normalizeStashItem()  (existing)
  6. saveDraft keyed by sha1: prefilled title/description/date/source/
     author/license/categories/captions/SDC extras from iiif-map.js
     → user-store Metadata.json via existing debounced writer
```

After the loop the modal closes and the user is looking at the normal workbench table with N prefilled rows — review, tweak, bulk-publish exactly as today.

---

## 4. Build plan — steps & dependencies

### Phase 0 — Remaining spikes & research (no product code)
| # | Task | Depends on | Why |
|---|---|---|---|
| 0.1 | ~~CORS check dlc.services~~ | — | ✅ done, positive |
| 0.2 | ~~Reference file wikitext + SDC~~ | — | ✅ done (see §2.3–2.4) |
| 0.3 | ~~Best-practice mining~~ ✅ **done 2026-07-07** — full findings in [`commons-best-practices.md`](commons-best-practices.md). Key outcomes: **license = `{{Licensed-PD-Art|PD-old-100-expired|Cc-zero}}`**; three template generations observed ({{Information}} → GWToolset {{Artwork}} → Pattypan {{Book}}, the {{Artwork}} generation being the richest — supports our Q3 choice); SDC core set on all KB files: P6216=Q19652, P195=Q1526131 (+P2868=Q29188408), P31=Q1250322+Q125191, P7482=Q74228490 (+P973 resolver URL, +P137 operator), P6243/P180/P921=manuscript Q-id; **P275 never used** (drop from Q5 set), P217 + captions absent everywhere (gaps our tool fills); category naming `<Common title> - <shelfmark>`; credit = `{{Institution:Koninklijke Bibliotheek}}` in the infobox **and** standalone `{{Koninklijke Bibliotheek}}` in source | — | The field-mapping table (Phase 3) is only as good as the target convention |
| 0.4 | ~~Verify in-browser SHA-1~~ ✅ **done 2026-07-07**: WebCrypto `subtle.digest('SHA-1')` matches native hashing on all 3 sample images, 16 ms for a 20 MB blob; `aisha1=` round-trip against Commons works (all 3 samples: not yet on Commons) | — | Step 2 of the pipeline hinges on it |
| 0.5 | ~~Confirm stash quota~~ ✅ **done 2026-07-07**: MediaWiki core has **no per-user stash count limit** — only `$wgUploadStashMaxAge` (the 48 h expiry). Real constraints for big imports: the 48 h window + Commons upload *rate* limits (sequential pipeline respects them); verify empirically with a real batch during Phase 4 testing | — | A 500-canvas manuscript must fit |
| 0.6 | ~~Decide git/remote/deployment~~ → **execute**: `git init`, create public GitHub repo `iiif-commons-upload-workbench`, initial commit + push (decided in Q12; local-dev-first, no Toolforge yet) | — | Everything after Phase 0 wants version control |

### Phase 1 — Manifest parser (`src/api/iiif.js`) — ✅ **implemented 2026-07-07**

Shipped as `src/api/iiif.js` (pure ESM: `fetchManifest`, `parseManifestFile`, `parseManifest`, language-map helpers, placeholder detection, canonical KB metadata-label normalisation, per-canvas full-res/thumb URL derivation with maxArea math, three-level validation report) + `scripts/test-iiif-parser.mjs` (corpus harness). Result over the 25-manifest corpus: **24 parse ok, 1 correctly rejected** (zero-canvas Wapenboek Beyeren); all known defects surface as report entries. Corpus fact: largest manifest is KW 129 A 10 Lancelotcompilatie at **484 canvases**.
| # | Task | Depends on |
|---|---|---|
| 1.1 | Fetch manifest by URL (with `Api-User-Agent`-style politeness) or accept a dropped/pasted JSON file | — |
| 1.2 | Validate: JSON well-formed; `@context` is Presentation 3 (v2 support per Q2); required fields (`id`, `type=Manifest`, `label`, `items`); per-canvas: painting annotation with ImageService | 1.1 |
| 1.3 | Extract global metadata: label, summary, `metadata[]` label/value pairs (multilingual maps flattened, Dutch-first), `rights`, provider | 1.2 |
| 1.4 | Extract canvases: label, dimensions, thumbnail URL, ImageService id + `maxArea` → compute `fullResUrl` (`{service}/full/max/0/default.jpg`) and the *expected* delivered pixel size (native, or maxArea-fitted) | 1.2 |
| 1.5 | Validation report object (errors / warnings / info) for display in the wizard — e.g. "metadata field X missing", "canvas 5 exceeds 25 MP, will be delivered downscaled", "Lorem ipsum placeholder detected" | 1.3, 1.4 |

### Phase 2 — Import wizard UI (`src/ui/iiif-import-modal.jsx`)
| # | Task | Depends on |
|---|---|---|
| 2.1 | Entry point: topbar button "Import IIIF manifest" (+ optionally: dropzone recognises a `.json` that parses as a manifest — Q1) | Phase 1 |
| 2.2 | Step A: URL input / file drop → parse → validation report | 2.1 |
| 2.3 | Step B: metadata summary panel (the manifest "passport": title, signature, origin, date, material, folia, license…) | 2.2 |
| 2.4 | Step C: canvas gallery — IIIF thumbnails (`/full/400,/…` — cheap, purpose-built), checkbox per canvas, select-all/none, per-canvas expected size + ">25 MP downscale" badge | 2.2 |
| 2.5 | Step D: mapping preview — target filename per image, one example wikitext render, proposed categories, proposed SDC; editable knobs (filename pattern, category, template) before starting | 2.4 + Phase 3 |
| 2.6 | Step E: run pipeline with per-image progress (download → hash → dup-check → stash), skip/error rows clearly reported; cancel button between items | 2.5 + Phase 4 |

### Phase 3 — Metadata mapping (`src/api/iiif-map.js`) — *the heart of it* — ✅ **implemented 2026-07-07**

Shipped as `src/api/iiif-map.js` (`mapManuscript` / `mapCanvases` / `mapManifest` + exported derivation helpers) and `src/api/wikidata.js` (P217 SPARQL lookup, apiCache'd, returns candidate list for user confirmation per Q6). Corpus-tested via `scripts/test-iiif-map.mjs`: 24/24 usable manifests map with unique, forbidden-char-free filenames. Notes: title derivation strips signature-repeats/parentheticals and truncates at word boundaries; dates map to `{{other date|circa/ca/between/or/century|…}}` with verbatim-Dutch fallback for half/quarter-century phrases; captions cap at compact length; `{{unknown|author}}` for Onbekend copyists; dimensions → `{{Size|unit=mm|…}}`. Per-canvas extras (medium, dimensions, institution, accession number, date wikitext, SDC statement inputs) travel under `item.iiif` for Phase 4/5 wiring — **including the Phase 5.2 to-do that `formatDate()` must pass non-ISO date wikitext through untruncated**.
| # | Task | Depends on |
|---|---|---|
| 3.1 | Mapping table manifest→workbench columns, grounded in 0.3. Draft (to be confirmed): `label`+canvas index → **title/filename**; `summary`/`Inhoud` → **description** (`{{nl|…}}`); `Datum van origine` → **date** (as `{{other date|circa|1538}}` when "Circa"); `Signatuur` → filename + SDC P195 qualifier / accession; `Materiaal`, `Afmetingen`, `Schrift`, `Taal`, `Herkomst` → template params (`medium`/`dimensions`/`language`/`provenance` where the chosen template has them); manifest `id` + KB resolver → **source**; `Kopiist`/`Illuminator` (usually "Onbekend") → **author** handling; `rights` (CC0) → **license** per Q4 | 0.3 |
| 3.2 | Filename generator: pattern per Q7 (e.g. `<Short title> - KW 129 A 24 - <NN>.jpg`), collision-safe, respects `sanitizeFilename()` + `FORBIDDEN_TITLE_CHARS`, NN from canvas order (zero-padded) or canvas label | 3.1 |
| 3.3 | Category proposal: per-manuscript home category (exemplar pattern: one category per manuscript, member of `Medieval manuscripts from Koninklijke Bibliotheek`) — **note the app currently blocks publishing with categories that don't exist on Commons (T425950)**, so this needs Q8's answer (tool creates the category page vs. user creates it manually first) | 3.1 |
| 3.4 | Wikidata Q-id lookup by signature (P217 SPARQL, `apiCache`d, manual override field in wizard) → feeds P6243/P180 + `|Wikidata=` param | 3.1 |
| 3.5 | Captions: nl caption from description (and en if provided/translated — Q13) via the existing per-language caption columns | 3.1 |

### Phase 4 — Pipeline engine (in-modal; reuses `dropzone.jsx` patterns)
| # | Task | Depends on |
|---|---|---|
| 4.1 | Sequential download→sha1→dup-check→stash loop with progress callbacks, per-item retry, abort between items | Phases 1–3 |
| 4.2 | Draft prefill on success: write mapped fields as drafts keyed by **sha1** (never filekey — lesson learned), via existing `user-store.js` debounced writer. Store the manifest URL as a small provenance note on the draft; never store the manifest itself in wiki pages (no derived data — lesson learned) | 4.1 |
| 4.3 | Memory hygiene: release each Blob before the next download (35 × 20 MB must not accumulate) | 4.1 |
| 4.4 | Import report: uploaded / skipped-duplicate / failed, with links | 4.1 |

### Phase 5 — SDC & publish extensions (`src/api/publish.js`)
| # | Task | Depends on |
|---|---|---|
| 5.1 | Extend `buildSdcClaims()` with opt-in item fields: P6243 digital representation of (Q-id), P195 collection (KB = Q1526131, with P217 inventory-number qualifier), P6216 copyright status + P275 license (per Q4), P7482 source of file (Q74228490 + operator/URL qualifiers) — scope per Q5 | 3.4 |
| 5.2 | Confirm the chosen template ({{Book}} or {{Artwork}} — Q3) renders all mapped params; add missing `key:` mappings in `BUILTIN_TEMPLATES` if a param exists but is unmapped (e.g. `medium`, `dimensions`, `institution` currently have `key: null`) | 3.1 |
| 5.3 | Auto-select the template + column set when items originate from a IIIF import (template config already flows through `publishOne/publishMany`) | 5.2 |

### Phase 6 — Verification & ship
| # | Task | Depends on |
|---|---|---|
| 6.1 | `npm run build` (includes the undefined-refs scanner; update `scripts/window-globals.json` only if any new window-global is introduced — plan: none) | all |
| 6.2 | End-to-end manual test: import a small manifest (e.g. KW 76 E 5 Beatrijs), verify wizard → table → wikitext preview → publish 1–2 files to Commons → verify rendered file page + SDC against the exemplar → check dup-flagging by re-importing | all |
| 6.3 | CHANGELOG entry under `[Unreleased]`; docs section in README | 6.2 |

**Estimated shape:** Phases 1+3 are the intellectual core; Phase 2 is the most code; Phases 4–5 are mostly wiring existing plumbing.

---

## 5. Constraints & risks (from CLAUDE.md + this design)

1. **API politeness** — the entire import is behind an explicit user gesture (fine per the "no bulk reads on bootstrap" rule); downloads and uploads run strictly sequentially; thumbnails use the manifest's purpose-built thumb sizes, not full-res.
2. **48-hour stash expiry** — an imported manuscript must be published within 48 h or re-imported. The existing countdown UI covers this, but a 100-canvas import the user "saves for the weekend" will silently evaporate. (Mitigation: warning in the import report; re-import is cheap and dup-checking makes it idempotent.)
3. **Bandwidth through the browser** — ~350 MB for a 35-canvas manuscript (down *and* up ≈ 700 MB total transfer). Acceptable for the KB use case; worth a heads-up in the wizard.
4. **sha1 as identity** (lesson learned) — all cross-session state keyed by sha1; filekey only as fallback. The dup-check equally protects against double-import.
5. **Don't persist derived data to wiki pages** (lesson learned) — drafts are OK (they're the same as hand-typed edits); the manifest JSON itself, canvas lists, or image URLs beyond a provenance pointer are NOT stored in `Metadata.json`.
6. **Metadata variance** — the mapper must degrade gracefully on missing/placeholder fields ("Onbekend", "Lorem ipsum", "-") and surface unmapped manifest fields in the summary so nothing silently disappears.
7. **Category existence blocking** — T425950 blocks publish on nonexistent categories; the per-manuscript home category will *always* be new. Q8 decides the resolution.
8. **maxArea** — Commons wants the highest available resolution; served max is 25 MP for the big canvases. Tile-stitching to reconstruct >25 MP natives is technically possible but heavy, brittle and arguably impolite — recommended out of scope for v1 (Q9).
9. **KB URL migration** — when `iiif.kb.nl` goes live, old manifest URLs will die (they already moved once). The ingestor treats URLs as opaque input; nothing breaks, but stored provenance pointers may go stale.

---

## 6. Questionnaire — decisions I need from you

Mark with `[x]`, add notes inline. ★ = my recommendation.

### Q1. Manifest entry point
- [x] ★ Both: paste a manifest **URL** (primary) *and* drop/upload a manifest **.json file** (fallback, also works when CORS/offline bites)
- [ ] URL only
- [ ] File only
- Notes: **DECIDED 2026-07-07: both.**

### Q2. IIIF Presentation API version scope (v1)
- [x] ★ Version 3.0 only (all KB manifests are v3; v2 support as a later task)
- [ ] Version 2.x + 3.0 from the start (needed if you want other institutions' manifests soon — e.g. MMMONK, Maastricht/Radboud partners)
- Notes: **DECIDED 2026-07-07: v3 only.**

### Q3. Wikitext template for manuscript images
*Field-level analysis (2026-07-07) across all 25 manifests: {{Artwork}} gives dedicated, semantically-correct params for ~9 of the 14 recurring manifest fields (accession number ← Signatuur, place of creation ← Plaats van origine, medium ← Materiaal, dimensions ← Afmetingen, object history ← Herkomst/Verwerving, institution ← Collectiebeheerder, plus date/description/references); {{Book}} covers only ~4 (Language, Illustrator, Date, Description) and its core params (Publisher/Printer/Edition/ISBN/OCLC) are meaningless for unique codices. The two existing KB exemplars (Mandeville, Gruuthuse) do use {{Book}}, but with nearly all params empty or metadata squeezed into free text — legacy of metadata-poor batch uploads, not a fit argument.*
- [x] ★ `{{Artwork}}` — best structural match for the manifest metadata; museum-object semantics fit a held manuscript
- [ ] `{{Book}}` — consistency with the existing KB uploads in the category; direct `Illustrator`/`Language`/`Homecat` params
- [ ] Decide per manuscript in the wizard (both wired up)
- Notes: **DECIDED 2026-07-07: {{Artwork}}** (confirmed by Olaf after field-level analysis).

### Q4. License emitted for these CC0-manifest, centuries-old manuscripts
- [ ] `{{CC-zero}}` — follow the manifest's `rights` field verbatim
- [ ] `{{PD-old-70}}` — what the Mandeville exemplar uses (author died >70 y ago)
- [x] ★ `{{PD-Art|PD-old-100-expired}}`-style / `{{Licensed-PD-Art|…|Cc-zero}}` combo — states both "work is PD" and "reproduction released CC0" (I'll confirm the exact best-practice template in Phase 0.3)
- Notes: **DECIDED 2026-07-07**. Phase 0.3 research settled the exact call: **`{{Licensed-PD-Art|PD-old-100-expired|Cc-zero}}`** — KB IIIF images are photographs (EXIF: Canon EOS 5D II) so the PD-Art family applies (not PD-scan); `Licensed-PD-Art` records the KB's CC0 grant on the reproduction for jurisdictions that don't follow Bridgeman; `PD-old-100-expired` covers author-death + US status. See `commons-best-practices.md` §4.

### Q5. Structured-data scope for v1
- [ ] Captions (nl/en) only — reuse what exists, zero new SDC code
- [x] ★ Captions + core statements matching the exemplar: P6243 digital representation of, P180 depicts, P195 collection (+P217 qualifier), P6216 copyright status, P275 license, P7482 source of file
- [ ] Everything incl. P4082 captured-with, P921 main subject
- Notes: **DECIDED 2026-07-07: core statements in v1.** Phase 0.3 refinement: **drop P275** (license — never used on PD works; P6216=Q19652 covers status) and match observed KB practice: P195 with qualifier P2868=Q29188408, P31=Q1250322+Q125191, P7482=Q74228490 with P973 (KB resolver URL) + P137 (operator) qualifiers. P217 and captions are absent from all existing KB files — our tool adds them as an improvement. See `commons-best-practices.md` §3/§5.

### Q6. Wikidata item for the manuscript (feeds P6243/P180/|Wikidata=)
- [x] ★ Auto-lookup by signature via Wikidata SPARQL (P217 = "129 A 24"), with a manual override field in the wizard; blank if not found
- [ ] Manual entry only
- [ ] Skip Wikidata linking in v1
- Notes: **DECIDED 2026-07-07: auto-lookup with manual override.**

### Q7. Commons filename pattern
- [ ] `<Short title> - KW <signature> - <NN>.jpg` (e.g. `Atlas de Dauphin - KW 129 A 24 - 03.jpg`) — mirrors the exemplar but with the KB's current "KW" shelfmark prefix
- [ ] `<Short title> - KB <signature> - <NN>.jpg` — exactly like the existing Mandeville/Gruuthuse files ("KB 131 B 14")
- [ ] Derive `<NN>` from the canvas **label** (e.g. folio numbers "fol. 6r") instead of positional index
- [x] Other pattern — describe in notes
- Notes: **DECIDED 2026-07-07: build the filename from the manifest Title plus the per-canvas label data** (the canvas's own `label` from the manifest). Implementation detail: KB canvas labels are currently filename-like (e.g. `KW129A4_0001.JPG`) — the generator strips the shelfmark prefix + extension and turns underscores into spaces (`KW129C3ii_0001a_Front_Cover.jpg` → `0001a Front Cover`), falling back to a zero-padded positional index when a canvas label is missing/unusable; the wizard's mapping-preview step (2.5) shows the resulting filenames for approval before anything uploads.
  **Refinement 2026-07-07 (after generating example titles from 10 real manifests):** descriptive label parts (`OMSLAG1`, `VP01`, `0001a Front Cover`, `Open View`) are kept **verbatim as in the manifest**, only altered when they clash with Commons title rules or forbidden characters (`# < > [ ] | { } / :` — same set as `FORBIDDEN_TITLE_CHARS`). Evidence from the examples run: labels ≠ canvas position (Beatrijs out-of-order, Liber Pantegni offset numbering) so labels are authoritative; Wapenboek Beyeren (KW 79 K 21) currently has **zero canvases** in its manifest — validation report must flag this class of upstream defect.

### Q8. Per-manuscript home category (will not exist on Commons yet)
- [x] **Combo (decided):** the wizard *suggests* a category name (e.g. `Category:Atlas de Dauphin - KW 129 A 24`); the user can **accept or edit** the suggested name; on confirmation the tool **creates the category page** as a subcategory of `[[Category:Medieval manuscripts from Koninklijke Bibliotheek]]` — unblocks T425950's publish check automatically
- [ ] Tool only *suggests* the name; you create the category manually on Commons first
- [ ] Skip per-manuscript categories; put files directly in the existing parent category
- Notes: **DECIDED 2026-07-07: suggest → user accepts/edits name → tool creates the subcat under the main category.** (If the edited name already exists on Commons, the tool skips creation and just uses it.)

### Q9. Resolution policy for canvases above the 25 MP service cap
- [x] ★ Accept the server's 25 MP `full/max` rendition (v1; simple, polite, still very high-res)
- [ ] Tile-stitch native resolution in the browser (complex; deferred proposal would follow)
- Notes: **DECIDED 2026-07-07: accept the 25 MP cap.**

### Q10. Duplicate images (sha1 already on Commons)
- [ ] Skip automatically (don't stash), show as "already on Commons" with a link in the report
- [x] Stash anyway, flag in the table, let me decide per file (existing `exists-on-commons` banner behaviour)
- Notes: **DECIDED 2026-07-07: stash anyway and flag** — user decides per file. (Pipeline step 3 therefore never skips; the dup-check result just lands as the existing `exists-on-commons` issue chip.)

### Q11. Prefilled drafts persistence
- [x] ★ Persist as normal drafts to your `Metadata.json` user-store page (survives reload, roams across devices — same as typing them by hand)
- [ ] Keep import-session-only (drafts vanish on reload; lighter on wiki writes)
- Notes: **DECIDED 2026-07-07: persist to user-store.**

### Q12. Repository & deployment (blocking practical question)
This folder is **not a git repository** (no `.git`), and it's a renamed copy of Daanvr's `upload-workbench`. Before writing code I need to know the intent:
- [x] Independent fork: `git init` here, publish to **GitHub** (org `KBNLwikimedia`), own Toolforge tool + **own OAuth consumer registration** later
- [ ] Independent fork on **Wikimedia GitLab**
- [ ] Aim to contribute upstream to `daanvr/upload-workbench` via MR (then we should develop against a proper clone + branch, and follow the Phabricator task workflow from CLAUDE.md)
- [ ] Just prototype locally for now (`git init` for safety, decide remote later)
- Notes: **DECIDED 2026-07-07: independent fork on GitHub** — repo `KBNLwikimedia/iiif-commons-upload-workbench` (org account), **public**. **Deployment: local dev first** (`npm run dev` + `VITE_OWNER_ACCESS_TOKEN` against the real Commons API); own Toolforge tool + OAuth consumer registration deferred until the ingestor works end-to-end.

### Q13. Description/caption languages
- [ ] Dutch verbatim from the manifest (`{{nl|…}}` + nl caption); English field left empty for you to fill manually where wanted
- [x] Dutch + auto-drafted English translation, clearly marked for review before publish
- [ ] Dutch + English both required before publish
- Notes: **DECIDED 2026-07-07: Dutch verbatim + machine-drafted English, marked for review.** (Implementation note: with no backend, translation needs a client-side path — candidate: MediaWiki/MinT translation API or draft-at-import via the wizard; to be settled in Phase 3.5.)

### Q14. Anything else — **ANSWERED 2026-07-07**
- **Batch size:** manifests can reach **500+ canvases**. Implications: (a) the 48 h stash expiry and the stash quota check (Phase 0.5) become critical — a 500-page import is ~10 GB through the browser and cannot realistically be imported *and* published in one sitting without planning; (b) the wizard should support **importing a selection/slice** of a manifest (canvas range + select-all/none already planned in 2.4) and make re-runs cheap; (c) memory hygiene (4.3) and abort/resume (4.1) are hard requirements, not niceties; (d) the drafts write to `Metadata.json` must stay batched/debounced so 500 drafts don't produce 500 wiki edits.
- **UI name:** "Import IIIF manifest" confirmed.
- **Other institutions:** likely later; **KB first**. Parser stays v3-only (Q2) but written defensively so non-KB v3 quirks are a config/mapping problem, not a rewrite.
- **Thinner first milestone:** undecided — revisit after Phase 1 (parser) is demoable.

---

## 7. My open feedback / observations for you

1. **Your exemplar contradicts the {{Artwork}} assumption** — the Mandeville file (which conversation.md designates as *the* model) uses `{{Book}}`. Both templates are already in the registry, so this is a one-line config choice (Q3), but the field mapping differs, so I'd like the answer before Phase 3.
2. **The strongest v1 simplification available:** skip the SDC extensions (Q5 option 1) and ship parser + wizard + pipeline first — items land in the existing workbench where captions/depicts/publish already work. SDC statements can follow one release later.
3. **Stash expiry is the sharpest UX edge** — 48 h between import and publish. The idempotent dup-check makes re-import safe, but it's worth deciding early whether "import → publish same session" is the expected workflow (I believe it is).
4. **KW 130 E 1's metadata gap** and the "Lorem ipsum" manifest show that upstream data quality will vary — the wizard's validation report (Phase 1.5) is not a nice-to-have, it's how Daniëlle's team gets actionable feedback too.
5. `urls.txt` and the Notion table now disagree with the live IIIF endpoints; consider asking Daniëlle for the definitive collection-index URL (I used `https://presentation-api.dlc.services/32`) and whether `iiif.kb.nl` has an ETA — the collection index would also let the ingestor offer a "browse available KB manifests" picker instead of paste-a-URL.
