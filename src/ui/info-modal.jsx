// Info modal — opens from the topbar "About" button.
//
// This fork is local-dev-only (no Toolforge deployment, no GitLab MRs, no
// per-version archive URLs), so the upstream About modal's live "Versions"
// accordion and "Open merge requests" list (both fetched from GitLab) don't
// apply here and were removed. What remains: About, Links (GitHub), and the
// build/version chip.
//
// __APP_VERSION__ and __DEPLOY_TARGET__ are Vite compile-time defines
// (see vite.config.js). __DEPLOY_TARGET__ is one of: "main", "v<X.Y.Z>",
// "mr-<iid>", "dev".

import React from 'react';

const Icon = window.Icon;
const { useEffect } = React;

const GITHUB_REPO = 'https://github.com/KBNLwikimedia/iiif-commons-upload-workbench';
const GITHUB_ISSUES = `${GITHUB_REPO}/issues`;
const GITHUB_CHANGELOG = `${GITHUB_REPO}/blob/main/CHANGELOG.md`;
const OAUTH_DOCS = `${GITHUB_REPO}/blob/main/docs/oauth-registration.md`;
const UPSTREAM = 'https://gitlab.wikimedia.org/daanvr/upload-workbench';
// Hidden tracking category appended to every published file by publish.js.
// Linking it lets the user browse all the files uploaded with the tool.
const COMMONS_CATEGORY = 'https://commons.wikimedia.org/wiki/Category:Uploaded_with_IIIF_Manifest_Upload_Workbench';

function deployLabel(target) {
  if (target === 'main') return 'Production (main)';
  if (target === 'dev') return 'Local development';
  if (target.startsWith('v')) return `Archived release ${target}`;
  if (target.startsWith('mr-')) return `Merge request preview #${target.slice(3)}`;
  return target;
}

export default function InfoModal({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const target = __DEPLOY_TARGET__;
  const version = __APP_VERSION__;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal info-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="info-modal-title"
      >
        <header className="modal__head">
          <div>
            <h2 className="modal__title" id="info-modal-title">
              IIIF Manifest Upload Workbench
              <span className="info-modal__version-chip" title={`Build target: ${target}`}>
                v{version} · {deployLabel(target)}
              </span>
            </h2>
            <p className="modal__sub">Turn IIIF manifests into Wikimedia Commons uploads.</p>
          </div>
          <button className="btn btn--quiet btn--icon-only" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="modal__body info-modal__body">
          <Section title="About">
            <p>
              This tool ingests <strong>IIIF Presentation manifests</strong> (starting with the
              KB's medieval manuscripts) and turns them into Wikimedia Commons uploads: parse the
              metadata, derive full-resolution images, prefill <code>{'{{Artwork}}'}</code> wikitext
              and structured data, review in a spreadsheet-style workbench, and publish. It runs
              entirely in your browser — no backend.
            </p>
            <p>
              Edits auto-save as drafts to your Commons user namespace, so they follow you across
              devices. Files in your stash expire after 48 hours — the workbench shows a countdown
              so nothing is lost.
            </p>
            <p>
              It's a fork of{' '}
              <a href={UPSTREAM} target="_blank" rel="noopener noreferrer">Upload Workbench</a>{' '}
              by Daan van Ramshorst (the general-purpose bulk-upload cockpit), extended with the
              IIIF ingestion funnel. Open source, MIT-licensed.
            </p>
          </Section>

          <Section title="Links">
            <ul className="info-modal__links">
              <li><a href={GITHUB_REPO} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} /> Source code on GitHub</a></li>
              <li><a href={GITHUB_ISSUES} target="_blank" rel="noopener noreferrer"><Icon name="warn" size={14} /> Report a bug / request a feature</a></li>
              <li><a href={GITHUB_CHANGELOG} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} /> Changelog</a></li>
              <li><a href={COMMONS_CATEGORY} target="_blank" rel="noopener noreferrer"><Icon name="image" size={14} /> Files uploaded with this tool (on Commons)</a></li>
              <li><a href={OAUTH_DOCS} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} /> OAuth registration docs</a></li>
            </ul>
          </Section>
        </div>

        <footer className="modal__foot">
          <span className="modal__hint">Local development build · v{version}</span>
          <button className="btn btn--progressive" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="info-modal__section">
      <h3 className="info-modal__section-title">{title}</h3>
      {children}
    </section>
  );
}
