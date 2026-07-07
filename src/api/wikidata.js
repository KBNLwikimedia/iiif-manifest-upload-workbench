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

// findManuscriptItems('KW 129 A 24') → [{ qid, label }] (possibly empty).
// Multiple hits are possible (other institutions reuse inventory numbers),
// so the caller shows the list and the user confirms — we don't guess.
export async function findManuscriptItems(signature) {
  const variants = signatureVariants(signature);
  if (!variants.length) return [];
  const values = variants.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(' ');
  const query = `
    SELECT DISTINCT ?item ?itemLabel WHERE {
      VALUES ?sig { ${values} }
      ?item wdt:P217 ?sig .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "nl,en". }
    } LIMIT 10`;
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const data = await fetchJSON(url, { headers: { Accept: 'application/sparql-results+json' } });
  return (data?.results?.bindings || []).map((b) => ({
    qid: b.item.value.split('/').pop(),
    label: b.itemLabel?.value || '',
  }));
}
