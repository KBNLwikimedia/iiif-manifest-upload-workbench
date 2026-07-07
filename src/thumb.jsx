import React from 'react';

// Thumbnail — generated SVG-style placeholder using deterministic color from data
// Each thumb is a stylized photographic placeholder; no real images.

function Thumb({ item, ratio, large }) {
  const w = item.width || 4;
  const h = item.height || 3;
  const aspect = ratio || (w / h);
  const isPortrait = aspect < 0.95;
  const isPano = aspect > 2.5;
  // Lightbox / detail-panel preview opts in to the large variant.
  // IIIF-imported stash rows carry a public manifest thumbnail
  // (item.iiifThumbUrl, persisted via the draft) — preferred because the
  // stash's own thumb URLs require session auth an <img> can't send.
  const thumbSrc = large
    ? (item.iiifThumbUrl || item.largeThumburl || item.thumburl)
    : (item.iiifThumbUrl || item.thumburl);

  // Build a deterministic gradient + horizon "scene" from the seed colors
  const bg = item.thumbColor || "#3a4a6b";
  const ac = item.thumbAccent || "#d8a657";

  // Hash filename for layout variation
  const seed = (item.filename || item.id || "").split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  const variant = seed % 4;

  // Track image load failure so we can hide the <img> and let the SVG backdrop show.
  const [imgFailed, setImgFailed] = React.useState(false);
  const realThumb = thumbSrc && !imgFailed;

  return (
    <div className="thumb" style={{ background: `linear-gradient(${130 + (seed % 60)}deg, ${bg}, ${shade(bg, -18)})` }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" className="thumb__svg" aria-hidden="true">
        {variant === 0 && (
          <>
            <rect x="0" y="58" width="100" height="42" fill={shade(bg, -28)} opacity="0.9" />
            <polygon points="0,58 22,38 38,52 60,30 78,46 100,32 100,58" fill={shade(bg, -10)} opacity="0.85" />
            <circle cx="78" cy="22" r="7" fill={ac} opacity="0.85" />
          </>
        )}
        {variant === 1 && (
          <>
            <rect x="0" y="62" width="100" height="38" fill={shade(bg, -22)} />
            <rect x="14" y="34" width="14" height="34" fill={shade(bg, 12)} opacity="0.9" />
            <rect x="32" y="22" width="20" height="46" fill={shade(bg, 18)} opacity="0.95" />
            <rect x="56" y="38" width="12" height="30" fill={shade(bg, 6)} opacity="0.85" />
            <rect x="72" y="28" width="18" height="40" fill={shade(bg, 14)} opacity="0.9" />
            <rect x="40" y="14" width="4" height="10" fill={ac} />
          </>
        )}
        {variant === 2 && (
          <>
            <circle cx="50" cy="42" r="22" fill={ac} opacity="0.18" />
            <circle cx="50" cy="42" r="14" fill={ac} opacity="0.4" />
            <rect x="0" y="64" width="100" height="36" fill={shade(bg, -25)} opacity="0.85" />
            <path d="M 0 66 Q 30 58 50 66 T 100 66 L 100 100 L 0 100 Z" fill={shade(bg, -15)} opacity="0.7" />
          </>
        )}
        {variant === 3 && (
          <>
            <rect x="0" y="0" width="100" height="100" fill="url(#stripes)" opacity="0.05" />
            <polygon points="20,80 50,30 80,80" fill={shade(bg, 14)} opacity="0.85" />
            <polygon points="40,80 60,50 80,80" fill={shade(bg, -8)} opacity="0.9" />
            <rect x="0" y="78" width="100" height="22" fill={shade(bg, -28)} />
            <circle cx="22" cy="20" r="4" fill={ac} opacity="0.9" />
          </>
        )}
        <defs>
          <pattern id="stripes" width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#fff" strokeWidth="0.5" />
          </pattern>
        </defs>
      </svg>
      {realThumb && (
        <img
          className="thumb__img"
          src={thumbSrc}
          alt=""
          loading="lazy"
          onError={() => setImgFailed(true)}
        />
      )}
      {isPano && <span className="thumb__chip thumb__chip--pano">PANO</span>}
    </div>
  );
}

function shade(hex, amt) {
  // amt: -100..100, percent change in lightness (rough)
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = amt / 100;
  if (f >= 0) {
    r = Math.round(r + (255 - r) * f);
    g = Math.round(g + (255 - g) * f);
    b = Math.round(b + (255 - b) * f);
  } else {
    r = Math.round(r * (1 + f));
    g = Math.round(g * (1 + f));
    b = Math.round(b * (1 + f));
  }
  return `#${[r, g, b].map(x => x.toString(16).padStart(2, "0")).join("")}`;
}

window.Thumb = Thumb;
window.shade = shade;
