// OI-26: error classification + retry-with-backoff for the IIIF import's
// MediaWiki write path. A 500-canvas import runs hundreds of sequential
// download → upload cycles over a multi-hour window; before this, one
// transient blip (network drop, HTTP 5xx, `ratelimited`, `maxlag` replag, or a
// rotated CSRF token) failed that item AND every item after it, with no
// recovery. This module is pure (zero imports) so Node can unit-test it.
//
// Errors built via apiError() carry structured fields the classifier reads:
//   { code, status, retryAfter (seconds), isNetwork }

export function apiError(message, { code = '', status = 0, retryAfter = 0, isNetwork = false } = {}) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  e.retryAfter = retryAfter;
  e.isNetwork = isNetwork;
  return e;
}

// Auth failures kill the whole batch — re-login is needed, retrying is futile
// and would surface as hundreds of identical per-item errors.
const AUTH_CODE = /^(mwoauth-invalid-authorization|assertuserfailed|assertbotfailed|notloggedin|badcredentials|permissiondenied|badaccess-groups)$/i;
// Transient failures are worth retrying with backoff.
const TRANSIENT_CODE = /^(ratelimited|maxlag|readonly|internal_api_error|internal_api_error_dberror|timeout|http)$/i;

// → 'badtoken' | 'auth' | 'transient' | 'fatal'
export function classifyError(err) {
  const code = String(err?.code || '');
  const status = Number(err?.status || 0);
  if (/^badtoken$/i.test(code)) return 'badtoken';
  if (AUTH_CODE.test(code) || status === 401) return 'auth';
  if (TRANSIENT_CODE.test(code) || err?.isNetwork || (status >= 500 && status < 600)) return 'transient';
  return 'fatal';
}

// Exponential backoff (1s, 2s, 4s… capped 30s) with ±25% jitter, but honour an
// explicit Retry-After (seconds) from the server when present (capped 60s).
export function backoffMs(attempt, retryAfterSec = 0) {
  if (retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 60000);
  const base = Math.min(1000 * 2 ** attempt, 30000);
  return base + Math.floor(base * 0.25 * Math.random());
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run fn(), retrying transient failures up to `retries` times with backoff.
// - A `badtoken` error awaits `onBadToken()` once (to refresh the CSRF token)
//   then retries immediately — token rotation over a multi-hour batch is
//   expected, not fatal.
// - `auth` and `fatal` errors (and transient after exhaustion) rethrow, tagged
//   with `err.kind` so the caller can decide to abort the batch vs the item.
// `onRetry(err, attemptNo, delayMs)` is a progress hook. Abort/signal handling
// is the caller's job (checked between items).
export async function withRetry(fn, { retries = 3, onRetry, onBadToken, sleep = defaultSleep } = {}) {
  let badTokenRetried = false;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'badtoken' && onBadToken && !badTokenRetried) {
        badTokenRetried = true;
        await onBadToken();
        continue; // retry immediately with the fresh token
      }
      if (kind === 'transient' && attempt < retries) {
        const ms = backoffMs(attempt, err?.retryAfter);
        onRetry?.(err, attempt + 1, ms);
        await sleep(ms);
        continue;
      }
      err.kind = kind;
      throw err;
    }
  }
}
