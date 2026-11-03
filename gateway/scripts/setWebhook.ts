function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env variable: ${key}`);
  return value;
}

const botToken = requiredEnv("BOT_TOKEN");
const webhookSecret = requiredEnv("WEBHOOK_SECRET");
const publicUrl = requiredEnv("PUBLIC_URL");

if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
  throw new Error(
    "WEBHOOK_SECRET must be 1-256 characters and contain only A-Z, a-z, 0-9, _ or -",
  );
}

const baseUrl = new URL(publicUrl);
if (baseUrl.protocol !== "https:") {
  throw new Error("PUBLIC_URL must use HTTPS, for example https://dezhbanbot.ir");
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error("PUBLIC_URL must be a plain HTTPS origin without credentials, query, or hash");
}

const webhookUrl = new URL("/webhook", baseUrl).toString();

// Telegram's Bot API requires the bot token in this outgoing API endpoint path.
// The webhook URL given to Telegram contains no token or secret.
const response = await fetch(
  `https://api.telegram.org/bot${botToken}/setWebhook`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      max_connections: 100,
      drop_pending_updates: false,
      allowed_updates: [
        "message",
        "edited_message",
        "callback_query",
        "my_chat_member",
        "message_reaction",
      ],
    }),
  },
);

const result = (await response.json()) as { ok?: boolean; description?: string };
if (!response.ok || !result.ok) {
  throw new Error(`Telegram setWebhook failed: ${result.description ?? response.statusText}`);
}

console.log(`Webhook successfully configured: ${webhookUrl}`);
