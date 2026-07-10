// VersionChip — topbar version indicator + dropdown navigator.
//
// Shows the running build's version, color-coded by __DEPLOY_TARGET__ (a Vite
// compile-time define — see vite.config.js). For this fork the target is
// almost always `dev` (local development only); the main/v/mr variants remain
// for a possible future Toolforge deploy.
//
// Click the chip → dropdown listing the fork's own releases (parsed from
// CHANGELOG.md on GitHub — fork releases only, v0.40.0 and up) and any open
// pull requests. Release rows link to their GitHub release page; PR rows link
// to the PR on GitHub. "Go to live release" points at the local app for now
// (no Toolforge deployment yet — OI-09/OI-10).
//
// Both data sources are unauthenticated, CORS-OK, and apiCache-wrapped at
// 5min TTL inside src/api/github.js.

import React from 'react';
import { fetchOpenPullRequests, fetchChangelogRaw, releaseUrl } from '../api/github.js';
import { parseChangelog } from './changelog-parse.jsx';

const Icon = window.Icon;
const { useState, useEffect, useRef } = React;

// First release made by this fork; everything below it in CHANGELOG.md is
// inherited upstream (GitLab) history and is filtered out of the list.
const FORK_MIN_VERSION = '0.40.0';
// The local app is the only deploy target for now (dev phase).
const LIVE_URL = window.location.origin + '/';

// Numeric "X.Y.Z" >= compare so upstream releases (≤0.39) drop off the list.
function versionGte(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
}

// Variant key consumed by `.version-chip--<variant>` CSS rules.
function variantFor(target) {
  if (target === 'main') return 'main';
  if (target === 'dev') return 'dev';
  if (target.startsWith('v')) return 'archive';
  if (target.startsWith('mr-')) return 'mr';
  return 'dev';
}

// Chip label varies with the deploy target so a user landing on an MR
// preview sees the MR identifier (not the underlying version number, which
// is whatever the MR was built against and isn't the build they're on).
//   main         → "v<X.Y.Z>"  (current live release)
//   v<X.Y.Z>     → "v<X.Y.Z>"  (this archived release's own number)
//   mr-<IID>     → "MR !<IID>" (the GitLab MR identifier)
//   dev          → "dev"       (npm run dev)
function labelFor(target, version) {
  if (target === 'main') return `v${version}`;
  if (target === 'dev') return 'dev';
  if (target.startsWith('mr-')) return `MR !${target.slice(3)}`;
  if (target.startsWith('v')) return target;
  return `v${version}`;
}

function tooltipFor(target, version) {
  if (target === 'main') return `On the live release (v${version}).`;
  if (target === 'dev') return `Local development build (v${version}).`;
  if (target.startsWith('v')) return `Viewing archived release ${target} — click for the live release.`;
  if (target.startsWith('mr-')) return `Previewing merge request !${target.slice(3)} (built from v${version}) — click for the live release or other previews.`;
  return `Build target: ${target}`;
}

export default function VersionChip() {
  const [open, setOpen] = useState(false);
  const [prs, setPrs] = useState(null);
  const [prsError, setPrsError] = useState(null);
  const [versions, setVersions] = useState(null);
  const [versionsError, setVersionsError] = useState(null);
  const wrapRef = useRef(null);

  const target = __DEPLOY_TARGET__;
  const version = __APP_VERSION__;
  const variant = variantFor(target);
  const label = labelFor(target, version);

  // Lazy-load both feeds on first open. Subsequent opens hit apiCache
  // (5min TTL) so they're effectively free.
  useEffect(() => {
    if (!open) return;
    if (versions === null && versionsError === null) {
      fetchChangelogRaw()
        .then((text) => setVersions(
          parseChangelog(text).filter((v) => v.version && versionGte(v.version, FORK_MIN_VERSION)),
        ))
        .catch((e) => setVersionsError(e?.message || String(e)));
    }
    if (prs === null && prsError === null) {
      fetchOpenPullRequests()
        .then(setPrs)
        .catch((e) => setPrsError(e?.message || String(e)));
    }
  }, [open, versions, versionsError, prs, prsError]);

  // Click-outside / Esc to close. Only wire while open.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const top5 = versions ? versions.slice(0, 5) : null;

  return (
    <div className="version-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`version-chip version-chip--${variant}`}
        title={tooltipFor(target, version)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="version-chip__dot" aria-hidden="true" />
        <span className="version-chip__label">{label}</span>
        <Icon name="chevron-down" size={14} />
      </button>

      {open && (
        <div className="version-chip__menu" role="menu">
          <div className="version-chip__menu-section">
            <div className="version-chip__menu-head">
              Latest releases
              {target !== 'main' && (
                <a className="version-chip__menu-headlink" href={LIVE_URL}>
                  Go to live release
                </a>
              )}
            </div>
            {top5
              ? top5.length
                ? <ChipList
                    items={top5.map((v) => ({
                      key: `v${v.version}`,
                      label: `v${v.version}`,
                      meta: v.date,
                      href: releaseUrl(v.version),
                      isCurrent: target === `v${v.version}`,
                    }))}
                  />
                : <div className="version-chip__menu-empty">No releases yet.</div>
              : versionsError
                ? <div className="version-chip__menu-error">Couldn't load releases.</div>
                : <div className="version-chip__menu-loading">Loading releases…</div>}
          </div>

          <div className="version-chip__menu-section">
            <div className="version-chip__menu-head">Open pull requests</div>
            {prs
              ? prs.length
                ? <ChipList
                    items={prs.map((pr) => ({
                      key: `pr-${pr.number}`,
                      label: `#${pr.number}`,
                      meta: pr.title,
                      href: pr.html_url,
                      isCurrent: false,
                      draft: pr.draft,
                    }))}
                  />
                : <div className="version-chip__menu-empty">No open pull requests.</div>
              : prsError
                ? <div className="version-chip__menu-error">Couldn't load pull requests.</div>
                : <div className="version-chip__menu-loading">Loading pull requests…</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function ChipList({ items }) {
  return (
    <ul className="version-chip__menu-list">
      {items.map((it) => (
        <li
          key={it.key}
          className={'version-chip__menu-item' + (it.isCurrent ? ' is-current' : '')}
        >
          <a href={it.href} className="version-chip__menu-link" target="_blank" rel="noopener noreferrer">
            <span className="version-chip__menu-label">
              {it.label}
              {it.draft && <span className="chip chip--info version-chip__menu-draft">Draft</span>}
            </span>
            {it.meta && <span className="version-chip__menu-meta">{it.meta}</span>}
          </a>
          {it.isCurrent && <span className="version-chip__menu-here">you are here</span>}
        </li>
      ))}
    </ul>
  );
}
