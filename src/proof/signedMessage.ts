import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Address } from "@aetra/sdk/address";
import { Bytes } from "@aetra/sdk/bytes";
import { AetraConnectError } from "../errors.js";
import type { ProofSigner } from "./proof.js";
import type { SignMessageResult } from "../types.js";

/**
 * Off-chain message signing — the `aetra_signMessage` primitive. It lets a dApp
 * get a wallet's signature over an arbitrary human-readable string (a login
 * challenge, a terms acceptance) without any transaction.
 *
 * Domain-separated from both transactions and Aetra Proofs by its own prefix,
 * so a signature obtained here can never stand in for a `SignDoc` or a proof.
 */

const SIGNED_MESSAGE_DOMAIN_SEPARATOR = "aetra-signed-message-v1";

/** Signs `message` (UTF-8) with `signer`, returning the signature + the derived account. */
export function signMessage(signer: ProofSigner, message: string): SignMessageResult {
  const address = Address.fromPubkey(Bytes.fromHex(signer.pubkeyHex));
  const signature = signer.sign(signedMessageBytes(message));
  return {
    signatureHex: Bytes.toHex(signature),
    pubkeyHex: signer.pubkeyHex,
    address: address.toUserFriendly(),
  };
}

/**
 * Verifies a `signMessage` result over `message`. Returns the proven `Address`;
 * throws `AetraConnectError("BAD_PROOF", …)` on any failure.
 */
export function verifySignedMessage(result: SignMessageResult, message: string): Address {
  const fail = (why: string): never => {
    throw new AetraConnectError("BAD_PROOF", `signed message rejected: ${why}`);
  };
  let pubkey: Uint8Array;
  let signature: Uint8Array;
  try {
    pubkey = Bytes.fromHex(result.pubkeyHex);
    signature = Bytes.fromHex(result.signatureHex);
  } catch {
    return fail("public key or signature is not valid hex");
  }
  let derived: Address;
  try {
    derived = Address.fromPubkey(pubkey);
  } catch {
    return fail("public key is not a valid secp256k1 point");
  }
  if (derived.toUserFriendly() !== result.address) fail("address does not match public key");

  let ok = false;
  try {
    ok = secp256k1.verify(signature, signedMessageBytes(message), pubkey, {
      prehash: true,
      lowS: true,
      format: "compact",
    });
  } catch {
    return fail("signature is malformed");
  }
  if (!ok) fail("signature does not verify");
  return derived;
}

/** The exact bytes signed for an off-chain message. */
export function signedMessageBytes(message: string): Uint8Array {
  return Bytes.concat([
    Bytes.utf8Encode(SIGNED_MESSAGE_DOMAIN_SEPARATOR),
    Bytes.withU32Length(Bytes.utf8Encode(message)),
  ]);
}
