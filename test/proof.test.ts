import { describe, it, expect } from "vitest";
import { Wallet } from "@aetra-network/sdk/wallet";
import { AetraProof, signMessage, verifySignedMessage } from "../src/proof/index.js";
import { AetraConnectError } from "../src/errors.js";

const DOMAIN = "https://swap.aetra.example";
const DAPP_ID = "aa".repeat(32);
const WALLET_ID = "bb".repeat(32);

function makeProof(wallet: Wallet, overrides: { payload?: string; timestamp?: number } = {}) {
  return AetraProof.create({
    signer: wallet,
    domain: DOMAIN,
    payload: overrides.payload ?? "challenge-123",
    dappClientId: DAPP_ID,
    walletClientId: WALLET_ID,
    ...(overrides.timestamp !== undefined ? { timestamp: overrides.timestamp } : {}),
  });
}

const expectation = {
  domain: DOMAIN,
  payload: "challenge-123",
  dappClientId: DAPP_ID,
  walletClientId: WALLET_ID,
};

describe("AetraProof", () => {
  it("verifies a genuine proof and returns the proven address", () => {
    const wallet = Wallet.random();
    const proof = makeProof(wallet);
    const address = AetraProof.verify(proof, expectation);
    expect(address.toUserFriendly()).toBe(wallet.address.toUserFriendly());
    expect(proof.addressRaw).toBe(wallet.address.toRaw());
  });

  it("rejects a mismatched challenge (replay of a proof for another session)", () => {
    const proof = makeProof(Wallet.random());
    expect(() => AetraProof.verify(proof, { ...expectation, payload: "different" })).toThrowError(AetraConnectError);
  });

  it("rejects a mismatched domain", () => {
    const proof = makeProof(Wallet.random());
    expect(() => AetraProof.verify(proof, { ...expectation, domain: "https://evil.example" })).toThrow(/domain/);
  });

  it("rejects when the bound wallet client id is swapped (MITM key substitution)", () => {
    const proof = makeProof(Wallet.random());
    expect(() => AetraProof.verify(proof, { ...expectation, walletClientId: "cc".repeat(32) })).toThrow(/client id/);
  });

  it("rejects a proof whose signature was made by a different key", () => {
    const proof = makeProof(Wallet.random());
    const forged = { ...proof, pubkeyHex: Wallet.random().pubkeyHex };
    expect(() => AetraProof.verify(forged, expectation)).toThrow(/address|verify/);
  });

  it("rejects a tampered address that no longer matches the pubkey", () => {
    const proof = makeProof(Wallet.random());
    const tampered = { ...proof, addressRaw: Wallet.random().address.toRaw() };
    expect(() => AetraProof.verify(tampered, expectation)).toThrow();
  });

  it("rejects a stale proof", () => {
    const wallet = Wallet.random();
    const old = makeProof(wallet, { timestamp: Math.floor(Date.now() / 1000) - 10_000 });
    expect(() => AetraProof.verify(old, expectation)).toThrow(/stale/);
  });

  it("rejects a future-dated proof", () => {
    const wallet = Wallet.random();
    const future = makeProof(wallet, { timestamp: Math.floor(Date.now() / 1000) + 10_000 });
    expect(() => AetraProof.verify(future, expectation)).toThrow(/future/);
  });

  it("honours an explicit `now` for deterministic verification", () => {
    const wallet = Wallet.random();
    const t = 1_800_000_000;
    const proof = makeProof(wallet, { timestamp: t });
    const address = AetraProof.verify(proof, { ...expectation, now: t + 10 });
    expect(address.equals(wallet.address)).toBe(true);
  });
});

describe("off-chain signMessage", () => {
  it("round-trips and binds to the signer's account", () => {
    const wallet = Wallet.random();
    const result = signMessage(wallet, "sign in to Aetra Swap");
    const address = verifySignedMessage(result, "sign in to Aetra Swap");
    expect(address.toUserFriendly()).toBe(wallet.address.toUserFriendly());
    expect(result.address).toBe(wallet.address.toUserFriendly());
  });

  it("rejects a signature checked against a different message", () => {
    const wallet = Wallet.random();
    const result = signMessage(wallet, "message A");
    expect(() => verifySignedMessage(result, "message B")).toThrowError(AetraConnectError);
  });
});
