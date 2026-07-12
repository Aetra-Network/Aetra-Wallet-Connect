import { randomBytes } from "@noble/hashes/utils";
import { Bytes } from "@aetra/sdk/bytes";

/**
 * CSPRNG helpers. `randomBytes` from @noble/hashes wraps
 * `crypto.getRandomValues` (browser) / `node:crypto` (Node) — never
 * `Math.random`. Everything session-identifying (ids, nonces, challenges) is
 * drawn from here.
 */

/** `n` cryptographically-random bytes. */
export function randomBytesOf(n: number): Uint8Array {
  return randomBytes(n);
}

/** A random hex id of `bytes` bytes (default 16 → 32 hex chars). */
export function randomId(bytes = 16): string {
  return Bytes.toHex(randomBytes(bytes));
}

/**
 * A random URL-safe challenge string for an `aetra_proof` request. 32 bytes of
 * entropy is well past any birthday-bound concern for a one-shot nonce.
 */
export function randomChallenge(bytes = 32): string {
  return Bytes.toBase64Url(randomBytes(bytes));
}
