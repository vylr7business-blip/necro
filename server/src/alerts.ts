import { CONFIG } from "./config.js";

const lastSent = new Map<string, number>();

/** Log an alert and, if a webhook is set, post it (Discord or Slack style). Same key at most once per 30 min. */
export async function alert(key: string, text: string) {
  const now = Date.now();
  if ((lastSent.get(key) ?? 0) > now - 30 * 60_000) return;
  lastSent.set(key, now);
  console.warn(`[ALERT] ${text}`);
  if (!CONFIG.alertWebhook) return;
  try {
    await fetch(CONFIG.alertWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `🪦 Necro: ${text}`, text: `🪦 Necro: ${text}` }),
    });
  } catch (e) {
    console.warn("[ALERT] webhook failed", e);
  }
}
