import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { Bytes } from "@aetra/sdk/bytes";
import { AetraConnectError } from "../errors.js";
import { randomBytesOf } from "./random.js";

const KEY_INFO = "aetra-connect/v1/session-key";
const HKDF_SALT = "aetra-connect/v1";
const NONCE_LENGTH = 24; // XChaCha20 nonce
const KEY_LENGTH = 32;

/**
 * `SessionCipher` — authenticated encryption for one session channel. The raw
 * X25519 shared secret is stretched through HKDF-SHA256 into a 32-byte key, and
 * each message is sealed with XChaCha20-Poly1305 under a fresh random 24-byte
 * nonce. The wire form is `nonce ‖ ciphertext+tag`, base64.
 *
 * Both parties derive the same key (ECDH is symmetric), so one `SessionCipher`
 * serves both send and receive. The optional `context` — bound as AEAD
 * associated data — ties every ciphertext to a specific pairing so a blob can't
 * be lifted onto another channel even in the impossible case of a key collision.
 */
export class SessionCipher {
  private readonly key: Uint8Array;
  private readonly aad: Uint8Array;

  constructor(sharedSecret: Uint8Array, context = "") {
    this.key = hkdf(sha256, sharedSecret, Bytes.utf8Encode(HKDF_SALT), Bytes.utf8Encode(KEY_INFO), KEY_LENGTH);
    this.aad = Bytes.utf8Encode(context);
  }

  /** Derives the channel context string from two client ids (order-independent). */
  static contextFor(clientIdA: string, clientIdB: string): string {
    return [clientIdA, clientIdB].sort().join(":");
  }

  /** Seals plaintext bytes → base64 envelope. */
  seal(plaintext: Uint8Array): string {
    const nonce = randomBytesOf(NONCE_LENGTH);
    const ciphertext = xchacha20poly1305(this.key, nonce, this.aad).encrypt(plaintext);
    return Bytes.toBase64(Bytes.concat([nonce, ciphertext]));
  }

  /** Opens a base64 envelope → plaintext bytes. Throws `DECRYPT_FAILED` on any tamper/mismatch. */
  open(envelopeBase64: string): Uint8Array {
    let raw: Uint8Array;
    try {
      raw = Bytes.fromBase64(envelopeBase64);
    } catch {
      throw new AetraConnectError("DECRYPT_FAILED", "envelope is not valid base64");
    }
    if (raw.length <= NONCE_LENGTH) {
      throw new AetraConnectError("DECRYPT_FAILED", "envelope too short");
    }
    const nonce = raw.slice(0, NONCE_LENGTH);
    const ciphertext = raw.slice(NONCE_LENGTH);
    try {
      return xchacha20poly1305(this.key, nonce, this.aad).decrypt(ciphertext);
    } catch {
      throw new AetraConnectError("DECRYPT_FAILED", "authentication failed — tampered or misrouted envelope");
    }
  }

  /** Seals a JSON value. */
  sealJson(value: unknown): string {
    return this.seal(Bytes.utf8Encode(JSON.stringify(value)));
  }

  /** Opens an envelope and parses it as JSON of `T`. Throws `DECRYPT_FAILED` on bad JSON. */
  openJson<T>(envelopeBase64: string): T {
    const bytes = this.open(envelopeBase64);
    try {
      return JSON.parse(Bytes.utf8Decode(bytes)) as T;
    } catch {
      throw new AetraConnectError("DECRYPT_FAILED", "decrypted payload was not valid JSON");
    }
  }
}
