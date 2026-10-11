import { uid } from './utils.js';
const pending = new Map();
let available = false;
const native = location.protocol === 'chrome-extension:' && typeof globalThis.chrome?.runtime?.sendMessage === 'function';
const targetOrigin = location.origin === 'null' ? '*' : location.origin;
if(native)chrome.runtime.onMessage.addListener(message=>{if(message.event==='capture-ready')window.dispatchEvent(new Event('htmlmemo-capture-ready'));});
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'htmlmemo-extension') return;
  const data = event.data;
  if (data.event === 'ready') { available = true; window.dispatchEvent(new Event('htmlmemo-chrome-ready')); return; }
  if (data.event === 'capture-ready') { window.dispatchEvent(new Event('htmlmemo-capture-ready')); return; }
  const request = pending.get(data.id); if (!request) return;
  clearTimeout(request.timeout); pending.delete(data.id);
  if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
});
export const bridgeAvailable = () => available;
export function bridge(action, args = {}, timeout = 20000) {
  if(native)return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Chrome 연결이 응답하지 않습니다.')),timeout);chrome.runtime.sendMessage({action,...args}).then(response=>{clearTimeout(timer);if(response?.error)reject(new Error(response.error));else resolve(response?.result);},error=>{clearTimeout(timer);reject(error);});});
  return new Promise((resolve, reject) => {
    const id = uid(); const timer = setTimeout(() => { pending.delete(id); if (action === 'ping') available = false; reject(new Error('Chrome 연결이 응답하지 않습니다. 확장 기능과 HTMLMemo 주소 설정을 확인해주세요.')); }, timeout);
    pending.set(id, {resolve, reject, timeout:timer});
    window.postMessage({channel:'htmlmemo-app', id, action, ...args}, targetOrigin);
  });
}
export async function discoverBridge() { try { await bridge('ping', {}, 800); available=true; return true; } catch { return false; } }
