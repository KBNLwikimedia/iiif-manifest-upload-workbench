// Publish a stashed file to Commons.
//
// Three-step orchestration:
//   1. action=upload&filekey=… commits the bytes from the stash, with the
//      assembled wikitext as the page content. Returns the canonical
//      filename and an imageinfo block including the description URL.
//   2. action=wbeditentity adds Structured Data (depicts, coords, location
//      of creation, inception) to the file's M{pageid} entity. SDC failure
//      is non-fatal — the file is already on Commons; we surface a warning
//      but don't unpublish.
//
// The wikitext schema is driven by the user's chosen template (default
// {{Information}}; also {{Artwork}}, {{Photograph}}, {{Book}}, or a custom
// body). The license template is inlined separately. Categories become
// [[Category:Foo]] lines.

import { publishFromStash, addStructuredData, createCategoryPage } from './commons.js';
import { renderLicenseTemplate, isOwnWorkLicense } from '../licenses.js';
import { renderTemplateBlock } from '../wikitext-templates.js';
import { KB_PARENT_CATEGORY } from './iiif-map.js';

// --- "Author = uploader" helpers (own-work uploads) ---
//
// Commons' canonical wikitext form for "I (the uploader) am the author" is
// a piped User: link, e.g. `[[User:Tuxyso|Tuxyso]]`. The matching SDC
// representation uses creator (P170) with a `somevalue` mainsnak (no
// Wikidata item for the author) plus qualifiers identifying the user:
// P2093 (author name string), P4174 (Wikimedia username), P2699 (URL to
// the user page on Commons). See the research notes on T425874 for the
// docs + real-upload references this pattern is drawn from.

export function selfAuthorWikitext(username) {
  if (!username) return '';
  return `[[User:${username}|${username}]]`;
}

// True if `author` (the wikitext stored in item.author) is the canonical
// "uploader is author" form for this username. Tolerant of whitespace and
// of the bare-username variant some users may type.
export function isSelfAuthor(author, username) {
  if (!author || !username) return false;
  const trimmed = String(author).trim();
  if (!trimmed) return false;
  if (trimmed === selfAuthorWikitext(username)) return true;
  // Bare username (case-insensitive on the first char to match MW casing).
  if (trimmed.toLowerCase() === String(username).toLowerCase()) return true;
  return false;
}

function selfAuthorClaim(username) {
  // P170 mainsnak `somevalue` + qualifiers, matching the on-wiki shape from
  // M28633332 / M154373445 (real own-work uploads). P3831 (object has role,
  // e.g. Q33231 photographer) is intentionally omitted — it's medium-
  // specific and not always present.
  return {
    mainsnak: { snaktype: 'somevalue', property: 'P170' },
    qualifiers: {
      P2093: [{ snaktype: 'value', property: 'P2093', datavalue: { type: 'string', value: String(username) } }],
      P4174: [{ snaktype: 'value', property: 'P4174', datavalue: { type: 'string', value: String(username) } }],
      P2699: [{ snaktype: 'value', property: 'P2699', datavalue: { type: 'string', value: `https://commons.wikimedia.org/wiki/User:${encodeURIComponent(String(username)).replace(/%20/g, '_')}` } }],
    },
    'qualifiers-order': ['P2093', 'P4174', 'P2699'],
    type: 'statement',
    rank: 'normal',
  };
}

// --- Wikitext assembly ---
//
// License-template generation lives in src/licenses.js — the catalog there is
// the single source of truth for the option set, short labels, info text, and
// per-license wikitext. Adding a new license? Edit src/licenses.js, not here.

// Source rendering — coupled with the chosen licence.
//
// Behaviour:
//   - Explicit user value (URL, citation text, raw `{{own}}`, etc.) wins,
//     always passed through verbatim. The cell editor stores `{{own}}` when
//     the user picks the "Own work" quick-select; the legacy plain-text
//     "Own work" string is also normalised to `{{own}}` for back-compat.
//   - Empty source + own-work licence (CC0 / CC BY 4.0 / CC BY-SA 4.0) →
//     `{{own}}` is the implicit default. This matches what {{Information}}
//     traditionally expects for self-uploads, without forcing the user to
//     type it for every row.
//   - Empty source + non-own-work licence (PD claims, third-party CC, GFDL,
//     custom) → empty. Validation upstream may flag this; the publish modal
//     surfaces blockers per row. We deliberately don't auto-emit `{{own}}`
//     here because attributing a third-party / PD work as own work would be
//     factually wrong.
//
// This helper is consumed by renderTemplateBlock in src/wikitext-templates.js
// when it builds the |source= field of the chosen template, so the licence-
// coupling fires regardless of which wikitext template the user picked.
export function effectiveSource(item) {
  const raw = (item?.source || '').trim();
  if (raw) {
    // Legacy back-compat: treat the plain string "Own work" (the old
    // normalize.js default) as the canonical wikitext.
    if (raw.toLowerCase() === 'own work') return '{{own}}';
    return raw;
  }
  if (isOwnWorkLicense(item?.license)) return '{{own}}';
  return '';
}


function formatLicense(item) {
  // renderLicenseTemplate handles three cases:
  //   - known catalog id → calls its template(author) builder
  //   - free-form custom wikitext (CUSTOM_LICENSE_ID branch) → passed through
  //   - empty / unknown → '' (an empty license-header is caught by validation)
  return renderLicenseTemplate(item.license, item.author || '');
}

// `templateConfig` follows the shape understood by wikitext-templates.js.
// When omitted (or null), defaults to {{Information}}.
//
// T426449 dropped the user-defined wikitext-template column type, so the
// previous `templateColumns` option here is gone.
//
// Hidden tracking category on Commons that collects every file published via
// this tool — see https://commons.wikimedia.org/wiki/Category:Uploaded_with_IIIF_Manifest_Upload_Workbench
// (the page itself carries `__HIDDENCAT__`; the wikitext we emit is just an
// ordinary [[Category:…]] link). Auto-appended at the end of buildWikitext so
// it sits alongside the user's other categories. Idempotent — if the user
// already typed it into their categories list (or it survives in a hand-edit
// roundtrip) we don't double-add. The user can still strip it by hand-editing
// the wikitext in the publish modal; we don't re-inject after that.
const TRACKING_CATEGORY = 'Uploaded with IIIF Manifest Upload Workbench';

function isTrackingCategory(name) {
  return String(name || '').trim().toLowerCase() === TRACKING_CATEGORY.toLowerCase();
}

export function buildWikitext(item, templateConfig) {
  const block = renderTemplateBlock(item, templateConfig);
  const lines = [
    '=={{int:filedesc}}==',
    block,
    '',
    '=={{int:license-header}}==',
    formatLicense(item),
    '',
  ];
  let trackingCategoryAlreadyPresent = false;
  for (const c of item.categories || []) {
    // Defensive: strip a leading "Category:" if any storage path slipped one
    // through, so we never emit `[[Category:Category:Foo]]` (T425912).
    const bare = String(c || '').replace(/^\s*Category\s*:\s*/i, '').trim();
    if (!bare) continue;
    if (isTrackingCategory(bare)) trackingCategoryAlreadyPresent = true;
    lines.push(`[[Category:${bare}]]`);
  }
  if (!trackingCategoryAlreadyPresent) {
    lines.push(`[[Category:${TRACKING_CATEGORY}]]`);
  }
  return lines.join('\n');
}

// --- Final filename ---
//
// Prefer the user-set title; fall back to the original filename. Always
// preserve the extension. Sanitize for Commons title rules.
//
// `titleOverride` (T425984): when the auto-sequence resolver assigned a
// concrete title (e.g. `Foo 8` from a `Foo #` placeholder), pass it here
// instead of the literal item.title. We don't want the placeholder `#` to
// reach the sanitizer (which would replace it with `-` and ruin the
// filename) — the resolver guarantees a clean replacement.

const FORBIDDEN_TITLE_CHARS = /[#<>[\]|{}/\\:]/g;

export function makeFinalFilename(item, titleOverride = null) {
  const original = item.filename || '';
  const ext = original.match(/\.[^.]+$/)?.[0] || '';
  const sourceTitle = titleOverride != null && titleOverride !== ''
    ? String(titleOverride)
    : (item.title || '');
  let base = sourceTitle.trim() || original.replace(/\.[^.]+$/, '');
  base = base.replace(FORBIDDEN_TITLE_CHARS, '-').replace(/\s+/g, ' ').trim();
  if (!base) base = 'Upload';
  return base.endsWith(ext) ? base : base + ext;
}

// --- Structured Data claims (P180 depicts, P625 coords, etc.) ---

function qidClaim(property, qid) {
  const numeric = parseInt(String(qid).replace(/^Q/, ''), 10);
  if (!Number.isFinite(numeric)) return null;
  return {
    mainsnak: {
      snaktype: 'value',
      property,
      datavalue: {
        type: 'wikibase-entityid',
        value: { 'entity-type': 'item', 'numeric-id': numeric, id: `Q${numeric}` },
      },
    },
    type: 'statement',
    rank: 'normal',
  };
}

function coordClaim(property, lat, lon) {
  return {
    mainsnak: {
      snaktype: 'value',
      property,
      datavalue: {
        type: 'globecoordinate',
        value: {
          latitude: Number(lat),
          longitude: Number(lon),
          precision: 0.0001,
          globe: 'http://www.wikidata.org/entity/Q2',
        },
      },
    },
    type: 'statement',
    rank: 'normal',
  };
}

function timeClaim(property, iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Wikidata expects "+YYYY-MM-DDTHH:MM:SSZ" with day precision = 11.
  const time = `+${d.toISOString().slice(0, 10)}T00:00:00Z`;
  return {
    mainsnak: {
      snaktype: 'value',
      property,
      datavalue: {
        type: 'time',
        value: {
          time,
          timezone: 0,
          before: 0,
          after: 0,
          precision: 11,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        },
      },
    },
    type: 'statement',
    rank: 'normal',
  };
}

export function buildSdcClaims(item, { selfUsername } = {}) {
  const claims = [];

  // P170 — creator. Only emitted when item.author is the canonical
  // "uploader is author" wikitext for the current user. Free-text authors
  // ("Acme Co.", "Public Domain", etc.) stay wikitext-only because we
  // can't safely model them as SDC without a Wikidata item.
  if (selfUsername && isSelfAuthor(item.author, selfUsername)) {
    claims.push(selfAuthorClaim(selfUsername));
  }

  // P180 — depicts
  for (const d of item.depicts || []) {
    if (d?.qid) {
      const c = qidClaim('P180', d.qid);
      if (c) claims.push(c);
    }
  }

  // P625 — coordinate location (use object location; fall back to camera/coords)
  const loc = item.objectLocation || item.coords || item.cameraLocation;
  if (loc && loc.lat != null && loc.lon != null) {
    claims.push(coordClaim('P625', loc.lat, loc.lon));
  }

  // P1071 — location of creation
  if (item.locationOfCreation?.qid) {
    const c = qidClaim('P1071', item.locationOfCreation.qid);
    if (c) claims.push(c);
  }

  // P571 — inception (date taken)
  if (item.dateTaken) {
    const c = timeClaim('P571', item.dateTaken);
    if (c) claims.push(c);
  }

  return claims;
}

// --- Orchestrator ---

// Per-session dedupe for pending-category creation: a 79-page bulk publish
// must create the manuscript's category once, not once per file.
const createdPendingCategories = new Set();

// publishOne — commits one stash file to Commons.
//
// Options:
//   ignorewarnings   — pass through to action=upload
//   selfUsername     — used by the SDC builder to attach a P170 (creator)
//                      claim when the author is the canonical self-author form.
//   templateConfig   — wikitext-template selection (Information/Artwork/etc.)
//   wikitext         — explicit wikitext override (e.g. from the publish-stage
//                      review textarea). When omitted, we build it from the
//                      item via buildWikitext.
//   resolvedTitle    — concrete title to use instead of item.title (T425984).
//                      Set by the auto-sequence resolver before publish so a
//                      `<basename> #` placeholder becomes `<basename> N`. We
//                      build a `effectiveItem` with item.title overridden, so
//                      the wikitext template ({{Artwork}}, {{Photograph}},
//                      {{Book}} all use |title=) sees the resolved title too.
//                      SDC claims don't reference the title field today, but
//                      the same overridden item is used there for consistency.
export async function publishOne(item, {
  ignorewarnings = false,
  selfUsername,
  templateConfig = null,
  wikitext: overrideWikitext,
  resolvedTitle = null,
} = {}) {
  const effectiveItem = resolvedTitle != null && resolvedTitle !== ''
    ? { ...item, title: String(resolvedTitle) }
    : item;

  // IIIF import (Q8, revised): the per-manuscript category is created here —
  // at publish time, right before the first file that uses it goes live —
  // never at import time, so an abandoned import leaves nothing behind on
  // Commons. Deduped per session; createonly makes racing calls harmless
  // (articleexists counts as success). Failure is non-fatal: the file still
  // publishes, the category is just a redlink the user can create by hand.
  if (item.iiifPendingCategory && (item.categories || []).includes(item.iiifPendingCategory)
      && !createdPendingCategories.has(item.iiifPendingCategory)) {
    try {
      await createCategoryPage(item.iiifPendingCategory, `[[Category:${item.iiifPendingParentCategory || KB_PARENT_CATEGORY}]]`);
      createdPendingCategories.add(item.iiifPendingCategory);
    } catch (e) {
      console.warn('Pending category creation failed:', item.iiifPendingCategory, e);
    }
  }

  const filename = makeFinalFilename(effectiveItem, null);
  const wikitext = overrideWikitext != null
    ? String(overrideWikitext)
    : buildWikitext(effectiveItem, templateConfig);
  const claims = buildSdcClaims(effectiveItem, { selfUsername });

  const uploadRes = await publishFromStash(item.filekey, filename, wikitext, { ignorewarnings });
  const upload = uploadRes.upload;
  if (!upload) {
    return { state: 'error', error: 'Upload API returned no upload object' };
  }

  // Warnings come back when ignorewarnings is false and the upload would
  // otherwise complete: duplicate, badfilename, exists, large-file, etc.
  // The file is NOT in Commons yet — the user has to retry with
  // ignorewarnings=1 (or change something) to commit.
  if (upload.warnings && !ignorewarnings) {
    return {
      state: 'warning',
      warnings: upload.warnings,
      filename,
      wikitext,
      claims,
    };
  }

  if (upload.result !== 'Success') {
    return { state: 'error', error: `Upload returned: ${upload.result || 'unknown'}` };
  }

  const finalName = upload.filename || filename;
  const descriptionurl = upload.imageinfo?.descriptionurl;

  // SDC is best-effort. The file is published; if SDC fails we still report
  // success but include the message so the UI can warn the user.
  let sdcError = null;
  if (claims.length > 0) {
    try {
      await addStructuredData(finalName, claims);
    } catch (e) {
      sdcError = e.message || String(e);
    }
  }

  return {
    state: 'success',
    filename: finalName,
    descriptionurl,
    sdcError,
    wikitext,
    claims,
  };
}

// Validation: the publish modal's Publish button is disabled until these
// are clear. recomputeIssues already populates these on the item.
//
// `categories-not-on-commons` (T425950) blocks publish whenever a row
// contains one or more category names that don't exist on Commons. The
// tool no longer creates new categories — the user must remove the
// unknown chip(s) or replace them with an existing category.
export const BLOCKING_ISSUE_CODES = new Set([
  'missing-title',
  'missing-license',
  'missing-author',
  'categories-not-on-commons',
  // Title format violates Commons' filename rules (length, forbidden chars,
  // structural). The publish API would reject the upload with a `badfilename`
  // / `extension-not-supported` warning anyway; blocking client-side saves
  // the round-trip and gives a clearer error.
  'invalid-title',
  // Cached uniqueness check came back "taken" — Commons would reject the
  // upload with an `exists` warning. As above, block client-side.
  'title-taken',
]);

export function blockingIssues(item) {
  return (item.issues || []).filter((c) => BLOCKING_ISSUE_CODES.has(c));
}

// Bulk publish — sequential. Commons rate-limits parallel uploads, and
// publishFromStash uses the cached CSRF token so consecutive calls don't
// re-fetch it. Per-item status is reported via the onUpdate callback so the
// UI can render a live checklist.
//
// onUpdate(itemId, partial) — called for each state transition:
//   { status: 'publishing' }
//   { status: 'success', filename, descriptionurl, sdcError }
//   { status: 'warning', warnings }
//   { status: 'error', error }
//
// The first warning seen (if any) returns control to the caller via the
// resolved array — the user can decide whether to ignore-and-retry that
// specific item via the modal's per-row retry button. Other items continue
// publishing.
export async function publishMany(items, {
  onUpdate,
  ignorewarnings = false,
  selfUsername,
  templateConfig = null,
  // Map of itemId -> per-row wikitext override (from the bulk publish modal's
  // per-row review). Items not in the map use the buildWikitext output.
  wikitextOverrides = null,
  // Map (or plain object) of itemId -> resolved sequence title. Set by the
  // auto-sequence resolver (T425984) so the publish call uses `Foo 8` instead
  // of the literal `Foo #` placeholder stored on the item. Items not in the
  // map use item.title directly.
  resolvedTitles = null,
} = {}) {
  const results = [];
  // Both Map and plain object lookup styles supported so callers can pass
  // either — Map.get for Map, [] for object.
  const lookupResolved = (id) => {
    if (!resolvedTitles) return null;
    if (typeof resolvedTitles.get === 'function') return resolvedTitles.get(id) ?? null;
    return resolvedTitles[id] ?? null;
  };
  for (const item of items) {
    onUpdate?.(item.id, { status: 'publishing' });
    try {
      const override = wikitextOverrides?.[item.id];
      const resolvedTitle = lookupResolved(item.id);
      const res = await publishOne(item, {
        ignorewarnings,
        selfUsername,
        templateConfig,
        ...(override != null ? { wikitext: override } : {}),
        ...(resolvedTitle != null ? { resolvedTitle } : {}),
      });
      if (res.state === 'success') {
        onUpdate?.(item.id, {
          status: 'success',
          filename: res.filename,
          descriptionurl: res.descriptionurl,
          sdcError: res.sdcError,
        });
      } else if (res.state === 'warning') {
        onUpdate?.(item.id, { status: 'warning', warnings: res.warnings });
      } else {
        onUpdate?.(item.id, { status: 'error', error: res.error });
      }
      results.push({ item, ...res });
    } catch (e) {
      const error = e.message || String(e);
      onUpdate?.(item.id, { status: 'error', error });
      results.push({ item, state: 'error', error });
    }
  }
  return results;
}
