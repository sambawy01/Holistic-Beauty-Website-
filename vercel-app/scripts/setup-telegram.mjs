#!/usr/bin/env node
/**
 * Connect Vassili's Telegram bot to the production webhook.
 *
 * Usage:  node scripts/setup-telegram.mjs            (run from vercel-app/)
 *         node scripts/setup-telegram.mjs --info     (only print webhook info)
 *         node scripts/setup-telegram.mjs --delete   (remove the webhook)
 *
 * Prerequisites:
 * 1. Create the bot with @BotFather (/newbot) and put the token in
 *    vercel-app/.env.local as TELEGRAM_BOT_TOKEN=...
 * 2. Generate the webhook secret:  openssl rand -hex 32
 *    and put it in .env.local as TELEGRAM_WEBHOOK_SECRET=...
 * 3. Add BOTH env vars to the Vercel project (production) too — the webhook
 *    route fails closed without them.
 * 4. Run this script. It calls getMe (token sanity check), then setWebhook
 *    pointing at the production route with the secret_token, then prints
 *    getWebhookInfo so you can see Telegram's view.
 * 5. In Telegram, Victoria sends the bot:  /start <ADMIN_PASS>
 *    to bind her chat as the owner.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WEBHOOK_URL =
  "https://book.victoriaholisticbeauty.com/api/telegram/webhook";

// --- env ---------------------------------------------------------------------
function loadEnvLocal() {
  const envPath = join(__dirname, "..", ".env.local");
  const env = {};
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
      if (m) env[m[1]] = m[2].trim();
    }
  } catch {
    // no .env.local — rely on process.env
  }
  return env;
}

const env = loadEnvLocal();
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
const SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET;

if (!TOKEN) {
  console.error(
    "TELEGRAM_BOT_TOKEN missing.\n" +
      "Create the bot with @BotFather, then add TELEGRAM_BOT_TOKEN=<token> to vercel-app/.env.local"
  );
  process.exit(1);
}

const api = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

async function call(method, payload) {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`${method} failed:`, data.description ?? data);
    process.exit(1);
  }
  return data.result;
}

const mode = process.argv[2] ?? "";

// --- sanity: who am I? ----------------------------------------------------------
const me = await call("getMe");
console.log(`Bot: @${me.username} (id ${me.id})`);

if (mode === "--delete") {
  await call("deleteWebhook", { drop_pending_updates: true });
  console.log("Webhook deleted.");
  process.exit(0);
}

if (mode !== "--info") {
  if (!SECRET) {
    console.error(
      "TELEGRAM_WEBHOOK_SECRET missing.\n" +
        "Generate with `openssl rand -hex 32` and add to vercel-app/.env.local AND the Vercel project."
    );
    process.exit(1);
  }
  await call("setWebhook", {
    url: WEBHOOK_URL,
    secret_token: SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  console.log(`Webhook set: ${WEBHOOK_URL}`);
}

const info = await call("getWebhookInfo");
console.log("\ngetWebhookInfo:");
console.log(JSON.stringify(info, null, 2));
console.log(
  "\nNext: Victoria opens the bot in Telegram and sends:  /start <ADMIN_PASS>"
);
