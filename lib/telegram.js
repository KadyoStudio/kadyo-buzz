// Both bots write to Kevin's private chat: the news bot (buzz alerts, morning topics, drafts) and the
// publication bot (site stats, LinkedIn calendar). DRY_RUN=1 prints the messages instead of sending them.
const DRY_RUN = process.env.DRY_RUN === "1";

export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function bot(token) {
  const chatId = () => process.env.TELEGRAM_CHAT_ID;

  async function call(method, body) {
    if (DRY_RUN) {
      console.log(`--- ${method} ---\n${body?.text ?? body?.caption ?? JSON.stringify(body)}\n`);
      return { message_id: Date.now() };
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
    return data.result;
  }

  const say = (text, replyTo, keyboard) =>
    call("sendMessage", {
      chat_id: chatId(),
      text: text.length > 4000 ? `${text.slice(0, 3990)}…` : text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });

  async function sendPhoto(image, caption, replyTo) {
    if (DRY_RUN) return call("sendPhoto", { caption });
    const form = new FormData();
    form.append("chat_id", chatId());
    form.append("caption", caption);
    form.append("photo", new Blob([image], { type: "image/jpeg" }), "visuel.jpg");
    if (replyTo) form.append("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) throw new Error(`telegram sendPhoto: ${data.description}`);
    return data.result;
  }

  const clearButtons = (message) =>
    call("editMessageReplyMarkup", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});

  /** Points the bot's webhook at `url`; Telegram then signs every update with the secret. */
  const setWebhook = (url) =>
    call("setWebhook", {
      url,
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
    });

  return { call, say, sendPhoto, clearButtons, setWebhook };
}

export const news = bot(process.env.ACTU_BOT_TOKEN);
export const publication = bot(process.env.TELEGRAM_BOT_TOKEN);

export const fromKevin = (chatOrUser) => String(chatOrUser?.id) === String(process.env.TELEGRAM_CHAT_ID);
export const signedByTelegram = (request) =>
  request.headers.get("x-telegram-bot-api-secret-token") === process.env.TELEGRAM_WEBHOOK_SECRET;
