/**
 * Paginated print preview.
 *
 * Preferred path: GET /api/render?format=html from the server's layout renderer.
 * When that endpoint is unavailable the view paginates locally by measuring the
 * rendered height of every block — an approximation that is labelled as such,
 * never presented as server output.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Block, DocDocument, Section } from "@dsh-doc/core/model";
import type { AppSnapshot, AppStore } from "../app/state";
import { ApiError, errorMessage } from "../app/api";
import { createRenderContext, ptToPx, renderBlock } from "../model/dom";
import { listLabels } from "../model/ops";
import { paginateBlocks, type PreviewPage } from "./pagination";

interface PreviewViewProps {
  store: AppStore;
  snapshot: AppSnapshot;
}

interface SectionPageGeometry {
  widthPt: number;
  heightPt: number;
  paddingPt: { top: number; right: number; bottom: number; left: number };
  contentWidthPt: number;
  contentHeightPt: number;
}

function geometryFor(section: Section | undefined): SectionPageGeometry {
  const page = section?.page;
  const widthPt = page?.width ?? 595.3;
  const heightPt = page?.height ?? 841.9;
  const margins = page?.margins ?? {
    top: 72,
    right: 72,
    bottom: 72,
    left: 72,
    header: 36,
    footer: 36,
    gutter: 0,
  };
  return {
    widthPt,
    heightPt,
    paddingPt: {
      top: margins.top,
      right: margins.right,
      bottom: margins.bottom,
      left: margins.left,
    },
    contentWidthPt: Math.max(72, widthPt - margins.left - margins.right),
    contentHeightPt: Math.max(72, heightPt - margins.top - margins.bottom),
  };
}

function blockHasPageBreak(block: Block): boolean {
  if (block.type !== "paragraph") return false;
  return block.inlines.some(
    (inline) => inline.type === "break" && inline.kind === "page",
  );
}

export function PreviewView({
  store,
  snapshot,
}: PreviewViewProps): React.JSX.Element {
  const zoom = snapshot.ui.zoom;
  const model: DocDocument = snapshot.document;
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [pages, setPages] = useState<PreviewPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [serverStatus, setServerStatus] = useState<
    "idle" | "loading" | "ready" | "unavailable"
  >("idle");
  const [serverHtml, setServerHtml] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverPageCount, setServerPageCount] = useState<number | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const context = useMemo(
    () =>
      createRenderContext(model, { zoom: 1, listLabels: listLabels(model) }),
    // The model is mutated in place; documentVersion drives recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, snapshot.documentVersion],
  );

  const measureEntries = useMemo(() => {
    const entries: Array<{
      block: Block;
      sectionIndex: number;
      forceBreakBefore: boolean;
    }> = [];
    let previousHadPageBreak = false;
    model.sections.forEach((section, sectionIndex) => {
      section.blocks.forEach((block) => {
        entries.push({
          block,
          sectionIndex,
          forceBreakBefore:
            previousHadPageBreak ||
            (sectionIndex > 0 && section.breakBefore !== "continuous"),
        });
        previousHadPageBreak = blockHasPageBreak(block);
      });
    });
    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, snapshot.documentVersion]);

  const measure = useCallback((): void => {
    const root = measureRef.current;
    if (!root) return;
    const wrappers = Array.from(
      root.querySelectorAll<HTMLElement>("[data-measure-block]"),
    );
    const measured = wrappers.map((wrapper, index) => {
      const style = window.getComputedStyle(
        wrapper.firstElementChild ?? wrapper,
      );
      const marginTop = Number.parseFloat(style.marginTop || "0") || 0;
      const marginBottom = Number.parseFloat(style.marginBottom || "0") || 0;
      const heightPx =
        (
          wrapper.firstElementChild as HTMLElement | null
        )?.getBoundingClientRect().height ?? 0;
      const entry = measureEntries[index];
      return {
        block: entry.block,
        sectionIndex: entry.sectionIndex,
        heightPt: ((heightPx + marginTop + marginBottom) * 72) / 96,
        forceBreakBefore: entry.forceBreakBefore,
      };
    });
    const next = paginateBlocks(
      measured,
      (sectionIndex) =>
        geometryFor(model.sections[sectionIndex]).contentHeightPt,
    );
    setPages((previous) => {
      const same =
        previous.length === next.length &&
        previous.every(
          (page, index) =>
            page.sectionIndex === next[index].sectionIndex &&
            page.blocks.length === next[index].blocks.length &&
            page.blocks.every(
              (block, blockIndex) =>
                block.id === next[index].blocks[blockIndex]?.id,
            ),
        );
      return same ? previous : next;
    });
  }, [measureEntries, model.sections]);

  useLayoutEffect(() => {
    measure();
  }, [measure, snapshot.documentVersion, zoom]);

  useEffect(() => {
    setPageIndex((index) => Math.min(index, Math.max(0, pages.length - 1)));
  }, [pages.length]);

  // Server-side render attempt (never silently replaced by the approximation).
  useEffect(() => {
    let cancelled = false;
    setServerStatus("loading");
    setServerHtml(null);
    setServerError(null);
    setServerPageCount(null);
    store.api
      .render("html")
      .then(async (response) => {
        const text = await response.text();
        if (cancelled) return;
        setServerHtml(text);
        setServerStatus("ready");
        try {
          const parsed = new DOMParser().parseFromString(text, "text/html");
          const markers = parsed.querySelectorAll(
            "[data-page-number], .page, .dsh-page",
          );
          setServerPageCount(markers.length > 0 ? markers.length : null);
        } catch {
          setServerPageCount(null);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setServerStatus("unavailable");
        if (error instanceof ApiError) {
          setServerError(
            `${error.message}${error.code ? ` (${error.code})` : ""}`,
          );
        } else {
          setServerError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
    // Re-request when the user asks for a refresh; the server render is based on
    // its own copy of the document, so document changes do not trigger refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const currentPage = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))];
  const geometry = geometryFor(model.sections[currentPage?.sectionIndex ?? 0]);
  const totalPages = pages.length;
  const approximation = serverStatus !== "ready";

  return (
    <div className="preview-view">
      <div
        className="preview-toolbar"
        role="toolbar"
        aria-label="Print preview controls"
      >
        <div className="preview-group">
          <button
            type="button"
            className="button small"
            onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            disabled={pageIndex <= 0}
            aria-label="Previous page"
          >
            ←
          </button>
          <span className="preview-page-count" aria-live="polite">
            Page {Math.min(pageIndex + 1, Math.max(1, totalPages))} of{" "}
            {totalPages}
          </span>
          <button
            type="button"
            className="button small"
            onClick={() =>
              setPageIndex((index) => Math.min(totalPages - 1, index + 1))
            }
            disabled={pageIndex >= totalPages - 1}
            aria-label="Next page"
          >
            →
          </button>
        </div>
        <div className="preview-group">
          <label htmlFor="preview-zoom">Zoom</label>
          <select
            id="preview-zoom"
            value={String(zoom)}
            onChange={(event) => store.setZoom(Number(event.target.value))}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={String(value)}>
                {Math.round(value * 100)}%
              </option>
            ))}
          </select>
        </div>
        <div className="preview-group">
          <button
            type="button"
            className="button small"
            onClick={() => setRefreshToken((token) => token + 1)}
          >
            Re-check server renderer
          </button>
          <button
            type="button"
            className="button primary small"
            onClick={() => window.print()}
          >
            Print
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => store.setView("editor")}
          >
            Back to editor
          </button>
        </div>
      </div>

      {approximation ? (
        <div className="notice notice-warning" role="status">
          <strong>Server renderer unavailable.</strong>{" "}
          {serverError ? `${serverError}. ` : ""}
          This preview is a <em>client-side approximation</em>: pages are packed
          from the measured height of each block. Blocks that do not fit move
          whole to the next page, so lines, table rows, footnotes and floating
          objects are not split the way the layout engine would split them.
        </div>
      ) : (
        <div className="notice notice-info" role="status">
          Rendered by the server’s layout engine (GET /api/render?format=html).
          {serverPageCount === null
            ? " The renderer did not report a page count."
            : ` ${serverPageCount} page(s).`}
        </div>
      )}

      {serverStatus === "ready" && serverHtml ? (
        <div className="preview-server-frame">
          <iframe
            title="Server-rendered document preview"
            sandbox=""
            srcDoc={serverHtml}
            style={{
              width: "100%",
              height: `${Math.round(ptToPx(geometry.heightPt, zoom))}px`,
            }}
          />
        </div>
      ) : (
        <div className="preview-pages">
          {currentPage ? (
            <div
              className="preview-page"
              style={{
                width: `${ptToPx(geometry.widthPt, zoom)}px`,
                minHeight: `${ptToPx(geometry.heightPt, zoom)}px`,
                padding: `${ptToPx(geometry.paddingPt.top, zoom)}px ${ptToPx(geometry.paddingPt.right, zoom)}px ${ptToPx(
                  geometry.paddingPt.bottom,
                  zoom,
                )}px ${ptToPx(geometry.paddingPt.left, zoom)}px`,
              }}
            >
              <div
                className="preview-page-inner"
                style={{ width: `${ptToPx(geometry.contentWidthPt, zoom)}px` }}
              >
                {currentPage.blocks.length === 0 ? (
                  <p className="preview-empty">This page is empty.</p>
                ) : (
                  currentPage.blocks.map((block) =>
                    renderBlock(block, { ...context, zoom }),
                  )
                )}
              </div>
            </div>
          ) : (
            <p className="preview-empty">Measuring the document…</p>
          )}
        </div>
      )}

      <div className="preview-debug" aria-hidden="true">
        <div
          ref={measureRef}
          className="preview-measure"
          style={{ width: `${ptToPx(geometry.contentWidthPt, 1)}px` }}
        >
          {measureEntries.map((entry) => (
            <div key={`measure-${entry.block.id}`} data-measure-block="">
              {renderBlock(entry.block, context)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
