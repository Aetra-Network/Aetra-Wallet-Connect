/**
 * End-to-end demo of the Aetra Connect handshake — dApp ↔ wallet in one process
 * over the in-memory bridge, so you can watch the whole flow without a relay,
 * a browser, or a live chain.
 *
 * Build first, then run:  npm run build && node examples/demo.mjs
 *
 * It walks through: pair → Aetra Proof verification → send transaction (the
 * wallet's handler stands in for build-sign-broadcast) → off-chain signMessage
 * → disconnect.
 */
import { AetraConnect, AetraWalletConnect, MemoryBridge, MemorySessionStore } from "../dist/index.js";
import { Wallet } from "@aetra-network/sdk/wallet";

const line = (s) => console.log(s);

async function main() {
  const bridge = new MemoryBridge();

  // --- The wallet (Dalen) side ------------------------------------------
  const account = Wallet.random(); // the unlocked account keypair
  line(`wallet account: ${account.address.toUserFriendly()}`);

  const wallet = new AetraWalletConnect({
    bridge,
    signer: account, // an @aetra-network/sdk Wallet satisfies WalletSigner directly
    wallet: { name: "Dalen Wallet" },
    chainId: "aetra-localnet-1",
    storage: new MemorySessionStore(),
    // This is where a real wallet shows a confirm dialog and reuses its
    // build → sign → broadcast pipeline. Here we just echo a fake hash.
    onTransaction: async (params) => {
      line(`\n[wallet] transaction request from ${params.from}`);
      for (const m of params.messages) line(`         · ${JSON.stringify(m)}`);
      line(`[wallet] user approves → broadcasting…`);
      return { hash: "0x" + "ab".repeat(16), accepted: true };
    },
  });

  // --- The dApp (website) side ------------------------------------------
  const dapp = new AetraConnect({
    app: { name: "Aetra Swap", url: "https://swap.aetra.example" },
    bridge,
    storage: new MemorySessionStore(),
  });

  dapp.on("connect", (a) => line(`\n[dapp] connected to ${a.address} (proof ${a.proof ? "verified ✓" : "not requested"})`));
  dapp.on("disconnect", (e) => line(`[dapp] disconnected: ${e.reason}`));

  // 1) dApp starts pairing and renders the URI as a QR / deep link.
  const handshake = dapp.connect({ proof: true });
  line(`\n[dapp] show this in the modal QR:`);
  line(`       ${handshake.universalLink}`);
  line(`[dapp] or open the wallet via: ${handshake.deepLink.slice(0, 48)}…`);

  // 2) The wallet scans/opens the URI and approves (its own UI would gate this).
  const request = wallet.readRequest(handshake.deepLink);
  line(`\n[wallet] pairing request from "${request.app.name}" (${request.app.url})`);
  await wallet.approve(request);

  // 3) The dApp's approval resolves with the proven account.
  const connected = await handshake.approval();
  line(`[dapp] approval resolved: ${connected.address}`);

  // 4) The dApp asks the wallet to send a transaction.
  const recipient = Wallet.random().address.toUserFriendly();
  const tx = await dapp.sendTransaction({
    messages: [{ kind: "send", to: recipient, amountNaet: "1500000000", comment: "gm from the demo" }],
    memo: "gm from the demo",
  });
  line(`\n[dapp] tx broadcast → hash ${tx.hash} (accepted: ${tx.accepted})`);

  // 5) Off-chain proof of ownership (no transaction).
  const signed = await dapp.signMessage("Log in to Aetra Swap");
  line(`[dapp] signMessage verified for ${signed.address}`);

  // 6) Tear the session down.
  await dapp.disconnect("demo complete");
  await new Promise((r) => setTimeout(r, 10));
  line(`\n[done] wallet active sessions: ${wallet.activeSessions.length}`);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
