import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';

// RisuAI's preset format uses SHA-256(password), AES-GCM and a zero IV.
// Local JS preserves its authenticated format on HTTP LAN origins where
// browsers do not expose SubtleCrypto. File bytes never leave the browser.
export function presetCrypt(data, password, decrypt = false) {
  const key = sha256(new TextEncoder().encode(password));
  const cipher = gcm(key, new Uint8Array(12));
  const bytes = new Uint8Array(data);
  const result = decrypt ? cipher.decrypt(bytes) : cipher.encrypt(bytes);
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
}
