// Ported from MemoSuite utils/crypto.ts; protocol/encryption intentionally preserved.
export async function deriveTopic(secret) {
  const data = new TextEncoder().encode("memosuite-sync-topic:" + secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return "ms" + hex.slice(0, 48);
}
function uint8ToB64(uint8) {
  const CHUNK_SIZE = 32768;
  let index = 0;
  const length = uint8.length;
  let result = "";
  while (index < length) {
    const slice = uint8.subarray(index, Math.min(index + CHUNK_SIZE, length));
    result += String.fromCharCode(...slice);
    index += CHUNK_SIZE;
  }
  return btoa(result);
}
function b64ToUint8(b64) {
  const binString = atob(b64);
  const size = binString.length;
  const uint8 = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    uint8[i] = binString.charCodeAt(i);
  }
  return uint8;
}
export async function encryptData(data, password) {
  const encoder = new TextEncoder();
  const dataUint8 = encoder.encode(data);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 1e5,
      hash: "SHA-256"
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    dataUint8
  );
  const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encrypted), salt.length + iv.length);
  return uint8ToB64(combined);
}
export async function decryptData(encryptedBase64, password) {
  const encoder = new TextEncoder();
  const combined = b64ToUint8(encryptedBase64);
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const data = combined.slice(28);
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 1e5,
      hash: "SHA-256"
    },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );
  return new TextDecoder().decode(decrypted);
}
