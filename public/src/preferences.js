export const PREFERENCES_KEY = 'htmlmemo-preferences-v1';
export const SETTINGS_FORMAT = 'HTMLMemo.settings';
export const DEFAULT_PREFERENCES = Object.freeze({theme:'light',librarySort:'modified',annotation:Object.freeze({color:'#edcf67',width:3,opacity:.35,penTTL:0}),toolbarPosition:null});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function normalizePreferences(value = {}) {
  if (!object(value)) throw new Error('설정 내용이 올바르지 않습니다.');
  const theme=value.theme??DEFAULT_PREFERENCES.theme, librarySort=value.librarySort??DEFAULT_PREFERENCES.librarySort;
  if(!['light','dark','system'].includes(theme)||!['modified','created','title'].includes(librarySort))throw new Error('테마 또는 정렬 설정이 올바르지 않습니다.');
  if(value.annotation!==undefined&&!object(value.annotation))throw new Error('주석 도구 설정이 올바르지 않습니다.');
  const input=value.annotation||{}, defaults=DEFAULT_PREFERENCES.annotation;
  const annotation={color:input.color??defaults.color,width:input.width??defaults.width,opacity:input.opacity??defaults.opacity,penTTL:input.penTTL??defaults.penTTL};
  if(!/^#[\da-f]{6}$/i.test(annotation.color)||!Number.isFinite(annotation.width)||annotation.width<1||annotation.width>18||!Number.isFinite(annotation.opacity)||annotation.opacity<.1||annotation.opacity>.9||![0,3,10,30].includes(annotation.penTTL))throw new Error('주석 색상·굵기·투명도·표시 시간 설정이 올바르지 않습니다.');
  let toolbarPosition=null;
  if(value.toolbarPosition!==null&&value.toolbarPosition!==undefined){const p=value.toolbarPosition;if(!object(p)||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new Error('툴바 위치 설정이 올바르지 않습니다.');toolbarPosition={x:p.x,y:p.y};}
  return {theme,librarySort,annotation,toolbarPosition};
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
