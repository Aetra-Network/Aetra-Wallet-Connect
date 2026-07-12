/**
 * Illustrative wallet integration (the Dalen wallet side).
 *
 * The wallet imports `@aetra/connect/wallet`, wires an `AetraWalletConnect` to
 * its unlocked account, and implements `onTransaction` as the seam where it
 * shows its confirm dialog and reuses its existing build → sign → broadcast
 * pipeline. Here that pipeline is the `@aetra/sdk` `Aetra` facade.
 *
 * This file is documentation, not run by the test suite.
 */
import {
  AetraWalletConnect,
  userRejected,
  type TransactionHandler,
  type WalletSigner,
} from "@aetra/connect/wallet";
import { BrowserSessionStore } from "@aetra/connect";
import { Aetra, Amount, Wallet } from "@aetra/sdk";

/**
 * Builds the transaction handler. `account` is the unlocked `Wallet`; `confirm`
 * is the wallet's own approval dialog (returns true if the user approves).
 */
function makeTransactionHandler(
  account: Wallet,
  aetra: Aetra,
  confirm: (summary: string) => Promise<boolean>,
): TransactionHandler {
  return async (params) => {
    // 1) Ask the user. Reject → the dApp's promise rejects with USER_REJECTED.
    const summary = params.messages.map(describe).join("\n");
    if (!(await confirm(summary))) throw userRejected("transaction");

    // 2) Execute each intent through the SDK. (Batch as needed for your UX.)
    let last: { ok: boolean; hash?: string; error?: string } = { ok: false };
    for (const msg of params.messages) {
      last = await execute(account, aetra, msg, params.memo);
      if (!last.ok) throw new Error(last.error ?? "transaction failed");
    }
    return { hash: last.hash!, accepted: true };
  };
}

async function execute(account: Wallet, aetra: Aetra, msg: any, memo?: string) {
  switch (msg.kind) {
    case "send": {
      const out = await aetra.transfer({ from: account, to: msg.to, amount: Amount.fromNaet(msg.amountNaet), memo });
      return out.ok ? { ok: true, hash: out.hash } : { ok: false, error: out.error };
    }
    case "activate": {
      const out = await aetra.activate({ wallet: account });
      return out.ok ? { ok: true, hash: out.hash } : { ok: false, error: out.error };
    }
    case "contract.execute": {
      const out = await aetra.sendToContract({
        from: account,
        contract: msg.contract,
        opcode: msg.opcode,
        // Map msg.fields → a ContractPayload with @aetra/sdk `Field` here.
        funds: msg.fundsNaet ? Amount.fromNaet(msg.fundsNaet) : undefined,
        gasLimit: msg.gasLimit,
      });
      return out.ok ? { ok: true, hash: out.hash } : { ok: false, error: out.error };
    }
    // stake.* and raw route to the wallet's own staking module / TxBuilder.
    default:
      return { ok: false, error: `unsupported intent: ${msg.kind}` };
  }
}

function describe(msg: any): string {
  switch (msg.kind) {
    case "send":
      return `Send ${Amount.fromNaet(msg.amountNaet).toString()} to ${msg.to}`;
    case "activate":
      return "Activate account (record public key)";
    case "contract.execute":
      return `Call contract ${msg.contract} (opcode ${msg.opcode ?? 0})`;
    default:
      return `${msg.kind}`;
  }
}

/** Called after the wallet unlocks. */
export async function startWalletConnect(account: Wallet, confirm: (s: string) => Promise<boolean>) {
  const aetra = new Aetra({ baseUrl: "http://127.0.0.1:8080" });

  const wc = new AetraWalletConnect({
    bridge: "https://bridge.aetra.network",
    signer: account as WalletSigner, // an @aetra/sdk Wallet satisfies WalletSigner
    wallet: { name: "Dalen Wallet", url: "https://wallet.aetra.network" },
    chainId: "aetra-localnet-1",
    storage: new BrowserSessionStore("aetra-connect:dalen"),
    onTransaction: makeTransactionHandler(account, aetra, confirm),
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
