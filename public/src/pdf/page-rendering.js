// Adapted from PDFMemo overrides/PdfPageRendering.ts; presentation remains HTMLMemo-owned.
const queues = new WeakMap();
const aborted = () => new DOMException('Page no longer needed', 'AbortError');
export class PdfRenderQueue {
    pending = [];
    running = new Set();
    scheduled = false;
    schedule(priority, signal, run) {
        if (signal.aborted)
            return Promise.reject(aborted());
        return new Promise((resolve, reject) => {
            const job = { priority, signal, run, resolve, reject, abort: () => {
                    const index = this.pending.indexOf(job);
                    if (index >= 0) {
                        this.pending.splice(index, 1);
                        signal.removeEventListener('abort', job.abort);
                        reject(aborted());
                        this.wake();
                    }
                    // Running PDF.js work owns its cancellation and releases its
                    // slot only after the render task has actually finished.
                } };
            signal.addEventListener('abort', job.abort, { once: true });
            this.pending.push(job);
            this.wake();
        });
    }
    wake() {
        if (this.scheduled)
            return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            this.pending.sort((a, b) => a.priority() - b.priority());
            while (this.running.size < 2 && this.pending.length) {
                const backgroundBusy = [...this.running].some(job => job.priority() > 0);
                const index = this.pending.findIndex(job => !backgroundBusy || job.priority() === 0);
                if (index < 0)
                    break;
                const [job] = this.pending.splice(index, 1);
                this.running.add(job);
                Promise.resolve().then(() => {
                    if (job.signal.aborted)
                        throw aborted();
                    return job.run();
                }).then(job.resolve, job.reject).finally(() => {
                    job.signal.removeEventListener('abort', job.abort);
                    this.running.delete(job);
                    this.wake();
                });
            }
        });
    }
}
export function pdfRenderQueue(doc) {
    let queue = queues.get(doc);
    if (!queue) {
        queue = new PdfRenderQueue();
        queues.set(doc, queue);
    }
    return queue;
}
export const PDF_PREVIEW_PIXELS = 512 * 1024;
/** Own the rasters inside a stable page box. Never resize a displayed canvas. */
// HTMLMemo displays a Blob image in its script-free reader iframe. Chromium can
// retain an unpainted canvas compositor layer across the iframe's hidden opening
// phase even though its pixels are complete. The raster queue and budgets remain
// PDFMemo's; each published image owns one revocable, local URL.
export class PdfPageImage {
    canvas = null;
    image = null;
    url = null;
    revision = 0;
    disposed = false;
    constructor(element) { this.element = element; }
    discardCanvas(canvas) { if(canvas){canvas.remove();canvas.width=0;canvas.height=0;} }
    publish(canvas,width,height) {
        if(this.disposed){this.discardCanvas(canvas);return;}
        const revision=++this.revision;
        this.discardCanvas(this.canvas);this.canvas=canvas;
        Object.assign(canvas.style,{display:'none',width:width+'px',height:height+'px'});
        canvas.dataset.pdfRendered='true';this.element.prepend(canvas);
        this.element.style.width=width+'px';this.element.style.height=height+'px';
        canvas.toBlob(blob=>{
            if(!blob||this.disposed||this.revision!==revision)return;
            const url=URL.createObjectURL(blob),image=this.element.ownerDocument.createElement('img');
            image.alt='';image.draggable=false;image.dataset.pdfRaster='';
            Object.assign(image.style,{display:'block',position:'absolute',left:'0',top:'0',width:width+'px',height:height+'px',zIndex:'1',pointerEvents:'none'});
            image.onload=()=>{if(this.disposed||this.revision!==revision){URL.revokeObjectURL(url);image.remove();return;}this.image?.remove();if(this.url)URL.revokeObjectURL(this.url);this.url=url;this.image=image;};
            image.onerror=()=>{URL.revokeObjectURL(url);image.remove();};
            image.src=url;this.element.prepend(image);
        },'image/png');
    }
    dispose() { this.disposed=true;this.revision++;this.discardCanvas(this.canvas);this.canvas=null;this.image?.remove();this.image=null;if(this.url)URL.revokeObjectURL(this.url);this.url=null; }
}

/** Paint a small complete image first, then replace it atomically with detail. */
export async function renderPdfPageImage({ doc, pageNumber, width, sliceTop, sliceBottom, rasterZoom, maxPixels, priority, signal, image, renderOptions, waitForIdle, onSize }) {
    const check = () => { if (signal.aborted)
        throw aborted(); };
    check();
    const page = await doc.getPage(pageNumber);
    check();
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const bandHeight = viewport.height * Math.max(1e-6, sliceBottom - sliceTop);
    const area = viewport.width * bandHeight;
    const budget = priority() > 0 ? Math.min(maxPixels, PDF_PREVIEW_PIXELS) : maxPixels;
    const detail = Math.min(Math.min(window.devicePixelRatio || 1, 2) * rasterZoom, Math.sqrt(budget / area));
    const canvas = image.canvas;
    const matchingSize = canvas && parseFloat(canvas.style.width) === viewport.width && parseFloat(canvas.style.height) === bandHeight;
    if (matchingSize && canvas.width >= Math.floor(viewport.width * detail) && canvas.height >= Math.floor(bandHeight * detail))
        return;
    const small = Math.min(detail, Math.sqrt(PDF_PREVIEW_PIXELS / area));
    const passes = !canvas && small < detail * .9 ? [small, detail] : [detail];
    for (const density of passes) {
        check();
        // Keep existing textures during finger/kinetic motion. Do not allocate
        // or draw their detail refresh until idle; new pages still get a preview
        // immediately and never wait behind a held render-queue slot.
        if (image.canvas)
            await waitForIdle();
        check();
        let buffer;
        try {
            await pdfRenderQueue(doc).schedule(priority, signal, async () => {
                check();
                buffer = image.element.ownerDocument.createElement('canvas');
                buffer.width = Math.max(1, Math.floor(viewport.width * density));
                buffer.height = Math.max(1, Math.floor(bandHeight * density));
                const context = buffer.getContext('2d');
                if (!context)
                    throw new Error('PDF canvas unavailable');
                // PDF.js paints the page background before applying this matrix.
                // Pre-scaling the context itself leaves transparent margins when
                // a preview is smaller than one CSS pixel per raster pixel.
                const task = page.render({ canvasContext: context, viewport,
                    transform: [density, 0, 0, density, 0, -sliceTop * viewport.height * density], ...renderOptions() });
                const cancel = () => task.cancel();
                signal.addEventListener('abort', cancel, { once: true });
                try {
                    await task.promise;
                }
                finally {
                    signal.removeEventListener('abort', cancel);
                }
            });
            check();
            if (image.canvas)
                await waitForIdle();
            check();
            image.publish(buffer, viewport.width, bandHeight);
            buffer = undefined; // The page now owns this fully painted texture.
            onSize(viewport.width, bandHeight);
        }
        finally {
            if (buffer) {
                buffer.width = 0;
                buffer.height = 0;
            }
        }
    }
}
