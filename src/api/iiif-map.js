// IIIF manifest → workbench-item mapping (design Phase 3).
//
// Input: the parsed manifest from iiif.js. Output: one manuscript-level
// summary (mapManuscript) plus one prefill object per canvas (mapCanvases)
// whose keys line up with the workbench's draft fields (DRAFT_FIELDS in
// user-store.js) so the import pipeline can hand them straight to the
// existing table / publish flow.
//
// All mapping targets follow the approved design decisions
// (__inputs/iiif-ingestor-design.md) and the mined Commons conventions
// (__inputs/commons-best-practices.md):
//   - template {{Artwork}} (Q3); license {{PD-Art|PD-old-100-expired}} (Q4,
//     revised 2026-07-07 — see KB_LICENSE_WIKITEXT below)
//   - filenames "<Title> - <KW signature> - <canvas label part>" (Q7)
//   - one category per manuscript, "<Title> - <KW signature>" (Q8)
//   - Dutch description/caption verbatim from the manifest (Q13)
//
// Since Phase 5.2 the {{Artwork}} extras (medium, dimensions, accession
// number, date wikitext) are first-class draft fields: mapCanvases emits
// them top-level (they're in DRAFT_FIELDS) and wikitext-templates.js
// renders them; formatDate() passes non-ISO strings like
// `{{other date|circa|1538}}` through untouched. The full mapping detail
// additionally travels under `item.iiif` (session-only) for Phase 5's SDC
// statements. Institution still waits on OI-62.
//
// Pure ESM, zero imports — Node-testable (scripts/test-iiif-map.mjs).

// Same forbidden set as FORBIDDEN_TITLE_CHARS in publish.js — keep in sync.
const FORBIDDEN_TITLE_CHARS = /[#<>[\]|{}/\\:]/g;

// Q4 (revised 2026-07-07 by Olaf): plain PD-Art — the work is PD because
// the author died >100 years ago + US-expired; the KB's CC0 grant on the
// reproduction is not separately asserted in the license block.
//
// The row's `license` field must carry the *catalog id* (so the licence
// dropdown recognises it, doesn't flag "missing", and renders the wikitext
// via the catalog `template()` at publish) — NOT the raw wikitext. The id
// below duplicates the catalog entry id in src/licenses.js — keep in sync.
export const KB_LICENSE_ID = 'PD-Art-PD-old-100-expired';
export const KB_LICENSE_WIKITEXT = '{{PD-Art|PD-old-100-expired}}';
export const KB_PARENT_CATEGORY = 'Medieval manuscripts from Koninklijke Bibliotheek';
export const KB_INSTITUTION_WIKITEXT = '{{Institution:Koninklijke Bibliotheek, Den Haag}}';
export const KB_COLLECTION_QID = 'Q1526131'; // Koninklijke Bibliotheek
// SDC constants per the mined conventions (commons-best-practices.md §3):
export const SDC_PUBLIC_DOMAIN_QID = 'Q19652';
export const SDC_FILE_AVAILABLE_ON_INTERNET_QID = 'Q74228490';
export const SDC_COLLECTION_QUALIFIER = { property: 'P2868', qid: 'Q29188408' }; // subject has role: museum object / holding

function sanitizeTitlePart(s) {
  return String(s || '')
    .replace(FORBIDDEN_TITLE_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
}

// Truncate a string so its UTF-8 byte length is ≤ maxBytes, always cutting on a
// whole-code-point boundary so a multi-byte character (or an emoji surrogate
// pair) is never split (OI-29). Commons/MediaWiki caps a file page title
// (the part after "File:") at 255 bytes.
export function truncateBytes(str, maxBytes) {
  const s = String(str || '');
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) { // for…of iterates by code point, not UTF-16 unit
    const n = enc.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

// --- Manuscript-level derivations ------------------------------------------

// Short title, best-effort (always user-editable in the wizard):
//   1. a parenthesized addition in the manifest label ("KW 128 E 2 (Haags
//      liederenhandschrift)") — ≥5 chars so "(ii)" stays part of the signature;
//   2. else the first meaningful segment of the summary;
//   3. else the Inhoud metadata field;
//   4. else '' (filename degrades to signature + page part).
export function deriveTitle(manifest) {
  const label = String(manifest.label || '').trim();
  const paren = label.match(/^(.*?)\s*\(([^)]{5,})\)\s*$/);
  if (paren) return cleanupTitle(paren[2]);

  let t = String(manifest.summary || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^Alternati(?:ve|eve)? titel:\s*/i, '');
  t = t.split('/')[0].split(' or ')[0].split(';')[0].split('|')[0].trim();
  if (t) return cleanupTitle(t, label);

  return cleanupTitle(String(manifest.fields?.inhoud || ''), label);
}

// Did the derived title fall back to the *whole* summary/Inhoud (a descriptive
// sentence), rather than a real title? True when there's no parenthetical title
// in the label AND no "title / subtitle"-style separator carved a head off the
// summary — i.e. the title IS the summary. Callers can then avoid presenting a
// long summary sentence as the title (the derivation still truncates it for
// filename use; this only flags the provenance). A short summary that happens
// to be a real title (e.g. "Getijdenboek") is flagged too, but that's harmless
// since consumers only special-case *long* fallbacks.
export function titleFromSummaryFallback(manifest) {
  const label = String(manifest.label || '').trim();
  if (/^(.*?)\s*\(([^)]{5,})\)\s*$/.test(label)) return false; // clean: label parenthetical
  const summary = String(manifest.summary || '')
    .replace(/\s+/g, ' ')
    .replace(/^Alternati(?:ve|eve)? titel:\s*/i, '')
    .trim();
  if (summary) {
    const first = summary.split('/')[0].split(' or ')[0].split(';')[0].split('|')[0].trim();
    return first.length >= summary.length; // no separator carved a title off → the title is the whole summary
  }
  return !!String(manifest.fields?.inhoud || '').trim(); // inhoud fallback isn't a real title either
}

// Shared title cleanup: drop a leading repeat of the manifest label /
// signature ("KW 129 A 10 (Lancelotcompilatie)" summaries), unwrap a title
// that is entirely parenthesized, strip parenthesized additions ("(1363-
// 1429)", "(Lib. IV, 2)"), and truncate long titles at a word boundary —
// without an ellipsis, since the title feeds filenames and category names.
function cleanupTitle(raw, label = '') {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (label) {
    const sig = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`^${sig}\\s*`, 'i'), '').trim();
  }
  const whole = t.match(/^\((.{3,})\)$/);
  if (whole) t = whole[1].trim();
  t = t.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '').replace(/[,;\s]+$/, '');
  return t;
}

// Shelfmark with the current "KW" prefix (design Q7): prefer the label when
// it already carries KW; else prefix the Signatuur metadata field.
export function deriveSignature(manifest) {
  const label = String(manifest.label || '').trim().replace(/\s*\([^)]{5,}\)\s*$/, '');
  if (/^KW\s/i.test(label)) return label.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  const sig = String(manifest.fields?.signatuur || '').trim();
  if (sig) return /^KW\s/i.test(sig) ? sig : `KW ${sig}`;
  return label;
}

// "Datum van origine" → date wikitext for the {{Artwork}} |date= param.
// Observed corpus forms: "Circa 1538", "1440-1460", "1400",
// "[ca. 1530 en ca. 1550-1560]". Anything unrecognised passes verbatim —
// wrong-but-visible beats silently dropped.
export function deriveDateWikitext(dateText) {
  let t = String(dateText || '').trim().replace(/^\[|\]$/g, '').trim();
  if (!t) return '';
  let m = t.match(/^(?:circa|ca\.?)\s*(\d{3,4})$/i);
  if (m) return `{{other date|circa|${m[1]}}}`;
  m = t.match(/^(?:circa|ca\.?)\s*(\d{3,4})\s*[-–]\s*(\d{3,4})$/i);
  if (m) return `{{other date|ca|${m[1]}|${m[2]}}}`; // circa-range: "circa 1395–1408"
  m = t.match(/^(\d{3,4})\s*[-–]\s*(\d{3,4})$/);
  if (m) return `{{other date|between|${m[1]}|${m[2]}}}`;
  m = t.match(/^(\d{3,4})\s+of\s+(\d{3,4})$/i); // Dutch "1373 of 1374"
  if (m) return `{{other date|or|${m[1]}|${m[2]}}}`;
  m = t.match(/^(\d{1,2})(?:de|ste)\s+eeuw$/i); // "13de eeuw"
  if (m) return `{{other date|century|${m[1]}}}`;
  if (/^\d{3,4}$/.test(t)) return t;
  // Everything else (halves/quarters of centuries, compound datings) stays
  // verbatim Dutch — visible and user-editable in the wizard beats a wrong
  // guess at {{other date}} sub-syntax. Verbatim manifest text goes into the
  // |date= param unquoted, so neutralize wiki structural chars (OI-74); the
  // mapper-authored {{other date|…}} returns above must stay raw.
  return neutralizeWikitext(t);
}

// "440×312" (h × b, per the KB's label) → {{Size}} wikitext; verbatim fallback.
export function deriveDimensionsWikitext(dimText) {
  const t = String(dimText || '').trim();
  if (!t) return '';
  const m = t.match(/^(\d+)\s*[×x]\s*(\d+)/);
  if (m) return `{{Size|unit=mm|height=${m[1]}|width=${m[2]}}}`;
  // Verbatim fallback (real corpus values like "Circa 250-255×180-188" land
  // here) — manifest text destined for the |dimensions= param, so neutralize
  // wiki structural chars (OI-74).
  return neutralizeWikitext(t);
}

// Neutralize the five wiki structural characters in free text pulled verbatim
// from the manifest, so a hostile value can't break out of a template
// parameter or inject templates / wikilinks / categories once it reaches the
// wikitext (OI-27; extended to the Phase 5.2 {{Artwork}} params in OI-74).
// Applied only to values that go to wikitext (author names, the source URL,
// medium, the dimensions/date verbatim fallbacks, the draft accession
// number) — never to the SDC copies under `sdc.*` (P217 needs the raw
// inventory number; SDC statements are not wikitext), and never to
// mapper-authored template wikitext ({{unknown|author}}, {{Size|…}},
// {{other date|…}}, {{Koninklijke Bibliotheek}}, …).
function neutralizeWikitext(s) {
  return String(s || '').replace(/[{}[\]|]/g, (c) => (
    { '{': '&#123;', '}': '&#125;', '[': '&#91;', ']': '&#93;', '|': '&#124;' }[c]
  ));
}

// Kopiist / Illuminator → |artist=. "Onbekend" (and friends) is the
// Commons-canonical {{unknown|author}}; named people are passed through
// with their role, both roles combined when both are known.
export function deriveAuthor(fields) {
  const known = (v) => {
    const t = String(v || '').trim();
    return t && !/^(onbekend|unknown|anoniem|-|n\/?a)$/i.test(t) ? t : null;
  };
  const parts = [];
  const kopiist = known(fields?.kopiist);
  const illuminator = known(fields?.illuminator);
  if (kopiist) parts.push(`${neutralizeWikitext(kopiist)} (kopiist)`);
  if (illuminator) parts.push(`${neutralizeWikitext(illuminator)} (illuminator)`);
  return parts.length ? parts.join('; ') : '{{unknown|author}}';
}

// Source block: the manifest URL is the machine-readable provenance; the
// standalone {{Koninklijke Bibliotheek}} credit template matches every
// existing KB upload (mining finding §2).
export function deriveSource(manifest) {
  const lines = [];
  const url = manifest.sourceUrl || manifest.id;
  if (url) lines.push(`* IIIF manifest: ${neutralizeWikitext(url)}`);
  lines.push('{{Koninklijke Bibliotheek}}');
  return lines.join('\n');
}

// mapManuscript(parsedManifest) → the shared, manuscript-level mapping.
// `wikidataQid` starts null; the wizard fills it via wikidata.js (Q6) or
// manual entry, then re-runs mapCanvases so depicts/SDC pick it up.
export function mapManuscript(manifest) {
  const title = deriveTitle(manifest);
  const signature = deriveSignature(manifest);
  const f = manifest.fields || {};
  return {
    title,
    titleFromSummaryFallback: titleFromSummaryFallback(manifest),
    signature,
    categoryName: sanitizeTitlePart(title ? `${title} - ${signature}` : signature),
    parentCategory: KB_PARENT_CATEGORY,
    license: KB_LICENSE_ID,
    author: deriveAuthor(f),
    source: deriveSource(manifest),
    descriptionNl: String(f.inhoud || manifest.summary || '').replace(/\s+/g, ' ').trim(),
    dateText: String(f.datumVanOrigine || '').trim(),
    dateWikitext: deriveDateWikitext(f.datumVanOrigine),
    wikidataQid: null,
    artwork: {
      institution: KB_INSTITUTION_WIKITEXT,
      // OI-74: these three reach the {{Artwork}} wikitext verbatim — the raw
      // inventory number for SDC/P217 lives separately under sdc.inventoryNumber.
      accessionNumber: neutralizeWikitext(String(f.signatuur || signature).trim()),
      medium: neutralizeWikitext(String(f.materiaal || '').trim()),
      dimensions: deriveDimensionsWikitext(f.afmetingen),
      placeOfCreation: String(f.plaatsVanOrigine || '').replace(/^\[|\]$/g, '').trim(),
      objectHistory: String(f.herkomst || f.verwerving || '').trim(),
      language: String(f.taal || '').trim(),
      script: String(f.schrift || '').replace(/^-$/, '').trim(),
      folia: String(f.aantalFolia || '').trim(),
      referenceLinks: [f.linkBnm, f.linkDbnl].filter(Boolean),
    },
    sdc: {
      copyrightStatusQid: SDC_PUBLIC_DOMAIN_QID,
      collectionQid: KB_COLLECTION_QID,
      collectionQualifier: SDC_COLLECTION_QUALIFIER,
      inventoryNumber: String(f.signatuur || '').trim() || signature.replace(/^KW\s+/i, ''),
      sourceOfFile: {
        typeQid: SDC_FILE_AVAILABLE_ON_INTERNET_QID,
        url: manifest.sourceUrl || manifest.id || '',
        operatorQid: KB_COLLECTION_QID,
      },
      // filled once wikidataQid is known:
      digitalRepresentationOfQid: null,
      depictsQid: null,
    },
  };
}

// --- Per-canvas derivations -------------------------------------------------

// Canvas label → the page part of the filename (design Q7 + refinement):
// verbatim label data, minus the shelfmark-like first chunk and the file
// extension, underscores as spaces. "KW129C3ii_0001a_Front_Cover.jpg" →
// "0001a Front Cover"; "128E3_OMSLAG1.jpg" → "OMSLAG1". Positional index
// (zero-padded to the canvas-count width) when the label yields nothing.
export function derivePagePart(label, index, total) {
  let t = String(label || '').trim().replace(/\.[A-Za-z]{2,4}$/, '');
  const chunks = t.split('_').filter(Boolean);
  // Drop the first chunk when it looks like a shelfmark run (letters+digits,
  // e.g. KW129A4, 128E3, KWKA16) AND something else remains.
  if (chunks.length > 1 && /^[A-Za-z]*\d+[A-Za-z0-9]*$/.test(chunks[0])) chunks.shift();
  t = sanitizeTitlePart(chunks.join(' '));
  if (t) return t;
  return String(index + 1).padStart(String(Math.max(total, 1)).length, '0');
}

// A Commons file page title (the part after "File:") maxes out at 255 bytes.
// The final name is `<base>[ (N)].jpg`, so budget the base by BYTES (not chars,
// so multi-byte titles are handled right — OI-29), leaving headroom for a
// " (99)" dedupe suffix (~6 B) and the ".jpg" extension (4 B).
const MAX_BASE_BYTES = 255 - 6 - 4; // 245

// mapCanvases(manuscript, manifest) → one prefill object per canvas, with
// unique target filenames. Re-run after the user edits the title/category/
// Q-id in the wizard — derivation is cheap and stateless.
export function mapCanvases(manuscript, manifest) {
  const canvases = manifest.canvases || [];
  const used = new Map(); // set of final (post-suffix) names already taken
  return canvases.map((canvas) => {
    const pagePart = derivePagePart(canvas.label, canvas.index, canvases.length);
    const stem = manuscript.title
      ? `${manuscript.title} - ${manuscript.signature}`
      : manuscript.signature;
    const stemBase = truncateBytes(sanitizeTitlePart(`${stem} - ${pagePart}`), MAX_BASE_BYTES).trim();
    // Ensure the FINAL name is unique: register the suffixed result, not just
    // the pre-suffix base. Keying `used` by the bare base let labels like
    // ["p1","p1","p1 (2)"] emit two identical "p1 (2)" filenames. (OI-35)
    let base = stemBase;
    let n = 1;
    while (used.has(base)) { n += 1; base = `${stemBase} (${n})`; }
    used.set(base, true);

    // Captions double as the {{Artwork}} |description= — keep them compact.
    // Long manifest summaries (the Atlas has a 500-char Latin incipit) fall
    // back to the derived short title; the full text stays available via the
    // manuscript summary in the wizard.
    const desc = manuscript.descriptionNl && manuscript.descriptionNl.length <= 200
      ? manuscript.descriptionNl
      : manuscript.title;
    const captionNl = [desc, manuscript.signature, pagePart].filter(Boolean).join(', ');

    return {
      // --- workbench draft fields (DRAFT_FIELDS-compatible) ---
      title: base,
      descriptions: { nl: captionNl },
      author: manuscript.author,
      source: manuscript.source,
      license: manuscript.license,
      institution: KB_INSTITUTION_WIKITEXT,
      // OI-02 (Phase 5.2): {{Artwork}} params as first-class draft fields so
      // they reach the rendered wikitext and survive reloads.
      medium: manuscript.artwork.medium || null,
      dimensions: manuscript.artwork.dimensions || null,
      accessionNumber: manuscript.artwork.accessionNumber || null,
      // OI-01: the derived date wikitext ({{other date|…}} / verbatim Dutch)
      // now lives on the real date field — formatDate passes non-ISO values
      // through untruncated.
      dateTaken: manuscript.dateWikitext || null,
      categories: [manuscript.categoryName],
      depicts: manuscript.wikidataQid ? [{ qid: manuscript.wikidataQid, label: manuscript.signature }] : [],
      // --- IIIF extras (session-only; consumed by the pipeline + Phase 5) ---
      iiif: {
        manifestUrl: manifest.sourceUrl || manifest.id || null,
        canvasId: canvas.id,
        canvasIndex: canvas.index,
        canvasLabel: canvas.label,
        pagePart,
        fullResUrl: canvas.fullResUrl,
        thumbUrl: canvas.thumbUrl,
        expectedWidth: canvas.expectedWidth,
        expectedHeight: canvas.expectedHeight,
        downscaled: canvas.downscaled,
        targetFilename: `${base}.jpg`,
        dateWikitext: manuscript.dateWikitext,
        artwork: manuscript.artwork,
        sdc: {
          ...manuscript.sdc,
          digitalRepresentationOfQid: manuscript.wikidataQid,
          depictsQid: manuscript.wikidataQid,
        },
      },
    };
  });
}

// Convenience wrapper: parse result → { manuscript, items }.
export function mapManifest(manifest, { wikidataQid = null } = {}) {
  const manuscript = mapManuscript(manifest);
  if (wikidataQid) {
    manuscript.wikidataQid = wikidataQid;
    manuscript.sdc.digitalRepresentationOfQid = wikidataQid;
    manuscript.sdc.depictsQid = wikidataQid;
  }
  return { manuscript, items: mapCanvases(manuscript, manifest) };
}
