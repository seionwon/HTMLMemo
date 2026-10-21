export const PREFERENCES_KEY = 'htmlmemo-preferences-v1';
export const SETTINGS_FORMAT = 'HTMLMemo.settings';
export const PRESET_COLORS = Object.freeze([
  '#edcf67', '#fde047', '#f59e0b', '#f97316', '#da8b55',
  '#ef4444', '#f39da2', '#ec4899', '#d946ef', '#bdace0',
  '#8b5cf6', '#6366f1', '#3b82f6', '#9fc8f0', '#06b6d4',
  '#14b8a6', '#77bdab', '#22c55e', '#366558', '#374151',
]);
export const PRESET_PALETTES = Object.freeze([
  Object.freeze({id:'preset-1',name:'기본 20색 팔레트',colors:PRESET_COLORS}),
  Object.freeze({id:'preset-2',name:'형광펜 베스트',colors:Object.freeze(['#edcf67','#fde047','#a7f3d0','#77bdab','#9fc8f0','#bdace0','#f39da2','#fdba74'])}),
  Object.freeze({id:'preset-3',name:'따뜻한 필기',colors:Object.freeze(['#edcf67','#f59e0b','#f97316','#da8b55','#ef4444','#e11d48','#9a3412','#78350f'])}),
  Object.freeze({id:'preset-4',name:'차분한 블루·그린',colors:Object.freeze(['#9fc8f0','#38bdf8','#3b82f6','#1d4ed8','#77bdab','#14b8a6','#366558','#1e293b'])}),
  Object.freeze({id:'preset-5',name:'파스텔 노트',colors:Object.freeze(['#fef08a','#fed7aa','#fbcfe8','#f39da2','#e9d5ff','#bdace0','#bae6fd','#a7f3d0'])}),
  Object.freeze({id:'preset-6',name:'선명한 강조',colors:Object.freeze(['#eab308','#f97316','#ef4444','#ec4899','#8b5cf6','#3b82f6','#06b6d4','#22c55e'])}),
  Object.freeze({id:'preset-7',name:'논문·교재 마킹',colors:Object.freeze(['#fde047','#86efac','#7dd3fc','#c4b5fd','#fda4af','#dc2626','#2563eb','#1e293b'])}),
  Object.freeze({id:'preset-8',name:'포레스트 데스크',colors:Object.freeze(['#d9f99d','#84cc16','#22c55e','#15803d','#77bdab','#366558','#57534e','#292524'])}),
  Object.freeze({id:'preset-9',name:'오션 브리즈',colors:Object.freeze(['#cffafe','#67e8f9','#06b6d4','#0284c7','#3b82f6','#1d4ed8','#312e81','#0f172a'])}),
  Object.freeze({id:'preset-10',name:'선셋 글로우',colors:Object.freeze(['#fde68a','#fbbf24','#fb923c','#f97316','#ef4444','#ec4899','#a855f7','#581c87'])}),
  Object.freeze({id:'preset-11',name:'베리·바이올렛',colors:Object.freeze(['#fbcfe8','#f472b6','#ec4899','#be185d','#e9d5ff','#c084fc','#8b5cf6','#4c1d95'])}),
  Object.freeze({id:'preset-12',name:'어스·세피아',colors:Object.freeze(['#f5ebe0','#e6ccb2','#ddb892','#da8b55','#b08968','#7f5539','#9c6644','#432818'])}),
  Object.freeze({id:'preset-13',name:'모노크롬·그레이',colors:Object.freeze(['#e2e8f0','#cbd5e1','#94a3b8','#64748b','#475569','#374151','#1f2937','#0f172a'])}),
  Object.freeze({id:'preset-14',name:'네온 팝',colors:Object.freeze(['#facc15','#a3e635','#4ade80','#2dd4bf','#38bdf8','#818cf8','#e879f9','#fb7185'])}),
  Object.freeze({id:'preset-15',name:'빈티지 북',colors:Object.freeze(['#e9c46a','#f4a261','#e76f51','#2a9d8f','#264653','#8ab17d','#b5838d','#6d6875'])}),
  Object.freeze({id:'preset-16',name:'스프링 가든',colors:Object.freeze(['#fef08a','#bef264','#86efac','#5eead4','#93c5fd','#f9a8d4','#fda4af','#fdba74'])}),
  Object.freeze({id:'preset-17',name:'어텀 리프',colors:Object.freeze(['#eab308','#d97706','#ea580c','#dc2626','#991b1b','#78350f','#65a30d','#3f6212'])}),
  Object.freeze({id:'preset-18',name:'다크 모드 필기',colors:Object.freeze(['#fde047','#facc15','#4ade80','#2dd4bf','#38bdf8','#a78bfa','#f472b6','#fb923c'])}),
  Object.freeze({id:'preset-19',name:'미니멀 잉크',colors:Object.freeze(['#111827','#374151','#dc2626','#2563eb','#16a34a','#d97706','#7c3aed','#0891b2'])}),
  Object.freeze({id:'preset-20',name:'레인보우 컬렉션',colors:Object.freeze(['#ef4444','#f97316','#f59e0b','#eab308','#84cc16','#22c55e','#06b6d4','#3b82f6','#6366f1','#a855f7'])}),
]);
export const DEFAULT_PREFERENCES = Object.freeze({theme:'light',librarySort:'modified',librarySortDirection:'desc',libraryView:'card',annotation:Object.freeze({color:'#edcf67',width:3,opacity:.35,penTTL:0}),toolbarPosition:null});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/^#/, '');
  if (/^[\da-f]{3}$/i.test(raw)) return '#' + raw.split('').map(ch => ch + ch).join('').toLowerCase();
  if (/^[\da-f]{6}$/i.test(raw)) return '#' + raw.toLowerCase();
  return null;
}
export function hexToRgb(hex) {
  const norm = normalizeHexColor(hex) || '#edcf67';
  const num = Number.parseInt(norm.slice(1), 16);
  return {r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255};
}
export function rgbToHex({r, g, b}) {
  const byte = n => Math.max(0, Math.min(255, Math.round(Number(n) || 0))).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}
export function rgbToHsv({r, g, b}) {
  const rn = Math.max(0, Math.min(255, Number(r) || 0)) / 255;
  const gn = Math.max(0, Math.min(255, Number(g) || 0)) / 255;
  const bn = Math.max(0, Math.min(255, Number(b) || 0)) / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  return {h: Math.round(h) % 360, s: Math.round((max === 0 ? 0 : d / max) * 100), v: Math.round(max * 100)};
}
export function hsvToRgb({h, s, v}) {
  const hn = ((Number(h) % 360) + 360) % 360;
  const sn = Math.max(0, Math.min(100, Number(s) || 0)) / 100;
  const vn = Math.max(0, Math.min(100, Number(v) || 0)) / 100;
  const c = vn * sn, x = c * (1 - Math.abs(((hn / 60) % 2) - 1)), m = vn - c;
  let rp = 0, gp = 0, bp = 0;
  if (hn < 60) [rp, gp, bp] = [c, x, 0];
  else if (hn < 120) [rp, gp, bp] = [x, c, 0];
  else if (hn < 180) [rp, gp, bp] = [0, c, x];
  else if (hn < 240) [rp, gp, bp] = [0, x, c];
  else if (hn < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return {r: Math.round((rp + m) * 255), g: Math.round((gp + m) * 255), b: Math.round((bp + m) * 255)};
}
export function hexToHsv(hex) { return rgbToHsv(hexToRgb(hex)); }
export function hsvToHex(hsv) { return rgbToHex(hsvToRgb(hsv)); }
export function normalizePreferences(value = {}) {
  if (!object(value)) throw new Error('설정 내용이 올바르지 않습니다.');
  const theme=value.theme??DEFAULT_PREFERENCES.theme, librarySort=value.librarySort??DEFAULT_PREFERENCES.librarySort, libraryView=value.libraryView??DEFAULT_PREFERENCES.libraryView;
  const librarySortDirection=value.librarySortDirection??(librarySort==='title'?'asc':'desc');
  if(!['light','dark','system'].includes(theme)||!['modified','created','title'].includes(librarySort)||!['asc','desc'].includes(librarySortDirection)||!['card','list'].includes(libraryView))throw new Error('테마 또는 서재 보기 설정이 올바르지 않습니다.');
  if(value.annotation!==undefined&&!object(value.annotation))throw new Error('주석 도구 설정이 올바르지 않습니다.');
  const input=value.annotation||{}, defaults=DEFAULT_PREFERENCES.annotation;
  const annotation={color:typeof input.color==='string'?input.color.toLowerCase():defaults.color,width:input.width??defaults.width,opacity:input.opacity??defaults.opacity,penTTL:input.penTTL??defaults.penTTL};
  if(!/^#[\da-f]{6}$/i.test(annotation.color)||!Number.isFinite(annotation.width)||annotation.width<1||annotation.width>18||!Number.isFinite(annotation.opacity)||annotation.opacity<.1||annotation.opacity>.9||![0,3,10,30].includes(annotation.penTTL))throw new Error('주석 색상·굵기·투명도·표시 시간 설정이 올바르지 않습니다.');
  if (input.paletteId !== undefined) {
    if (typeof input.paletteId !== 'string' || !/^[\w-]{1,64}$/.test(input.paletteId)) throw new Error('팔레트 설정이 올바르지 않습니다.');
    annotation.paletteId = input.paletteId;
  }
  if (input.customColors !== undefined) {
    if (!Array.isArray(input.customColors) || input.customColors.length > 64 || input.customColors.some(c => typeof c !== 'string' || !/^#[\da-f]{6}$/i.test(c))) throw new Error('사용자 색상 목록이 올바르지 않습니다.');
    annotation.customColors = [...new Set(input.customColors.map(c => c.toLowerCase()))];
  }
  if (input.customPalettes !== undefined) {
    if (!Array.isArray(input.customPalettes) || input.customPalettes.length > 40) throw new Error('사용자 팔레트 목록이 올바르지 않습니다.');
    annotation.customPalettes = input.customPalettes.map(p => {
      if (!object(p) || typeof p.id !== 'string' || !/^[\w-]{1,64}$/.test(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 60 || !Array.isArray(p.colors) || !p.colors.length || p.colors.length > 32 || p.colors.some(c => typeof c !== 'string' || !/^#[\da-f]{6}$/i.test(c))) throw new Error('사용자 팔레트 형식이 올바르지 않습니다.');
      return {id: p.id, name: p.name.trim(), colors: [...new Set(p.colors.map(c => c.toLowerCase()))]};
    });
  }
  let toolbarPosition=null;
  if(value.toolbarPosition!==null&&value.toolbarPosition!==undefined){const p=value.toolbarPosition;if(!object(p)||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new Error('툴바 위치 설정이 올바르지 않습니다.');toolbarPosition={x:p.x,y:p.y};}
  return {theme,librarySort,librarySortDirection,libraryView,annotation,toolbarPosition};
}
export function loadPreferences(storage) {
  const saved=storage.getItem(PREFERENCES_KEY);
  return saved?normalizePreferences(JSON.parse(saved)):normalizePreferences({theme:storage.getItem('htmlmemo-theme')||'light'});
}
export function storePreferences(value,storage) {
  const preferences=normalizePreferences(value);storage.setItem(PREFERENCES_KEY,JSON.stringify(preferences));storage.setItem('htmlmemo-theme',preferences.theme);return preferences;
}
export function serializeSettings(preferences,folderName='') {
  return JSON.stringify({format:SETTINGS_FORMAT,version:1,storage:'local',savedAt:new Date().toISOString(),preferences:normalizePreferences(preferences),folderName:String(folderName).slice(0,255)},null,2)+'\n';
}
export function parseSettings(text) {
  if(typeof text!=='string'||text.length>131072)throw new Error('설정 파일은 128KB 이하의 JSON 파일이어야 합니다.');
  let input;try{input=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new Error('설정 JSON 파일을 읽을 수 없습니다.');}
  if(!object(input)||input.format!==SETTINGS_FORMAT||input.version!==1||input.storage!=='local'||!object(input.preferences))throw new Error('지원하는 HTMLMemo 로컬 설정 파일이 아닙니다.');
  if(input.folderName!==undefined&&(typeof input.folderName!=='string'||input.folderName.length>255))throw new Error('저장 폴더 정보가 올바르지 않습니다.');
  return {preferences:normalizePreferences(input.preferences),folderName:input.folderName||''};
}
export async function readSettingsFile(input) {
  const file=input?.kind==='file'?await input.getFile():input;
  if(!file||file.size>131072||typeof file.text!=='function')throw new Error('128KB 이하의 설정 JSON 파일을 선택해주세요.');
  return parseSettings(await file.text());
}
