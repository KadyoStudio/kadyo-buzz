import { readFileSync, writeFileSync, existsSync } from "node:fs";

const STATE_FILE = process.env.STATE_FILE ?? "state.json";
const { ZERNIO_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const ZERNIO = "https://zernio.com/api/v1";
const TELEGRAM = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
// Text after this line in a draft is published as the first comment (LinkedIn shows posts with a link in the caption less).
const COMMENT_MARKER = "\n[commentaire]\n";

if (!ZERNIO_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.log("linkedin: missing ZERNIO_API_KEY or Telegram secrets, skipped");
  process.exit(0);
}

async function zernio(method, path, body) {
  const res = await fetch(`${ZERNIO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ZERNIO_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`zernio ${method} ${path} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function telegram(method, body) {
  const res = await fetch(`${TELEGRAM}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const idOf = (post) => post._id ?? post.id;
const accountIdOf = (p) => (typeof p.accountId === "object" ? (p.accountId._id ?? p.accountId.id) : p.accountId);

function split(content) {
  const [text, comment = ""] = content.split(COMMENT_MARKER);
  return { text: text.trim(), comment: comment.trim() };
}

async function listLinkedinDrafts() {
  const data = await zernio("GET", "/posts?status=draft&limit=50");
  const posts = data.posts ?? data.data ?? [];
  return posts.filter((p) => p.status === "draft" && (p.platforms ?? []).some((pl) => pl.platform === "linkedin"));
}

async function announce(post) {
  const { text, comment } = split(post.content ?? "");
  const body =
    `📝 <b>Post LinkedIn à valider</b>\n\n${escapeHtml(text)}` +
    (comment ? `\n\n💬 <b>Premier commentaire</b>\n${escapeHtml(comment)}` : "") +
    `\n\n<i>Réponds OUI à ce message pour publier, NON pour l'abandonner.</i>`;
  const message = await telegram("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: body.length > 4000 ? `${body.slice(0, 3990)}…` : body,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  return message.message_id;
}

async function publish(draftId) {
  const data = await zernio("GET", `/posts/${draftId}`);
  const draft = data.post ?? data;
  const { text, comment } = split(draft.content ?? "");
  const platforms = (draft.platforms ?? [])
    .filter((p) => p.platform === "linkedin")
    .map((p) => ({
      platform: "linkedin",
      accountId: accountIdOf(p),
      ...(comment ? { platformSpecificData: { firstComment: comment } } : {}),
    }));
  const mediaItems = (draft.mediaItems ?? []).map(({ url, type }) => ({ url, type }));
  const created = await zernio("POST", "/posts", {
    content: text,
    platforms,
    ...(mediaItems.length ? { mediaItems } : {}),
    publishNow: true,
  });
  const post = created.post ?? created;
  if (post.status !== "published") throw new Error(`publish status ${post.status}: ${JSON.stringify(post.platforms)}`);
  await zernio("DELETE", `/posts/${draftId}`);
  return post.platforms?.[0]?.platformPostUrl ?? "";
}

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
state.drafts ??= {};
state.tgOffset ??= 0;

const drafts = await listLinkedinDrafts();
const draftIds = new Set(drafts.map(idOf));
for (const id of Object.keys(state.drafts)) if (!draftIds.has(id)) delete state.drafts[id];
for (const post of drafts) {
  if (!state.drafts[idOf(post)]) state.drafts[idOf(post)] = await announce(post);
}

const updates = await telegram("getUpdates", { offset: state.tgOffset + 1, allowed_updates: ["message"] });
for (const update of updates) {
  state.tgOffset = Math.max(state.tgOffset, update.update_id);
  const message = update.message;
  if (!message || String(message.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
  const answer = (message.text ?? "").trim().toLowerCase();
  if (answer !== "oui" && answer !== "non") continue;

  const pending = Object.entries(state.drafts);
  const repliedTo = message.reply_to_message?.message_id;
  const target = repliedTo
    ? pending.find(([, messageId]) => messageId === repliedTo)
    : pending.length === 1 ? pending[0] : undefined;
  if (!target) {
    if (pending.length > 1 && !repliedTo) {
      await telegram("sendMessage", { chat_id: TELEGRAM_CHAT_ID, text: "Plusieurs posts attendent : réponds directement au message du post concerné." });
    }
    continue;
  }

  const [draftId, messageId] = target;
  try {
    if (answer === "oui") {
      const url = await publish(draftId);
      await telegram("sendMessage", {
        chat_id: TELEGRAM_CHAT_ID,
        reply_to_message_id: messageId,
        text: `✅ Publié sur LinkedIn${url ? ` : ${url}` : "."}`,
      });
    } else {
      await zernio("DELETE", `/posts/${draftId}`);
      await telegram("sendMessage", { chat_id: TELEGRAM_CHAT_ID, reply_to_message_id: messageId, text: "🗑️ Post abandonné." });
    }
    delete state.drafts[draftId];
  } catch (err) {
    console.error(err.message);
    await telegram("sendMessage", {
      chat_id: TELEGRAM_CHAT_ID,
      reply_to_message_id: messageId,
      text: `⚠️ Échec de la publication, le brouillon est conservé dans Zernio. ${err.message.slice(0, 300)}`,
    });
  }
}

writeFileSync(STATE_FILE, JSON.stringify(state));
console.log(`linkedin: ${Object.keys(state.drafts).length} draft(s) pending`);
