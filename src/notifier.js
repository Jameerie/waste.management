import { config } from "./config.js";

/**
 * Alert transport.
 *
 * Telegram is the default because it is the cheapest option that still reaches
 * a phone as a real push notification: free, unlimited, no per-message cost,
 * and a bot takes two minutes to create. SMS gateways charge per message and
 * add up quickly across many bins.
 *
 * Delivery must never break ingestion. If Telegram is down or misconfigured
 * the reading is still recorded and the event still lands in the database -
 * we log the failure and move on.
 */

const TELEGRAM_TIMEOUT_MS = 8000;

export function isConfigured() {
  return Boolean(config.telegram.botToken && config.telegram.chatId);
}

/**
 * @returns {Promise<boolean>} whether the alert was actually delivered
 */
export async function sendAlert(text) {
  if (!isConfigured()) {
    // Development fallback - makes the whole pipeline usable with no setup.
    console.log(`[alert] ${text}`);
    return false;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          disable_notification: false,
        }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      console.error(`[alert] telegram responded ${res.status}: ${await safeBody(res)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[alert] telegram delivery failed: ${err.message}`);
    return false;
  }
}

async function safeBody(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}
