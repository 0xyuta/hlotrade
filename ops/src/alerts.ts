const DISCORD_MAX = 1990;
const TELEGRAM_MAX = 4000;

/** ALERT_WEBHOOK_URL (Slack/Discord-style JSON) and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. */
export function alertRequests(env: Record<string, string | undefined>, text: string) {
  const out: { label: string; url: string; body: Record<string, unknown> }[] = [];
  if (env.ALERT_WEBHOOK_URL) out.push({ label: "webhook", url: env.ALERT_WEBHOOK_URL, body: { text, content: text.slice(0, DISCORD_MAX) } });
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    out.push({
      label: "telegram",
      url: `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      body: { chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, TELEGRAM_MAX), disable_web_page_preview: true },
    });
  }
  return out;
}

/** Logs to stderr and posts to every configured channel. A failing channel never throws, and only its label is logged (the Telegram token is in its URL). */
export async function sendAlert(env: Record<string, string | undefined>, text: string): Promise<void> {
  console.error(`ALERT: ${text}`);
  for (const r of alertRequests(env, `HLO: ${text}`)) {
    try {
      const res = await fetch(r.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r.body), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) console.error(`alert via ${r.label} failed: HTTP ${res.status}`);
    } catch (e) {
      console.error(`alert via ${r.label} failed: ${(e as Error).name}`);
    }
  }
}
