export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const uid = () => crypto.randomUUID();
export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
export function filename(title) { return (title || '웹 페이지').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.+$/g, '').slice(0, 100).trim() + '.html'; }
export function normalizeURL(input) {
  const value = input.trim();
  if (!value) throw new Error('웹 주소를 입력해주세요.');
  if (/^(https?:\/\/)/i.test(value)) { const url = new URL(value); if (url.username || url.password) throw new Error('사용자 정보가 포함된 주소는 사용할 수 없습니다.'); return url.href; }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^localhost:\d+/i.test(value)) throw new Error('http 또는 https 주소를 입력해주세요.');
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(value)) return new URL('http://' + value).href;
  if (/^[^\s/]+\.[^\s/]+/.test(value) && !/\s/.test(value)) return new URL('https://' + value).href;
  return 'https://www.google.com/search?q=' + encodeURIComponent(value);
}
export function displayHost(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '로컬 HTML'; } }
export function formatDate(time) { return new Intl.DateTimeFormat('ko', {month:'short', day:'numeric'}).format(time); }
export function formatBytes(bytes) { return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB'; }
export function download(content, name, type = 'text/html;charset=utf-8') {
  const href = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement('a'); a.href = href; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(href), 30000);
}
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="m14 6-6 6 6 6M8 12h13"/>', forward: '<path d="m10 6 6 6-6 6M3 12h13"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2 7M20 4v7h-7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a19 19 0 0 1 0 18 19 19 0 0 1 0-18"/>',
  library: '<path d="M4 4h4v16H4zM11 4h4v16h-4zM18 4l4 15-3 1-4-15z"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2zM7 3v6h10V3M7 21v-8h10v8"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  select: '<path d="m5 3 14 10-7 1-4 7z"/>',
  pen: '<path d="m16 3 5 5L8 21l-6 1 1-6zM13 6l5 5M3 16l5 5"/>',
  highlight: '<path d="m14 3 7 7-8 8-7-7zM6 11l-3 7 3 3 7-3M2 22h13"/>',
  underline: '<path d="M6 4v7a6 6 0 0 0 12 0V4M4 21h16"/>',
  strike: '<path d="M17 6c-2-4-11-4-11 1 0 2 3 3 6 4M7 18c3 4 11 3 11-2 0-1-1-2-2-3M3 12h18"/>',
  eraser: '<path d="m14 3 7 7-10 11H5l-4-4zM7 11l7 7M11 21h11"/>',
  undo: '<path d="M9 4 3 10l6 6M3 10h10a7 7 0 0 1 7 7v3"/>',
  redo: '<path d="m15 4 6 6-6 6M21 10h-10a7 7 0 0 0-7 7v3"/>',
  note: '<path d="M21 14V3H3v18h11zM14 21v-7h7M7 8h10M7 12h5"/>',
  text: '<path d="M3 5h18M12 5v16M8 21h8M3 5v3M21 5v3"/>',
  shapes: '<rect x="3" y="3" width="11" height="11" rx="1"/><circle cx="16" cy="16" r="6"/>',
  rect: '<rect x="3" y="5" width="18" height="14" rx="1"/>', ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  arrow: '<path d="m4 20 16-16M9 4h11v11"/>', area: '<rect x="3" y="5" width="18" height="14" fill="currentColor" opacity=".2"/><rect x="3" y="5" width="18" height="14" stroke-dasharray="3 3"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18h1c3 0 3-3 1-4s-1-3 1-3h3c5 0 2-11-6-11z"/><circle cx="7" cy="10" r=".6"/><circle cx="10" cy="6" r=".6"/><circle cx="15" cy="7" r=".6"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  external: '<path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7"/>',
  check: '<path d="m4 12 5 5L20 6"/>', trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  zoom: '<circle cx="10" cy="10" r="7"/><path d="M10 6v8M6 10h8M15 15l7 7"/>',
  minus: '<path d="M5 12h14"/>', moon: '<path d="M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M20 4l-2 2M6 18l-2 2"/>',
  grip: '<path d="M8 6h.01M16 6h.01M8 12h.01M16 12h.01M8 18h.01M16 18h.01" stroke-width="3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>', print: '<path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 14h12v7H6z"/>',
};
export const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
