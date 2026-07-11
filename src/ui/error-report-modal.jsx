// Error report modal — opens from the "Report this error" button on the
// boot-error / ErrorBoundary panels (see src/main.jsx).
//
// Captures the error context automatically, lets the user add a free-text
// comment, and submits via a pre-filled GitHub issue on the fork repo
// (label: `user feedback,bug` — same convention as the Feedback modal).
// The upstream Phabricator/User-talk routes were removed with the fork
// rebrand (OI-10).
//
// Submission does `window.open(...)` — no API calls, no new OAuth scopes,
// and the user reviews the body before clicking the button.

import React from 'react';

const Icon = window.Icon;
const { useState, useEffect, useMemo, useRef } = React;

const GITHUB_ISSUES_NEW_URL = 'https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench/issues/new';
// Labels only stick when the reporter has triage rights (OI-73) — harmless
// otherwise, GitHub silently drops them.
const REPORT_LABELS = 'user feedback,bug';

// Build the body text the user submits — GitHub-flavored markdown for the
// pre-filled issue body.
function buildReportBody({ comment, timestamp, version, deployTarget, errorMessage, errorStack, userAgent, url }) {
  const lines = [];
  lines.push('## What happened');
  lines.push('');
  lines.push(comment.trim() || '_(no comment provided)_');
  lines.push('');
  lines.push('## Error details');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| **Time** | ${timestamp} |`);
  lines.push(`| **Version** | v${version} (${deployTarget}) |`);
  lines.push(`| **URL** | \`${url}\` |`);
  lines.push(`| **User agent** | \`${userAgent}\` |`);
  lines.push('');
  lines.push('**Error message:**');
  lines.push('');
  lines.push('```');
  lines.push(errorMessage || '(no message)');
  lines.push('```');
  if (errorStack) {
    lines.push('');
    lines.push('**Stack trace:**');
    lines.push('');
    lines.push('```');
    lines.push(errorStack);
    lines.push('```');
  }
  lines.push('');
  lines.push('_Reported from the IIIF Manifest Upload Workbench error panel._');
  return lines.join('\n');
}

function buildGithubUrl({ title, body }) {
  const params = new URLSearchParams({
    title,
    body,
    labels: REPORT_LABELS,
  });
  return `${GITHUB_ISSUES_NEW_URL}?${params.toString()}`;
}

export default function ErrorReportModal({ error, onClose }) {
  const [comment, setComment] = useState('');
  const [showStack, setShowStack] = useState(false);
  const [copyState, setCopyState] = useState('idle'); // 'idle' | 'copied' | 'failed'
  const bodyRef = useRef(null);

  // Snapshot the captured context once, when the modal mounts. The timestamp
  // is the moment the user opened the report dialog (close enough to "when
  // the error happened" since this modal is opened from the error panel).
  const ctx = useMemo(() => ({
    timestamp: new Date().toISOString(),
    version: __APP_VERSION__,
    deployTarget: __DEPLOY_TARGET__,
    errorMessage: error?.message || String(error || '(unknown)'),
    errorStack: error?.stack || '',
    userAgent: navigator.userAgent,
    url: window.location.href,
  }), [error]);

  // The user can edit the body before submitting — they may want to redact a
  // filename from the URL, strip the stack trace, etc. We keep the body in a
  // single textarea (no separate read-only block) so editing is obvious.
  const [body, setBody] = useState(() => buildReportBody({ ...ctx, comment: '' }));

  // Re-derive the body when the comment changes, *unless* the user has
  // hand-edited the body. Once they touch the textarea, freeze.
  const [bodyDirty, setBodyDirty] = useState(false);
  useEffect(() => {
    if (bodyDirty) return;
    setBody(buildReportBody({ ...ctx, comment }));
  }, [comment, bodyDirty, ctx]);

  // Title generated from the error message (truncated). User can't edit
  // the title directly — it's derived from the error and stays in sync
  // with the body so a re-opened report from the same error gets the same
  // title. Keep under ~90 chars (Phab task titles are unlimited but long
  // titles get truncated in lists).
  const title = useMemo(() => {
    const msg = (ctx.errorMessage || 'Unknown error').replace(/\s+/g, ' ').trim();
    const truncated = msg.length > 80 ? msg.slice(0, 77) + '…' : msg;
    return `Error in IIIF Manifest Upload Workbench v${ctx.version}: ${truncated}`;
  }, [ctx]);

  // Body scroll locked while open. Esc/backdrop deliberately do NOT dismiss —
  // the modal holds a half-typed comment / hand-edited report (same policy as
  // the Feedback and Columns modals); the × and Cancel are the ways out.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const githubUrl = useMemo(() => buildGithubUrl({ title, body }), [title, body]);

  const copyToClipboard = async () => {
    try {
      // Prefer the async clipboard API; fall back to a hidden textarea +
      // execCommand for older browsers / non-secure contexts.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(body);
      } else if (bodyRef.current) {
        bodyRef.current.select();
        document.execCommand('copy');
      } else {
        throw new Error('No clipboard API available');
      }
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (e) {
      console.warn('Clipboard copy failed:', e);
      setCopyState('failed');
      setTimeout(() => setCopyState('idle'), 3000);
    }
  };

  const openGithub = () => {
    window.open(githubUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="modal-backdrop">
      <div
        className="modal error-report-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="error-report-title"
      >
        <header className="modal__head">
          <div>
            <h2 className="modal__title" id="error-report-title">
              <Icon name="warn" size={16} /> Report this error
            </h2>
            <p className="modal__sub">
              The details below will be pre-filled into your chosen submission. Review and edit before submitting — you're the one signing it.
            </p>
          </div>
          <button className="btn btn--quiet btn--icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="modal__body error-report-modal__body">
          <section className="error-report-modal__section">
            <label htmlFor="error-report-comment" className="error-report-modal__label">
              What were you doing when this happened? <span className="error-report-modal__optional">(optional)</span>
            </label>
            <textarea
              id="error-report-comment"
              className="error-report-modal__comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="e.g. I clicked Publish on a row with three files selected and the page went blank."
              rows={3}
            />
          </section>

          <section className="error-report-modal__section">
            <div className="error-report-modal__label-row">
              <span className="error-report-modal__label">Report preview</span>
              {bodyDirty && (
                <button
                  type="button"
                  className="btn btn--small btn--quiet"
                  onClick={() => { setBodyDirty(false); setBody(buildReportBody({ ...ctx, comment })); }}
                  title="Discard hand-edits and regenerate"
                >
                  Reset
                </button>
              )}
            </div>
            <textarea
              ref={bodyRef}
              className="error-report-modal__body-text"
              value={body}
              onChange={(e) => { setBody(e.target.value); setBodyDirty(true); }}
              spellCheck={false}
              rows={Math.min(20, Math.max(10, body.split('\n').length + 1))}
            />
            <p className="modal__hint">
              You can edit this directly — useful to redact filenames or trim the stack trace before submitting.
            </p>
          </section>

          {ctx.errorStack && (
            <section className="error-report-modal__section">
              <button
                type="button"
                className="btn btn--small btn--quiet"
                onClick={() => setShowStack(!showStack)}
              >
                <Icon name={showStack ? 'chevron-down' : 'chevron-right'} size={12} />
                {showStack ? 'Hide raw stack trace' : 'Show raw stack trace'}
              </button>
              {showStack && (
                <pre className="error-report-modal__stack">{ctx.errorStack}</pre>
              )}
            </section>
          )}
        </div>

        <footer className="modal__foot error-report-modal__foot">
          <span className="modal__hint">
            {copyState === 'copied' && <><Icon name="ok" size={12} /> Copied to clipboard.</>}
            {copyState === 'failed' && <span style={{ color: 'var(--color-destructive)' }}>Copy failed — select and copy manually.</span>}
            {copyState === 'idle' && 'No data is sent anywhere until you click one of the buttons.'}
          </span>
          <div className="error-report-modal__actions">
            <button
              className="btn"
              onClick={copyToClipboard}
              title="Copy the report text to your clipboard"
            >
              <Icon name="copy" size={14} /> Copy text
            </button>
            <button
              className="btn btn--progressive"
              onClick={openGithub}
              title="Opens a pre-filled new issue on the tool's GitHub repository. Requires a GitHub account."
            >
              <Icon name="external" size={14} /> Open GitHub issue
            </button>
            <button className="btn error-report-modal__cancel" onClick={onClose}>Cancel</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
