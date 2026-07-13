/**
 * Illustrative wallet integration (the Dalen wallet side).
 *
 * The wallet imports `@aetra-network/connect/wallet`, wires an `AetraWalletConnect` to
 * its unlocked account, and implements `onTransaction` as the seam where it
 * shows its confirm dialog and reuses its existing build → sign → broadcast
 * pipeline. Here that pipeline is `@aetra-network/kit`'s `WalletClient` — it executes
 * the exact same `ConnectTxMessage[]` vocabulary this protocol carries as one
 * signed tx, so an approved request forwards straight through with no
 * re-encoding by hand (see `@aetra-network/kit`'s `compileIntents` for that mapping).
 * `@aetra-network/kit` isn't a dependency of this package; a real wallet integration
 * installs it alongside `@aetra-network/connect`: `npm install @aetra-network/kit`.
 *
 * This file is documentation, not run by the test suite.
 */
import {
  AetraWalletConnect,
  userRejected,
  type TransactionHandler,
  type WalletSigner,
} from "@aetra-network/connect/wallet";
import { BrowserSessionStore, type ConnectTxMessage } from "@aetra-network/connect";
import { Amount, Wallet } from "@aetra-network/sdk";
import { WalletClient, createWalletClient } from "@aetra-network/kit";

/**
 * Builds the transaction handler. `walletClient` is a `@aetra-network/kit`
 * `WalletClient` over the unlocked account; `confirm` is the wallet's own
 * approval dialog (returns true if the user approves).
 */
function makeTransactionHandler(
  walletClient: WalletClient,
  confirm: (summary: string) => Promise<boolean>,
): TransactionHandler {
  return async (params) => {
    // 1) Ask the user. Reject → the dApp's promise rejects with USER_REJECTED.
    const summary = params.messages.map(describe).join("\n");
    if (!(await confirm(summary))) throw userRejected("transaction");

    // 2) Execute the whole batch as one signed tx. `accepted` threads through
    // the real CheckTx verdict — don't hardcode it to true once you're past
    // the confirm step.
    return walletClient.send(params.messages, params.memo ? { memo: params.memo } : {});
  };
}

function describe(msg: ConnectTxMessage): string {
  switch (msg.kind) {
    case "send":
      return `Send ${Amount.fromNaet(msg.amountNaet).toString()} to ${msg.to}`;
    case "activate":
      return "Activate account (record public key)";
    case "contract.execute":
      return `Call contract ${msg.contract} (opcode ${msg.opcode ?? 0})`;
    case "contract.deploy":
      return `Deploy contract (salt ${msg.salt})`;
    case "stake.deposit":
      return `Deposit ${Amount.fromNaet(msg.amountNaet).toString()} into pool ${msg.poolId}`;
    case "stake.unbond":
      return `Unbond ${msg.shares} shares from pool ${msg.poolId}`;
    case "stake.claim":
      return `Claim rewards from pool ${msg.poolId}`;
    case "raw":
      return `Raw message ${msg.typeUrl}`;
    default:
      return (msg as { kind: string }).kind;
  }
}

/** Called after the wallet unlocks. */
export async function startWalletConnect(account: Wallet, confirm: (s: string) => Promise<boolean>) {
  const walletClient = createWalletClient({ account, url: "http://127.0.0.1:8080" });

  const wc = new AetraWalletConnect({
    bridge: "https://bridge.aetra.network",
    signer: account as WalletSigner, // an @aetra-network/sdk Wallet satisfies WalletSigner
    wallet: { name: "Dalen Wallet", url: "https://wallet.aetra.network" },
    chainId: "aetra-localnet-1",
    storage: new BrowserSessionStore("aetra-connect:dalen"),
    onTransaction: makeTransactionHandler(walletClient, confirm),
    // Gate off-chain signing behind the same dialog if you like:
    // onSignMessage: async (message) => { if (!(await confirm(message))) throw userRejected(); ... },
    autoDisconnectMs: 30 * 60_000, // mirror the wallet's auto-lock idle window
  });

  // Resume sessions paired before this unlock, so requests keep flowing.
  await wc.resume();

  // The wallet's "scan QR / paste link" action calls:
  //   const request = wc.readRequest(uri);   // show request.app, then:
  //   await wc.approve(request);              // or wc.reject(request)

  return wc;
}
