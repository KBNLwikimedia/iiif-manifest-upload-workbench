// Feedback button — a quiet action in the topbar's right cluster (next to
// About), per Codex chrome conventions: no floating FAB, no second brand-blue
// element competing with the primary CTA (DESIGN.md "one accent per screen").
// Click opens <FeedbackModal/>. The modal reuses the same window.open plumbing
// as the error-report flow (T426408) — no new OAuth scopes.

import React from 'react';
import FeedbackModal from './feedback-modal.jsx';

const Icon = window.Icon;
const { useState } = React;

export default function FeedbackButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn btn--quiet topbar__feedback"
        onClick={() => setOpen(true)}
        title="Upload Workbench is in beta — your feedback is unusually valuable"
      >
        <Icon name="info" size={16} />
        <span className="topbar__feedback-label">Feedback</span>
        <span className="chip chip--info topbar__feedback-beta">Beta</span>
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
}
