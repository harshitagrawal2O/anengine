import { config } from "../config.js";

export async function sendTelegram(text: string): Promise<{ ok: boolean; channel: string }> {
  const { token, chatId } = config.telegram;
  if (!token || !chatId) {
    console.log("\n[telegram:console] " + text + "\n");
    return { ok: true, channel: "console" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      // Bound the request so a hung/slow Telegram API can't leak a pending
      // fetch (and block a tick that awaits delivery) indefinitely.
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[telegram] error", res.status, body);
      return { ok: false, channel: "telegram" };
    }
    return { ok: true, channel: "telegram" };
  } catch (e) {
    console.error("[telegram] failed", e);
    return { ok: false, channel: "telegram" };
  }
}
