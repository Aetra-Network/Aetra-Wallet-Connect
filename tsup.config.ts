import { defineConfig } from "tsup";

/**
 * Each entry is a subpath export (see package.json "exports"). A dApp that only
 * shows a connect button pulls `@aetra/connect/dapp`; a wallet integration pulls
 * `@aetra/connect/wallet`. Splitting the bundles keeps the dApp path from
 * dragging in wallet-only code (and vice versa), and lets the light primitives
 * (`/proof`, `/crypto`) be imported on their own.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    dapp: "src/dapp/index.ts",
    wallet: "src/wallet/index.ts",
    proof: "src/proof/index.ts",
    session: "src/session/index.ts",
    bridge: "src/bridge/index.ts",
    crypto: "src/crypto/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Runtime deps stay external — declared in package.json, resolved by the consumer.
  external: ["@aetra/sdk", "@noble/ciphers", "@noble/curves", "@noble/hashes"],
});
