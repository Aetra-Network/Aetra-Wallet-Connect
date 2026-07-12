import { describe, it, expect, vi } from "vitest";
import { Wallet } from "@aetra/sdk/wallet";
import { AetraConnect } from "../src/dapp/index.js";
import { AetraWalletConnect, userRejected } from "../src/wallet/index.js";
import { MemoryBridge } from "../src/bridge/index.js";
import { MemorySessionStore } from "../src/session/index.js";
import { AetraConnectError } from "../src/errors.js";
import type { SendTransactionParams } from "../src/types.js";

const APP = { name: "Aetra Swap", url: "https://swap.aetra.example", icon: "https://swap.aetra.example/icon.png" };
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeWallet(
  bridge: MemoryBridge,
  onTransaction = vi.fn(async () => ({ hash: "TXHASH", accepted: true })),
  storage = new MemorySessionStore(),
) {
  const signer = Wallet.random();
  const wc = new AetraWalletConnect({
    bridge,
    signer,
    wallet: { name: "Dalen Wallet" },
    chainId: "aetra-localnet-1",
    storage,
    onTransaction,
  });
  return { wc, signer, onTransaction, storage };
}

describe("end-to-end handshake over MemoryBridge", () => {
  it("pairs with a verified proof, then sends a transaction and signs a message", async () => {
    const bridge = new MemoryBridge();
    const received: SendTransactionParams[] = [];
    const onTx = vi.fn(async (p: SendTransactionParams) => {
      received.push(p);
      return { hash: "0xDEADBEEF", accepted: true };
    });
    const { wc, signer } = makeWallet(bridge, onTx);
    const dapp = new AetraConnect({ app: APP, bridge, storage: new MemorySessionStore() });

    // dApp starts pairing; wallet reads the URI and approves.
    const hs = dapp.connect({ proof: true });
    const request = wc.readRequest(hs.deepLink);
    expect(request.app.name).toBe("Aetra Swap");
    await wc.approve(request);

    const account = await hs.approval();
    expect(account.address).toBe(signer.address.toUserFriendly());
    expect(account.addressRaw).toBe(signer.address.toRaw());
    expect(account.chainId).toBe("aetra-localnet-1");
    expect(account.proof).toBeDefined();
    expect(dapp.connected).toBe(true);
    expect(wc.activeSessions).toHaveLength(1);

    // Transaction request → wallet handler → hash back to the dApp.
    const recipient = Wallet.random().address.toUserFriendly();
    const res = await dapp.sendTransaction({
      messages: [{ kind: "send", to: recipient, amountNaet: "1000000000", comment: "gm" }],
      memo: "gm",
    });
    expect(res).toEqual({ hash: "0xDEADBEEF", accepted: true });
    expect(onTx).toHaveBeenCalledOnce();
    expect(received[0]!.from).toBe(signer.address.toUserFriendly());
    expect(received[0]!.messages[0]).toMatchObject({ kind: "send", to: recipient, amountNaet: "1000000000" });

    // Off-chain message signing, verified end-to-end by the dApp.
    const sig = await dapp.signMessage("log in to Aetra Swap");
    expect(sig.address).toBe(signer.address.toUserFriendly());
    expect(sig.signatureHex).toMatch(/^[0-9a-f]{128}$/);
  });

  it("pairs without a proof when the dApp doesn't request one", async () => {
    const bridge = new MemoryBridge();
    const { wc } = makeWallet(bridge);
    const dapp = new AetraConnect({ app: APP, bridge });

    const hs = dapp.connect({ proof: false });
    expect(hs.request.items).toEqual([{ name: "aetra_address" }]);
    await wc.approve(wc.readRequest(hs.deepLink));
    const account = await hs.approval();
    expect(account.proof).toBeUndefined();
    expect(dapp.connected).toBe(true);
  });

  it("fails fast with USER_REJECTED when the wallet declines", async () => {
    const bridge = new MemoryBridge();
    const { wc } = makeWallet(bridge);
    const dapp = new AetraConnect({ app: APP, bridge });

    const hs = dapp.connect();
    const request = wc.readRequest(hs.universalLink);
    await wc.reject(request, "not now");

    await expect(hs.approval()).rejects.toMatchObject({ code: "USER_REJECTED" });
    expect(dapp.connected).toBe(false);
  });

  it("propagates a wallet-side transaction rejection to the dApp", async () => {
    const bridge = new MemoryBridge();
    const onTx = vi.fn(async () => {
      throw userRejected("transaction");
    });
    const { wc } = makeWallet(bridge, onTx);
    const dapp = new AetraConnect({ app: APP, bridge });

    const hs = dapp.connect();
    await wc.approve(wc.readRequest(hs.deepLink));
    await hs.approval();

    await expect(
      dapp.sendTransaction({ messages: [{ kind: "activate" }] }),
    ).rejects.toMatchObject({ code: "USER_REJECTED" });
  });

  it("tears down both sides on dApp disconnect", async () => {
    const bridge = new MemoryBridge();
    const { wc } = makeWallet(bridge);
    const dapp = new AetraConnect({ app: APP, bridge });
    const disconnected = vi.fn();
    wc.on("disconnect", disconnected);

    const hs = dapp.connect();
    await wc.approve(wc.readRequest(hs.deepLink));
    await hs.approval();
    expect(wc.activeSessions).toHaveLength(1);

    await dapp.disconnect("done");
    await tick();
    expect(dapp.connected).toBe(false);
    expect(wc.activeSessions).toHaveLength(0);
    expect(disconnected).toHaveBeenCalled();
  });

  it("reconnecting while connected replaces the session without leaking", async () => {
    const bridge = new MemoryBridge();
    const { wc } = makeWallet(bridge);
    const dapp = new AetraConnect({ app: APP, bridge });
    const disconnects: Array<{ reason?: string }> = [];
    dapp.on("disconnect", (e) => disconnects.push(e));

    const hs1 = dapp.connect();
    await wc.approve(wc.readRequest(hs1.deepLink));
    const first = await hs1.approval();

    // Pair again while already connected — the old session is torn down cleanly.
    const hs2 = dapp.connect();
    await wc.approve(wc.readRequest(hs2.deepLink));
    const second = await hs2.approval();

    expect(dapp.connected).toBe(true);
    expect(second.address).toBe(first.address); // same wallet account
    expect(disconnects.some((d) => /replaced/.test(d.reason ?? ""))).toBe(true);

    // The new session works.
    const res = await dapp.sendTransaction({ messages: [{ kind: "activate" }] });
    expect(res.accepted).toBe(true);
  });

  it("rejects a wallet on the wrong chain when requiredChainId is set", async () => {
    const bridge = new MemoryBridge();
    const { wc } = makeWallet(bridge); // wallet reports chainId "aetra-localnet-1"
    const dapp = new AetraConnect({ app: APP, bridge, requiredChainId: "aetra-mainnet-1" });

    const hs = dapp.connect();
    await wc.approve(wc.readRequest(hs.deepLink));
    await expect(hs.approval()).rejects.toMatchObject({ code: "CHAIN_MISMATCH" });
    expect(dapp.connected).toBe(false);
  });

  it("refuses sendTransaction with no messages", async () => {
    const bridge = new MemoryBridge();
    const { wc } = makeWallet(bridge);
    const dapp = new AetraConnect({ app: APP, bridge });
    const hs = dapp.connect();
    await wc.approve(wc.readRequest(hs.deepLink));
    await hs.approval();
    await expect(dapp.sendTransaction({ messages: [] })).rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("rejects a malformed transaction result from a misbehaving wallet", async () => {
    const bridge = new MemoryBridge();
    // Wallet handler returns junk instead of { hash, accepted }.
    const { wc } = makeWallet(bridge, vi.fn(async () => ({}) as any));
    const dapp = new AetraConnect({ app: APP, bridge });
    const hs = dapp.connect();
    await wc.approve(wc.readRequest(hs.deepLink));
    await hs.approval();
    await expect(dapp.sendTransaction({ messages: [{ kind: "activate" }] })).rejects.toMatchObject({ code: "TX_FAILED" });
  });

  it("a duplicate approve does not leave orphaned wallet sessions", async () => {
    const bridge = new MemoryBridge();
    const { wc } = makeWallet(bridge);
    const dapp = new AetraConnect({ app: APP, bridge });
    const hs = dapp.connect();
    const request = wc.readRequest(hs.deepLink);
    await wc.approve(request);
    await wc.approve(request); // same topic — must not leak a second session
    await hs.approval();
    expect(wc.activeSessions).toHaveLength(1);
  });

  it("restores a persisted dApp session and keeps transacting", async () => {
    const bridge = new MemoryBridge();
    const walletStore = new MemorySessionStore();
    const dappStore = new MemorySessionStore();
    const { wc } = makeWallet(bridge, vi.fn(async () => ({ hash: "AFTER_RESTORE", accepted: true })), walletStore);

    const dapp = new AetraConnect({ app: APP, bridge, storage: dappStore });
    const hs = dapp.connect();
    await wc.approve(wc.readRequest(hs.deepLink));
    await hs.approval();

    // A fresh dApp instance (simulating a page reload) restores from storage.
    const reloaded = new AetraConnect({ app: APP, bridge, storage: dappStore });
    const restored = await reloaded.restore();
    expect(restored).not.toBeNull();
    expect(reloaded.connected).toBe(true);

    const res = await reloaded.sendTransaction({ messages: [{ kind: "stake.claim", poolId: "pool-1" }] });
    expect(res.hash).toBe("AFTER_RESTORE");
  });
});
