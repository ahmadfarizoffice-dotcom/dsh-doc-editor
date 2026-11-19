/**
 * Inline SVG icon set (no network images, no icon font).
 *
 * Icons are decorative: every icon-only control carries an `aria-label`, so the
 * SVG is hidden from assistive technology.
 */
import type { ReactNode } from "react";

export type IconName =
  | "undo"
  | "redo"
  | "print"
  | "paint"
  | "link"
  | "comment"
  | "commentAdd"
  | "image"
  | "chart"
  | "shape"
  | "table"
  | "find"
  | "formatMarks"
  | "trackChanges"
  | "share"
  | "history"
  | "more"
  | "chevronDown"
  | "chevronUp"
  | "close"
  | "plus"
  | "minus"
  | "open"
  | "save"
  | "newDoc"
  | "export"
  | "cut"
  | "copy"
  | "paste"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignJustify"
  | "lineSpacing"
  | "bulletList"
  | "numberList"
  | "checklist"
  | "indentIncrease"
  | "indentDecrease"
  | "clearFormat"
  | "footnote"
  | "toc"
  | "pageBreak"
  | "sectionBreak"
  | "grid"
  | "search"
  | "account"
  | "collapse"
  | "inspector"
  | "pages"
  | "gdocs"
  | "word"
  | "writer"
  | "zoomIn"
  | "zoomOut"
  | "check"
  | "arrowLeft"
  | "arrowRight"
  | "cloud"
  | "format"
  | "page"
  | "styles"
  | "property"
  | "bookmark"
  | "theme";

const paths: Record<IconName, ReactNode> = {
  undo: (
    <>
      <path d="M9 7 4 12l5 5" />
      <path d="M4 12h9.5a5.5 5.5 0 0 1 5.5 5.5V19" />
    </>
  ),
  redo: (
    <>
      <path d="m15 7 5 5-5 5" />
      <path d="M20 12H10.5A5.5 5.5 0 0 0 5 17.5V19" />
    </>
  ),
  print: (
    <>
      <path d="M7 9V4h10v5" />
      <rect x="4" y="9" width="16" height="7" rx="1.5" />
      <path d="M7 14h10v6H7z" />
    </>
  ),
  paint: (
    <>
      <path d="m14 4 6 6-8 8H6v-6z" />
      <path d="M5 20h6" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7" />
    </>
  ),
  comment: <path d="M4 5h16v11H9l-5 4z" />,
  commentAdd: (
    <>
      <path d="M4 5h16v11H9l-5 4z" />
      <path d="M12 8v5M9.5 10.5h5" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17 5-5 4 4 3-2.5 3.5 3.5" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  shape: (
    <>
      <rect x="3" y="8" width="8" height="8" rx="1" />
      <circle cx="17" cy="12" r="4.5" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1" />
      <path d="M3.5 10h17M3.5 14h17M9 5v14M15 5v14" />
    </>
  ),
  find: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m15 15 5 5" />
    </>
  ),
  formatMarks: (
    <>
      <path d="M9 5h8M9 9h8M9 5v14M13 5v14M6 5h2" />
      <path d="M5 19h14" />
    </>
  ),
  trackChanges: (
    <>
      <path d="m4 20 1-4 11-11 3 3-11 11z" />
      <path d="m15 5 3 3" />
    </>
  ),
  share: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.3-5.7" />
      <path d="M4 4v4h4" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronUp: <path d="m6 15 6-6 6 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  open: (
    <>
      <path d="M3 7h6l2 2h10v10H3z" />
      <path d="M3 7V5h6l2 2" />
    </>
  ),
  save: (
    <>
      <path d="M4 4h13l3 3v13H4z" />
      <path d="M8 4v6h8V4M8 20v-6h8v6" />
    </>
  ),
  newDoc: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 13h6M12 10v6" />
    </>
  ),
  export: (
    <>
      <path d="M12 15V4M8 8l4-4 4 4" />
      <path d="M5 14v6h14v-6" />
    </>
  ),
  cut: (
    <>
      <circle cx="6.5" cy="7" r="2.5" />
      <circle cx="6.5" cy="17" r="2.5" />
      <path d="m8.5 8.5 11 10M8.5 15.5l11-10" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="1.5" />
      <path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3H5.5A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8" />
    </>
  ),
  paste: (
    <>
      <path d="M8 4h8v3H8z" />
      <path d="M8 6H5v15h14V6h-3" />
      <path d="M8 11h8M8 15h8" />
    </>
  ),
  alignLeft: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  alignCenter: <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  alignRight: <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  alignJustify: <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
  lineSpacing: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 4v16M2 6l2-2 2 2M2 18l2 2 2-2" />
    </>
  ),
  bulletList: (
    <>
      <circle cx="4.5" cy="7" r="1.2" />
      <circle cx="4.5" cy="12" r="1.2" />
      <circle cx="4.5" cy="17" r="1.2" />
      <path d="M8 7h12M8 12h12M8 17h12" />
    </>
  ),
  numberList: (
    <>
      <path d="M4 5h2v4M3.5 9h3" />
      <path d="M3.5 13h3l-3 3h3" />
      <path d="M4 19h2M4 21h2" />
      <path d="M9 7h11M9 15h11M9 19h11" />
    </>
  ),
  checklist: (
    <>
      <rect x="3" y="4" width="5" height="5" rx="1" />
      <path d="m4 6.5 1.2 1.2L7 5.5" />
      <rect x="3" y="14" width="5" height="5" rx="1" />
      <path d="M11 6.5h9M11 16.5h9" />
    </>
  ),
  indentIncrease: (
    <>
      <path d="M4 6h16M4 18h16M10 10h10M10 14h10" />
      <path d="m4 10 4 2-4 2z" />
    </>
  ),
  indentDecrease: (
    <>
      <path d="M4 6h16M4 18h16M10 10h10M10 14h10" />
      <path d="m8 10-4 2 4 2z" />
    </>
  ),
  clearFormat: (
    <>
      <path d="M7 5h10M12 5l-3 12" />
      <path d="M5 20h14" />
      <path d="m14 12 7 7M21 12l-7 7" />
    </>
  ),
  footnote: (
    <>
      <path d="M5 3h9l5 5v13H5z" />
      <path d="M14 3v5h5" />
      <path d="M9 14h4M11 12v4" />
      <path d="m8 18 2-2M14 18l-2-2" />
    </>
  ),
  toc: (
    <>
      <path d="M4 6h8M4 11h8M4 16h8" />
      <path d="M15 6h5M15 11h5M15 16h5" />
      <path d="M12 6h1M12 11h1M12 16h1" />
    </>
  ),
  pageBreak: (
    <>
      <path d="M6 3h8l4 4v6M6 3v6M18 7h-4V3" />
      <path d="M4 14h16" strokeDasharray="2 2" />
      <path d="M6 18h12v3H6z" />
    </>
  ),
  sectionBreak: (
    <>
      <path d="M6 3h12v8H6zM6 15h12v6H6z" />
      <path d="M3 13h18" strokeDasharray="2 2" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m15 15 5 5" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  collapse: <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />,
  inspector: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  pages: (
    <>
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M15 2v5h5" />
      <path d="m9 17 3-7 3 7M10 15h4" />
    </>
  ),
  gdocs: (
    <>
      <path d="M6 2h9l5 5v15H6z" fill="currentColor" stroke="none" />
      <path d="M15 2v5h5" fill="none" stroke="#fff" strokeWidth="1.6" />
      <path
        d="M9 12h8M9 15h8M9 18h5"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
      />
    </>
  ),
  word: (
    <>
      <path d="M6 2h9l5 5v15H6z" fill="currentColor" stroke="none" />
      <path d="M15 2v5h5" fill="none" stroke="#fff" strokeWidth="1.6" />
      <path
        d="m9 12 1.6 6L12 13l1.4 5L15 12"
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
      />
    </>
  ),
  writer: (
    <>
      <path d="M6 2h9l5 5v15H6z" fill="currentColor" stroke="none" />
      <path d="M15 2v5h5" fill="none" stroke="#fff" strokeWidth="1.6" />
      <path
        d="M9 12h8M9 15h8M9 18h6"
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
      />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m15 15 5 5M8 10.5h5M10.5 8v5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m15 15 5 5M8 10.5h5" />
    </>
  ),
  check: <path d="m5 12 4 4 10-10" />,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  cloud: (
    <>
      <path d="M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.6 1.4A3.3 3.3 0 0 1 17 18z" />
    </>
  ),
  format: (
    <>
      <path d="M4 19 10 5l6 14M6.5 14h7" />
      <path d="M16 19h5" />
    </>
  ),
  page: (
    <>
      <path d="M6 2h9l5 5v15H6z" />
      <path d="M15 2v5h5" />
    </>
  ),
  styles: (
    <>
      <path d="M4 5h16M4 10h10M4 15h16M4 20h10" />
      <path d="M18 8v8M16 10l2-2 2 2" />
    </>
  ),
  property: (
    <>
      <path d="M5 6h14M5 12h14M5 18h14" />
      <circle cx="9" cy="6" r="1.8" />
      <circle cx="15" cy="12" r="1.8" />
      <circle cx="8" cy="18" r="1.8" />
    </>
  ),
  bookmark: (
    <>
      <path d="M6 3h12v18l-6-4-6 4z" />
    </>
  ),
  theme: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16M4 12h16" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
