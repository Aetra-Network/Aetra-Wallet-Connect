import { describe, it, expect } from "vitest";
import { SessionKeyPair } from "../src/crypto/index.js";
import { Session } from "../src/session/index.js";
import { AetraConnectError } from "../src/errors.js";
import type { ConnectedAccount, AppMetadata, RpcMessage } from "../src/types.js";

const account: ConnectedAccount = {
  address: "AEexample",
  addressRaw: "ae1example",
  pubkeyHex: "02" + "00".repeat(32),
};
const app: AppMetadata = { name: "Aetra Swap", url: "https://swap.aetra.example" };

function pair(now = 1_000_000) {
  const dappKp = SessionKeyPair.generate();
  const walletKp = SessionKeyPair.generate();
  const common = { account, app, bridge: "mem", createdAt: now, expiresAt: now + 10_000 };
  const dapp = new Session({ topic: dappKp.clientId, role: "dapp", self: dappKp, peerClientId: walletKp.clientId, ...common });
  const wallet = new Session({ topic: dappKp.clientId, role: "wallet", self: walletKp, peerClientId: dappKp.clientId, ...common });
  return { dapp, wallet };
}

describe("Session", () => {
  it("seals on one side and opens on the peer", () => {
    const { dapp, wallet } = pair();
    const msg: RpcMessage = { type: "request", id: "1", method: "aetra_signMessage", params: { message: "hi" } };
    const envelope = dapp.seal(msg);
    expect(envelope.from).toBe(dapp.selfClientId);
    expect(envelope.to).toBe(wallet.selfClientId);
    expect(wallet.open(envelope)).toEqual(msg);
  });

  it("refuses an envelope that is not from the session peer", () => {
    const { wallet } = pair();
    const stranger = SessionKeyPair.generate();
    const forged = { from: stranger.clientId, to: wallet.selfClientId, payload: "x" };
    expect(() => wallet.open(forged)).toThrowError(AetraConnectError);
  });

  it("survives a store round-trip and can still decrypt", () => {
    const { dapp, wallet } = pair();
    const restored = Session.fromRecord(dapp.toRecord());
    const envelope = restored.seal({ type: "event", event: "disconnect", payload: { reason: "bye" } });
    expect(wallet.open(envelope)).toEqual({ type: "event", event: "disconnect", payload: { reason: "bye" } });
    expect(restored.topic).toBe(dapp.topic);
    expect(restored.account).toEqual(account);
  });

  it("tracks expiry and idle timeout", () => {
    const { dapp } = pair(1_000_000);
    expect(dapp.isExpired(1_005_000)).toBe(false);
    expect(dapp.isExpired(1_010_001)).toBe(true);

    dapp.touch(1_000_000);
    expect(dapp.isIdle(3_000, 1_002_000)).toBe(false);
    expect(dapp.isIdle(3_000, 1_003_001)).toBe(true);
    expect(dapp.isIdle(0, 9_999_999)).toBe(false); // 0 disables the idle check
  });
});
