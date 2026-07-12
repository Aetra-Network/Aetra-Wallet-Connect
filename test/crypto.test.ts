import { describe, it, expect } from "vitest";
import { Bytes } from "@aetra/sdk/bytes";
import { SessionKeyPair, SessionCipher } from "../src/crypto/index.js";
import { AetraConnectError } from "../src/errors.js";

describe("SessionKeyPair + SessionCipher", () => {
  it("both parties derive the same channel and round-trip a message", () => {
    const alice = SessionKeyPair.generate();
    const bob = SessionKeyPair.generate();

    const ctx = SessionCipher.contextFor(alice.clientId, bob.clientId);
    const aliceCipher = new SessionCipher(alice.sharedSecret(Bytes.fromHex(bob.clientId)), ctx);
    const bobCipher = new SessionCipher(bob.sharedSecret(Bytes.fromHex(alice.clientId)), ctx);

    const sealed = aliceCipher.sealJson({ hello: "aetra", n: 7 });
    expect(bobCipher.openJson<{ hello: string; n: number }>(sealed)).toEqual({ hello: "aetra", n: 7 });

    // And the reverse direction on the same key.
    const back = bobCipher.seal(Bytes.utf8Encode("pong"));
    expect(Bytes.utf8Decode(aliceCipher.open(back))).toBe("pong");
  });

  it("context is order-independent", () => {
    const a = SessionKeyPair.generate();
    const b = SessionKeyPair.generate();
    expect(SessionCipher.contextFor(a.clientId, b.clientId)).toBe(SessionCipher.contextFor(b.clientId, a.clientId));
  });

  it("a fresh nonce per seal makes ciphertexts differ", () => {
    const kp = SessionKeyPair.generate();
    const cipher = new SessionCipher(kp.sharedSecret(kp.publicKey), "ctx");
    const a = cipher.seal(Bytes.utf8Encode("same"));
    const b = cipher.seal(Bytes.utf8Encode("same"));
    expect(a).not.toBe(b);
    expect(Bytes.utf8Decode(cipher.open(a))).toBe("same");
  });

  it("rejects a tampered envelope with DECRYPT_FAILED", () => {
    const kp = SessionKeyPair.generate();
    const cipher = new SessionCipher(kp.sharedSecret(kp.publicKey), "ctx");
    const sealed = cipher.seal(Bytes.utf8Encode("secret"));
    const raw = Bytes.fromBase64(sealed);
    const last = raw.length - 1;
    raw[last] = (raw[last] ?? 0) ^ 0xff; // flip a tag byte
    const tampered = Bytes.toBase64(raw);
    expect(() => cipher.open(tampered)).toThrowError(AetraConnectError);
    try {
      cipher.open(tampered);
    } catch (err) {
      expect((err as AetraConnectError).code).toBe("DECRYPT_FAILED");
    }
  });

  it("a wrong key cannot open the envelope", () => {
    const kp = SessionKeyPair.generate();
    const other = SessionKeyPair.generate();
    const sender = new SessionCipher(kp.sharedSecret(other.publicKey), "ctx");
    const wrong = new SessionCipher(other.sharedSecret(kp.publicKey.slice().fill(1)), "ctx");
    const sealed = sender.seal(Bytes.utf8Encode("hi"));
    expect(() => wrong.open(sealed)).toThrow();
  });

  it("recreates a keypair from its secret hex", () => {
    const kp = SessionKeyPair.generate();
    const same = SessionKeyPair.fromSecretHex(kp.secretHex);
    expect(same.clientId).toBe(kp.clientId);
  });
});
