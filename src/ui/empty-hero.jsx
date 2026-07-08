// Empty-stash hero: large call-to-action shown when the stash has no files.
//
// This tool is a IIIF ingestor only — the sole entry point is the "Import
// IIIF manifest" wizard, so the hero's primary action opens it. A IIIF
// Presentation 3.0 manifest can also be dropped anywhere on the window as a
// `.json` file (window-level wiring lives in `src/ui/dropzone.jsx`); the
// hero just makes the affordance visible. (T426377)
//
// Sized large enough to dominate the empty page, using the same dashed
// progressive-blue border + iconography as the dropzone-overlay so the
// "drop here" language is consistent across empty-state and active-drag.

import React from 'react';

const Icon = window.Icon;

// `onImportIiif` opens the "Import IIIF manifest" wizard (passed down from
// App so the hero and the topbar button share one open-the-modal path).
export function EmptyHero({ onImportIiif }) {
  return (
    <div className="empty-hero" role="region" aria-label="Import a IIIF manifest to start">
      <div className="empty-hero__icon" aria-hidden="true">
        <Icon name="upload" size={56} />
      </div>
      <h2 className="empty-hero__title">Import a IIIF manifest to start</h2>
      <p className="empty-hero__subtitle">
        Paste a manifest URL or drop a IIIF Presentation 3.0 manifest
        (<code>.json</code>) onto the page. Every page becomes a full-resolution
        image with prefilled <code>{'{{Artwork}}'}</code> metadata in your stash,
        ready to review and publish to Wikimedia Commons.
      </p>
      <div className="empty-hero__actions">
        {onImportIiif && (
          <button
            type="button"
            className="btn btn--progressive empty-hero__iiif"
            onClick={onImportIiif}
          >
            <Icon name="upload" size={16} /> Import IIIF manifest
          </button>
        )}
      </div>
      <p className="empty-hero__hint">
        You can drop a IIIF Presentation 3.0 manifest (<code>.json</code>) anywhere
        on this window to open the import wizard.
      </p>
    </div>
  );
}
