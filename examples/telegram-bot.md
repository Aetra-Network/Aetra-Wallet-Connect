# Server-side usage: a Telegram bot

`@aetra-network/connect` runs headless in Node (>=18) with **zero extra setup** — the
`HttpBridge` falls back to a built-in fetch-streaming SSE client when there is
no browser `EventSource`. That makes the "dApp side" of the protocol usable
from a bot, a backend, or a CLI: generate a pairing QR, wait for the user's
wallet to approve, then request transactions.

The example below is a complete Telegram bot (using [grammY](https://grammy.dev)
and the `qrcode` package for PNG generation):

```bash
npm install @aetra-network/connect @aetra-network/sdk grammy qrcode
```

```js
// bot.mjs
import { Bot, InputFile } from "grammy";
import QRCode from "qrcode";
import { AetraConnect, AetraConnectError, MemorySessionStore } from "@aetra-network/connect";

const BRIDGE = process.env.AETRA_BRIDGE ?? "https://bridge.aetra.network";
const bot = new Bot(process.env.BOT_TOKEN);

// One connector per Telegram user (each has its own session).
const connectors = new Map();
function connectorFor(userId) {
  let c = connectors.get(userId);
  if (!c) {
    c = new AetraConnect({
      // The bot's identity — host this manifest anywhere CORS-open.
      manifestUrl: "https://mybot.example/aetra-connect-manifest.json",
      bridge: BRIDGE,
      storage: new MemorySessionStore(), // swap for a DB-backed SessionStore in production
    });
    connectors.set(userId, c);
  }
  return c;
}

bot.command("connect", async (ctx) => {
  const connect = connectorFor(ctx.from.id);
  await connect.ready();

  const handshake = connect.connect({ proof: true });

  // Render the pairing link as a QR PNG and send it.
  const png = await QRCode.toBuffer(handshake.universalLink, { width: 400, margin: 1 });
  await ctx.replyWithPhoto(new InputFile(png, "connect.png"), {
    caption: "Scan with your Aetra wallet to connect.",
  });

  try {
    const account = await handshake.approval({ timeoutMs: 3 * 60_000 });
    await ctx.reply(`Connected: ${account.address}\n(ownership verified by Aetra Proof)`);
  } catch (err) {
    if (AetraConnectError.is(err, "TIMEOUT")) await ctx.reply("Connection timed out — /connect to retry.");
    else if (AetraConnectError.is(err, "USER_REJECTED")) await ctx.reply("You declined the connection.");
    else await ctx.reply("Could not connect.");
  }
});

bot.command("send", async (ctx) => {
  const connect = connectorFor(ctx.from.id);
  if (!connect.connected) return ctx.reply("Not connected — /connect first.");

  // /send AE…recipient 1.5
  const [, to, aet] = ctx.message.text.split(/\s+/);
  const amountNaet = (BigInt(Math.round(parseFloat(aet) * 1e9))).toString(); // or Amount.fromAet(aet).toNaetString()

  await ctx.reply("Confirm the transaction in your wallet…");
  try {
    const { hash } = await connect.sendTransaction({
      messages: [{ kind: "send", to, amountNaet, comment: "via telegram bot" }],
    });
    await ctx.reply(`Sent! Tx: ${hash}`);
  } catch (err) {
    if (AetraConnectError.is(err, "USER_REJECTED")) await ctx.reply("You rejected it in the wallet.");
    else await ctx.reply(`Failed: ${err.message}`);
  }
});

bot.command("disconnect", async (ctx) => {
  await connectorFor(ctx.from.id).disconnect();
  await ctx.reply("Disconnected.");
});

bot.start();
```

## Notes

- **No `EventSource` shim needed** — the bridge subscribes via its built-in
  `FetchEventSource` (streaming `fetch` + auto-reconnect).
- **Sessions**: `MemorySessionStore` forgets on restart. For a real bot,
  implement the 4-method `SessionStore` interface over your database so users
  stay connected across deploys.
- **Off-chain login**: `connect.signMessage("…nonce…")` works the same way —
  useful to bind a Telegram account to an Aetra address verifiably.
- The same pattern works for any server-side flow (payment terminals, CI
  approval gates, checkout pages rendered server-side).
