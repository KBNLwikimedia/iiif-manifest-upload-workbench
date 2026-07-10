// CC0 acknowledgment modal — informs the user that the workbench persists
// drafts/preferences to a public Commons user-subpage and gets explicit
// consent that this metadata is treated as CC0 by intent of the maintainer.
//
// Trigger logic (decided by App, not this component):
//   - cc0Acknowledgment is null/missing            → show on every fresh load
//   - cc0Acknowledgment.suppressFurther === true   → never show
//   - cc0Acknowledgment exists but suppressFurther
//     is false                                     → show on every fresh load
//   - DEMO_MODE                                    → never show (no wiki writes)
//
// Buttons:
//   - "I agree — remind me next session"  → records ack with suppressFurther: false
//   - "I agree — don't remind me again"   → records ack with suppressFurther: true
//
// Esc / backdrop click is treated as NO acknowledgment (the modal will
// reappear on the next session). Explicit choice is required to suppress.
//
// Persistence: a single key on Preferences.json:
//   cc0Acknowledgment: { acknowledgedAt: <ISO>, suppressFurther: <bool>, version: 1 }
// The `version` field exists so a future copy/scope change can re-prompt by
// bumping the version number — see App's render guard.

import React from 'react';

const Icon = window.Icon;

// Public-facing version of the acknowledgment text. Bump this if the modal's
// scope or claims change in a way that warrants re-asking previously-suppressed
// users. App's render guard checks `version === CC0_ACK_VERSION`.
// v2 (2026-07-10): rebranded to IIIF Manifest Upload Workbench + corrected the
// user-subpage path (the store moved to /IIIFManifestUploadWorkbench/). Bumping
// re-prompts users who suppressed the v1 (upstream-branded) notice once.
export const CC0_ACK_VERSION = 2;

// Helper used by App so the version number lives in one place.
export function shouldShowCc0Modal(ack) {
  if (!ack) return true;
  if (ack.version !== CC0_ACK_VERSION) return true; // scope/copy changed
  return !ack.suppressFurther;
}

export function Cc0Modal({ username, onAcknowledge, onDismiss }) {
  // Lock body scroll + Esc-to-dismiss while open. Esc is "no ack" — the modal
  // will come back on next session.
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onDismiss]);

  // The user's own subpage tree — opens in a new tab so they can verify what's
  // stored without losing their workbench session.
  const userPageUrl = username
    ? `https://commons.wikimedia.org/wiki/User:${encodeURIComponent(username)}/IIIFManifestUploadWorkbench`
    : 'https://commons.wikimedia.org/wiki/User:You/IIIFManifestUploadWorkbench';

  return (
    <div className="modal-backdrop" onClick={onDismiss}>
      <div
        className="modal cc0-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc0-modal-title"
      >
        <header className="modal__head">
          <div>
            <h2 className="modal__title" id="cc0-modal-title">
              Heads up: your workbench data is public
            </h2>
            <p className="modal__sub">
              Quick one-time notice about how your drafts and preferences are stored.
            </p>
          </div>
          <button
            className="btn btn--quiet btn--icon-only"
            onClick={onDismiss}
            aria-label="Close — you'll see this again next session"
            title="Close — you'll see this again next session"
          >
            {Icon ? <Icon name="close" size={16} /> : '×'}
          </button>
        </header>

        <div className="modal__body cc0-modal__body">
          <p>
            IIIF Manifest Upload Workbench saves your drafts, column preferences, hidden-file
            list, and related state to two pages in your own Wikimedia Commons user namespace:
          </p>
          <ul className="cc0-modal__pages">
            <li><code>User:{username || 'You'}/IIIFManifestUploadWorkbench/Preferences.json</code></li>
            <li><code>User:{username || 'You'}/IIIFManifestUploadWorkbench/Metadata.json</code></li>
          </ul>
          <p>
            These pages are <strong>public</strong>, just like every page on Commons — anyone
            can read, copy, mirror, or archive them. By using IIIF Manifest Upload Workbench,
            you agree that the contents of these workbench pages are dedicated to the public
            domain under{' '}
            <a
              href="https://commons.wikimedia.org/wiki/Commons:CC0"
              target="_blank"
              rel="noopener noreferrer"
            >
              Creative Commons CC0
            </a>
            .
          </p>
          <p className="cc0-modal__small">
            Note: this only covers the workbench's own configuration and draft data. The
            files you publish to Commons keep whatever license you pick for them on the
            publish form (CC BY-SA 4.0, CC BY 4.0, CC0, public-domain claims, etc.).
          </p>
          <p className="cc0-modal__small">
            <a href={userPageUrl} target="_blank" rel="noopener noreferrer">
              {Icon && <Icon name="external" size={12} />} View your workbench pages on Commons
            </a>
          </p>
        </div>

        <footer className="modal__foot cc0-modal__foot">
          <span className="modal__hint">
            Esc closes without recording your choice — you'll see this again next session.
          </span>
          <div className="cc0-modal__buttons">
            <button
              type="button"
              className="btn"
              onClick={() => onAcknowledge({ suppressFurther: false })}
            >
              I agree — remind me next session
            </button>
            <button
              type="button"
              className="btn btn--progressive"
              onClick={() => onAcknowledge({ suppressFurther: true })}
            >
              I agree — don't remind me again
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default Cc0Modal;
