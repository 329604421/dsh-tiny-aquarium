function jarSvg(angle) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <g transform="rotate(${angle} 16 16)" stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 6h10v5H11zM10 11h12v15H10z" fill="#f5e8c8" stroke="#fffdf7" stroke-width="4"/>
    <path d="M11 6h10v5H11zM10 11h12v15H10zM13 3h6M13 17h6M13 22h4" fill="none" stroke="#59402b" stroke-width="1.5"/>
    <path d="M11 6h10v5H11z" fill="#b77a45" stroke="#59402b" stroke-width="1.5"/>
    <path d="M10 11h12v15H10z" fill="#f5e8c8" fill-opacity=".9" stroke="#59402b" stroke-width="1.5"/>
    <circle cx="7" cy="6" r="1.25" fill="#c38a4e" stroke="#fffdf7" stroke-width="1"/>
    <circle cx="4" cy="10" r=".9" fill="#c38a4e" stroke="#fffdf7" stroke-width=".8"/>
  </g>
</svg>`;
}

export function createFeedCursor(angle) {
  return `url("data:image/svg+xml,${encodeURIComponent(jarSvg(angle))}") 7 7, pointer`;
}

/** The resting tool is tipped; over the water it tips far enough to pour. */
export const FEED_CURSOR = createFeedCursor(-18);
export const FEED_CURSOR_WATER = createFeedCursor(-54);
