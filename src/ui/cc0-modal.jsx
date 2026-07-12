// CC0 acknowledgment modal — informs the user that the workbench persists
// drafts/preferences to a public Commons user-subpage and gets explicit
// consent that this metadata is treated as CC0 by intent of the maintainer.
//
// Step 1 of the coupled CC0 → waiver onboarding. The user must agree every
// fresh session: there is no "don't remind me again" option and nothing is
// persisted (maintainer decision 2026-07-12). DEMO_MODE skips it (no wiki
// writes). A single "I agree" button proceeds to step 2 (the waiver).
//
// Esc / backdrop click is treated as NO acknowledgment (App re-chains to the
// waiver either way, and the modal shows again next session regardless).

import React from 'react';

const Icon = window.Icon;

// Always show (once per session): the CC0 consent is no longer persisted, so
// the user re-agrees each new session. DEMO_MODE is filtered out by App.
export function shouldShowCc0Modal() {
  return true;
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
  const u = username || 'You';
  const pageUrl = (file) =>
    `https://commons.wikimedia.org/wiki/User:${encodeURIComponent(u)}/IIIFManifestUploadWorkbench/${file}`;

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
              <span className="modal__stepbadge">Step 1 of 2</span>
              Quick notice about how your drafts and preferences are stored.
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
            list, recently loaded manifests, and related state to two pages in your own
            Wikimedia Commons user namespace:
          </p>
          <ul className="cc0-modal__pages">
            <li>
              <a href={pageUrl('Preferences.json')} target="_blank" rel="noopener noreferrer">
                <code>User:{u}/IIIFManifestUploadWorkbench/Preferences.json</code>
              </a>
            </li>
            <li>
              <a href={pageUrl('Metadata.json')} target="_blank" rel="noopener noreferrer">
                <code>User:{u}/IIIFManifestUploadWorkbench/Metadata.json</code>
              </a>
            </li>
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
        </div>

        <footer className="modal__foot cc0-modal__foot">
          <span className="modal__hint">
            You'll be asked to agree again each session.
          </span>
          <div className="cc0-modal__buttons">
            <button
              type="button"
              className="btn btn--progressive"
              onClick={() => onAcknowledge()}
            >
              I agree — continue
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default Cc0Modal;
