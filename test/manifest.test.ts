import { describe, it, expect, vi } from "vitest";
import { Wallet } from "@aetra/sdk/wallet";
import { loadManifest, validateManifest, manifestToApp, type AetraConnectManifest } from "../src/manifest.js";
import { AetraConnect } from "../src/dapp/index.js";
import { AetraWalletConnect } from "../src/wallet/index.js";
import { MemoryBridge } from "../src/bridge/index.js";
import { MemorySessionStore } from "../src/session/index.js";
import { AetraConnectError } from "../src/errors.js";

const MANIFEST: AetraConnectManifest = {
  url: "https://swap.aetra.example",
  name: "Aetra Swap",
  iconUrl: "https://swap.aetra.example/icon.png",
};

/** A fetch stub that serves `manifest` at `url` and 404s elsewhere. */
function manifestFetch(url: string, manifest: AetraConnectManifest): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === url) {
      return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("manifest", () => {
  it("validates and maps to app metadata", () => {
    const app = manifestToApp(validateManifest({ ...MANIFEST, url: "https://swap.aetra.example/" }));
    expect(app).toEqual({ name: "Aetra Swap", url: "https://swap.aetra.example", icon: MANIFEST.iconUrl });
  });

  it("rejects a malformed manifest", () => {
    expect(() => validateManifest({ name: "x" })).toThrow(/url/);
    expect(() => validateManifest({ url: "ftp://x", name: "n", iconUrl: "https://x/i.png" })).toThrow(/url/);
    expect(() => validateManifest({ url: "https://x", name: "n", iconUrl: "notaurl" })).toThrow(/iconUrl/);
  });

  it("fetches a manifest over (stubbed) http", async () => {
    const url = "https://swap.aetra.example/aetra-connect-manifest.json";
    const loaded = await loadManifest(url, manifestFetch(url, MANIFEST));
    expect(loaded).toEqual(MANIFEST);
  });

  it("surfaces a fetch failure as MALFORMED", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(loadManifest("https://x/m.json", fetchImpl)).rejects.toMatchObject({ code: "MALFORMED" });
  });

  it("pairs end-to-end using a manifestUrl on both sides", async () => {
    const bridge = new MemoryBridge();
    const manifestUrl = "https://swap.aetra.example/aetra-connect-manifest.json";
    const fetchImpl = manifestFetch(manifestUrl, MANIFEST);

    const signer = Wallet.random();
    const wallet = new AetraWalletConnect({
      bridge,
      signer,
      fetch: fetchImpl,
      chainId: "aetra-localnet-1",
      onTransaction: async () => ({ hash: "0xMANIFEST", accepted: true }),
    });

    const dapp = new AetraConnect({ manifestUrl, bridge, fetch: fetchImpl, storage: new MemorySessionStore() });
    await dapp.ready();
    expect(dapp.appMetadata?.url).toBe("https://swap.aetra.example");

    const hs = dapp.connect({ proof: true });
    expect(hs.request.manifestUrl).toBe(manifestUrl);

    const request = wallet.readRequest(hs.deepLink);
    const shownApp = await wallet.resolveApp(request); // wallet displays verified identity
    expect(shownApp.name).toBe("Aetra Swap");

    await wallet.approve(request);
    const account = await hs.approval();
    // Proof domain was bound to the manifest's origin — verified by the dApp.
    expect(account.proof?.domain).toBe("https://swap.aetra.example");
    expect(account.address).toBe(signer.address.toUserFriendly());

    const res = await dapp.sendTransaction({ messages: [{ kind: "activate" }] });
    expect(res.hash).toBe("0xMANIFEST");
  });

  it("ready() rejects when the manifest can't be loaded", async () => {
    const dapp = new AetraConnect({
      manifestUrl: "https://swap.aetra.example/missing.json",
      bridge: new MemoryBridge(),
      fetch: vi.fn(async () => new Response("no", { status: 404 })) as unknown as typeof fetch,
    });
    await expect(dapp.ready()).rejects.toBeInstanceOf(AetraConnectError);
  });

  it("still supports inline app metadata (no manifest)", async () => {
    const dapp = new AetraConnect({ app: { name: "Inline", url: "https://inline.example" }, bridge: new MemoryBridge() });
    await dapp.ready();
    const hs = dapp.connect({ proof: false });
    expect(hs.request.manifestUrl).toBeUndefined();
    expect(hs.request.app.name).toBe("Inline");
  });
});
