// 48-hour waiver modal — step 2 of the CC0 → waiver onboarding, shown after the
// CC0 notice. The user acknowledges that imported images sit in a temporary
// upload area on Commons that is cleared after 48 hours, so the import→publish
// flow has to be finished within that window.
//
// Like the CC0 step, this is asked every fresh session: a single "OK, I
// understand" button, no "don't show again" option, nothing persisted
// (maintainer decision 2026-07-12).

import React from 'react';

// Always show (once per session): the acknowledgment is not persisted, so the
// user re-agrees each new session. DEMO_MODE is filtered out by App.
export function shouldShowWaiverModal() {
  return true;
}

export function WaiverModal({ onAcknowledge, onBack }) {
  // Lock body scroll while open. Esc does NOT close — this is a required
  // acknowledgment; the user must pick a button.
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <div className="modal-backdrop">
      <div
        className="modal waiver-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="waiver-modal-title"
      >
        <header className="modal__head">
          <div>
            <h2 className="modal__title" id="waiver-modal-title">
              Finish your upload within 48 hours
            </h2>
            <p className="modal__sub">
              <span className="modal__stepbadge">Step 2 of 2</span>
              One thing to acknowledge about how imported images are staged on Commons.
            </p>
          </div>
        </header>

        <div className="modal__body waiver-modal__body">
          <p>
            When you import a manifest, its images are first placed in a{' '}
            <strong>temporary upload area</strong> on Wikimedia Commons and then published
            from there to their final file pages.
          </p>
          <p>
            That temporary area is automatically <strong>cleared 48 hours after upload</strong>.
            Any imported images you have not finished publishing within that window are removed
            and would need to be imported again.
          </p>
          <ul className="waiver-modal__points">
            <li><strong>Plan to review and publish within 48 hours</strong> of importing.</li>
            <li>Re-importing is cheap and safe — the tool detects images already on Commons (by SHA-1), so nothing is uploaded twice.</li>
          </ul>
          <p className="waiver-modal__risk">
            ⚠️ Any imported images you have not published within 48 hours are removed and are
            then <strong>your own responsibility</strong> to re-import.
          </p>
        </div>

        <footer className="modal__foot waiver-modal__foot">
          <div className="waiver-modal__buttons">
            {onBack && (
              <button type="button" className="btn" onClick={onBack}>
                ‹ Back
              </button>
            )}
            <button
              type="button"
              className="btn btn--progressive"
              onClick={() => onAcknowledge()}
            >
              OK, I understand
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default WaiverModal;
