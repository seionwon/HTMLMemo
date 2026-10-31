// Adapted from PDFMemo/mobile/overrides/pdfViewportWindow.ts.
// Logical page positions stay in document coordinates. Only the scrollable CSS
// surface is windowed, keeping even an 800% view below Chromium's height limit.
export const PDF_SCROLL_WINDOW_HEIGHT = 900_000;
export const pdfScrollWindows = new WeakMap();
// A retained pinch uses the very same transform for subsequent vertical travel.
// Its range is the whole document, independent of the old native scroll box.
export const pdfPreviewScrolls = new WeakMap();
export const pdfScrollSurface = (scroller) => pdfPreviewScrolls.get(scroller) ?? scroller;
export function pdfWindowBase(total, current, pageTop) {
    const max = Math.max(0, total - PDF_SCROLL_WINDOW_HEIGHT);
    if (!max)
        return 0;
    const wanted = pageTop === undefined ? current : pageTop - PDF_SCROLL_WINDOW_HEIGHT * .25;
    return Math.max(0, Math.min(max, wanted));
}
export function pdfWindowScrollTop(scrollTop, oldBase, newBase, zoom) {
    return scrollTop + (oldBase - newBase) * zoom;
}
