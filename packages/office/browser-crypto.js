import {sha256} from '@noble/hashes/sha2.js';
import {Buffer} from 'buffer';
export const randomUUID=()=>globalThis.crypto.randomUUID();
export function createHash(name){
  if(name!=='sha256')throw Error('Unsupported Office digest');
  const hash=sha256.create();
  return {update(bytes){hash.update(typeof bytes==='string'?new TextEncoder().encode(bytes):bytes);return this;},digest(encoding){const bytes=Buffer.from(hash.digest());return encoding?bytes.toString(encoding):bytes;}};
}
