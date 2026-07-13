// ============================================================
// paymentCrypto — application-layer encryption for sensitive payout
// identifiers (bank account number, ABA/routing number).
//
// Algorithm: AES-256-GCM (authenticated encryption).
//   - 256-bit key from env PAYMENT_ENCRYPTION_KEY (64 hex chars = 32 bytes).
//   - Random 12-byte IV per value.
//   - 16-byte GCM auth tag detects tampering on decrypt.
//
// Stored format (single base64 string):  iv || authTag || ciphertext
//   -> base64(concat(iv[12], tag[16], ciphertext[n]))
//
// The DB only ever stores this ciphertext. Plaintext account numbers exist
// only transiently in memory on the API server during encrypt/decrypt.
//
// KEY GENERATION (one-time, keep secret, set in .env / Vercel):
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// ============================================================
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;   // GCM standard nonce length
const TAG_LEN = 16;

let cachedKey = null;

/**
 * Resolve and validate the 32-byte encryption key from env.
 * Throws loudly if misconfigured — we must never silently store PII in the
 * clear or with a weak key.
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const hex = process.env.PAYMENT_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'PAYMENT_ENCRYPTION_KEY is not set. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const key = Buffer.from(hex.trim(), 'hex');
  if (key.length !== 32) {
    throw new Error(
      `PAYMENT_ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${key.length} bytes.`
    );
  }
  cachedKey = key;
  return key;
}

/**
 * Encrypt a plaintext string. Returns base64(iv || tag || ciphertext),
 * or null for null/empty input (so optional fields round-trip cleanly).
 * @param {string|null|undefined} plaintext
 * @returns {string|null}
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Decrypt a value produced by encrypt(). Returns null for null input.
 * Throws if the ciphertext is malformed or the auth tag fails (tampering /
 * wrong key), so callers can surface a clear error rather than leak garbage.
 * @param {string|null|undefined} blob
 * @returns {string|null}
 */
function decrypt(blob) {
  if (blob == null || blob === '') return null;
  const key = getKey();
  const raw = Buffer.from(blob, 'base64');
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error('Ciphertext too short — malformed payment blob.');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Last 4 chars of a raw account number, for masked readback. */
function last4(accountNumber) {
  if (!accountNumber) return null;
  const digits = String(accountNumber).replace(/\s/g, '');
  return digits.slice(-4) || null;
}

module.exports = { encrypt, decrypt, last4 };
