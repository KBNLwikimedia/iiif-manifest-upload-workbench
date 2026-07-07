// Corpus test for src/api/iiif-map.js — maps every manifest in
// __inputs/manifests/ and checks the invariants that matter for Commons:
//
//   - every usable canvas maps to exactly one item
//   - target filenames are unique within a manuscript
//   - no forbidden title characters ( # < > [ ] | { } / \ : ) survive
//   - filename base stays under the Commons length ceiling
//   - license / category / author / source are always present
//
// Run:  node scripts/test-iiif-map.mjs          # summary + failures
//       node scripts/test-iiif-map.mjs -v       # + 3 sample filenames each
//       node scripts/test-iiif-map.mjs "KW 76"  # only matching files

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../src/api/iiif.js';
import { mapManifest } from '../src/api/iiif-map.js';

const verbose = process.argv.includes('-v');
const filter = process.argv.slice(2).find((a) => a !== '-v') || '';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__inputs', 'manifests');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f.includes(filter));

const FORBIDDEN = /[#<>[\]|{}/\\:]/;
let failures = 0;

const fail = (file, msg) => {
  failures += 1;
  console.log(`  FAIL  ${file}: ${msg}`);
};

for (const f of files) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const parsed = parseManifest(json, { sourceUrl: `https://iiif.bibliotheken.nl/test/${f}` });
  if (!parsed.ok) {
    console.log(`skip   ${f.padEnd(52)} (parser rejected — expected for the zero-canvas manifest)`);
    continue;
  }

  const { manuscript, items } = mapManifest(parsed.manifest, { wikidataQid: 'Q00000' });

  console.log(`ok     ${f.padEnd(52)} title="${manuscript.title}"  sig="${manuscript.signature}"  cat="${manuscript.categoryName}"  date="${manuscript.dateWikitext}"`);

  if (items.length !== parsed.manifest.canvases.length) {
    fail(f, `mapped ${items.length} items for ${parsed.manifest.canvases.length} canvases`);
  }

  const names = new Set();
  for (const it of items) {
    const name = it.iiif.targetFilename;
    if (names.has(name)) fail(f, `duplicate filename: ${name}`);
    names.add(name);
    if (FORBIDDEN.test(it.title)) fail(f, `forbidden char in title: ${it.title}`);
    if (it.title.length > 235) fail(f, `title too long (${it.title.length}): ${it.title.slice(0, 60)}…`);
    if (!it.license) fail(f, 'missing license');
    if (!it.categories?.length) fail(f, 'missing category');
    if (!it.author) fail(f, 'missing author');
    if (!it.source) fail(f, 'missing source');
    if (!it.descriptions?.nl) fail(f, 'missing nl caption');
    if (!it.iiif.fullResUrl) fail(f, 'missing fullResUrl');
    if (it.depicts?.[0]?.qid !== 'Q00000') fail(f, 'depicts did not pick up the Wikidata Q-id');
  }

  if (verbose) {
    const picks = [0, 1, items.length - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
    for (const i of picks) {
      console.log(`         File:${items[i].iiif.targetFilename}`);
    }
    console.log(`         caption[nl]: ${items[0].descriptions.nl.slice(0, 110)}`);
    console.log(`         author: ${items[0].author}   medium: ${manuscript.artwork.medium}   dims: ${manuscript.artwork.dimensions}`);
  }
}

console.log(`\n${files.length} manifests mapped, ${failures} failure(s).`);
process.exitCode = failures ? 1 : 0;
