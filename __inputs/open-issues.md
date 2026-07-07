# Open issues & deferred decisions — IIIF Commons Upload Workbench

Living register of everything known-but-not-yet-done: technical debt, deferred design decisions, upstream data defects, and nice-to-haves. Companion to the build plan in [`iiif-ingestor-design.md`](iiif-ingestor-design.md).

**Conventions:** every entry gets a stable ID (`OI-nn`), the date it was raised, where it came from, and what resolves it. When an issue is resolved, don't delete it — move it to the *Closed* section at the bottom with the date and the commit/decision that closed it. New entries append to the relevant section with the next free ID.

*Last updated: 2026-07-07.*

---

## A. Must fix before/at the named phase (blocking that phase's completion)

| ID | Issue | Origin | Resolution plan |
|---|---|---|---|
| OI-01 | **`formatDate()` truncates to 10 chars** (`String(item.dateTaken).slice(0, 10)` in `src/wikitext-templates.js`) — an ISO assumption that would mangle `{{other date|circa|1538}}`. The mapper therefore parks date wikitext in `item.iiif.dateWikitext` instead of `dateTaken`. | Phase 3 mapping, 2026-07-07 | Phase 5.2: make the {{Artwork}} date handler pass non-ISO values through untruncated (detect `{{`/non-date strings), then move the value onto the real field. |
| OI-02 | **{{Artwork}} params `medium`, `dimensions`, `institution`, `accession number`, `department` have `key: null`** in `BUILTIN_TEMPLATES` — mapped IIIF values can't reach the rendered wikitext yet. | Q3 decision + Phase 3, 2026-07-07 | Phase 5.2: add column keys (or an `item.iiif.artwork` passthrough) in `wikitext-templates.js` so these params render from the mapper output. |
| OI-03 | **`item.iiif` extras are session-only** — `iiif` is not in `DRAFT_FIELDS` (`src/api/user-store.js`), so mapped extras (SDC inputs, date wikitext, artwork params, manifest URL) vanish on reload. Deliberate for now (never persist derived data — lesson learned), but the pipeline needs *something* durable. | Phase 3, 2026-07-07 | Phase 4: persist only the non-derivable minimum (manifest URL + confirmed `wikidataQid`, probably as draft fields); recompute the rest from the manifest on demand. |
| OI-04 | **Per-manuscript category will not exist on Commons** and the app blocks publish on nonexistent categories (upstream T425950, `categories-not-on-commons` blocking issue). | Q8 decision | Phase 2/4 wizard: suggest name → user accepts/edits → `action=edit` creates the category page under `Category:Medieval manuscripts from Koninklijke Bibliotheek` before publish; skip creation if it already exists. |
| OI-05 | **English caption/description drafting (Q13) has no implementation path yet** — no backend, so machine translation must run client-side. Candidate: Wikimedia's MinT translation API. | Q13 decision | Phase 3.5 (before Phase 5 completes): evaluate MinT (auth? CORS? quality on nl→en heritage text); wire as clearly-marked draft the user reviews. Fallback: leave `en` empty. |
| OI-06 | **Commons upload rate limits unquantified for large batches** — a 500-canvas import runs hundreds of sequential stash uploads + publishes; the exact throttle behaviour (error codes, backoff needed) is unverified. | Phase 0.5 spike, 2026-07-07 | Phase 4 testing: run a real ~50-file batch, observe `ratelimited` errors, implement retry-with-backoff; document the observed budget. |

## B. Deferred by explicit design decision (revisit when the trigger fires)

| ID | Issue | Decided | Trigger to revisit |
|---|---|---|---|
| OI-07 | **IIIF Presentation 2.x support** — v3 only in v1. | Q2 | First non-KB institution whose manifests are v2 (MMMONK, Maastricht/Radboud partners). |
| OI-08 | **Tile-stitching native resolution >25 MP** — v1 accepts the server's `full/max` (25 MP cap); ~30-60% of KB canvases arrive downscaled. | Q9 | If Commons reviewers or the KB ask for full native resolution. |
| OI-09 | **Own OAuth consumer + Toolforge deployment** — local dev only (`VITE_OWNER_ACCESS_TOKEN`). | Q12 | Ingestor works end-to-end (after Phase 6). |
| OI-10 | **In-app identity renames** — `APP_USER_AGENT`, `attributionSuffix()` (`toolforge:upload-workbench` link), `index.html` title still identify as upstream. Correct while the code lineage is upstream's; must flip in one dedicated commit. | Fork setup, 2026-07-07 | Same trigger as OI-09 (own consumer/deployment). See CLAUDE.md → "Pending identity renames". |
| OI-11 | **Thin-first-milestone scope** — "not sure yet". | Q14 | Revisit now that the parser is demoable; decide before starting Phase 2 if a minimal end-to-end slice should ship first. |
| OI-12 | **Stash thumbnails show placeholder tiles, not real previews** — `Special:UploadStash` needs auth an `<img>` can't send; user chose "leave it for now". IIIF-imported items can avoid this entirely by setting `thumburl` to the manifest's public IIIF thumbnail (easy win in Phase 4); user-dropped files would need the upload-stash-viewer approach (auth fetch → blob URL). | 2026-07-07 conversation | If missing previews annoy during Phase 4/6 testing. The IIIF-thumb easy win should just be done in Phase 4. |

## C. Mapping-quality niggles (user-editable in the wizard, but could be smarter)

| ID | Issue | Example | Improvement idea |
|---|---|---|---|
| OI-13 | **Dutch period phrases stay verbatim in `|date=`** — halves/quarters of centuries and compound datings aren't converted to `{{other date}}`. | "tweede helft 15de eeuw", "eerste kwart 16de eeuw", "ca. 1530 en ca. 1550-1560" | Verify the exact `{{other date|2half/quarter|…}}` sub-syntax against the template docs, then extend `deriveDateWikitext()`. |
| OI-14 | **Title truncation can end awkwardly** — 60-char word-boundary cut may end on a function word. | KW 130 E 1 → "Regel van St. Augustinus van Hippo met commentaar van" | Trim trailing stopwords (van/de/het/met/en) after truncation; or prefer the pre-comma segment. |
| OI-15 | **Caption = description** — the `descriptions` map feeds both the `{{Artwork}} |description=` wikitext and the caption columns, so one compact string serves two purposes; long summaries are dropped in favour of the short title. | Atlas de Dauphin's 500-char Latin incipit | If richer descriptions are wanted: separate description channel (e.g. dedicated field rendered into `|description=`) while captions stay short. |

## D. Upstream data defects (KB / Daniëlle — not ours to fix, but must stay reported & guarded)

| ID | Issue | Manifest | Status |
|---|---|---|---|
| OI-16 | Manifest contains **zero canvases**. | KW 79 K 21 (Wapenboek Beyeren) | Parser rejects with a clear error. Reported on the Notion project page (7 juli 2026). |
| OI-17 | All metadata is **"Lorem ipsum"** placeholder. | KW 71 G 55 | Manifest deleted from corpus; parser detects placeholder values generically. Reported. |
| OI-18 | **No summary / Inhoud field.** | KW 130 E 1 | Title supplied manually (from Notion table); parser warns on missing summary. Reported. |
| OI-19 | **Metadata label spelling drift** — five variants of "Afmetingen" alone; `Beeldlicentie` vs `Objectlicentie`. | corpus-wide | Parser normalises via `LABEL_CANON`; watch for new variants when new manifests arrive. |
| OI-20 | **Canvas order ≠ canvas-label numbering** (labels are authoritative). | KW 76 E 5 (Beatrijs: canvas 2 = label 005, last = 004); KW 73 J 6 (labels offset by 1) | Filenames derive from labels (Q7); no fix needed, but flag in the wizard so the user understands non-sequential numbers. |
| OI-21 | **Corpus manifests in `__inputs/manifests/` carry old dlc.services ids** — downloaded before the `iiif.bibliotheken.nl` move; content identical but `id` fields point at the legacy host. | corpus-wide | Optionally re-download from the new base when convenient; parser doesn't care. Also: sub-collections `topstukken` + `fragmenten` were never downloaded. |

## E. Nice-to-haves / ideas (no commitment)

| ID | Idea | Origin |
|---|---|---|
| OI-22 | **"Browse available KB manifests" picker** in the wizard, fed by a collection index instead of paste-a-URL. Open question: is there an index on `iiif.bibliotheken.nl` (root URL returns 200 — inspect what it serves)? The authoritative overview is currently a KB SharePoint Excel (login required — not machine-readable for the tool). | Design §7.5 |
| OI-23 | **P217 + captions as a selling point** — no existing KB Commons file has the inventory-number statement or multilingual captions; our uploads add both. Worth mentioning in eventual documentation/announcement. | Phase 0.3 mining |
| OI-24 | **Build chunk-size warning** (bundle > 500 kB) — pre-existing upstream, cosmetic; code-splitting would silence it. | every `npm run build` |

## Closed

| ID | Issue | Closed | How |
|---|---|---|---|
| — | *(nothing closed yet)* | | |
