// Unit tests for the pure helpers added in the post-v0.41.0 rounds:
//
//   - truncateBytes            (iiif-map.js, OI-29 byte-capped filenames)
//   - titleFromSummaryFallback (iiif-map.js, lightbox-caption provenance)
//   - findManifestDuplicates   (iiif.js, OI-85 shared collision detector)
//
// Plus a corpus invariant: every derived target filename across all sample
// manifests stays ≤ 255 UTF-8 bytes including the extension.
//
// Run:  node scripts/test-iiif-units.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, findManifestDuplicates } from '../src/api/iiif.js';
import { mapManifest, truncateBytes, titleFromSummaryFallback } from '../src/api/iiif-map.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const bytes = (s) => new TextEncoder().encode(s).length;

// --- truncateBytes ----------------------------------------------------------

check('truncateBytes: short ASCII untouched', truncateBytes('abc', 10) === 'abc');
check('truncateBytes: exact fit untouched', truncateBytes('abcde', 5) === 'abcde');
check('truncateBytes: ASCII cut to limit', truncateBytes('abcdef', 3) === 'abc');
check('truncateBytes: empty/null safe', truncateBytes(null, 5) === '' && truncateBytes('', 5) === '');
// ö = 2 bytes; limit 3 can hold 'aö' (3B) but not 'aöö'
check('truncateBytes: multibyte boundary', truncateBytes('aöö', 3) === 'aö');
// never split a 2-byte char: limit 2 after 1-byte 'a' can't fit 'ö'
check('truncateBytes: no split of 2-byte char', truncateBytes('aö', 2) === 'a');
// emoji (surrogate pair, 4 bytes in UTF-8) is kept whole or dropped whole
check('truncateBytes: emoji kept whole', truncateBytes('a😀b', 5) === 'a😀');
check('truncateBytes: emoji dropped whole', truncateBytes('a😀b', 4) === 'a');
// result is always within the byte budget
for (const [s, n] of [['Ωmega-manuscript-Ω', 7], ['ααααα', 6], ['a😀😀', 9]]) {
  check(`truncateBytes: ≤${n}B for ${JSON.stringify(s)}`, bytes(truncateBytes(s, n)) <= n);
}

// --- titleFromSummaryFallback ------------------------------------------------

check('titleFallback: label parenthetical → false',
  titleFromSummaryFallback({ label: 'KW 128 E 2 (Haags liederenhandschrift)', summary: 'whatever long sentence here' }) === false);
check('titleFallback: summary with separator → false',
  titleFromSummaryFallback({ label: 'KW 70 H 36', summary: 'De navolging van Christus / Thomas à Kempis' }) === false);
check('titleFallback: whole-summary title → true',
  titleFromSummaryFallback({ label: 'KW 79 K 10', summary: 'Een lang beschrijvend zinnetje zonder scheidingsteken' }) === true);
check('titleFallback: no summary, inhoud fallback → true',
  titleFromSummaryFallback({ label: 'KW 1 A 1', summary: '', fields: { inhoud: 'Getijdenboek' } }) === true);
check('titleFallback: nothing at all → false',
  titleFromSummaryFallback({ label: 'KW 1 A 1', summary: '' }) === false);

// --- findManifestDuplicates ---------------------------------------------------

const mk = (idx, label, img) => ({ index: idx, label, fullResUrl: img, serviceId: null });
{
  const r = findManifestDuplicates([]);
  check('dups: empty input', r.labelGroups.length === 0 && r.imageGroups.length === 0 && r.dupNames === 0 && r.dupImages === 0);
}
{
  const r = findManifestDuplicates(null);
  check('dups: null input safe', r.dupNames === 0 && r.dupImages === 0);
}
{
  // labels: A,A,B → one group of 2; images: x,y,z all distinct
  const r = findManifestDuplicates([mk(0, 'A', 'x'), mk(1, 'A', 'y'), mk(2, 'B', 'z')]);
  check('dups: label group found', r.labelGroups.length === 1 && r.dupNames === 2);
  check('dups: label positions 1-based', JSON.stringify(r.labelGroups[0].positions) === '[1,2]');
  check('dups: no image groups', r.imageGroups.length === 0 && r.dupImages === 0);
}
{
  // images: same URL on canvases 0 and 2 (labels distinct)
  const r = findManifestDuplicates([mk(0, 'A', 'same'), mk(1, 'B', 'other'), mk(2, 'C', 'same')]);
  check('dups: image group found', r.imageGroups.length === 1 && r.dupImages === 2);
  check('dups: image positions 1-based', JSON.stringify(r.imageGroups[0].positions) === '[1,3]');
}
{
  // blank labels never collide; canvases with no image URL never collide
  const r = findManifestDuplicates([mk(0, '', null), mk(1, '', null), mk(2, '  ', null)]);
  check('dups: blank labels/images ignored', r.dupNames === 0 && r.dupImages === 0);
}
{
  // non-contiguous indices keep true canvas indices in `indices`
  const r = findManifestDuplicates([mk(4, 'X', 'a'), mk(9, 'X', 'b')]);
  check('dups: sparse indices preserved', JSON.stringify(r.labelGroups[0].indices) === '[4,9]'
    && JSON.stringify(r.labelGroups[0].positions) === '[5,10]');
}

// --- corpus invariant: filenames ≤ 255 bytes ---------------------------------

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__inputs', 'manifests');
let checked = 0;
let over = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let parsed;
  try {
    parsed = parseManifest(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  } catch { continue; }
  if (!parsed.manifest) continue;
  const { items } = mapManifest(parsed.manifest);
  for (const it of items) {
    checked++;
    if (bytes(it.iiif.targetFilename) > 255) {
      over++;
      console.error(`FAIL  corpus: >255B filename in ${f}: ${it.iiif.targetFilename}`);
    }
  }
}
check(`corpus: all ${checked} derived filenames ≤ 255 bytes`, over === 0);

// -----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
