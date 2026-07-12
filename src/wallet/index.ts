/**
 * Wallet side. `AetraWalletConnect` reads a pairing URI, approves/rejects it,
 * and serves the dApp's requests through injected handlers (where the wallet
 * shows its confirm UI and reuses its build-sign-broadcast pipeline).
 */
export { AetraWalletConnect, userRejected } from "./connector.js";
export type {
  AetraWalletConnectOptions,
  WalletSigner,
  TransactionHandler,
  SignMessageHandler,
  TransactionContext,
} from "./connector.js";
