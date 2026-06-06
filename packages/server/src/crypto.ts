// =============================================================================
// Symmetric encryption for secrets at rest (MikroTik passwords) + small helpers.
// AES-256-GCM. Key comes from CREDENTIALS_ENC_KEY (base64, 32 bytes).
// Ciphertext format: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
// =============================================================================

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { env } from './env';

const KEY = Buffer.from(env.CREDENTIALS_ENC_KEY, 'base64');
if (KEY.length !== 32) {
  throw new Error('CREDENTIALS_ENC_KEY must decode to exactly 32 bytes (base64).');
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(encoded: string): string {
  const [version, ivB64, tagB64, ctB64] = encoded.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || ctB64 == null) {
    throw new Error('Invalid ciphertext format');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    KEY,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Opaque random token (hex). Used for per-router webhook tokens. */
export function generateToken(bytes = 24): string {
  return randomBytes(bytes).toString('hex');
}

/** SHA-256 hex digest. Used to store refresh tokens hashed + webhook dedup. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
