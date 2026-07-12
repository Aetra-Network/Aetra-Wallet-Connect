# @aetra/connect

**Aetra Wallet Connect** — an end-to-end-encrypted protocol for connecting a
dApp to an Aetra wallet. A website shows a modal with a QR code (or a deep link
to the wallet); the user approves in their wallet; the dApp gets a proven
account and can request transactions that the wallet confirms and broadcasts.

Object-oriented, dependency-light TypeScript. Runs unchanged in the browser and
in Node (>=18). Built on [`@aetra/sdk`](../sdk) — the same address codec and
signer that the chain, the Dalen wallet, and the Tarsen framework already share.

> Status: **0.1.0 — foundation.** Full pairing → proof → transaction →
> disconnect flow, session persistence, idle auto-disconnect, and a reference
> relay. 34 tests, including an end-to-end handshake over the in-memory bridge.

## Why

`@aetra/sdk`'s `Signer` is the seam "who authorises a transaction". A local
`Wallet` implements it today. `@aetra/connect` is the **remote** signer: the
key stays in the user's wallet, the dApp holds only a session, and every
transaction is user-approved. Nothing signs on the dApp side.

## Install

```bash
npm install @aetra/connect
```

## The two sides

| Import | Class | Who uses it |
| --- | --- | --- |
| `@aetra/connect/dapp` | `AetraConnect` | The website — pair, then request transactions & signatures. |
| `@aetra/connect/wallet` | `AetraWalletConnect` | The wallet — read a URI, approve/reject, serve requests. |

Narrow primitives are exported on their own subpaths too: `@aetra/connect/proof`
(Aetra Proof), `@aetra/connect/crypto` (session keys + cipher),
`@aetra/connect/session` (state + storage), `@aetra/connect/bridge` (transports).

## dApp quick start

```ts
import { AetraConnect, BrowserSessionStore } from "@aetra/connect/dapp";

const connect = new AetraConnect({
  app: { name: "Aetra Swap", url: location.origin, icon: `${location.origin}/icon.png` },
  bridge: "https://bridge.aetra.network",
  storage: new BrowserSessionStore("aetra-connect:swap"),
});

await connect.restore();                      // resume a prior session, if any

// On "Connect wallet":
const handshake = connect.connect({ proof: true });
renderQrCode(handshake.universalLink);        // the QR the wallet scans
openWalletButton.href = handshake.deepLink;   // or an installed-wallet deep link

const account = await handshake.approval();   // resolves when the user approves
// account.address, account.addressRaw, account.pubkeyHex, account.proof

// Later:
const { hash } = await connect.sendTransaction({
  messages: [{ kind: "send", to: "AE…recipient", amountNaet: "1000000000", comment: "gm" }],
});

const signed = await connect.signMessage("Sign in to Aetra Swap: <nonce>");

await connect.disconnect();
```

`connect.on("connect" | "disconnect" | "session_update", …)` mirror the same
state changes for a reactive UI.

## Wallet quick start

```ts
import { AetraWalletConnect, userRejected } from "@aetra/connect/wallet";

const wc = new AetraWalletConnect({
  bridge: "https://bridge.aetra.network",
  signer: unlockedWallet,                  // an @aetra/sdk Wallet — or any { pubkeyHex, sign }
  wallet: { name: "Dalen Wallet" },
  chainId: "aetra-localnet-1",
  onTransaction: async (params, { account }) => {
    if (!(await showConfirmDialog(params))) throw userRejected("transaction");
    const { hash } = await buildSignBroadcast(params);   // your existing pipeline
    return { hash, accepted: true };
  },
});

await wc.resume();                          // reattach sessions after unlock

// When the wallet scans a QR / opens a deep link:
const request = wc.readRequest(uri);        // throws MALFORMED / UNSUPPORTED_VERSION / EXPIRED
// show request.app in the approval screen, then:
await wc.approve(request);                   // or: await wc.reject(request, "not now")
```

`onTransaction` is the whole integration point: it receives the decrypted intent
list, shows the wallet's confirm UI, and returns the broadcast hash. See
[`examples/wallet.ts`](examples/wallet.ts) for wiring it to the `@aetra/sdk`
`Aetra` facade.

## How the handshake works

```
 dApp                         bridge (relay)                     wallet
  │  connect() → pairing URI ──────────────────── (QR / deep link) →│
  │  subscribe(dappClientId)                                        │  readRequest(uri)
  │                                                                 │  approve(): sign Aetra Proof
  │  ← ── ─ encrypted ConnectEvent ── ─────────── send(dapp) ───────│  subscribe(walletClientId)
  │  verify proof, open Session                                     │
  │  sendTransaction() ─ encrypted request ── send(wallet) ─────────→│  onTransaction() → confirm → broadcast
  │  ← ── ─ encrypted response (hash) ── ──────── send(dapp) ────────│
```

- **Pairing** travels in the URI (public: only the dApp's session key, origin,
  and a challenge). Everything after is AEAD-sealed over the bridge.
- **Transport encryption**: each side mints an ephemeral **X25519** keypair;
  its public key is the `clientId` the relay routes by. ECDH → HKDF-SHA256 →
  **XChaCha20-Poly1305**. The relay only sees ciphertext and routing ids.
- **Account proof**: separate from transport, the wallet signs an **Aetra Proof**
  with its **secp256k1** account key (see below).

## Aetra Proof

At connect time the dApp sends a random `payload` challenge. The wallet returns
a signature over a domain-separated encoding of:

> `"aetra-proof-v1"` ‖ dApp origin ‖ challenge ‖ account (raw) ‖ **dApp clientId** ‖ **wallet clientId** ‖ timestamp

Binding **both session keys** ties the account signature to this exact encrypted
channel — a man-in-the-middle on the relay can't splice a genuine proof onto its
own session key. The domain separator (first byte `0x61`) can never prefix a
Cosmos `SignDoc` (`0x0a`), so a proof signature is never a valid transaction
signature and vice-versa. The dApp verifies the signature, that the address
derives from the public key, that the challenge/origin/keys match, and that the
timestamp is fresh. Verification lives in `@aetra/connect/proof` (`AetraProof`).

`signMessage` / `verifySignedMessage` provide the same guarantee for arbitrary
off-chain messages (its own `"aetra-signed-message-v1"` domain).

## Sessions & auto-disconnect

A `Session` carries a hard TTL (`sessionTtlMs`, default 7 days) and an idle
window (`autoDisconnectMs`, default 30 min — mirror the wallet's auto-lock). The
connectors run a heartbeat that tears a session down on expiry or inactivity and
emits `disconnect`. `BrowserSessionStore` persists sessions to `localStorage`
(the channel key is re-derived on load, never stored), so `restore()` / `resume()`
survive a reload. Store records only inside the same trust boundary as the
account keys — a record holds an X25519 secret key.

## Transaction intents

`sendTransaction({ messages })` takes a list of high-level intents the wallet
resolves into signed chain messages:

| `kind` | Fields |
| --- | --- |
| `send` | `to`, `amountNaet`, `comment?` |
| `activate` | — (records the account's public key) |
| `stake.deposit` | `poolId`, `amountNaet` |
| `stake.unbond` | `poolId`, `requestId`, `shares` |
| `stake.claim` | `poolId` |
| `contract.execute` | `contract`, `opcode?`, `fields?`, `fundsNaet?`, `gasLimit?` |
| `raw` | `typeUrl`, `valueBase64` (escape hatch) |

Amounts are base-unit **naet** strings (never floats). The dApp describes intent;
the wallet decides how to build, sign, fee, and broadcast — the dApp never sees a
private key.

## The bridge

The relay is a dumb forwarder: it routes envelopes by recipient id and never
sees plaintext, so it can be a shared public service. `HttpBridge` talks to it
over `POST /send` and `GET /events?client=<id>` (SSE). A minimal, runnable
reference relay is in [`examples/relay.mjs`](examples/relay.mjs):

```bash
node examples/relay.mjs        # listens on :8788
```

For a wallet embedded in the same page as the dApp, pass a `MemoryBridge`
instance to both sides instead of a URL — no relay needed.

## Run the demo

```bash
npm run build
node examples/demo.mjs         # dApp ↔ wallet in one process over MemoryBridge
```

It prints the pairing URI, the proof verification, a transaction round-trip, an
off-chain signature, and the disconnect.

## Security model

- The relay is **untrusted**: end-to-end AEAD means it sees only ciphertext and
  routing ids. A malicious relay can drop or reorder, never read or forge.
- The **Aetra Proof** authenticates the account to the dApp and is bound to the
  session keys, defeating relay-level key substitution.
- **Replay** is prevented by the per-connection challenge and a freshness window.
- Requests carry a `validUntil`; the wallet refuses stale ones.
- The dApp **holds no key** and cannot sign — every transaction is user-approved
  in the wallet.

## Develop

```bash
npm install
npm test         # vitest — crypto, proof, uri, session, e2e handshake (34 tests)
npm run typecheck
npm run build    # tsup → dist/ (ESM + .d.ts), one bundle per subpath
```

## License

Apache-2.0
