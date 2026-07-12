/**
 * Account-ownership proofs — the secp256k1 layer, distinct from the X25519
 * transport crypto. `AetraProof` binds an account to a connection at pairing
 * time; `signMessage`/`verifySignedMessage` cover generic off-chain signing.
 */
export { AetraProof } from "./proof.js";
export type { ProofSigner, ProofClaim, ProofExpectation } from "./proof.js";
export { signMessage, verifySignedMessage, signedMessageBytes } from "./signedMessage.js";
