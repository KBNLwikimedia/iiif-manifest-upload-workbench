// Feedback modal — opens from the always-visible <FeedbackButton/> pill
// pinned to the top-centre of the viewport.
//
// Sibling of src/ui/error-report-modal.jsx: same `window.open` plumbing.
// Destination is a pre-filled GitHub issue on the fork repo
// (KBNLwikimedia/iiif-manifest-upload-workbench), no OAuth scopes.
// (error-report-modal.jsx still points at upstream Phabricator/GitLab —
// repoint it too when convenient.) Differences from the error flow:
//
//   - No error context (no error message / stack trace). Instead we capture
//     a wider environment snapshot (version, deploy target, URL, user
//     agent, viewport, locale, plus stash/history item counts and the
//     signed-in username if we can read them from window.uwbDiagnostics)
//     so the maintainer doesn't have to ask "what build / what state were
//     you in?" on every report.
//   - Encouraging "we want your feedback, the tool is in beta" copy.
//   - The free-text comment is the *primary* content; the body is derived
//     from it.
//   - A small row of inspirational-question chips above the textarea —
//     clicking one inserts a scaffold ("**What were you doing?**\n\n…")
//     into the comment so a user who isn't sure what to type still ends up
//     with a structured bug report instead of a one-liner.
//   - A "Type of feedback" tab (Bug / Suggestion / Question / Praise) that
//     shapes the prompt chips and the body heading. Defaults to Bug since
//     that's the highest-leverage flow.
//   - Submit buttons are disabled until the user has typed something.

import React from 'react';

const Icon = window.Icon;
const { useState, useEffect, useMemo, useRef } = React;

const GITHUB_ISSUES_NEW_URL = 'https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench/issues/new';
// Map feedback type → an existing repo label (unknown labels would make
// GitHub show a warning). Only 'bug' and 'enhancement' exist; question /
// praise get no label.
const GITHUB_LABEL = { bug: 'bug', suggestion: 'enhancement' };

// Feedback-type definitions. The label is what we show on the chip; the
// `prompts` are the inspirational scaffolds the user can click to seed
// their comment; `heading` is the section title in the body so the
// maintainer can sort reports by intent.
const FEEDBACK_TYPES = [
  {
    id: 'bug',
    label: 'Bug',
    icon: 'warn',
    heading: 'Bug report',
    placeholder:
      "Something went wrong? Tell us what you were doing, what you expected, and what happened instead. The more detail the better — file names, the column you were editing, screenshots pasted into the talk page if you go that route…",
    prompts: [
      {
        id: 'doing',
        label: 'What I was doing',
        scaffold:
          "**What I was doing**\n(e.g. I selected 3 rows and clicked Publish, or I dragged a file onto the dropzone)\n\n",
      },
      {
        id: 'expected',
        label: 'What I expected',
        scaffold:
          "**What I expected**\n(e.g. the modal to open with the three files listed)\n\n",
      },
      {
        id: 'happened',
        label: 'What happened instead',
        scaffold:
          "**What happened instead**\n(e.g. nothing happened, or a blank page, or the wrong file got published)\n\n",
      },
      {
        id: 'repro',
        label: 'How to reproduce',
        scaffold:
          "**How to reproduce**\n1. \n2. \n3. \n\n",
      },
    ],
  },
  {
    id: 'suggestion',
    label: 'Suggestion',
    icon: 'plus',
    heading: 'Suggestion',
    placeholder:
      "Got an idea? Half-formed is fine — \"I wish it did X\", \"this would be smoother if Y\", \"can the column for Z remember my choice\"…",
    prompts: [
      {
        id: 'pain',
        label: 'The pain point',
        scaffold:
          "**The pain point**\n(e.g. I'm uploading 40 photos from a trip and have to retype the date column 40 times)\n\n",
      },
      {
        id: 'idea',
        label: 'The idea',
        scaffold:
          "**The idea**\n(e.g. fill-down should copy a value into every selected row, like Excel)\n\n",
      },
    ],
  },
  {
    id: 'question',
    label: 'Question',
    icon: 'info',
    heading: 'Question',
    placeholder:
      "Stuck on something? Confused about a column or a button? Ask away — the answer can become part of the onboarding for the next user.",
    prompts: [
      {
        id: 'context',
        label: 'What I was trying to do',
        scaffold:
          "**What I was trying to do**\n\n",
      },
      {
        id: 'question',
        label: 'The question',
        scaffold:
          "**The question**\n\n",
      },
    ],
  },
  {
    id: 'praise',
    label: 'Praise',
    icon: 'ok',
    heading: 'Praise',
    placeholder:
      "Found something that worked well? Saved you time? Made you smile? Tell us — knowing what to keep is just as useful as knowing what to fix.",
    prompts: [],
  },
];

// Snapshot the build / runtime context once when the modal opens. The
// version + deploy target tell us which build the feedback came from
// (handy when feedback is about a preview MR rather than production); the
// rest narrows down environment-specific bugs (browser, OS, language,
// viewport size) and gives a rough sense of the user's data shape (item
// counts, signed-in username) so the maintainer can reproduce locally
// without a back-and-forth.
function captureContext() {
  const diag = (typeof window !== 'undefined' && typeof window.uwbDiagnostics === 'function')
    ? safeDiag(window.uwbDiagnostics)
    : {};
  const tz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
  })();
  return {
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown',
    deployTarget: typeof __DEPLOY_TARGET__ !== 'undefined' ? __DEPLOY_TARGET__ : 'unknown',
    timestamp: new Date().toISOString(),
    url: window.location.href,
    userAgent: navigator.userAgent || '',
    viewport: `${window.innerWidth || 0}×${window.innerHeight || 0}`,
    language: navigator.language || '',
    timezone: tz,
    username: diag.username || '',
    stashCount: diag.stashCount,
    historyCount: diag.historyCount,
    loadErrors: diag.loadErrors || null,
  };
}

function safeDiag(fn) {
  try { return fn() || {}; } catch (e) {
    console.warn('uwbDiagnostics() threw:', e);
    return {};
  }
}

// Build the body the user submits. The grammar is shared between the
// Phabricator description and the talk-page section body — Phabricator
// Remarkup and MediaWiki wikitext both render `##` headings and `|` tables,
// so a single string works for both.
function buildFeedbackBody({ heading, comment, ctx }) {
  const lines = [];
  lines.push(`## ${heading}`);
  lines.push('');
  lines.push(comment.trim() || '_(no feedback typed)_');
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| **Build** | v${ctx.version} (${ctx.deployTarget}) |`);
  lines.push(`| **URL** | \`${ctx.url}\` |`);
  if (ctx.username) lines.push(`| **User** | ${ctx.username} |`);
  if (typeof ctx.stashCount === 'number') {
    lines.push(`| **Stash items** | ${ctx.stashCount} |`);
  }
  if (typeof ctx.historyCount === 'number') {
    lines.push(`| **History items (cached)** | ${ctx.historyCount} |`);
  }
  lines.push(`| **Viewport** | ${ctx.viewport} |`);
  lines.push(`| **Language** | \`${ctx.language}\` |`);
  if (ctx.timezone) lines.push(`| **Timezone** | \`${ctx.timezone}\` |`);
  lines.push(`| **Time** | ${ctx.timestamp} |`);
  lines.push(`| **User agent** | \`${ctx.userAgent}\` |`);
  if (ctx.loadErrors) {
    const errs = Object.entries(ctx.loadErrors).filter(([, v]) => v);
    if (errs.length) {
      lines.push('');
      lines.push('**Load errors at session start:**');
      lines.push('');
      lines.push('```');
      for (const [k, v] of errs) lines.push(`${k}: ${v}`);
      lines.push('```');
    }
  }
  lines.push('');
  lines.push('_Submitted via the IIIF Manifest Upload Workbench Feedback button._');
  return lines.join('\n');
}

function buildGithubIssueUrl({ title, body, typeId }) {
  const params = new URLSearchParams({ title, body });
  const label = GITHUB_LABEL[typeId];
  if (label) params.set('labels', label);
  return `${GITHUB_ISSUES_NEW_URL}?${params.toString()}`;
}

export default function FeedbackModal({ onClose }) {
  const [typeId, setTypeId] = useState('bug');
  const [comment, setComment] = useState('');
  const [copyState, setCopyState] = useState('idle'); // 'idle' | 'copied' | 'failed'
  const bodyRef = useRef(null);
  const commentRef = useRef(null);

  const ctx = useMemo(() => captureContext(), []);
  const type = useMemo(
    () => FEEDBACK_TYPES.find((t) => t.id === typeId) || FEEDBACK_TYPES[0],
    [typeId],
  );

  // The user can hand-edit the body before submitting (e.g. to redact a
  // filename from the URL hash). Once they do, freeze the auto-derive.
  const [body, setBody] = useState(() => buildFeedbackBody({ heading: type.heading, ctx, comment: '' }));
  const [bodyDirty, setBodyDirty] = useState(false);
  useEffect(() => {
    if (bodyDirty) return;
    setBody(buildFeedbackBody({ heading: type.heading, ctx, comment }));
  }, [comment, bodyDirty, ctx, type.heading]);

  // Title derived from the first non-blank line of the comment (truncated)
  // and prefixed with the chosen type so reports are easy to triage on the
  // workboard. If the user hasn't typed anything, we surface a placeholder
  // so the submit buttons can still build a valid URL — but they're
  // disabled in that state so this string never reaches Phabricator.
  const title = useMemo(() => {
    const firstLine = comment
      .split('\n')
      .map((l) => l.replace(/^[\s*#>_-]+/, '').trim())
      .find((l) => l.length > 0)
      || `Feedback on IIIF Manifest Upload Workbench`;
    const cleaned = firstLine.replace(/\s+/g, ' ').trim();
    const truncated = cleaned.length > 80 ? cleaned.slice(0, 77) + '…' : cleaned;
    return `[${type.label}] ${truncated}`;
  }, [comment, type.label]);

  const hasComment = comment.trim().length > 0;

  // Inserts a prompt scaffold at the cursor position (or appends it if
  // there's no cursor info). After insertion, focus the textarea so the
  // user can immediately type into the scaffold.
  const insertPrompt = (scaffold) => {
    const el = commentRef.current;
    if (!el) {
      setComment((prev) => (prev ? prev.replace(/\s*$/, '\n\n') : '') + scaffold);
      return;
    }
    const start = el.selectionStart ?? comment.length;
    const end = el.selectionEnd ?? comment.length;
    const before = comment.slice(0, start);
    const after = comment.slice(end);
    // Add separating blank line if we're appending after existing text.
    const sep = before.length > 0 && !/\n\n$/.test(before) ? '\n\n' : '';
    const next = before + sep + scaffold + after;
    setComment(next);
    // Move cursor to the end of the inserted scaffold so typing continues
    // *inside* the scaffold, not after the placeholder.
    requestAnimationFrame(() => {
      if (!commentRef.current) return;
      const cursor = (before + sep + scaffold).length;
      commentRef.current.focus();
      commentRef.current.setSelectionRange(cursor, cursor);
    });
  };

  // Esc closes; body scroll locked while open; autofocus the comment box.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (commentRef.current) commentRef.current.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const githubUrl = useMemo(() => buildGithubIssueUrl({ title, body, typeId }), [title, body, typeId]);

  const copyToClipboard = async () => {
    try {
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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal feedback-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
      >
        <header className="modal__head">
          <div>
            <h2 className="modal__title" id="feedback-title">
              <Icon name="info" size={16} /> Send feedback{' '}
              <span className="chip chip--info feedback-modal__beta">Beta</span>
            </h2>
            <p className="modal__sub">
              IIIF Manifest Upload Workbench is in beta — your feedback is unusually valuable. Bug reports, half-formed ideas, "I wish it did X", "this label confused me", praise — all welcome. The note below opens a pre-filled GitHub issue; review and edit before sending.
            </p>
          </div>
          <button className="btn btn--quiet btn--icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="modal__body feedback-modal__body">
          <section className="feedback-modal__section">
            <span className="feedback-modal__label">What kind of feedback?</span>
            <div
              className="feedback-modal__types"
              role="radiogroup"
              aria-label="Type of feedback"
            >
              {FEEDBACK_TYPES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={typeId === t.id}
                  className={
                    'feedback-modal__type' + (typeId === t.id ? ' feedback-modal__type--active' : '')
                  }
                  onClick={() => setTypeId(t.id)}
                >
                  <Icon name={t.icon} size={12} /> {t.label}
                </button>
              ))}
            </div>
          </section>

          <section className="feedback-modal__section">
            <label htmlFor="feedback-comment" className="feedback-modal__label">
              Your feedback
            </label>
            {type.prompts.length > 0 && (
              <div className="feedback-modal__prompts">
                <span className="feedback-modal__prompts-lede">
                  Not sure what to say? Click a prompt to insert a scaffold:
                </span>
                <div className="feedback-modal__prompts-row">
                  {type.prompts.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="btn btn--small btn--quiet feedback-modal__prompt"
                      onClick={() => insertPrompt(p.scaffold)}
                      title={`Insert "${p.label}" scaffold into your feedback`}
                    >
                      <Icon name="plus" size={10} /> {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <textarea
              ref={commentRef}
              id="feedback-comment"
              className="feedback-modal__comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={type.placeholder}
              rows={7}
            />
          </section>

          <section className="feedback-modal__section">
            <div className="feedback-modal__label-row">
              <span className="feedback-modal__label">
                Preview <span className="feedback-modal__label-hint">(environment auto-attached for troubleshooting)</span>
              </span>
              {bodyDirty && (
                <button
                  type="button"
                  className="btn btn--small btn--quiet"
                  onClick={() => { setBodyDirty(false); setBody(buildFeedbackBody({ heading: type.heading, ctx, comment })); }}
                  title="Discard hand-edits and regenerate"
                >
                  Reset
                </button>
              )}
            </div>
            <textarea
              ref={bodyRef}
              className="feedback-modal__body-text"
              value={body}
              onChange={(e) => { setBody(e.target.value); setBodyDirty(true); }}
              spellCheck={false}
              rows={Math.min(20, Math.max(10, body.split('\n').length + 1))}
            />
            <p className="modal__hint">
              You can edit this directly — useful to tweak wording or redact something from the URL/user agent before submitting.
            </p>
          </section>
        </div>

        <footer className="modal__foot feedback-modal__foot">
          <span className="modal__hint">
            {copyState === 'copied' && <><Icon name="ok" size={12} /> Copied to clipboard.</>}
            {copyState === 'failed' && <span style={{ color: 'var(--color-destructive)' }}>Copy failed — select and copy manually.</span>}
            {copyState === 'idle' && 'No data is sent anywhere until you click one of the buttons.'}
          </span>
          <div className="feedback-modal__actions">
            <button className="btn btn--quiet" onClick={onClose}>Cancel</button>
            <button
              className="btn"
              onClick={copyToClipboard}
              disabled={!hasComment}
              title="Copy the feedback text to your clipboard"
            >
              <Icon name="copy" size={14} /> Copy text
            </button>
            <button
              className="btn btn--progressive"
              onClick={openGithub}
              disabled={!hasComment}
              title="Opens a pre-filled new issue on GitHub (KBNLwikimedia/iiif-manifest-upload-workbench). Requires a GitHub account."
            >
              <Icon name="external" size={14} /> Open GitHub issue
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
