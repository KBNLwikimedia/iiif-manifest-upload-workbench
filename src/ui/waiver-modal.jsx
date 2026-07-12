// 48-hour waiver modal — shown after the CC0 notice. The user must actively
// acknowledge (or decline) that imported images sit in a temporary upload area
// on Commons that is cleared after 48 hours, so the import→publish flow has to
// be finished within that window.
//
// Two DISTINCT outcomes (both proceed into the app — this is a warning, not a
// hard gate):
//   - Accept  → iiifWaiver.accepted = true  → never shown again.
//   - Decline → iiifWaiver.accepted = false → the user proceeds "at their own
//               risk"; the modal reappears next session (nudging them to
//               accept) UNLESS they also ticked "Don't show this again".
//
// The "Don't show this again" checkbox (unchecked by default) sets
// suppressFurther, which only affects the decline path (accepting already
// suppresses future shows).
//
// Persistence: one key on Preferences.json:
//   iiifWaiver: { accepted: <bool>, acknowledgedAt: <ISO>, suppressFurther: <bool>, version: 1 }

import React from 'react';

// Bump to re-prompt everyone after a material change to the 48-hour policy/copy.
export const WAIVER_VERSION = 1;

// Show unless: accepted (ever), or declined-with-suppress, or version matches an
// accepted record. A version mismatch always re-prompts.
export function shouldShowWaiverModal(waiver) {
  if (!waiver) return true;
  if (waiver.version !== WAIVER_VERSION) return true;
  if (waiver.accepted) return false;      // accepted → done forever
  return !waiver.suppressFurther;         // declined → again unless suppressed
}

export function WaiverModal({ onAccept, onDecline }) {
  const [suppress, setSuppress] = React.useState(false);

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
            ⚠️ If you do not accept this, you can still use the tool — but any imported images
            lost after 48 hours are then <strong>your own responsibility</strong>.
          </p>
          <label className="waiver-modal__dontshow">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
            />
            Don&apos;t show this again
          </label>
        </div>

        <footer className="modal__foot waiver-modal__foot">
          <div className="waiver-modal__buttons">
            <button
              type="button"
              className="btn btn--progressive"
              onClick={() => onAccept({ suppressFurther: suppress })}
            >
              I understand — I&apos;ll upload within 48&nbsp;hours
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => onDecline({ suppressFurther: suppress })}
            >
              I don&apos;t accept — proceed at my own risk
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default WaiverModal;
