/**
 * Encryption Utility
 *
 * Provides AES-256-GCM encryption/decryption for secure token storage.
 * Used to encrypt OAuth tokens (Slack, etc.) before storing in DB.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { logger } from '../logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Get or derive encryption key from environment
 *
 * If ENCRYPTION_KEY is set (64 hex chars = 32 bytes), use it directly.
 * Otherwise, derive from ENCRYPTION_PASSWORD using scrypt.
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  const envPassword = process.env.ENCRYPTION_PASSWORD;

  if (envKey) {
    // Direct hex key (64 chars = 32 bytes)
    if (envKey.length !== 64) {
      throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(envKey, 'hex');
  }

  if (envPassword) {
    // Derive key from password using scrypt
    // Use a fixed salt for deterministic key derivation (stored tokens must decrypt with same key)
    const fixedSalt = process.env.ENCRYPTION_SALT || 'lens-platform-default-salt-v1';
    return scryptSync(envPassword, fixedSalt, KEY_LENGTH);
  }

  // Fallback: generate a warning and use a default (NOT SECURE for production)
  logger.warn('WARNING: No ENCRYPTION_KEY or ENCRYPTION_PASSWORD set. Using insecure default key.');
  logger.warn('Set ENCRYPTION_KEY (64 hex chars) or ENCRYPTION_PASSWORD in production!');
  return scryptSync('insecure-default-key-do-not-use-in-production', 'default-salt', KEY_LENGTH);
}

/**
 * Encrypt a string using AES-256-GCM
 *
 * Returns a string in format: iv:authTag:encryptedData (all hex-encoded)
 *
 * @param plaintext - The string to encrypt
 * @returns Encrypted string in format iv:authTag:ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt()
 *
 * @param encryptedData - String in format iv:authTag:ciphertext
 * @returns Decrypted plaintext string
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export function decrypt(encryptedData: string): string {
  const key = getEncryptionKey();

  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  if (iv.length !== IV_LENGTH) {
    throw new Error('Invalid IV length');
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Invalid auth tag length');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Encrypt a token (alias for encrypt with better semantics)
 */
export function encryptToken(token: string): string {
  return encrypt(token);
}

/**
 * Decrypt a token (alias for decrypt with better semantics)
 */
export function decryptToken(encryptedToken: string): string {
  return decrypt(encryptedToken);
}

/**
 * Generate a secure encryption key (for setup/key rotation)
 *
 * @returns A 64-character hex string suitable for ENCRYPTION_KEY env var
 */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Validate that encryption is properly configured
 *
 * @returns true if encryption key is available (even if using insecure default)
 */
export function isEncryptionConfigured(): boolean {
  return !!(process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_PASSWORD);
}
