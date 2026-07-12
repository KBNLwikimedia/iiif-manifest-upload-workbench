// Report-manifest modal — opens from the "Report duplicates" button on the
// select step (Step 2/3) when the loaded manifest contains duplicate canvas
// labels and/or duplicate images (OI-85).
//
// Sibling of src/ui/feedback-modal.jsx: same `window.open` plumbing to a
// pre-filled GitHub issue on the fork repo (KBNLwikimedia/…), no OAuth scopes.
// Differences from feedback:
//   - The body is derived from the detected duplicates (not free text); the
//     user can add an optional note and hand-edit the body before sending.
//   - The issue is labelled `manifest-needs-checking` so the KB maintainers
//     can triage manifests that need correcting.
//   - After submitting on GitHub, the user pastes the new issue number back
//     into a field here; it's saved against the recent-manifest entry so the
//     "Needs work" tab on Step 1 can show the reported issue number.

import React from 'react';
import { findManifestDuplicates } from '../api/iiif.js';

const Icon = window.Icon;
const { useState, useMemo, useEffect, useRef } = React;

const REPO_SLUG = 'KBNLwikimedia/iiif-manifest-upload-workbench';
const GITHUB_ISSUES_NEW_URL = `https://github.com/${REPO_SLUG}/issues/new`;
const REPORT_LABEL = 'manifest-needs-checking';

// Turn "https://github.com/owner/repo/issues/123" or "#123" or "123" into the
// numeric issue id, or null if it doesn't look like one.
function parseIssueNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/(?:issues\/|#)?(\d{1,7})\s*$/);
  return m ? Number(m[1]) : null;
}

function buildReportBody({ manuscript, sourceUrl, dup, canvases, note }) {
  const labelOf = (idx) => {
    const c = canvases.find((x) => x.index === idx);
    return (c && c.label) ? c.label : `image ${idx + 1}`;
  };
  const lines = [];
  lines.push('## Manifest flagged as needing checking');
  lines.push('');
  const idLine = [manuscript.title, manuscript.signature].filter(Boolean).join(' — ');
  lines.push(`**Manuscript:** ${idLine || '(unknown)'}`);
  if (sourceUrl) lines.push(`**Manifest:** ${sourceUrl}`);
  lines.push('');
  lines.push('The IIIF Manifest Upload Workbench flagged this manifest as containing duplicate content that needs correcting by the manifest maintainers before its images can be uploaded to Wikimedia Commons.');
  lines.push('');

  if (dup.labelGroups.length) {
    lines.push(`### Duplicate filenames (${dup.dupNames} images)`);
    lines.push('');
    lines.push('These canvases share the same label, so they would derive the **same** Wikimedia Commons filename (not allowed):');
    lines.push('');
    for (const g of dup.labelGroups) {
      lines.push(`- \`${g.label}\` — images ${g.positions.join(', ')}`);
    }
    lines.push('');
  }

  if (dup.imageGroups.length) {
    lines.push(`### Duplicate images (${dup.dupImages} images)`);
    lines.push('');
    lines.push('These canvases point at the **identical** image (same image URL, so identical bytes / SHA-1):');
    lines.push('');
    for (const g of dup.imageGroups) {
      const labelList = g.positions.map((p, i) => `${p} (\`${labelOf(g.indices[i])}\`)`).join(', ');
      lines.push(`- images ${labelList}`);
      if (g.image) lines.push(`  - \`${g.image}\``);
    }
    lines.push('');
  }

  if (note.trim()) {
    lines.push('### Notes');
    lines.push('');
    lines.push(note.trim());
    lines.push('');
  }

  lines.push('_Reported via the IIIF Manifest Upload Workbench._');
  return lines.join('\n');
}

export default function ReportManifestModal({ onClose, manifest, manuscript, sourceUrl, recordedIssues = [], allRecordedIssueNumbers = [], canRecord = true, onRecordIssue, onRemoveIssue }) {
  const canvases = manifest?.canvases || [];
  const dup = useMemo(() => findManifestDuplicates(canvases), [canvases]);
  const ms = manuscript || {};

  const [note, setNote] = useState('');
  const [issueInput, setIssueInput] = useState('');
  const [saved, setSaved] = useState(recordedIssues.map((i) => i.number));
  const [copyState, setCopyState] = useState('idle');
  const [opened, setOpened] = useState(false);
  const bodyRef = useRef(null);

  // Input guards on the issue number:
  //   1. no duplicates — a GitHub issue number can only be linked once (to any
  //      manifest), so reject one already recorded.
  //   2. must be a *new* issue — a freshly-created issue always gets a number
  //      higher than everything that existed when the report was started, so
  //      reject a number that isn't above the repo's highest issue at open.
  //      A number confirmed by "Find my issue" is a verified existing issue and
  //      bypasses this guard.
  const [baseline, setBaseline] = useState(null); // highest issue# at open, or null if unknown
  const [verifiedNumber, setVerifiedNumber] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${REPO_SLUG}/issues?state=all&per_page=1&sort=created&direction=desc`,
          { headers: { Accept: 'application/vnd.github+json' } },
        );
        if (!res.ok) return; // rate-limited/offline → guard 2 simply doesn't apply
        const arr = await res.json();
        const top = Array.isArray(arr) && arr[0] ? Number(arr[0].number) : null;
        if (alive && top) setBaseline(top);
      } catch { /* ignore — soft guard */ }
    })();
    return () => { alive = false; };
  }, []);
  const alreadyRecorded = new Set([...allRecordedIssueNumbers, ...saved]);
  const inputNum = parseIssueNumber(issueInput);
  const inputError = (() => {
    if (!inputNum) return null;
    if (alreadyRecorded.has(inputNum)) return `#${inputNum} is already recorded — an issue can only be linked once.`;
    if (inputNum === verifiedNumber) return null; // confirmed by "Find my issue"
    if (baseline != null && inputNum <= baseline) return `#${inputNum} isn't a newly-created issue — the latest issue in the repo is #${baseline}, and a new one always gets a higher number. Check the number, or use “Find my issue”.`;
    return null;
  })();
  const canSave = !!inputNum && !inputError;

  const title = useMemo(() => {
    const idLine = [ms.signature, ms.title].filter(Boolean).join(' — ') || 'manifest';
    return `[${REPORT_LABEL}] ${idLine} — duplicate images/filenames`;
  }, [ms.signature, ms.title]);

  const [body, setBody] = useState(() => buildReportBody({ manuscript: ms, sourceUrl, dup, canvases, note: '' }));
  const [bodyDirty, setBodyDirty] = useState(false);
  useEffect(() => {
    if (bodyDirty) return;
    setBody(buildReportBody({ manuscript: ms, sourceUrl, dup, canvases, note }));
  }, [note, bodyDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const githubUrl = useMemo(() => {
    const params = new URLSearchParams({ title, body });
    params.set('labels', REPORT_LABEL);
    return `${GITHUB_ISSUES_NEW_URL}?${params.toString()}`;
  }, [title, body]);

  // Body scroll locked while open. Esc does NOT close (don't lose a half-typed
  // report); use Cancel / ×.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const copyToClipboard = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(body);
      else if (bodyRef.current) { bodyRef.current.select(); document.execCommand('copy'); }
      else throw new Error('No clipboard API');
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (e) {
      console.warn('Copy failed:', e);
      setCopyState('failed');
      setTimeout(() => setCopyState('idle'), 3000);
    }
  };

  const openGithub = () => {
    window.open(githubUrl, '_blank', 'noopener,noreferrer');
    setOpened(true);
  };

  const saveIssue = () => {
    if (!canSave) return; // guards: valid number, not a duplicate, is a new issue
    const num = inputNum;
    onRecordIssue?.(num, issueInput.trim());
    setSaved((prev) => (prev.includes(num) ? prev : [...prev, num]));
    setIssueInput('');
    setVerifiedNumber(null);
  };

  // Undo a wrong paste/lookup: drop the number here and from Preferences, and
  // clear any stale "found" message so a fresh lookup starts clean.
  const removeSaved = (num) => {
    onRemoveIssue?.(num);
    setSaved((prev) => prev.filter((x) => x !== num));
    setFindMsg(null);
  };

  // "Find my issue": query GitHub's public search API (no auth, CORS-enabled)
  // for the newest issue with the manifest-needs-checking label whose title
  // mentions this manuscript's signature (unique shelfmark) — falling back to
  // the title. It's a *suggestion* the user confirms with Save, not a silent
  // auto-fill: title-matching can't guarantee the right issue if two were
  // reported close together.
  const searchKey = (ms.signature || ms.title || '').trim();
  const [finding, setFinding] = useState(false);
  const [findMsg, setFindMsg] = useState(null); // { kind, text, url?, number? }
  const findMyIssue = async () => {
    if (!searchKey) { setFindMsg({ kind: 'error', text: 'This manifest has no signature or title to search by — paste the number manually.' }); return; }
    setFinding(true);
    setFindMsg(null);
    try {
      const q = `repo:KBNLwikimedia/iiif-manifest-upload-workbench is:issue label:${REPORT_LABEL} in:title "${searchKey}"`;
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=5`;
      const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
      if (res.status === 403) { setFindMsg({ kind: 'error', text: 'GitHub search rate limit reached (a few searches per minute). Wait a moment and retry, or paste the number manually.' }); return; }
      if (!res.ok) { setFindMsg({ kind: 'error', text: `GitHub search failed (HTTP ${res.status}) — paste the number manually.` }); return; }
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) {
        setFindMsg({ kind: 'none', text: `No “${REPORT_LABEL}” issue mentioning “${searchKey}” found yet. If you just submitted it, wait a few seconds and retry, or paste the number manually.` });
        return;
      }
      const top = items[0];
      setIssueInput(String(top.number));
      setVerifiedNumber(top.number); // a real labelled issue matching this manifest — bypasses the "new issue" guard
      setFindMsg({ kind: 'found', text: `#${top.number}: ${top.title}`, url: top.html_url, number: top.number, multiple: items.length > 1 });
    } catch (e) {
      console.warn('Find-my-issue search failed:', e);
      setFindMsg({ kind: 'error', text: 'Could not reach GitHub — paste the number manually.' });
    } finally {
      setFinding(false);
    }
  };

  const nDup = dup.dupNames + dup.dupImages;

  return (
    <div className="modal-backdrop">
      <div className="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="report-manifest-title">
        <header className="modal__head">
          <div>
            <h2 className="modal__title" id="report-manifest-title">
              <Icon name="warn" size={16} /> Report manifest problems
            </h2>
            <p className="modal__sub">
              This manifest has duplicate filenames and/or duplicate images that the manifest maintainers should fix. The note below opens a pre-filled GitHub issue (labelled <code>{REPORT_LABEL}</code>) on the workbench repository — review and edit it, then send. After submitting, paste the new issue number back here so it shows up under <strong>Needs work</strong>.
            </p>
          </div>
          <button className="btn btn--quiet btn--icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="modal__body feedback-modal__body">
          <section className="feedback-modal__section">
            <span className="feedback-modal__label">Detected problems</span>
            <ul className="report-modal__summary">
              {dup.labelGroups.length > 0 && (
                <li><strong>{dup.dupNames}</strong> images with duplicate filenames ({dup.labelGroups.length} name{dup.labelGroups.length === 1 ? '' : 's'})</li>
              )}
              {dup.imageGroups.length > 0 && (
                <li><strong>{dup.dupImages}</strong> duplicate images ({dup.imageGroups.length} group{dup.imageGroups.length === 1 ? '' : 's'} of identical pictures)</li>
              )}
              {nDup === 0 && <li>No duplicates detected in this manifest.</li>}
            </ul>
          </section>

          <section className="feedback-modal__section">
            <label htmlFor="report-note" className="feedback-modal__label">Add a note (optional)</label>
            <textarea
              id="report-note"
              className="feedback-modal__comment"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything the maintainers should know — e.g. which of the duplicate pages is the correct one, or that a page is missing."
              rows={3}
            />
          </section>

          <section className="feedback-modal__section">
            <div className="feedback-modal__label-row">
              <span className="feedback-modal__label">Preview</span>
              {bodyDirty && (
                <button
                  type="button"
                  className="btn btn--small btn--quiet"
                  onClick={() => { setBodyDirty(false); setBody(buildReportBody({ manuscript: ms, sourceUrl, dup, canvases, note })); }}
                  title="Discard hand-edits and regenerate"
                >Reset</button>
              )}
            </div>
            <textarea
              ref={bodyRef}
              className="feedback-modal__body-text"
              value={body}
              onChange={(e) => { setBody(e.target.value); setBodyDirty(true); }}
              spellCheck={false}
              rows={Math.min(18, Math.max(8, body.split('\n').length + 1))}
            />
          </section>

          {/* Step 1: create the issue on GitHub. Kept above the record step so
              the flow reads top-to-bottom — first open/submit, then record. */}
          <section className="feedback-modal__section report-modal__create">
            <span className="feedback-modal__label">1. Open the pre-filled issue on GitHub and submit it</span>
            <div className="report-modal__create-row">
              <button className="btn btn--progressive" onClick={openGithub} disabled={nDup === 0} title="Opens a pre-filled new issue on GitHub. Requires a GitHub account.">
                <Icon name="external" size={14} /> Open GitHub issue
              </button>
              <button className="btn" onClick={copyToClipboard} disabled={nDup === 0} title="Copy the report text to your clipboard">
                <Icon name="copy" size={14} /> Copy text
              </button>
              <span className="modal__hint report-modal__create-hint">
                {copyState === 'copied' && <><Icon name="ok" size={12} /> Copied to clipboard.</>}
                {copyState === 'failed' && <span style={{ color: 'var(--color-destructive)' }}>Copy failed — select and copy manually.</span>}
                {copyState === 'idle' && (opened ? 'Opened in a new tab — submit it there, then record its number below.' : 'Nothing is sent until you click a button.')}
              </span>
            </div>
          </section>

          {/* Step 2: record the created issue number. Only possible when the
              manifest is in the recent list (OI-88) — a dropped file with no
              reusable URL has nowhere to save the number, so the whole record
              step is replaced by a note. */}
          <section className="feedback-modal__section report-modal__record">
            <label htmlFor="report-issue" className="feedback-modal__label">
              2. Created the issue? Let the tool find it — or paste in the number
            </label>
            {!canRecord ? (
              <p className="report-modal__norecord">
                This manifest was opened from a dropped file with no reusable URL, so it isn’t in your recent list and an issue number can’t be saved here. The GitHub issue itself is unaffected — reload the manifest by URL if you want it tracked under <strong>Needs work</strong>.
              </p>
            ) : (
            <>
            <div className="report-modal__record-row">
              <input
                id="report-issue"
                type="text"
                inputMode="numeric"
                className={'report-modal__issue-input' + (inputError ? ' report-modal__issue-input--invalid' : '')}
                value={issueInput}
                /* Digits only: strip every non-digit as typed/pasted (also drops
                   any spaces, #, or a pasted URL's punctuation) so the field can
                   only ever hold an issue number. */
                onChange={(e) => setIssueInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') saveIssue(); }}
                placeholder="e.g. 42"
                aria-invalid={!!inputError}
              />
              <button
                className={'btn' + (findMsg && findMsg.kind !== 'found' ? ' report-modal__findbtn--notfound' : '')}
                onClick={findMyIssue}
                disabled={finding || !searchKey}
                title={`Search GitHub for the ${REPORT_LABEL} issue mentioning “${searchKey || 'this manifest'}”`}
              >
                {finding ? 'Searching…' : 'Find my issue'}
              </button>
              <button className="btn btn--progressive" onClick={saveIssue} disabled={!canSave}>Save issue #</button>
            </div>
            {inputError && <p className="report-modal__inputerr">⚠️ {inputError}</p>}
            {findMsg && (
              <p className={'report-modal__find report-modal__find--' + findMsg.kind}>
                {findMsg.kind === 'found' ? (
                  <>
                    Found <a href={findMsg.url} target="_blank" rel="noopener noreferrer">{findMsg.text}</a> — check it's the right one, then <strong>Save issue #</strong>.
                    {findMsg.multiple && ' (More than one matched; this is the most recent.)'}
                  </>
                ) : findMsg.text}
              </p>
            )}
            {saved.length > 0 && (
              <div className="report-modal__saved">
                <span>Reported as</span>
                {saved.map((n) => (
                  <span key={n} className="report-modal__saved-chip">
                    <a href={`https://github.com/KBNLwikimedia/iiif-manifest-upload-workbench/issues/${n}`} target="_blank" rel="noopener noreferrer">#{n}</a>
                    <button
                      type="button"
                      className="report-modal__saved-remove"
                      onClick={() => removeSaved(n)}
                      title={`Remove issue #${n} — wrong number? Delete it and look up again.`}
                      aria-label={`Remove issue #${n}`}
                    >×</button>
                  </span>
                ))}
                <span className="report-modal__saved-note">— shown under <strong>Needs work</strong>. Wrong one? Remove it (×) and look up again.</span>
              </div>
            )}
            </>
            )}
          </section>
        </div>

        <footer className="modal__foot feedback-modal__foot">
          <button className="btn feedback-modal__cancel" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}
