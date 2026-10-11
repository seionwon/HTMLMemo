export const FORMAT_VERSION = 1;
export const TEXT_TOOLS = ['highlight', 'underline', 'strike'];
export const DRAW_TOOLS = ['pen', 'rect', 'ellipse', 'arrow', 'area', 'area-underline'];
export function validateAnnotations(value) {
  if (!Array.isArray(value)) throw new Error('주석 데이터 형식이 올바르지 않습니다.');
  if (value.length > 20000) throw new Error('한 문서의 주석 수가 너무 많습니다.');
  const valid = [...TEXT_TOOLS, ...DRAW_TOOLS, 'note', 'text'];
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[\w-]{1,80}$/.test(item.id) || ids.has(item.id) || !valid.includes(item.type)) throw new Error('지원하지 않거나 손상된 주석입니다.');
    ids.add(item.id);
    if (!/^#[\da-f]{6}$/i.test(item.color)) throw new Error('주석 색상 형식이 올바르지 않습니다.');
    if (!Number.isFinite(item.width) || item.width < .1 || item.width > 100) throw new Error('주석 굵기가 올바르지 않습니다.');
    if (!Number.isFinite(item.opacity) || item.opacity < 0 || item.opacity > 1) throw new Error('주석 투명도가 올바르지 않습니다.');
    if (TEXT_TOOLS.includes(item.type)) {
      const a = item.textAnchor;
      if (!a || typeof a.quote !== 'string' || !a.quote.length || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start < 0 || a.end <= a.start || a.quote.length > 200000) throw new Error('주석의 텍스트 위치가 손상되었습니다.');
    } else {
      if (!Array.isArray(item.points) || !item.points.length || item.points.length > 100000 || item.points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e8 || Math.abs(p.y) > 1e8)) throw new Error('주석 좌표가 올바르지 않습니다.');
      if (item.anchor && !/^(body|n\d+)$/.test(item.anchor)) throw new Error('주석의 문서 위치가 손상되었습니다.');
    }
    if (item.text != null && (typeof item.text !== 'string' || item.text.length > 10000)) throw new Error('메모가 너무 길거나 올바르지 않습니다.');
    return structuredClone(item);
  });
}
export class History {
  constructor(initial = []) { this.entries = [structuredClone(initial)]; this.index = 0; }
  commit(value) { this.entries.splice(this.index + 1); this.entries.push(structuredClone(value)); if (this.entries.length > 101) this.entries.shift(); this.index = this.entries.length - 1; return this.current; }
  get current() { return structuredClone(this.entries[this.index]); }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }
  undo() { if (this.canUndo) this.index--; return this.current; }
  redo() { if (this.canRedo) this.index++; return this.current; }
}
// A single writer per document. Edits arriving during a disk write are drained
// before flush resolves; callers never overwrite a newer edit with an old one.
export class SaveQueue {
  constructor(write, report = () => {}) { this.write = write; this.report = report; this.revision = 0; this.saved = 0; this.error = null; this.running = null; this.timer = null; }
  schedule() { this.revision++; this.error = null; this.report(this); clearTimeout(this.timer); this.timer = setTimeout(() => { this.flush().catch(() => {}); }, 300); }
  async flush() {
    clearTimeout(this.timer);
    if (this.running) { await this.running; if (this.saved < this.revision) return this.flush(); return; }
    this.running = (async () => {
      try {
        while (this.saved < this.revision) { const next = this.revision; await this.write(next); this.saved = next; this.error = null; this.report(this); }
      } catch (error) { this.error = error; this.report(this); throw error; }
    })();
    try { await this.running; } finally { this.running = null; }
  }
  get pending() { return this.saved < this.revision; }
}
