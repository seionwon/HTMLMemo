import { uid } from './utils.js';
const pending = new Map();
let available = false;
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
  return new Promise((resolve, reject) => {
    const id = uid(); const timer = setTimeout(() => { pending.delete(id); if (action === 'ping') available = false; reject(new Error('Chrome 연결이 응답하지 않습니다. 확장 기능과 HTMLMemo 주소 설정을 확인해주세요.')); }, timeout);
    pending.set(id, {resolve, reject, timeout:timer});
    window.postMessage({channel:'htmlmemo-app', id, action, ...args}, location.origin);
  });
}
export async function discoverBridge() { try { await bridge('ping', {}, 800); available=true; return true; } catch { return false; } }
