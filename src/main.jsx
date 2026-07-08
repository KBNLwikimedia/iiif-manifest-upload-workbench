// Entry point — wires React, the design's window-globals, OAuth, and mounts the app.
//
// The design files (data.js, vocabulary.js, *.jsx) cross-reference each other
// through `window.X = X` and `window.X` reads, so we (a) expose React on the
// global scope before any of them load, and (b) side-effect-import them in
// dependency order. Composite components (table, detail, app) are imported
// last so their leaf dependencies (icons, thumb, columns-modal) are available.

import React from 'react';
import ReactDOM from 'react-dom/client';

globalThis.React = React;
globalThis.ReactDOM = ReactDOM;

import './codex-tokens.css';
import './app.css';

import './data.js';
import './vocabulary.js';
import './licenses.js';
import './captions.js';
import './icons.jsx';
import './thumb.jsx';
import './columns-modal.jsx';
import './table.jsx';
import './detail.jsx';
import { App, TWEAK_DEFAULTS } from './app.jsx';

import { DEMO_MODE } from './config.js';
import {
  handleCallback,
  isAuthenticated,
  fetchUserProfile,
  login,
  logout,
} from './api/oauth.js';
import { fetchStashedFiles } from './api/commons.js';
import { fetchHistoryDetailed } from './api/history.js';
import {
  loadStores,
  mergeDraftsOntoItems,
  getAllPrefs,
  flushAll,
  pruneHiddenFilekeys,
  migrateLegacyHiddenFilekeys,
  getCachedHistory,
  setCachedHistory,
  shouldAutoRefreshHistory,
} from './api/user-store.js';
import { installLiveAutocomplete, seedFromHistory } from './api/autocomplete.js';
import ErrorReportModal from './ui/error-report-modal.jsx';
import FeedbackButton from './ui/feedback-button.jsx';

// Once the design's vocabulary.js has set up window.KNOWN_*, install our
// bridge so cell editors get live wiki results in addition to the mock
// vocab — without us having to touch the ~2600-line table.jsx editors.
installLiveAutocomplete();

const Icon = window.Icon; // exported by icons.jsx via window

// ------------------------------------------------------------------
// <BootErrorPanel> — shared error-recovery surface for the two hard-error
// paths (Bootstrap failed, ErrorBoundary caught a render error).
//
// Renders the original message + Reload (+ optional Log out) buttons, plus
// a "Report this error" button that opens <ErrorReportModal/> so the user
// can submit a pre-filled report to Phabricator or User talk:Daanvr.
//
// Accepts `error` as either an Error-like object (has .message / .stack) or
// a plain string. Internally we wrap strings into a stack-less shape so the
// modal renders consistently.
// ------------------------------------------------------------------
function BootErrorPanel({ title, error, monospaceMessage, onLogout }) {
  const [showReport, setShowReport] = React.useState(false);
  const normalized = typeof error === 'string'
    ? { message: error, stack: '' }
    : { message: error?.message || String(error), stack: error?.stack || '' };
  return (
    <div className="boot-error">
      <h2>{title}</h2>
      <p style={monospaceMessage ? { fontFamily: 'var(--font-family-monospace)', fontSize: '0.85em' } : undefined}>
        {normalized.message}
      </p>
      <div className="boot-error__actions">
        <button className="btn btn--progressive" onClick={() => location.reload()}>Reload</button>
        <button className="btn" onClick={() => setShowReport(true)}>
          <Icon name="warn" size={14} /> Report this error
        </button>
        {onLogout && <button className="btn btn--quiet" onClick={onLogout}>Log out</button>}
      </div>
      {showReport && (
        <ErrorReportModal error={normalized} onClose={() => setShowReport(false)} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// <Login> — shown when not authenticated and DEMO_MODE is off.
// ------------------------------------------------------------------
function Login() {
  return (
    <div className="login-screen">
      <div className="login-screen__card">
        <div className="login-screen__brand">
          <img className="topbar__logo" src="/app-logo.png" alt="" width="28" height="28" />
          <span className="login-screen__title">IIIF Manifest Upload Workbench</span>
          <span className="chip chip--info" style={{ marginLeft: 'var(--spacing-50)' }}>Beta</span>
        </div>
        <p className="login-screen__lede">
          Turn IIIF manifests (starting with the KB's medieval manuscripts)
          into Wikimedia Commons uploads — parse the metadata, derive full-res
          images, prefill wikitext + structured data, review, and publish.
        </p>
        <button
          className="btn btn--progressive btn--large"
          onClick={() => login()}
        >
          <Icon name="user" size={16} /> Log in with Wikimedia
        </button>
        <p className="login-screen__hint">
          You'll be redirected to meta.wikimedia.org and back.
        </p>
        <p className="login-screen__hint">
          Beta — found a bug? File it on{' '}
          <a
            href="https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          . Source at{' '}
          <a
            href="https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench"
            target="_blank"
            rel="noopener noreferrer"
          >
            KBNLwikimedia/iiif-manifest-upload-workbench
          </a>
          .
        </p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// <Bootstrap> — fetches the user profile + initial items, then renders <App>.
// Stash and history are loaded in parallel; either one can fail
// independently. Failures are surfaced to App as `loadErrors` so the section
// can render an inline error chip while the other section still works.
// ------------------------------------------------------------------
function Bootstrap({ tweaks, setTweak, onLogout }) {
  const [user, setUser] = React.useState(null);
  const [items, setItems] = React.useState(null);
  const [prefs, setPrefs] = React.useState(null);
  const [loadErrors, setLoadErrors] = React.useState({ stash: null, history: null });
  const [bootError, setBootError] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. Profile (blocks the rest — we need the username for everything else).
        let profile;
        if (DEMO_MODE) {
          profile = window.SAMPLE_USER;
        } else {
          profile = await fetchUserProfile();
          if (!profile) throw new Error('Could not load your Wikimedia profile.');
        }
        if (cancelled) return;
        setUser(profile);

        // 2. User-store + stash in parallel. History comes from the cache first.
        const [storesRes, stashRes] = await Promise.allSettled([
          loadStores(profile.username),
          fetchStashedFiles(),
        ]);
        if (cancelled) return;

        const stashRaw = stashRes.status === 'fulfilled' ? stashRes.value : [];
        if (storesRes.status === 'rejected') {
          console.warn('User-store load failed (continuing with empty drafts):', storesRes.reason);
        }

        // 3. Pull cached history from the user-store (fast — no network).
        const cached = getCachedHistory();
        let histItems = cached.items;
        setLoadErrors({
          stash: stashRes.status === 'rejected' ? String(stashRes.reason?.message || stashRes.reason) : null,
          history: null, // cache load never throws; background refresh failures stay in console
        });

        // 4. Merge drafts onto stash, migrate + prune hidden state, seed autocomplete.
        // For each current stash row whose sha1 we know, migrate any legacy
        // filekey-based hide entry to the canonical sha1 list. Then prune any
        // legacy filekey hides that point at no-longer-present stash rows.
        // hiddenSha1s is intentionally not pruned (soft-delete is content-
        // permanent — a re-upload of the same bytes inherits the deletion).
        const stashFilekeyToSha1 = new Map(
          stashRaw.map((i) => [i.filekey, i.sha1]).filter(([k, s]) => k && s),
        );
        const migrated = migrateLegacyHiddenFilekeys(stashFilekeyToSha1);
        if (migrated > 0) console.info(`[hidden] migrated ${migrated} legacy filekey hide(s) to sha1`);
        pruneHiddenFilekeys(stashRaw.map((i) => i.filekey).filter(Boolean));
        seedFromHistory(histItems);
        const stash = mergeDraftsOntoItems(stashRaw);
        setPrefs(getAllPrefs());
        setItems([...stash, ...histItems]);

        // 5. Background refresh if the cache is stale (or empty). One call,
        // bounded — the rich items window is the only thing we cache. Older
        // re-uploads are caught by the per-stash findCommonsFileBySha1 effect
        // in app.jsx, not by a paginated index here.
        if (shouldAutoRefreshHistory()) {
          (async () => {
            try {
              const { items: fresh } = await fetchHistoryDetailed(profile.username, { limit: 50 });
              if (cancelled || !fresh) return;
              setCachedHistory(fresh);
              seedFromHistory(fresh);
              setItems((prev) => {
                const stashOnly = prev.filter((i) => i.status?.startsWith('stash'));
                return [...stashOnly, ...fresh];
              });
            } catch (e) {
              console.warn('Background history refresh failed:', e.message);
            }
          })();
        }
      } catch (e) {
        // Preserve the full Error (with stack) so the report modal can
        // surface it. Defaults to a stack-less wrapper when the throw site
        // gave us a plain string.
        if (!cancelled) {
          setBootError(e instanceof Error ? e : new Error(String(e)));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Flush any pending wiki saves on tab close.
  React.useEffect(() => {
    const onBeforeUnload = () => { flushAll(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Expose a tiny diagnostics snapshot for the always-visible Feedback button
  // to read when its modal opens. Lives on `window` (not React context) so
  // it crosses the <ErrorBoundary>/<Root> boundary — <FeedbackButton/> is
  // mounted at <Root> outside the boundary, so any prop-based wiring would
  // disappear after a render crash. The function is a getter, so the
  // snapshot reflects the *current* state at modal-open time, not at the
  // last render of <Bootstrap>.
  React.useEffect(() => {
    window.uwbDiagnostics = () => ({
      username: user?.username || '',
      stashCount: items
        ? items.filter((i) => i?.status?.startsWith?.('stash')).length
        : undefined,
      historyCount: items
        ? items.filter((i) => !i?.status?.startsWith?.('stash')).length
        : undefined,
      loadErrors: {
        stash: loadErrors?.stash || null,
        history: loadErrors?.history || null,
      },
    });
    return () => {
      // Leave the global cleared rather than stale if Bootstrap unmounts.
      if (window.uwbDiagnostics) delete window.uwbDiagnostics;
    };
  }, [user, items, loadErrors]);

  if (bootError) {
    return (
      <BootErrorPanel
        title="Couldn't start"
        error={bootError}
        onLogout={onLogout}
      />
    );
  }

  if (!user || items === null) {
    return (
      <div className="boot-loading">
        <div className="spinner" aria-label="Loading" />
        <span>Loading your workbench…</span>
      </div>
    );
  }

  return (
    <App
      tweaks={tweaks}
      setTweak={setTweak}
      user={user}
      onLogout={onLogout}
      initialItems={items}
      initialPrefs={prefs}
      loadErrors={loadErrors}
    />
  );
}

// ------------------------------------------------------------------
// <AuthGate> — decides between login screen and bootstrap.
// In DEMO_MODE the gate is always open.
// ------------------------------------------------------------------
function AuthGate({ tweaks, setTweak }) {
  const [authed, setAuthed] = React.useState(() => DEMO_MODE || isAuthenticated());

  if (!authed) return <Login />;
  return <Bootstrap tweaks={tweaks} setTweak={setTweak} onLogout={DEMO_MODE ? null : () => { logout(); setAuthed(false); }} />;
}

// ------------------------------------------------------------------
// <Root> — owns tweaks state (dark mode, density, card size, etc.)
// The design's TweaksPanel UI is stripped; the state survives.
// ------------------------------------------------------------------
// Catches uncaught render errors so a single broken component doesn't blank
// the whole app. We log to console + show a recovery panel; the user can
// reload (their drafts and prefs are persisted in the user-store).
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('Workbench render error:', error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <BootErrorPanel
        title="Something broke"
        error={this.state.error}
        monospaceMessage
      />
    );
  }
}

function Root() {
  const [tweaks, setTweaks] = React.useState(TWEAK_DEFAULTS);
  const setTweak = (k, v) => setTweaks((prev) => ({ ...prev, [k]: v }));
  // FeedbackButton sits outside ErrorBoundary so it remains visible (and
  // its own modal still works) even if a render error inside the app
  // tree triggers <BootErrorPanel>. The boot-error panel already has its
  // own "Report this error" button (T426408), so the user has two
  // overlapping channels in the error case — that's intentional, both
  // are useful.
  return (
    <>
      <ErrorBoundary>
        <AuthGate tweaks={tweaks} setTweak={setTweak} />
      </ErrorBoundary>
      <FeedbackButton />
    </>
  );
}

// ------------------------------------------------------------------
// Mount.
// First, handle any pending OAuth callback so an authed session lands
// here cleanly; only then mount React (so AuthGate sees the right state).
// ------------------------------------------------------------------
async function start() {
  if (!DEMO_MODE) {
    try {
      await handleCallback();
    } catch (e) {
      console.error('OAuth callback failed:', e);
    }
  }
  ReactDOM.createRoot(document.getElementById('root')).render(<Root />);
}

start();
