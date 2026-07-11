// Upload Workbench — Configuration
//
// Secrets live in `.env.local` (gitignored). Copy `.env.example` to `.env.local`
// and fill in your values. Vite exposes any var prefixed with `VITE_` to the
// browser via `import.meta.env`.

export const CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID || '';
export const CLIENT_SECRET = import.meta.env.VITE_OAUTH_CLIENT_SECRET || '';

// Owner-only access token — bypasses the OAuth redirect flow for testing.
// Leave VITE_OWNER_ACCESS_TOKEN unset (or empty) to use the normal PKCE flow.
export const OWNER_ACCESS_TOKEN = import.meta.env.VITE_OWNER_ACCESS_TOKEN || '';

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
export const OAUTH_AUTHORIZE_URL = 'https://meta.wikimedia.org/w/rest.php/oauth2/authorize';
export const OAUTH_TOKEN_URL = 'https://meta.wikimedia.org/w/rest.php/oauth2/access_token';
export const OAUTH_PROFILE_URL = 'https://meta.wikimedia.org/w/rest.php/oauth2/resource/profile';

export const REDIRECT_URI = window.location.origin + '/';

export const STASH_EXPIRY_HOURS = 48;
export const APP_USER_AGENT = 'IIIFManifestUploadWorkbench/0.41 (https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench)';

// Edit-summary attribution suffix (T425978).
//
// Every write to Commons (action=upload publish, action=edit on File:/User:
// pages, action=wbeditentity for SDC) appends this so a human reading the page
// history can see which tool + exact version wrote the edit. The version is
// the full SemVer from package.json (`__APP_VERSION__` is a Vite compile-time
// define, see vite.config.js) — not the truncated APP_USER_AGENT MAJOR.MINOR —
// so post-hoc debugging can pinpoint behavior precisely.
//
// The tool has an on-wiki homepage (Commons:IIIF Manifest Upload Workbench),
// so the edit-summary attribution links to it as a normal wikilink — which
// DOES render clickable in Commons page histories (unlike an external URL,
// which shows as plain text). This is the on-wiki equivalent of upstream's
// `toolforge:` interwiki.
//
// Helper, not a constant, so the build-time `__APP_VERSION__` resolves at the
// call site. Returns the suffix already prefixed with a space so callers can
// just concatenate to whatever summary they already had (or use it standalone
// for writes that have no per-call summary).
export function attributionSuffix() {
  return ` with [[Commons:IIIF Manifest Upload Workbench|IIIF Manifest Upload Workbench]] v${__APP_VERSION__}`;
}

// When no client_id is configured, the app runs against SAMPLE_UPLOADS in data.js
// instead of hitting the live Commons API. Set VITE_OAUTH_CLIENT_ID to switch.
export const DEMO_MODE = !CLIENT_ID;
