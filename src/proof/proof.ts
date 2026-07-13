import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Address } from "@aetra-network/sdk/address";
import { Bytes } from "@aetra-network/sdk/bytes";
import { AetraConnectError } from "../errors.js";
import type { AetraProofData } from "../types.js";

/**
 * The Aetra Proof — a wallet's secp256k1 signature proving it controls an
 * account, bound to *this* connection so it can't be replayed or relayed.
 *
 * The signed message is a domain-separated, length-prefixed encoding of:
 *   - the dApp origin (`domain`),
 *   - the dApp's random challenge (`payload`),
 *   - the proven account (`addressRaw`),
 *   - both session public keys (`dappClientId`, `walletClientId`), and
 *   - the signing timestamp.
 *
 * Binding both client ids ties the account signature to the exact encrypted
 * channel: a man-in-the-middle on the bridge can't swap in its own session key
 * and forward a genuine proof, because the proof commits to the wallet's key.
 *
 * The leading ASCII domain separator (`aetra-proof-v1`, first byte 0x61) can
 * never be the prefix of a Cosmos `SignDoc` (protobuf field 1 → first byte
 * 0x0a), so a proof signature can never be mistaken for a transaction signature
 * made by the same key, and vice-versa.
 */

const PROOF_DOMAIN_SEPARATOR = "aetra-proof-v1";
/** Reject a proof signed more than this many seconds ago (or this far in the future). */
const DEFAULT_MAX_AGE_SECONDS = 300;
const MAX_CLOCK_SKEW_SECONDS = 60;

export interface ProofSigner {
  /** Compressed secp256k1 public key, hex. The account is derived from this. */
  readonly pubkeyHex: string;
  /**
   * secp256k1 over sha256(message), low-S, 64-byte compact. Identical semantics
   * to the SDK `Signer.sign` — an `@aetra-network/sdk` `Wallet` satisfies this directly.
   * Callers must NOT pre-hash; `sign` hashes internally.
   */
  sign(message: Uint8Array): Uint8Array;
}

export interface ProofClaim {
  domain: string;
  payload: string;
  addressRaw: string;
  dappClientId: string;
  walletClientId: string;
  timestamp: number;
}

export interface ProofExpectation {
  domain: string;
  payload: string;
  dappClientId: string;
  walletClientId: string;
  /** Max signature age in seconds (default 300). */
  maxAgeSeconds?: number;
  /** Override "now" (unix seconds) — for deterministic tests. */
  now?: number;
}

export class AetraProof {
  /**
   * Builds and signs a proof for `signer` over the given claim. `timestamp`
   * defaults to now (unix seconds). The account address is derived from the
   * signer's public key — a signer can't claim an address it doesn't control.
   */
  static create(params: {
    signer: ProofSigner;
    domain: string;
    payload: string;
    dappClientId: string;
    walletClientId: string;
    timestamp?: number;
  }): AetraProofData {
    const pubkey = Bytes.fromHex(params.signer.pubkeyHex);
    const address = Address.fromPubkey(pubkey);
    const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
    const claim: ProofClaim = {
      domain: params.domain,
      payload: params.payload,
      addressRaw: address.toRaw(),
      dappClientId: params.dappClientId,
      walletClientId: params.walletClientId,
      timestamp,
    };
    const signature = params.signer.sign(AetraProof.messageBytes(claim));
    return {
      ...claim,
      pubkeyHex: params.signer.pubkeyHex,
      signatureHex: Bytes.toHex(signature),
    };
  }

  /**
   * Verifies `proof` against what the dApp expects. Returns the proven
   * `Address` on success; throws `AetraConnectError("BAD_PROOF", …)` on any
   * failure (mismatch, bad signature, wrong address, replay window).
   */
  static verify(proof: AetraProofData, expected: ProofExpectation): Address {
    const fail = (why: string): never => {
      throw new AetraConnectError("BAD_PROOF", `Aetra Proof rejected: ${why}`);
    };

    if (proof.domain !== expected.domain) fail("domain mismatch");
    if (proof.payload !== expected.payload) fail("challenge payload mismatch");
    if (proof.dappClientId !== expected.dappClientId) fail("dApp client id mismatch");
    if (proof.walletClientId !== expected.walletClientId) fail("wallet client id mismatch");

    const now = expected.now ?? Math.floor(Date.now() / 1000);
    const maxAge = expected.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    if (!Number.isFinite(proof.timestamp)) fail("timestamp is not a number");
    if (proof.timestamp > now + MAX_CLOCK_SKEW_SECONDS) fail("timestamp is in the future");
    if (proof.timestamp < now - maxAge) fail("proof is stale");

    let pubkey: Uint8Array;
    try {
      pubkey = Bytes.fromHex(proof.pubkeyHex);
    } catch {
      return fail("public key is not valid hex");
    }

    // The address must actually derive from the presented public key.
    let derived: Address;
    try {
      derived = Address.fromPubkey(pubkey);
    } catch {
      return fail("public key is not a valid secp256k1 point");
    }
    if (derived.toRaw() !== proof.addressRaw) fail("address does not match public key");

    const message = AetraProof.messageBytes(proof);
    let signature: Uint8Array;
    try {
      signature = Bytes.fromHex(proof.signatureHex);
    } catch {
      return fail("signature is not valid hex");
    }

    let ok = false;
    try {
      ok = secp256k1.verify(signature, message, pubkey, { prehash: true, lowS: true, format: "compact" });
    } catch {
      return fail("signature is malformed");
    }
    if (!ok) fail("signature does not verify");

    return derived;
  }

  /** The exact bytes signed / verified for `claim`. Public for cross-impl test vectors. */
  static messageBytes(claim: ProofClaim): Uint8Array {
    return Bytes.concat([
      Bytes.utf8Encode(PROOF_DOMAIN_SEPARATOR),
      Bytes.withU32Length(Bytes.utf8Encode(claim.domain)),
      Bytes.withU32Length(Bytes.utf8Encode(claim.payload)),
      Bytes.withU32Length(Bytes.utf8Encode(claim.addressRaw)),
      Bytes.withU32Length(Bytes.utf8Encode(claim.dappClientId)),
      Bytes.withU32Length(Bytes.utf8Encode(claim.walletClientId)),
      u64be(claim.timestamp),
    ]);
  }
}

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.trunc(n)), false);
  return out;
}
