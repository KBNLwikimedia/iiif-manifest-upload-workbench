// Upload Workbench — Wikimedia Commons API
//
// Adapted from upload-stash-viewer/src/api/commons.js. Upload Workbench needs
// both the stash list (mystashedfiles) and the published-history list
// (allimages with auser=) to populate the two streams shown in the design.
//
// Currently the UI loads from window.SAMPLE_UPLOADS (data.js). Wire these
// functions into app.jsx when replacing the mock data layer.

import { COMMONS_API, DEMO_MODE, APP_USER_AGENT, attributionSuffix } from '../config.js';
import { fetchJSON, fetchWithAuth } from '../utils.js';
import { getAccessToken } from './oauth.js';
import { normalizeStashItem, normalizePublishedItem } from './normalize.js';
import { getStashedFilename as getCachedFilenameLocal } from './local-store.js';
import { getStashedFilename as getCachedFilenameWiki } from './user-store.js';

// --- Stash (authenticated) ---

// Realistic 48h-window stash counts are well under this. The cap exists so
// a misbehaving API that keeps returning a continue token can't lock the tab.
const STASH_PAGE_LIMIT = 500;
const STASH_SAFETY_CAP = 5000;

export async function fetchStashedFiles() {
  if (DEMO_MODE) return window.SAMPLE_UPLOADS.filter((i) => i.status?.startsWith('stash'));

  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  // Page through mystashedfiles. The MediaWiki default limit is 10, so a
  // single call drops everything past the first page; users with more than
  // 10 stash files would see a truncated workbench. Loop until the API
  // stops returning a msfcontinue token (or we hit the safety cap).
  const allFiles = [];
  let msfcontinue = null;
  while (allFiles.length < STASH_SAFETY_CAP) {
    const params = new URLSearchParams({
      action: 'query',
      list: 'mystashedfiles',
      msfprop: 'size|type',
      msflimit: String(STASH_PAGE_LIMIT),
      format: 'json',
      formatversion: '2',
    });
    if (msfcontinue) params.set('msfcontinue', msfcontinue);
    const data = await fetchWithAuth(`${COMMONS_API}?${params}`, token);
    const page = data.query?.mystashedfiles || [];
    allFiles.push(...page);
    msfcontinue = data.continue?.msfcontinue || null;
    if (!msfcontinue) break;
  }
  if (allFiles.length >= STASH_SAFETY_CAP) {
    console.warn(
      `[stash] hit safety cap of ${STASH_SAFETY_CAP} files; some entries may be missing`,
    );
  }

  return Promise.all(
    allFiles.map(async (file) => {
      let info = null;
      try {
        info = await fetchStashFileInfo(file.filekey);
      } catch {
        // The file row from list=mystashedfiles is enough to render the card;
        // the detail panel will retry if the user opens it.
      }
      // The stash API doesn't preserve the user-chosen filename. We keep two
      // caches: user-store (cross-device, takes precedence) and local-store
      // (instant boot, fallback). Either is enough to show a real name.
      const cachedFilename =
        getCachedFilenameWiki(file.filekey) || getCachedFilenameLocal(file.filekey);
      const enriched = cachedFilename ? { ...file, filename: cachedFilename } : file;
      return normalizeStashItem(enriched, info);
    }),
  );
}

export async function fetchStashFileInfo(filekey) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const params = new URLSearchParams({
    action: 'query',
    prop: 'stashimageinfo',
    siifilekey: filekey,
    // extmetadata has cleaner GPS values (decimal degrees) than the raw
    // metadata array; we ask for both so we can fall back if needed.
    siiprop: 'timestamp|url|metadata|commonmetadata|extmetadata|mime|sha1|size|dimensions|bitdepth',
    siiurlwidth: '320',
    format: 'json',
    formatversion: '2',
  });

  const data = await fetchWithAuth(`${COMMONS_API}?${params}`, token);
  const info = data.query?.stashimageinfo?.[0];
  if (!info) throw new Error('No stash image info for this filekey');
  return { filekey, ...info, thumburl: info.thumburl || info.url };
}

// --- Published history for the current user ---
// Uses list=allimages&aisort=timestamp&aiuser=<username>. Requires the username,
// which the OAuth profile endpoint provides.

export async function fetchPublishedFiles(username, { limit = 50 } = {}) {
  if (DEMO_MODE) return window.SAMPLE_UPLOADS.filter((i) => i.status === 'published');

  const params = new URLSearchParams({
    action: 'query',
    list: 'allimages',
    aisort: 'timestamp',
    aidir: 'older',
    aiuser: username,
    ailimit: String(limit),
    aiprop: 'timestamp|url|size|dimensions|mime|sha1|canonicaltitle',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });

  const data = await fetchJSON(`${COMMONS_API}?${params}`);
  const files = data.query?.allimages || [];
  return files.map(normalizePublishedItem);
}

// --- Duplicate detection across all of Commons ---
//
// Given a SHA-1 (hex), ask Commons whether any file with that exact hash
// already exists — uploaded by anyone, not just the current user. The
// stash returns sha1 in fetchStashFileInfo, so we never need to hash
// client-side. allimages is public and indexed on sha1.

export async function findCommonsFileBySha1(sha1, { noCache = false } = {}) {
  if (!sha1) return null;
  if (DEMO_MODE) return null;

  const params = new URLSearchParams({
    action: 'query',
    list: 'allimages',
    aisha1: sha1,
    aiprop: 'timestamp|url|canonicaltitle|user|size|mime',
    ailimit: '5',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });

  const data = await fetchJSON(`${COMMONS_API}?${params}`, { noCache });
  const hit = data.query?.allimages?.[0];
  if (!hit) return null;
  return {
    filename: hit.canonicaltitle?.replace(/^File:/, '') || hit.name,
    descriptionurl: hit.descriptionurl,
    timestamp: hit.timestamp,
    user: hit.user,
    size: hit.size,
    mime: hit.mime,
  };
}

// --- CSRF + Publish ---

export async function fetchCSRFToken() {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const params = new URLSearchParams({
    action: 'query',
    meta: 'tokens',
    type: 'csrf',
    format: 'json',
  });
  const data = await fetchWithAuth(`${COMMONS_API}?${params}`, token, { noCache: true });
  return data.query?.tokens?.csrftoken;
}

export async function publishFromStash(filekey, filename, wikitext, { ignorewarnings = false } = {}) {
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 500));
    return {
      upload: {
        result: 'Success',
        filename,
        imageinfo: {
          descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename)}`,
        },
      },
    };
  }

  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const csrfToken = await fetchCSRFToken();

  const formData = new FormData();
  formData.append('action', 'upload');
  formData.append('filekey', filekey);
  formData.append('filename', filename);
  formData.append('text', wikitext);
  // T425978: every Commons write self-identifies in its edit summary. The
  // attribution suffix is always appended; user-supplied summaries are out of
  // scope for now (the publish flow doesn't expose one).
  formData.append('comment', `Uploaded${attributionSuffix()}`);
  formData.append('token', csrfToken);
  formData.append('format', 'json');
  formData.append('formatversion', '2');
  formData.append('assert', 'user');
  if (ignorewarnings) formData.append('ignorewarnings', '1');

  const url = `${COMMONS_API}?crossorigin=`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Api-User-Agent': APP_USER_AGENT,
    },
    body: formData,
  });

  if (!response.ok) throw new Error(`Upload failed: HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`Upload error: ${data.error.info}`);
  return data;
}

// --- Structured Data on Commons (action=wbeditentity on M-id) ---
//
// File pages have a sibling SDC entity at id "M{pageid}". To attach
// claims (P180 depicts, P625 coords, P1071 location-of-creation, P571
// inception), we need the file's pageid first.

async function fetchFilePageId(filename) {
  const params = new URLSearchParams({
    action: 'query',
    titles: `File:${filename}`,
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  const data = await fetchJSON(`${COMMONS_API}?${params}`);
  const pageid = data.query?.pages?.[0]?.pageid;
  if (!pageid) throw new Error(`Could not resolve pageid for File:${filename}`);
  return pageid;
}

export async function addStructuredData(filename, claims) {
  if (!claims?.length) return null;
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 200));
    return { success: 1 };
  }

  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const pageid = await fetchFilePageId(filename);
  const entityId = `M${pageid}`;
  const csrfToken = await fetchCSRFToken();

  // wbeditentity takes the data as JSON in a single `data` field. Note that
  // SDC's payload uses `claims` (not `statements`).
  const fd = new FormData();
  fd.append('action', 'wbeditentity');
  fd.append('id', entityId);
  fd.append('data', JSON.stringify({ claims }));
  fd.append('token', csrfToken);
  // T425978: every Commons write self-identifies in its edit summary.
  fd.append('summary', `Add structured data${attributionSuffix()}`);
  fd.append('format', 'json');
  fd.append('assert', 'user');

  const url = `${COMMONS_API}?crossorigin=`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Api-User-Agent': APP_USER_AGENT,
    },
    body: fd,
  });
  const data = await response.json();
  if (data.error) throw new Error(`SDC error: ${data.error.info}`);
  return data;
}

// --- Vocabularies (Wikidata + Commons) ---

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

export async function searchWikidataEntities(query, language = 'en') {
  if (!query || query.length < 2) return [];
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: query,
    language,
    limit: '10',
    format: 'json',
    origin: '*',
  });
  const data = await fetchJSON(`${WIKIDATA_API}?${params}`);
  return (data.search || []).map((item) => ({
    qid: item.id,
    label: item.label || item.id,
    desc: item.description || '',
  }));
}

// Fetch the canonical label + description for a single Q-id from Wikidata.
// Used by the depicts-pill info popover (`PillInfoPopover` in table.jsx) so
// users see the live Wikidata label/description rather than whatever string
// got cached on the file's SDC P180 statement, even for Q-ids that aren't
// in the local KNOWN_DEPICTS pool. Cached for 5 minutes via fetchJSON's
// apiCache; the unauthenticated wbgetentities endpoint is CORS-enabled and
// supports `origin=*`.
//
// Returns { qid, label, desc } or null on miss / network error.
export async function fetchWikidataEntity(qid, language = 'en') {
  if (!qid || !/^Q\d+$/i.test(qid)) return null;
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    props: 'labels|descriptions',
    languages: language,
    languagefallback: '1',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  try {
    const data = await fetchJSON(`${WIKIDATA_API}?${params}`);
    const entity = data?.entities?.[qid];
    if (!entity || entity.missing !== undefined) return null;
    const label = entity.labels?.[language]?.value || entity.labels?.en?.value || qid;
    const desc = entity.descriptions?.[language]?.value || entity.descriptions?.en?.value || '';
    return { qid, label, desc };
  } catch (e) {
    console.warn('[wikidata] fetchWikidataEntity failed for', qid, e?.message || e);
    return null;
  }
}

export async function searchCategories(query) {
  if (!query || query.length < 2) return [];
  // Defensive: callers may already send "Category:Foo" — strip before
  // re-prefixing so we never query for "Category:Category:Foo" (T425912).
  const bare = String(query).replace(/^\s*Category\s*:\s*/i, '').trim();
  if (bare.length < 2) return [];
  const params = new URLSearchParams({
    action: 'opensearch',
    search: `Category:${bare}`,
    namespace: '14',
    limit: '20',
    format: 'json',
    origin: '*',
  });
  const data = await fetchJSON(`${COMMONS_API}?${params}`);
  return (data[1] || []).map((t) => t.replace(/^Category:/, ''));
}

// --- Category existence check ---
//
// Lightweight `prop=info` lookup — returns true when the category page
// exists on Commons, false when it's missing. Used to gate publish on
// rows that contain non-existing categories (T425950): the tool does not
// create new categories, only attaches existing ones, so any unknown name
// the user typed must be flagged red and blocked from publish.
//
// Cached via fetchJSON's apiCache (5-min TTL), so repeat checks for the
// same name in a session are free. DEMO_MODE: optimistically true so the
// mock UI keeps working without network access.
export async function categoryExists(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (DEMO_MODE) return true;

  const params = new URLSearchParams({
    action: 'query',
    prop: 'info',
    titles: `Category:${n}`,
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  const data = await fetchJSON(`${COMMONS_API}?${params}`);
  const page = data.query?.pages?.[0];
  if (!page) return false;
  // formatversion=2 returns `missing: true` (boolean) for non-existent pages
  // and a numeric pageid for existing ones.
  return !page.missing && typeof page.pageid === 'number';
}

// --- OI-68 B/C: discover existing category variants for a manuscript -------
//
// The suggested per-manuscript category ("Bout psalter-getijdenboek - KW 79 K
// 11") often does NOT exist, yet the manuscript already has a category under a
// different name ("Bout Psalter-Hours KB 79K11"). We surface those so the user
// adopts one instead of creating a near-duplicate. Two sources, both verified:
//   B  generated KB naming-convention variants → existence check
//   C  full-text category search (title + signature) → keep only categories
//      that are actually filed under the KB parent (kills search noise like
//      German heritage monuments whose codes contain "76…5")

const KB_PARENT_HINT = 'Koninklijke Bibliotheek'; // any parent containing this = a real KB manuscript category

// Full-text category search (namespace 14). Returns bare category names.
export async function searchCategoriesFullText(query, limit = 8) {
  const q = String(query || '').replace(/^\s*Category\s*:\s*/i, '').trim();
  if (!q || DEMO_MODE) return [];
  const params = new URLSearchParams({
    action: 'query', list: 'search', srsearch: q, srnamespace: '14',
    srlimit: String(limit), srprop: '', format: 'json', formatversion: '2', origin: '*',
  });
  const data = await fetchJSON(`${COMMONS_API}?${params}`);
  return (data.query?.search || []).map((r) => String(r.title).replace(/^Category:/, ''));
}

// Parent categories of a category page (bare names).
export async function categoryParents(name) {
  const n = String(name || '').replace(/^\s*Category\s*:\s*/i, '').trim();
  if (!n || DEMO_MODE) return [];
  const params = new URLSearchParams({
    action: 'query', prop: 'categories', titles: `Category:${n}`,
    cllimit: '100', format: 'json', formatversion: '2', origin: '*',
  });
  const data = await fetchJSON(`${COMMONS_API}?${params}`);
  const page = data.query?.pages?.[0];
  return (page?.categories || []).map((c) => String(c.title).replace(/^Category:/, ''));
}

// Is this category filed (directly) under a KB parent? (verification for C)
async function isUnderKbParent(name) {
  try { return (await categoryParents(name)).some((p) => p.includes(KB_PARENT_HINT)); }
  catch { return false; }
}

// KB signature → candidate existing-category names (Phase B). The real ones
// are unpunctuated and KB- (not KW-) prefixed: "Den Haag KB 76 E 5",
// "Bout Psalter-Hours KB 79K11". We try the KB naming conventions.
function namingVariants(signature) {
  const sig = String(signature || '').replace(/^KW\s+/i, '').trim(); // bare shelfmark
  if (!sig) return [];
  const nospace = sig.replace(/([A-Za-z])\s+(\d)/g, '$1$2'); // "79 K 11" → "79 K11"
  const cands = new Set([
    `Den Haag KB ${sig}`, `Den Haag, KB ${sig}`,
    `KB ${sig}`, `KB ${nospace}`,
    sig,
  ]);
  return [...cands];
}

// findManuscriptCategoryVariants({ title, signature }) → existing categories
// that are (verified) this manuscript's home on Commons, each { name, source }.
// `source`: 'naming' (B) or 'search' (C). Sequential + apiCache-backed to
// respect API-politeness; runs only behind the user gesture (a parsed
// manifest whose suggested category is missing).
export async function findManuscriptCategoryVariants({ title, signature }) {
  if (DEMO_MODE) return [];
  const found = new Map(); // name → { name, source } (insertion order: B before C)
  const add = (name, source) => { if (name && !found.has(name)) found.set(name, { name, source }); };

  const terms = [String(title || '').trim(), String(signature || '').replace(/^KW\s+/i, '').trim()].filter(Boolean);

  // Fire B (existence of generated variants) and the C searches together — a
  // bounded, user-triggered read burst (not bootstrap, doesn't scale with
  // canvas count), all apiCache-backed.
  const [bResults, searchLists] = await Promise.all([
    Promise.all(namingVariants(signature).map(async (cand) => ({ cand, exists: await categoryExists(cand).catch(() => false) }))),
    Promise.all(terms.map((t) => searchCategoriesFullText(t, 8).catch(() => []))),
  ]);

  // B — keep the naming variants that exist (deterministic, preferred).
  for (const { cand, exists } of bResults) if (exists) add(cand, 'naming');

  // C — verify the search hits are actually filed under the KB parent
  // (kills noise: heritage monuments whose codes contain "76…5"). Parallel,
  // capped, skipping any already confirmed via B.
  const hits = [...new Set(searchLists.flat())].filter((n) => !found.has(n)).slice(0, 8);
  const verified = await Promise.all(hits.map(async (name) => ({ name, ok: await isUnderKbParent(name) })));
  for (const { name, ok } of verified) if (ok) add(name, 'search');

  return [...found.values()];
}

// Create a category page on Commons (IIIF ingestor, design Q8 / OI-04).
//
// The T425950 publish check blocks rows whose categories don't exist; the
// IIIF import wizard therefore creates the per-manuscript home category
// (after the user confirmed/edited its name) before any publish happens.
// `createonly` makes the call a no-op-with-error when the page already
// exists — we treat that as success (the category being there is the goal).
//
// NOTE: this bypasses categoryExists' 5-min apiCache — callers should
// re-check existence with { noCache } semantics in mind, or simply trust
// the successful return.
export async function createCategoryPage(name, wikitext) {
  const bare = String(name || '').replace(/^\s*Category\s*:\s*/i, '').trim();
  if (!bare) throw new Error('Empty category name');
  if (DEMO_MODE) {
    await new Promise((r) => setTimeout(r, 200));
    return { created: true, demo: true };
  }

  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const csrf = await fetchCSRFToken();

  const fd = new FormData();
  fd.append('action', 'edit');
  fd.append('title', `Category:${bare}`);
  fd.append('text', wikitext);
  fd.append('createonly', '1');
  fd.append('summary', `Create category for IIIF manuscript import${attributionSuffix()}`);
  fd.append('token', csrf);
  fd.append('format', 'json');
  fd.append('formatversion', '2');

  const response = await fetch(`${COMMONS_API}?crossorigin=`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Api-User-Agent': APP_USER_AGENT },
    body: fd,
  });
  const data = await response.json();
  if (data.error) {
    if (data.error.code === 'articleexists') return { created: false, existed: true };
    throw new Error(`${data.error.code}: ${data.error.info}`);
  }
  return { created: true };
}

// --- Category info (for the pill info popover) ---
//
// Fetches existence + a one-line summary for a Commons category.
// Combines three props in a single request:
//   - categoryinfo: { size, pages, files, subcats } — counts on the category
//   - extracts:     plain-text lead extract (1 sentence) — categories often
//                   have a stub/no extract; we degrade gracefully
//   - categories:   parent categories (we exclude hidden maintenance cats)
//
// Returns null when the category page does not exist (i.e. it would be
// created on publish). Cached by fetchJSON's 5-minute TTL.
export async function fetchCategoryInfo(name) {
  if (!name) return null;
  if (DEMO_MODE) return null;

  // Defensive: strip a leading "Category:" if the caller already prefixed
  // (T425912 — display surfaces are now prefixed everywhere; storage is bare,
  // but be lenient here).
  const bare = String(name).replace(/^\s*Category\s*:\s*/i, '').trim();
  if (!bare) return null;

  const params = new URLSearchParams({
    action: 'query',
    prop: 'categoryinfo|extracts|categories',
    titles: `Category:${bare}`,
    explaintext: '1',
    exsentences: '1',
    exlimit: '1',
    clshow: '!hidden',
    cllimit: '10',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });

  const data = await fetchJSON(`${COMMONS_API}?${params}`);
  const page = data.query?.pages?.[0];
  if (!page || page.missing) return null;

  const ci = page.categoryinfo || {};
  const parents = (page.categories || [])
    .map((c) => (c.title || '').replace(/^Category:/, ''))
    .filter(Boolean);
  return {
    name: bare,
    pageid: page.pageid,
    files: typeof ci.files === 'number' ? ci.files : 0,
    subcats: typeof ci.subcats === 'number' ? ci.subcats : 0,
    pages: typeof ci.pages === 'number' ? ci.pages : 0,
    extract: (page.extract || '').trim(),
    parents,
  };
}

// Batched counts-only flavour of fetchCategoryInfo, used by autocomplete
// suggestions. Returns Map<name, {files, subcats, pages, missing}>.
//
// MediaWiki accepts up to 50 titles per query (500 for bots; we stay polite).
// We chunk just in case the caller passes more — autocomplete passes ≤20.
// Cached at the URL level by fetchJSON's 5-min TTL, so the same suggestion
// list re-typed within the session re-uses the response.
export async function fetchCategoryInfoBatch(names) {
  const out = new Map();
  if (!Array.isArray(names) || names.length === 0) return out;
  if (DEMO_MODE) return out;

  const unique = Array.from(new Set(names.filter(Boolean)));
  const CHUNK = 50;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const titles = chunk.map((n) => `Category:${n}`).join('|');
    const params = new URLSearchParams({
      action: 'query',
      prop: 'categoryinfo',
      titles,
      format: 'json',
      formatversion: '2',
      origin: '*',
    });
    let data;
    try {
      data = await fetchJSON(`${COMMONS_API}?${params}`);
    } catch (e) {
      console.warn('[categoryinfo] batch fetch failed:', e?.message || e);
      continue;
    }
    const pages = data?.query?.pages || [];
    // The response order is not guaranteed to match the request, but each
    // page carries its own title. MediaWiki normalises titles (e.g. underscore
    // ↔ space); the canonical form lives in normalized[].
    const normMap = new Map();
    for (const n of data?.query?.normalized || []) {
      // n.from is what we sent (with our prefix), n.to is the canonical
      normMap.set(n.from, n.to);
    }
    // Build an inverse: canonical title → original requested name
    const reverseLookup = new Map();
    for (const requested of chunk) {
      const sent = `Category:${requested}`;
      const canonical = normMap.get(sent) || sent;
      reverseLookup.set(canonical, requested);
    }
    for (const p of pages) {
      const requested = reverseLookup.get(p.title);
      if (!requested) continue;
      const ci = p.categoryinfo || {};
      out.set(requested, {
        files: typeof ci.files === 'number' ? ci.files : 0,
        subcats: typeof ci.subcats === 'number' ? ci.subcats : 0,
        pages: typeof ci.pages === 'number' ? ci.pages : 0,
        missing: !!p.missing,
      });
    }
  }
  return out;
}
