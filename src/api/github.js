// GitHub read-only API helpers for the fork.
//
// Used by the topbar version chip to list the fork's own releases (parsed
// from CHANGELOG.md on the default branch) and any open pull requests.
// Replaces the old GitLab/Toolforge plumbing (OI-10) — this fork lives on
// GitHub and, for now, deploys only to local dev.
//
// Both endpoints are unauthenticated and CORS-enabled:
//   - raw.githubusercontent.com sends Access-Control-Allow-Origin: *
//   - api.github.com sends it too (unauthenticated, 60 req/h per IP — fine
//     behind a user click + the 5-min apiCache).

import { apiCache } from '../utils.js';

const OWNER = 'KBNLwikimedia';
const REPO = 'iiif-manifest-upload-workbench';
const BRANCH = 'main';

export const GITHUB_REPO_URL = `https://github.com/${OWNER}/${REPO}`;

// Open pull requests on the fork. Shape used by the chip: { number, title,
// html_url, draft }.
export async function fetchOpenPullRequests() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/pulls?state=open&per_page=50&sort=updated&direction=desc`;
  const cached = apiCache.get(url);
  if (cached) return cached;
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub PR fetch failed: HTTP ${r.status}`);
  const data = await r.json();
  apiCache.set(url, data);
  return data;
}

// Raw CHANGELOG.md from the default branch, for the release list.
export async function fetchChangelogRaw() {
  const url = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/CHANGELOG.md`;
  const cached = apiCache.get(url);
  if (cached) return cached;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Changelog fetch failed: HTTP ${r.status}`);
  const text = await r.text();
  apiCache.set(url, text);
  return text;
}

// GitHub release/tag page for a version string ("0.40.0" → …/releases/tag/v0.40.0).
export function releaseUrl(version) {
  return `${GITHUB_REPO_URL}/releases/tag/v${version}`;
}
