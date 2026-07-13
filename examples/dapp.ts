/**
 * Illustrative dApp integration (browser).
 *
 * A website imports `@aetra-network/connect/dapp`, shows a "Connect wallet" button that
 * opens a modal with a QR code, and once connected requests transactions. Pair
 * this with any QR renderer (e.g. `qrcode` / `qrcode.react`).
 *
 * This file is documentation, not run by the test suite.
 */
import { AetraConnect, AetraConnectError, BrowserSessionStore } from "@aetra-network/connect";

const connect = new AetraConnect({
  app: {
    name: "Aetra Swap",
    url: window.location.origin, // the origin the Aetra Proof binds to
    icon: `${window.location.origin}/icon.png`,
  },
  // A public relay. In same-tab/embedded setups pass a Bridge instance instead.
  bridge: "https://bridge.aetra.network",
  // Persist the session so a reload stays connected.
  storage: new BrowserSessionStore("aetra-connect:swap"),
  // The universal link a QR should encode (opens the web wallet).
  universalBase: "https://wallet.aetra.network/connect",
});

// Resume a prior session on page load.
export async function init() {
  const account = await connect.restore();
  if (account) renderConnected(account.address);

  connect.on("connect", (a) => renderConnected(a.address));
  connect.on("disconnect", () => renderDisconnected());
}

// Called when the user clicks "Connect wallet".
export async function onConnectClick() {
  const handshake = connect.connect({ proof: true });

  // Render the modal: a QR of `universalLink`, plus an "Open wallet" deep link.
  showModal({
    qrData: handshake.universalLink,
    openWalletHref: handshake.deepLink,
    onCancel: () => handshake.cancel(),
  });

  try {
    const account = await handshake.approval({ timeoutMs: 3 * 60_000 });
    hideModal();
    renderConnected(account.address);
  } catch (err) {
    hideModal();
    if (AetraConnectError.is(err, "USER_REJECTED")) toast("Connection declined");
    else if (AetraConnectError.is(err, "TIMEOUT")) toast("Connection timed out");
    else toast("Could not connect");
  }
}

// Called when the user submits a swap / send.
export async function onSend(to: string, amountNaet: string) {
  try {
    const { hash } = await connect.sendTransaction({
      messages: [{ kind: "send", to, amountNaet, comment: "swap via Aetra Connect" }],
    });
    toast(`Sent — ${hash}`);
  } catch (err) {
    if (AetraConnectError.is(err, "USER_REJECTED")) toast("You rejected the transaction");
    else toast(err instanceof Error ? err.message : "Transaction failed");
  }
}

// Off-chain login: prove address ownership without a transaction.
export async function onLogin() {
  const nonce = crypto.randomUUID();
  const signed = await connect.signMessage(`Sign in to Aetra Swap: ${nonce}`);
  // Send { signed, nonce } to your backend, which re-verifies with
  // `verifySignedMessage` from `@aetra-network/connect/proof`.
  return signed;
}

export async function onDisconnect() {
  await connect.disconnect();
}

// --- UI stubs (wire these to your framework) --------------------------------
declare function showModal(opts: { qrData: string; openWalletHref: string; onCancel: () => void }): void;
declare function hideModal(): void;
declare function renderConnected(address: string): void;
declare function renderDisconnected(): void;
declare function toast(message: string): void;
