// Wikidata lookups for the IIIF ingestor (design decision Q6).
//
// The KB's manuscript signatures ("129 A 24") are recorded on Wikidata as
// P217 (inventory number) on stub items like Q114991159 ("Den Haag, KB :
// ms. 130 E 1"). The wizard auto-fills the manuscript's Q-id from the
// signature and lets the user override it; the Q-id feeds SDC statements
// P6243 (digital representation of) and P180 (depicts) plus the {{Artwork}}
// |wikidata= parameter.
//
// Reads go through fetchJSON → apiCache (5-min TTL) so re-running the
// wizard on the same manuscript doesn't re-hit the query service.

import { fetchJSON } from '../utils.js';

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

// Both "129 A 24" and "KW 129 A 24" forms exist in the wild; P217 values on
// the KB stubs use the bare form. Try the signature as given plus the
// KW-stripped variant.
function signatureVariants(signature) {
  const sig = String(signature || '').trim();
  if (!sig) return [];
  const out = [sig];
  const stripped = sig.replace(/^KW\s+/i, '');
  if (stripped !== sig) out.push(stripped);
  else out.push(`KW ${sig}`);
  return out;
}

// findManuscriptItems('KW 129 A 24') →
//   [{ qid, label, commonsCategory, commonsPage }] (possibly empty).
// Multiple hits are possible (other institutions reuse inventory numbers),
// so the caller shows the list and the user confirms — we don't guess.
//
// OI-68 Phase A: the same query also pulls the item's P373 (Commons
// category — for KB manuscripts this is the *existing* category under a
// KB naming convention, e.g. Q1929931 → "Den Haag KB 76 E 5") and the
// commonswiki sitelink (usually a gallery page). The wizard uses P373 to
// offer the already-existing category instead of creating a near-duplicate.
export async function findManuscriptItems(signature) {
  const variants = signatureVariants(signature);
  if (!variants.length) return [];
  const values = variants.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(' ');
  const query = `
    SELECT DISTINCT ?item ?itemLabel ?commonsCat ?commonsPage WHERE {
      VALUES ?sig { ${values} }
      ?item wdt:P217 ?sig .
      OPTIONAL { ?item wdt:P373 ?commonsCat . }
      OPTIONAL {
        ?sitelink schema:about ?item ;
                  schema:isPartOf <https://commons.wikimedia.org/> ;
                  schema:name ?commonsPage .
      }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "nl,en". }
    } LIMIT 20`;
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const data = await fetchJSON(url, { headers: { Accept: 'application/sparql-results+json' } });
  // The OPTIONALs can yield several rows per item — merge them by Q-id.
  const byQid = new Map();
  for (const b of data?.results?.bindings || []) {
    const qid = b.item.value.split('/').pop();
    const cur = byQid.get(qid) || { qid, label: '', commonsCategory: null, commonsPage: null };
    if (!cur.label && b.itemLabel?.value) cur.label = b.itemLabel.value;
    if (!cur.commonsCategory && b.commonsCat?.value) cur.commonsCategory = b.commonsCat.value;
    if (!cur.commonsPage && b.commonsPage?.value) cur.commonsPage = b.commonsPage.value;
    byQid.set(qid, cur);
  }
  return [...byQid.values()];
}
