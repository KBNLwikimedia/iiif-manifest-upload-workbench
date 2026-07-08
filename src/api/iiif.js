// IIIF Presentation API 3.0 — manifest fetching, validation, parsing.
//
// Scope (design decision Q2): Presentation 3.0 only. The parser is
// deliberately defensive — the KB corpus has shipped manifests with
// all-"Lorem ipsum" metadata, empty summaries, zero canvases, and five
// spelling variants of the same metadata label. Every defect becomes a
// validation-report entry instead of a crash; the import wizard shows the
// report before anything is downloaded.
//
// This module is pure data-in/data-out (fetch + parse). Mapping the parsed
// manifest onto workbench columns / {{Artwork}} params lives in iiif-map.js;
// UI lives in src/ui/iiif-import-modal.jsx.
//
// Pure ESM with zero imports so Node can load it directly for corpus tests
// (scripts/test-iiif-parser.mjs runs it over __inputs/manifests/*.json).

// Preferred language order when flattening IIIF language maps. The KB corpus
// is Dutch-first; 'none' is the IIIF spec's "no linguistic content" key.
const LANG_PREFERENCE = ['nl', 'en', 'none'];

// --- Language-map helpers -------------------------------------------------

// IIIF v3 strings are language maps: { "nl": ["…"], "en": ["…"] }.
// Returns the first value in preference order, else the first value of any
// language, else ''. Multiple values per language are joined with newlines
// (the KB uses multi-value summaries for multi-work codices).
export function firstValue(languageMap, preference = LANG_PREFERENCE) {
  if (languageMap == null) return '';
  if (typeof languageMap === 'string') return languageMap; // tolerate v2-style plain strings
  for (const lang of preference) {
    const v = languageMap[lang];
    if (Array.isArray(v) && v.length) return v.filter(Boolean).join('\n');
  }
  for (const v of Object.values(languageMap)) {
    if (Array.isArray(v) && v.length) return v.filter(Boolean).join('\n');
  }
  return '';
}

// All language/value pairs of a language map, flattened:
// { nl: ["a"], en: ["b"] } → [{ lang: 'nl', value: 'a' }, { lang: 'en', value: 'b' }]
export function allValues(languageMap) {
  const out = [];
  if (languageMap == null || typeof languageMap !== 'object') return out;
  for (const [lang, vals] of Object.entries(languageMap)) {
    for (const v of Array.isArray(vals) ? vals : []) {
      if (v != null && String(v).trim() !== '') out.push({ lang, value: String(v) });
    }
  }
  return out;
}

// Placeholder junk the KB backend has been observed to ship. A metadata
// value matching one of these is treated as absent (and warned about).
const PLACEHOLDER_RE = /^(lorem ipsum.*|-|—|n\/?a|onbekend\?*|\?+|xxx+|todo|tbd)$/i;

export function isPlaceholderValue(s) {
  return PLACEHOLDER_RE.test(String(s || '').trim());
}

// --- Validation report ----------------------------------------------------

// report entries: { level: 'error'|'warning'|'info', code, message }
// 'error'  → the manifest (or canvas) cannot be imported
// 'warning'→ importable but something is off; shown prominently
// 'info'   → worth knowing (e.g. oversized canvases will be downscaled)
function makeReport() {
  const entries = [];
  return {
    entries,
    error: (code, message) => entries.push({ level: 'error', code, message }),
    warn: (code, message) => entries.push({ level: 'warning', code, message }),
    info: (code, message) => entries.push({ level: 'info', code, message }),
    hasErrors: () => entries.some((e) => e.level === 'error'),
  };
}

// --- Canvas parsing -------------------------------------------------------

// Dig the painting-annotation image body out of a v3 canvas:
// canvas.items[] (AnnotationPage) → .items[] (Annotation, motivation
// "painting") → .body (Image). Returns null when the chain is broken.
function paintingBody(canvas) {
  for (const page of canvas?.items || []) {
    for (const anno of page?.items || []) {
      const motivation = anno?.motivation;
      // Treat a missing motivation as painting: some real v3 manifests omit
      // it on the sole image annotation. A non-painting motivation (e.g.
      // "supplementing" for OCR/text) is still excluded. (OI-34)
      const isPainting = motivation == null
        || motivation === 'painting'
        || (Array.isArray(motivation) && motivation.includes('painting'));
      if (!isPainting) continue;
      // body can be a single object, an array, or a Choice wrapper
      // ({ type:'Choice', items:[imageBody, …] } — alternate image versions).
      // Flatten the Choice's items before the Image test, or the whole canvas
      // is skipped for a spec-valid manifest. (OI-34)
      const rawBodies = Array.isArray(anno.body) ? anno.body : [anno.body];
      const bodies = rawBodies.flatMap((b) => (b?.type === 'Choice' ? (b.items || []) : [b]));
      for (const b of bodies) {
        if (b && (b.type === 'Image' || b.format?.startsWith?.('image/'))) return b;
      }
    }
  }
  return null;
}

// Pick the image service off a body. v3 nests `service: [...]`; each entry
// has `id` (v3) or `@id` (v2-style embedded in v3 manifests). Prefer
// ImageService3, fall back to anything with an IIIF image profile.
function imageService(body) {
  const services = Array.isArray(body?.service) ? body.service : (body?.service ? [body.service] : []);
  const v3 = services.find((s) => s?.type === 'ImageService3' || /image\/3/.test(s?.['@context'] || ''));
  const any = v3 || services.find((s) => s?.id || s?.['@id']);
  if (!any) return null;
  return {
    id: any.id || any['@id'],
    isV3: any === v3 || any.type === 'ImageService3',
    maxArea: any.maxArea ?? null,
    maxWidth: any.maxWidth ?? null,
    maxHeight: any.maxHeight ?? null,
  };
}

// Expected delivered pixel size for a `full/max` request: native, or fitted
// to the service's maxArea / maxWidth / maxHeight constraints (IIIF Image
// API 3.0 §5.3: the service scales down to the largest size within limits).
function expectedDelivery(width, height, svc) {
  let scale = 1;
  if (svc?.maxArea && width * height > svc.maxArea) {
    scale = Math.min(scale, Math.sqrt(svc.maxArea / (width * height)));
  }
  if (svc?.maxWidth && width > svc.maxWidth) scale = Math.min(scale, svc.maxWidth / width);
  if (svc?.maxHeight && height > svc.maxHeight) scale = Math.min(scale, svc.maxHeight / height);
  return {
    width: Math.floor(width * scale),
    height: Math.floor(height * scale),
    downscaled: scale < 1,
  };
}

// One parsed canvas. `report` collects per-canvas defects under a stable code.
function parseCanvas(canvas, index, report) {
  const label = firstValue(canvas?.label);
  const width = Number(canvas?.width) || 0;
  const height = Number(canvas?.height) || 0;
  const name = label || `canvas ${index + 1}`;

  const body = paintingBody(canvas);
  if (!body) {
    report.warn('canvas-no-image', `Canvas ${index + 1} (${name}) has no painting image — it will be skipped.`);
    return null;
  }
  const svc = imageService(body);

  // Full-res URL: ImageService3 spells "biggest allowed" as `max`;
  // ImageService2 spells it `full`. Without a service, fall back to the
  // body's direct id (a static image URL).
  let fullResUrl = body.id || null;
  let thumbUrl = null;
  if (svc?.id) {
    fullResUrl = `${svc.id}/full/${svc.isV3 ? 'max' : 'full'}/0/default.jpg`;
    thumbUrl = `${svc.id}/full/400,/0/default.jpg`;
  }
  // Prefer the canvas's own purpose-built thumbnail when present.
  const declaredThumb = Array.isArray(canvas?.thumbnail) ? canvas.thumbnail[0]?.id : canvas?.thumbnail?.id;
  if (declaredThumb) thumbUrl = declaredThumb;

  if (!fullResUrl) {
    report.warn('canvas-no-url', `Canvas ${index + 1} (${name}) has no derivable image URL — it will be skipped.`);
    return null;
  }
  if (!width || !height) {
    report.warn('canvas-no-dimensions', `Canvas ${index + 1} (${name}) is missing width/height.`);
  }

  const expected = expectedDelivery(width, height, svc);

  return {
    index,
    id: canvas?.id || null,
    label,
    width,
    height,
    thumbUrl,
    fullResUrl,
    serviceId: svc?.id || null,
    maxArea: svc?.maxArea || null,
    expectedWidth: expected.width,
    expectedHeight: expected.height,
    downscaled: expected.downscaled,
  };
}

// --- Manifest parsing -----------------------------------------------------

// Known KB metadata label variants → canonical key. The corpus has five
// spellings of "Afmetingen" alone; normalising here keeps iiif-map.js simple.
// Unknown labels pass through under their literal (trimmed) label so nothing
// silently disappears — the wizard lists unmapped fields.
const LABEL_CANON = [
  [/^signatuur$/i, 'signatuur'],
  [/^inhoud$/i, 'inhoud'],
  [/^collectiebeheerder$/i, 'collectiebeheerder'],
  [/^plaats van origine$/i, 'plaatsVanOrigine'],
  [/^datum van origine$/i, 'datumVanOrigine'],
  [/^kopiist$/i, 'kopiist'],
  [/^illuminator$/i, 'illuminator'],
  [/^materiaal$/i, 'materiaal'],
  [/^aantal folia$/i, 'aantalFolia'],
  [/^afmetingen\b.*$/i, 'afmetingen'], // "Afmetingen (in mm)", "Afmetingen in mm (h x b)", …
  [/^schrift$/i, 'schrift'],
  [/^taal$/i, 'taal'],
  [/^herkomst$/i, 'herkomst'],
  [/^verwerving$/i, 'verwerving'],
  [/^(beeld|object)licentie$/i, 'beeldlicentie'],
  [/^datalicentie$/i, 'datalicentie'],
  [/^link naar bnm$/i, 'linkBnm'],
  [/^link naar dbnl$/i, 'linkDbnl'],
];

function canonicalKey(label) {
  const trimmed = String(label || '').trim();
  for (const [re, key] of LABEL_CANON) {
    if (re.test(trimmed)) return key;
  }
  return null;
}

// parseManifest(json, { sourceUrl }) → {
//   ok,              boolean — false when errors make the manifest unusable
//   report,          [{ level, code, message }] — the validation report
//   manifest: {
//     id, sourceUrl, label, summary,
//     metadata,      [{ label, key|null, value, values: [{lang,value}] }]
//     fields,        { canonicalKey: value } — placeholder-free convenience map
//     rights,
//     canvases,      [parsed canvases — see parseCanvas]
//     canvasCount, downscaledCount,
//   } | null
// }
export function parseManifest(json, { sourceUrl = null } = {}) {
  const report = makeReport();

  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    report.error('not-an-object', 'The file is not a JSON object.');
    return { ok: false, report: report.entries, manifest: null };
  }

  // --- structural validation (v3 only, per design decision Q2) ---
  const context = json['@context'];
  const contexts = Array.isArray(context) ? context : [context];
  const isV3 = contexts.some((c) => typeof c === 'string' && c.includes('iiif.io/api/presentation/3'));
  const isV2 = contexts.some((c) => typeof c === 'string' && c.includes('iiif.io/api/presentation/2'));
  if (isV2 && !isV3) {
    report.error('presentation-v2', 'This is a IIIF Presentation 2.x manifest — only version 3.0 is supported (v2 support is a planned follow-up).');
  } else if (!isV3) {
    report.error('no-iiif-context', 'Missing or unrecognised @context — not a IIIF Presentation 3.0 manifest.');
  }
  if (json.type !== 'Manifest') {
    if (json.type === 'Collection') {
      report.error('is-collection', 'This is a IIIF Collection (a list of manifests), not a Manifest. Open one of its member manifests instead.');
    } else {
      report.error('not-a-manifest', `Expected type "Manifest", found "${json.type || 'none'}".`);
    }
  }
  if (!json.id && !json['@id']) report.warn('no-id', 'Manifest has no id.');
  if (report.hasErrors()) {
    return { ok: false, report: report.entries, manifest: null };
  }

  // --- descriptive properties ---
  const label = firstValue(json.label);
  if (!label) report.warn('no-label', 'Manifest has no label (title).');

  const summary = firstValue(json.summary);
  if (!summary) report.warn('no-summary', 'Manifest has no summary — the description column will start empty.');

  const rights = json.rights || null;
  if (!rights) report.warn('no-rights', 'Manifest declares no rights/license URI.');

  // --- metadata pairs ---
  const metadata = [];
  const fields = {};
  let placeholderCount = 0;
  for (const md of Array.isArray(json.metadata) ? json.metadata : []) {
    const mdLabel = firstValue(md?.label);
    const value = firstValue(md?.value);
    if (!mdLabel && !value) continue;
    const key = canonicalKey(mdLabel);
    const placeholder = isPlaceholderValue(value);
    if (placeholder) placeholderCount += 1;
    metadata.push({ label: mdLabel, key, value, values: allValues(md?.value), placeholder });
    if (key && !placeholder && value) {
      // First non-placeholder value wins per canonical key.
      if (!(key in fields)) fields[key] = value;
    }
    if (!key && mdLabel && !placeholder) {
      report.info('unmapped-field', `Metadata field "${mdLabel}" has no canonical mapping — shown as-is, not auto-filled.`);
    }
  }
  if (!metadata.length) report.warn('no-metadata', 'Manifest has no metadata block at all.');
  if (placeholderCount) {
    report.warn('placeholder-metadata', `${placeholderCount} metadata field(s) look like placeholder values ("Lorem ipsum", "Onbekend", "-", …). They're imported and flagged with ⚠️ below — use the ✕ to drop any you don't want.`);
  }

  // --- canvases ---
  const rawCanvases = Array.isArray(json.items) ? json.items : [];
  const canvases = [];
  for (let i = 0; i < rawCanvases.length; i++) {
    const c = parseCanvas(rawCanvases[i], i, report);
    if (c) canvases.push(c);
  }
  if (!rawCanvases.length) {
    report.error('no-canvases', 'Manifest contains zero canvases — there are no images to import. (Upstream data defect; report it to the manifest provider.)');
  } else if (!canvases.length) {
    report.error('no-usable-canvases', 'None of the canvases yielded a usable image URL.');
  }

  const downscaledCount = canvases.filter((c) => c.downscaled).length;
  if (downscaledCount) {
    report.info('downscaled-canvases', `${downscaledCount} of the ${canvases.length} pages are larger than 25 megapixels. The KB's IIIF image server caps what it delivers at 25 MP, so those pages arrive slightly smaller than the original (but still high-res) — e.g. an 8040 × 6030 page (48 MP) downloads at ~25 MP. This is a limit of the IIIF server, not of Wikimedia Commons, which accepts much larger files.`);
  }

  return {
    ok: !report.hasErrors(),
    report: report.entries,
    manifest: {
      id: json.id || json['@id'] || null,
      sourceUrl,
      label,
      summary,
      metadata,
      fields,
      rights,
      canvases,
      canvasCount: canvases.length,
      downscaledCount,
    },
  };
}

// --- Fetching ---------------------------------------------------------------

// Manifests are public; no auth. dlc.services serves `Access-Control-Allow-
// Origin: *` (verified 2026-07-07), so a plain browser fetch works. The size
// guard exists because a pasted URL could point at anything.
const MAX_MANIFEST_BYTES = 30 * 1024 * 1024; // far above any real manifest (KB max seen: ~2 MB)

export async function fetchManifest(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Could not fetch the manifest (network/CORS): ${e.message}`);
  }
  if (!res.ok) throw new Error(`Manifest URL returned HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_MANIFEST_BYTES) throw new Error('Manifest is implausibly large (>30 MB) — refusing to parse.');
  const text = await res.text();
  if (text.length > MAX_MANIFEST_BYTES) throw new Error('Manifest is implausibly large (>30 MB) — refusing to parse.');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The URL did not return valid JSON.');
  }
  return parseManifest(json, { sourceUrl: url });
}

// Parse a user-dropped/selected .json File (the offline entry path of Q1).
export async function parseManifestFile(file) {
  const text = await file.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`"${file.name}" is not valid JSON.`);
  }
  return parseManifest(json, { sourceUrl: null });
}
