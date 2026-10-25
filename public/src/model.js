export const FORMAT_VERSION = 1;
export const TEXT_TOOLS = ['highlight', 'underline', 'strike'];
export const DRAW_TOOLS = ['pen', 'rect', 'ellipse', 'arrow', 'area', 'area-underline'];
export const ANNOTATION_LABELS = {pen:'펜 그림',highlight:'형광펜',underline:'밑줄',strike:'취소선',note:'메모',text:'텍스트',rect:'사각형',ellipse:'타원',arrow:'화살표',area:'영역 강조','area-underline':'영역 밑줄'};
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
      if (item.anchor && !/^(body|n\d+|js\d+)$/.test(item.anchor)) throw new Error('주석의 문서 위치가 손상되었습니다.');
      if (item.penBasis != null) {
        const basis = item.penBasis;
        if (item.type !== 'pen' || !item.anchor || typeof basis !== 'object' ||
          ['width','height'].some(key=>!Number.isFinite(basis[key]) || basis[key] < 1 || basis[key] > 1e8) ||
          !Number.isFinite(basis.fontSize) || basis.fontSize < .1 || basis.fontSize > 1000) throw new Error('펜 그림의 글자 크기 기준이 손상되었습니다.');
        if(basis.textAnchor != null){
          const a=basis.textAnchor;
          if(!a || typeof a!=='object' || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start<0 || a.end<=a.start || a.end>1e8 ||
            typeof a.quote!=='string' || !a.quote.length || a.quote.length>16 || a.end-a.start!==a.quote.length ||
            ['prefix','suffix'].some(key=>typeof a[key]!=='string' || a[key].length>40) ||
            ['x','y'].some(key=>!Number.isFinite(a[key]) || Math.abs(a[key])>1e8) ||
            !Number.isFinite(a.fontSize) || a.fontSize<.1 || a.fontSize>1000) throw new Error('펜 그림의 글자 기준 위치가 손상되었습니다.');
        }
      }
      if (item.anchorTarget != null) {
        const target = item.anchorTarget;
        if (!target || typeof target !== 'object' || !/^[a-z][a-z0-9-]{0,63}$/.test(target.tag) ||
          ['id','rootId','section'].some(key=>typeof target[key] !== 'string' || target[key].length > 1000) ||
          typeof target.quote !== 'string' || target.quote.length > 160 ||
          !Array.isArray(target.path) || target.path.length > 64 || target.path.some(index=>!Number.isSafeInteger(index) || index < 0 || index > 1000000)) throw new Error('주석의 본문 기준 위치가 손상되었습니다.');
      }
    }
    if (!TEXT_TOOLS.includes(item.type) && item.textAnchor != null && (typeof item.textAnchor?.quote !== 'string' || item.textAnchor.quote.length > 200000)) throw new Error('메모의 대상 문장이 손상되었습니다.');
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
  constructor(write, report = () => {}) { this.write = write; this.report = report; this.revision = 0; this.editRevision = 0; this.saved = 0; this.error = null; this.running = null; this.timer = null; }
  schedule({background = false} = {}) {
    this.revision++;
    if (!background) { this.editRevision = this.revision; this.error = null; this.report(this); }
    // Reading position is saved quietly after a pause. It must never delay an edit.
    if (background && this.editsPending) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.flush().catch(() => {}); }, background ? 2000 : 300);
  }
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
  get editsPending() { return this.saved < this.editRevision; }
}

// Independent from fast autosave. One event-driven timer per edited document;
// reading and pointer motion outside annotation input never start a timer.
export class AnnotationCheckpoints {
  constructor(write,report=()=>{},{now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),interval=300000,idle=60000}={}) {
    Object.assign(this,{write,report,now,setTimer,clearTimer,interval,idle});
    this.revision=0;this.saved=0;this.started=0;this.lastInput=0;this.timer=null;this.due=0;this.running=null;this.error=null;this.disposed=false;
  }
  get pending(){return this.saved<this.revision;}
  schedule(){if(this.disposed)return;if(!this.pending||this.error)this.started=this.now();this.revision++;this.error=null;this.activity();}
  activity(){if(!this.pending||this.disposed)return;this.lastInput=this.now();this.arm();}
  arm(){
    if(!this.pending||this.disposed||this.error||this.running)return;
    const due=Math.min(this.started+this.interval,this.lastInput+this.idle);
    // Keep an earlier wake-up rather than recreating timers for every pen point.
    if(this.timer!==null&&this.due<=due)return;
    if(this.timer!==null)this.clearTimer(this.timer);this.due=due;
    this.timer=this.setTimer(()=>{this.timer=null;if(this.now()<Math.min(this.started+this.interval,this.lastInput+this.idle))this.arm();else void this.flush().catch(()=>{});},Math.max(0,due-this.now()));
  }
  async flush({force=false}={}){
    if(this.disposed)return;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
    if(this.running){await this.running;if(force||this.pending)return this.flush({force});return;}
    if(!force&&!this.pending)return;
    this.running=(async()=>{
      try{
        do{const next=this.revision;await this.write();this.saved=next;this.error=null;}while(force&&this.pending);
        if(this.pending)this.started=this.now();this.report(this);
      }catch(error){this.error=error;this.report(this);throw error;}
    })();
    try{await this.running;}finally{this.running=null;this.arm();}
  }
  dispose(){this.disposed=true;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
}
