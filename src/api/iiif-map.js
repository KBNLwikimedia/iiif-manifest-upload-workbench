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
//   - template {{Artwork}} (Q3); license {{Licensed-PD-Art|PD-old-100-expired|Cc-zero}} (Q4)
//   - filenames "<Title> - <KW signature> - <canvas label part>" (Q7)
//   - one category per manuscript, "<Title> - <KW signature>" (Q8)
//   - Dutch description/caption verbatim from the manifest (Q13)
//
// Everything the current {{Artwork}} field map can't place yet (medium,
// dimensions, institution, accession number, date wikitext) travels under
// `item.iiif` — Phase 5.2 wires those into wikitext-templates.js. NOTE:
// `iiif` is not in DRAFT_FIELDS, so these extras are session-only until
// Phase 4 decides how they persist. The date deliberately does NOT go into
// `dateTaken`: formatDate() truncates to ISO's first 10 chars, which would
// mangle `{{other date|circa|1538}}` (Phase 5.2 adds a passthrough).
//
// Pure ESM, zero imports — Node-testable (scripts/test-iiif-map.mjs).

// Same forbidden set as FORBIDDEN_TITLE_CHARS in publish.js — keep in sync.
const FORBIDDEN_TITLE_CHARS = /[#<>[\]|{}/\\:]/g;

export const KB_LICENSE_WIKITEXT = '{{Licensed-PD-Art|PD-old-100-expired|Cc-zero}}';
export const KB_PARENT_CATEGORY = 'Medieval manuscripts from Koninklijke Bibliotheek';
export const KB_INSTITUTION_WIKITEXT = '{{Institution:Koninklijke Bibliotheek}}';
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
  // guess at {{other date}} sub-syntax.
  return t;
}

// "440×312" (h × b, per the KB's label) → {{Size}} wikitext; verbatim fallback.
export function deriveDimensionsWikitext(dimText) {
  const t = String(dimText || '').trim();
  if (!t) return '';
  const m = t.match(/^(\d+)\s*[×x]\s*(\d+)/);
  if (m) return `{{Size|unit=mm|height=${m[1]}|width=${m[2]}}}`;
  return t;
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
  if (kopiist) parts.push(`${kopiist} (kopiist)`);
  if (illuminator) parts.push(`${illuminator} (illuminator)`);
  return parts.length ? parts.join('; ') : '{{unknown|author}}';
}

// Source block: the manifest URL is the machine-readable provenance; the
// standalone {{Koninklijke Bibliotheek}} credit template matches every
// existing KB upload (mining finding §2).
export function deriveSource(manifest) {
  const lines = [];
  if (manifest.sourceUrl) lines.push(`* IIIF manifest: ${manifest.sourceUrl}`);
  else if (manifest.id) lines.push(`* IIIF manifest: ${manifest.id}`);
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
    signature,
    categoryName: sanitizeTitlePart(title ? `${title} - ${signature}` : signature),
    parentCategory: KB_PARENT_CATEGORY,
    license: KB_LICENSE_WIKITEXT,
    author: deriveAuthor(f),
    source: deriveSource(manifest),
    descriptionNl: String(f.inhoud || manifest.summary || '').replace(/\s+/g, ' ').trim(),
    dateText: String(f.datumVanOrigine || '').trim(),
    dateWikitext: deriveDateWikitext(f.datumVanOrigine),
    wikidataQid: null,
    artwork: {
      institution: KB_INSTITUTION_WIKITEXT,
      accessionNumber: String(f.signatuur || signature).trim(),
      medium: String(f.materiaal || '').trim(),
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

// Commons titles max out at 240 bytes; leave headroom for " (2)" dedupe
// suffixes and the extension.
const MAX_BASE_LENGTH = 220;

// mapCanvases(manuscript, manifest) → one prefill object per canvas, with
// unique target filenames. Re-run after the user edits the title/category/
// Q-id in the wizard — derivation is cheap and stateless.
export function mapCanvases(manuscript, manifest) {
  const canvases = manifest.canvases || [];
  const used = new Map(); // base name → count, for collision suffixes
  return canvases.map((canvas) => {
    const pagePart = derivePagePart(canvas.label, canvas.index, canvases.length);
    const stem = manuscript.title
      ? `${manuscript.title} - ${manuscript.signature}`
      : manuscript.signature;
    let base = sanitizeTitlePart(`${stem} - ${pagePart}`).slice(0, MAX_BASE_LENGTH).trim();
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    if (n > 1) base = `${base} (${n})`;

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
