# Commons best practices: KB medieval manuscript uploads

Research snapshot, 2026-07-07. Source: `Category:Medieval manuscripts from Koninklijke Bibliotheek`
(39 per-manuscript subcategories + 88 loose files). 15 files sampled across 9+ manuscripts, wikitext
(`prop=revisions`) + structured data (`wbgetentities`, M-ids) fetched for each. Feeds field-mapping
design of the IIIF→Commons upload tool.

## 1. Sample table

| File (M-id) | Manuscript | Infobox | License (verbatim) | SDC beyond core |
|---|---|---|---|---|
| Egmond Gospels - 76 F 1 - 001r.jpg (M95264139) | Egmond Gospels, KW 76 F 1 | {{Book}} | `{{PD-old-100}}` | P6243, P180, P921, P7482+resolver, EXIF props |
| Egmond Gospels - 76 F 1 - 002v.jpg (M95258646) | idem | {{Book}} | `{{PD-old-100}}` | idem |
| Gruuthuse manuscript - KW 79 K 10 - 01r.jpg (M95494857) | Gruuthuse, KW 79 K 10 | {{Book}} | `{{PD-old-100}}` | P7482+resolver only |
| Gruuthuse manuscript - KW 79 K 10 - 02v.jpg (M95494071) | idem | {{Book}} | `{{PD-old-100}}` | idem |
| Trivulzio book of hours - KW SMC 1 - Calendar April recto.jpg (M95488931) | Trivulzio, KW SMC 1 | {{Book}} | `{{PD-old-100}}` | P6243, P180 (5 values), P921, P7482, P8791, P4082 |
| Aprul (April) and Meye (May)… Der naturen bloeme - KB KA 16 - 002v.jpg (M95335602) | Der naturen bloeme, KA 16 | {{Book}} | `{{PD-old-100}}` | P6243, P180, P921, P7482, P4082 |
| Boec der aspecten… KB KA 16 - 031r.jpg (M95318606) | idem | {{Book}} | `{{PD-old-100}}` | idem |
| Beatrijs - KB 76 E 5, folium 047v.jpg (M61572835) | Beatrijs, KW 76 E 5 | {{Artwork}} | `{{PD-old-70-1923}}` (header) / `{{PD-art\|PD-old-70-1923}}` (permission=) | P6243 (2 vals), P180, P921 |
| Beatrijs - KB 76 E 5, folium 049r.jpg (M61557210) | idem | {{Artwork}} | `{{PD-art\|PD-old-70-1923}}` | P6243, P180, P921, P7482+resolver |
| Back cover sheet, Psalter of Eleanor of Aquitaine… ep001v.jpg (M61611891) | Psalter Eleanor, KW 76 F 13 | {{Artwork}} | `{{PD-art\|PD-old-70-1923}}` | P6243, P180, P921, P7482+resolver |
| Des faits et dits mémorables… 66 B 13, f. 2r.jpg (M29607039) | Valerius Maximus, 66 B 13 | {{Information}} | `{{PD-old-100}}` | core only |
| Judith and olofernes (The Hague, KB, 76 F 5).jpg (M17528296) | Psalter, 76 F 5 | {{Information}} | `{{PD-Art\|PD-old-100}}` | core only |
| Haags Liederenhandschrift.jpg (M26830350) | Haags liederenhandschrift, KW 128 E 2 | {{Information}} | `{{PD-art\|PD-old}}` | P6243, P180, P921, P571 |
| KB Book of Hours snowman illustration.jpg (M17748241) | Book of Hours KW 76 F 21 | {{Information}} | `{{PD-Art}}` (bare) | core only |
| 12th-century painters - Evangeliarum - WGA16006.jpg (M15498805) | Evangeliary (WGA batch) | {{Artwork}} | `{{PD-art\|PD-old-100}}` | P7482 (WGA), P31=digital image |

Three upload generations are visible:
1. **Ad-hoc volunteer uploads** (2005-2013): {{Information}}, inconsistent licensing, free-text dates.
2. **KB GWToolset batch** (~2017, Beatrijs/Psalter "Topstukken"): rich per-folio {{Artwork}} with
   Iconclass codes, dimensions, `wikidata=` param, `{{PD-art|PD-old-70-1923}}`.
3. **KB Pattypan batches** (2024-2026, Egmond/Gruuthuse/Trivulzio/Der naturen bloeme): minimal
   {{Book}} + plain `{{PD-old-100}}` + strong SDC. This is current KB practice.

## 2. Observed conventions

**Category naming.** One category per manuscript, member of
`Category:Medieval manuscripts from Koninklijke Bibliotheek`. Dominant pattern:
`<Common title> - <shelfmark>` — e.g. `Der naturen bloeme - KB KA 16`, `Gruuthuse manuscript`,
`Bout Psalter-Hours KB 79K11`, `Wapenboek Nassau-Vianden (ca. 1490) - KB 1900A016`. Shelfmark
spacing/prefix is inconsistent (`KB 76F13` vs `KB 76 E 5` vs plain `The Hague, KB, 78`). Newer
uploads use the current KB `KW` signature prefix in filenames (`KW 79 K 10`, `KW SMC 1`) while
older categories say `KB`. Files carry only the per-manuscript category plus topical categories
(e.g. `April calendar pages`); the parent KB category is on the manuscript category, not the file.

**Filename pattern.** `<Manuscript name> - <shelfmark> - <folio>.jpg` with zero-padded folio +
r/v: `Egmond Gospels - 76 F 1 - 001r.jpg`, `Gruuthuse manuscript - KW 79 K 10 - 02v.jpg`,
`Trivulzio book of hours - KW SMC 1 - Calendar for the month of April - recto.jpg` (descriptive
page label variant). Recommended for the IIIF tool: `<Title> - KW <shelfmark> - <folio>.jpg`.

**Institution & credit.** Every file has two things: `{{Institution:Koninklijke Bibliotheek}}`
inside the infobox (institution= or References=) and the standalone source/credit template
`{{Koninklijke Bibliotheek}}` (auto-adds `Category:Media contributed by Koninklijke Bibliotheek`).
Recent {{Book}} uploads put `{{Koninklijke Bibliotheek}}` in `|Source=` and
"This book was digitised by the {{Institution:Koninklijke Bibliotheek}}" in `|References=`.

**Shelfmark/accession.** Never in a dedicated SDC P217; lives in the filename and category.
The 2017 batch abused `|accession number=` for a bullet list of KB links. The IIIF tool should
put the bare shelfmark in `|accession number=` (Artwork) and add SDC P217 with P195 qualifier —
an improvement over all observed practice.

**Source links.** Older: `manuscripts.kb.nl` deep links (now dead, patched with {{Wayback}}).
Current SDC uses persistent `https://resolver.kb.nl/resolve?urn=urn:gvn:...` URLs as P973
qualifier on P7482. Lesson: use resolver/IIIF persistent URIs, never CMS deep links.

**Languages.** Descriptions bilingual with `{{en|...}}{{nl|...}}` in recent batches. SDC captions
(labels): zero across all 15 files — a gap the tool can fill (en + nl).

**Dates.** Best practice observed: `{{other date|~|1374}}`, `{{other date|between|1150|1200}}`,
`{{circa|1470}}`. Recent {{Book}} batch leaves Date empty (it lives on the Wikidata item).
`|wikidata=Q...` (manuscript item) set on all batch uploads — the strongest join key.

## 3. SDC statement frequency (n=15)

| Property | Count | Value pattern |
|---|---|---|
| P6216 copyright status | 15/15 | Q19652 (public domain), no qualifiers |
| P195 collection | 15/15 | Q1526131 (KB); KB batches qualify P2868=Q29188408 "collection highlight" |
| P31 instance of | 15/15 | Q1250322 (digital image); KB batches add second value Q125191 (photograph) |
| P1163/P4092/P3575/P2048/P2049 | 14/15 | media type, sha1, size — auto-added by bots, don't set |
| P7482 source of file | 9/15 | Q74228490 (file available on the internet) + qualifiers P137=Q105080966 (Het Geheugen) and P973=resolver.kb.nl URL |
| P180 depicts | 8/15 | the manuscript's own Wikidata Q-id (Trivulzio adds pictorial subjects too) |
| P921 main subject | 8/15 | same manuscript Q-id |
| P6243 digital repr. of | 8/15 | manuscript Q-id (Beatrijs: both manuscript and work item) |
| P4082 captured with | 3/15 | camera model (EXIF-derived) |
| P6757/P6790/P6789/P2151 | 6/15 | exposure/f-number/ISO/focal length (EXIF-derived) |
| P275 license | 0/15 | absent — PD files need no license statement |
| P217 inventory number | 0/15 | absent everywhere (gap — tool should add it) |
| P571 inception | 1/15 | only once, and wrongly = digitisation date |

**Core SDC set for the tool:** P6216=Q19652; P195=Q1526131 (+P217 qualifier if supported, else
separate P217 with P195 qualifier); P31=Q1250322+Q125191; P7482=Q74228490 with P137=Q1526131
(operator: KB, not Het Geheugen for new IIIF-sourced files) + P973=persistent resolver/manifest
URL; P6243/P180/P921=manuscript Q-id when known. Skip P1163/P4092/size props (bots do it).

## 4. Recommended license template call

```
{{Licensed-PD-Art|PD-old-100-expired|Cc-zero}}
```

Reasoning, grounded in template docs + observed practice:

- **PD-Art family, not PD-scan:** `Template:PD-scan/doc` restricts PD-scan to mechanical
  scans/photocopies; `Template:PD-Art/doc` says PD-Art "is only for use when the initial
  reproduction was by means of a photograph". KB IIIF images are studio photographs of bound
  manuscripts (SDC even records Canon EOS 5D Mark II + exposure data) — photograph, not scan.
- **Licensed-PD-Art, not plain PD-Art:** `Template:Licensed-PD-Art/doc`: "for use by the uploader
  of a freely-licensed photograph where the original work being photographed is a public domain,
  two-dimensional work of art… In the jurisdictions where it is not [PD], the terms of the free
  license must be observed." KB explicitly releases its reproductions as CC0, so recording that
  grant makes the file safe even in jurisdictions that don't follow the WMF Bridgeman position.
  Param 1 = original-work PD tag, param 2 = reproduction license; the doc's own example is
  `{{Licensed-PD-Art|PD-old-auto-expired|cc-zero|deathyear=1940}}`.
- **PD-old-100-expired, not PD-old-100:** Commons requires PD status in the US as well.
  `PD-old-100` covers only the 100-years-after-death rule; the `-expired` variant additionally
  asserts US expiry (published before 1930) — trivially true for medieval manuscripts and avoids
  the "must also add a US tag" maintenance category.
- **Not plain {{CC-zero}}:** claims KB owns a copyright in the reproduction, which contradicts
  the WMF position and hides the original work's PD status.
- Observed practice (plain `{{PD-old-100}}` in the 2026 Pattypan batches) is acceptable but
  weaker: it says nothing about the reproduction layer and discards KB's CC0 grant.
  `{{PD-old-70-1923}}` (2017 batch) is a deprecated construction — do not copy it.

## 5. Recommended {{Artwork}} usage for the IIIF tool

{{Book}} is current KB batch practice but nearly all its fields stay empty; {{Artwork}} (as in the
Beatrijs/Psalter batch) carries per-folio metadata better and maps cleanly from a IIIF manifest:

```
== {{int:filedesc}} ==
{{Artwork
 | title             = <manifest label, wikilinked to nl/en article if known>
 | description       = {{en|<canvas label + manuscript context>}}{{nl|...}}
 | date              = {{other date|between|<from>|<to>}}   <!-- or {{other date|~|YYYY}} -->
 | medium            = Manuscript on parchment              <!-- or {{Technique|Illumination|parchment}} -->
 | dimensions        = {{Size|mm|<h>|<w>}}
 | institution       = {{Institution:Koninklijke Bibliotheek}}
 | accession number  = KW <shelfmark>, fol. <folio>
 | place of creation = <from manifest metadata, free text>
 | source            = {{Koninklijke Bibliotheek}} <persistent resolver or IIIF manifest URL>
 | permission        = {{Licensed-PD-Art|PD-old-100-expired|Cc-zero}}
 | wikidata          = <manuscript Q-id>
}}
== {{int:license-header}} ==
{{Licensed-PD-Art|PD-old-100-expired|Cc-zero}}

[[Category:<Manuscript title> - KW <shelfmark>]]
```

Plus SDC core set (section 3) and en/nl captions. Ensure the per-manuscript category exists and is
itself in `Category:Medieval manuscripts from Koninklijke Bibliotheek` (+ century/type categories).

## 6. Anti-patterns to avoid

- Bare `{{PD-Art}}` with no parameter (defaults to vague PD-old) or `{{PD-old-70-1923}}`.
- Free-text dates ("1380, I think.", author names stuffed in |Date= and |Author=).
- CMS deep links as source (`manuscripts.kb.nl` — all dead now); use resolver.kb.nl / IIIF URIs.
- Link lists in `|accession number=` instead of the shelfmark (2017 Beatrijs batch).
- Duplicate/typo params (`other versions` + `other_versions` both set) and placeholder junk
  (`|Other_versions = xxx`) — validate against the template's real parameter list.
- Embedding raw batch-tool metadata blobs (`<metadata_raw>` GWToolset comments) in wikitext.
- No SDC captions, no P217, P571 set to the digitisation date instead of the work's date —
  gaps/mistakes in existing practice the tool should fix, not replicate.
- Redundant parent category on files when the per-manuscript category already carries it.
