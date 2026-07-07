// Corpus test for src/api/iiif.js — runs parseManifest over every manifest
// in __inputs/manifests/ and prints a per-file validation summary.
//
// Not a unit-test framework (the repo has none); this is the manual
// verification harness the CLAUDE.md workflow calls for. Run with:
//
//   node scripts/test-iiif-parser.mjs           # summary table
//   node scripts/test-iiif-parser.mjs -v        # + every report entry
//   node scripts/test-iiif-parser.mjs "KW 76"   # only matching files
//
// Expected known defects in the corpus (should be REPORTED, not crash):
//   - KW 79 K 21 (Wapenboek Beyeren): zero canvases → error
//   - KW 130 E 1: no summary / no Inhoud → warnings
//   - several: >25 MP canvases → downscale info

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../src/api/iiif.js';

const verbose = process.argv.includes('-v');
const filter = process.argv.slice(2).find((a) => a !== '-v') || '';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__inputs', 'manifests');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f.includes(filter));

let okCount = 0;
let errCount = 0;

for (const f of files) {
  let result;
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    result = parseManifest(json, { sourceUrl: `file://${f}` });
  } catch (e) {
    console.log(`CRASH  ${f}: ${e.message}`);
    errCount += 1;
    continue;
  }

  const { ok, report, manifest } = result;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const e of report) counts[e.level] += 1;

  const status = ok ? 'ok   ' : 'ERROR';
  const canvases = manifest ? `${String(manifest.canvasCount).padStart(3)} canvases` : '  no manifest';
  const down = manifest?.downscaledCount ? ` (${manifest.downscaledCount} downscaled)` : '';
  const fieldCount = manifest ? Object.keys(manifest.fields).length : 0;
  console.log(
    `${status}  ${f.padEnd(52)} ${canvases}${down}  fields:${String(fieldCount).padStart(2)}  E:${counts.error} W:${counts.warning} I:${counts.info}`,
  );
  if (verbose) {
    for (const e of report) console.log(`         [${e.level}] ${e.code}: ${e.message}`);
  }

  if (ok) okCount += 1; else errCount += 1;
}

console.log(`\n${files.length} manifests: ${okCount} parse ok, ${errCount} rejected with errors.`);
// The corpus contains exactly one known-defective manifest (zero canvases).
// Anything beyond that deserves a look.
process.exitCode = errCount > 1 ? 1 : 0;
