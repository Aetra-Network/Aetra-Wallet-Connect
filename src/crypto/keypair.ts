import { x25519 } from "@noble/curves/ed25519.js";
import { Bytes } from "@aetra-network/sdk/bytes";

/**
 * `SessionKeyPair` — an ephemeral X25519 keypair, one per session per side. Its
 * public key doubles as the party's `clientId`: the bridge routes by it, and
 * both sides feed it into `getSharedSecret` to derive the channel key. The
 * secret key stays in this object; only the public `clientId` ever leaves.
 *
 * These keys authorise nothing on-chain — they encrypt the transport. Account
 * ownership is proven separately by the secp256k1-signed Aetra Proof.
 */
export class SessionKeyPair {
  private constructor(
    private readonly secretKey: Uint8Array,
    readonly publicKey: Uint8Array,
  ) {}

  /** A fresh random keypair. */
  static generate(): SessionKeyPair {
    const { secretKey, publicKey } = x25519.keygen();
    return new SessionKeyPair(secretKey, publicKey);
  }

  /** Rebuilds a keypair from a stored secret key (the public key is recomputed). */
  static fromSecretKey(secretKey: Uint8Array): SessionKeyPair {
    return new SessionKeyPair(secretKey, x25519.getPublicKey(secretKey));
  }

  /** Rebuilds from a hex-encoded secret key (as persisted by `SessionStore`). */
  static fromSecretHex(hex: string): SessionKeyPair {
    return SessionKeyPair.fromSecretKey(Bytes.fromHex(hex));
  }

  /** This side's routing handle / shared-secret input: the public key, hex. */
  get clientId(): string {
    return Bytes.toHex(this.publicKey);
  }

  /** Hex of the secret key — persist only in the same trust boundary as the account keys. */
  get secretHex(): string {
    return Bytes.toHex(this.secretKey);
  }

  /** The raw X25519 shared secret with a peer public key. Feed to `SessionCipher`, don't use directly. */
  sharedSecret(peerPublicKey: Uint8Array): Uint8Array {
    return x25519.getSharedSecret(this.secretKey, peerPublicKey);
  }
}
