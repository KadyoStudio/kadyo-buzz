// Telegram webhook of the news bot: drafts a LinkedIn post from an alert, revises it on
// Kevin's replies and publishes it through Zernio on OUI. Drafts live in Vercel Blob,
// never in Zernio, so the publication calendar (publisher.mjs) never sees them.
import { waitUntil } from "@vercel/functions";
import { get, put } from "@vercel/blob";
import { write, parse } from "../lib/writer.js";
import { generatePhoto, compose } from "../lib/visual.js";

const { ACTU_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET, ZERNIO_API_KEY } = process.env;
const TELEGRAM = `https://api.telegram.org/bot${ACTU_BOT_TOKEN}`;
const ZERNIO = "https://zernio.com/api/v1";
const LINKEDIN_ACCOUNT = "6ae326288f95d757b1641c50";
const EXAMPLE_POSTS = 3;

// ---------- Telegram ----------

async function telegram(method, body) {
  const res = await fetch(`${TELEGRAM}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const say = (text, replyTo, keyboard) =>
  telegram("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: text.length > 4000 ? `${text.slice(0, 3990)}…` : text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });

async function sendPhoto(image, caption, replyTo) {
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("photo", new Blob([image], { type: "image/jpeg" }), "visuel.jpg");
  if (replyTo) form.append("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
  const res = await fetch(`${TELEGRAM}/sendPhoto`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram sendPhoto: ${data.description}`);
  return data.result;
}

const clearButtons = (message) =>
  telegram("editMessageReplyMarkup", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});

/** Links of a Telegram message: clickable titles (text_link) and bare URLs. */
function linksOf(message) {
  const text = message.text ?? message.caption ?? "";
  return (message.entities ?? message.caption_entities ?? [])
    .map((e) => (e.type === "text_link" ? e.url : e.type === "url" ? text.slice(e.offset, e.offset + e.length) : null))
    .filter(Boolean);
}

// ---------- storage ----------

async function load(path) {
  const found = await get(path, { access: "private", useCache: false });
  return found ? new Response(found.stream).json() : null;
}

async function loadBytes(path) {
  const found = await get(path, { access: "private", useCache: false });
  if (!found) throw new Error(`fichier introuvable : ${path}`);
  return Buffer.from(await new Response(found.stream).arrayBuffer());
}

const store = (path, data, contentType = "application/json") =>
  put(path, contentType === "application/json" ? JSON.stringify(data) : data, {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType,
  });

// ---------- Zernio ----------

async function zernio(method, path, body) {
  const res = await fetch(`${ZERNIO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ZERNIO_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`zernio ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Uploads the visual to Zernio's storage and returns its public URL, for mediaItems. */
async function uploadImage(image) {
  const { uploadUrl, publicUrl } = await zernio("POST", "/media/presign", {
    filename: "visuel.jpg",
    contentType: "image/jpeg",
  });
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: image });
  if (!res.ok) throw new Error(`envoi de l'image à Zernio : ${res.status}`);
  return publicUrl;
}

async function recentPosts() {
  const data = await zernio("GET", `/posts?status=published&limit=${EXAMPLE_POSTS}`);
  const posts = (data.posts ?? data.data ?? []).map((p) => p.content?.trim()).filter(Boolean);
  return posts.length ? posts.join("\n\n---\n\n") : "(aucun exemple disponible)";
}

// ---------- drafts ----------

function render(version, number) {
  if (!version.post) return `🤔 <b>Pas de post proposé</b>\n\n${escapeHtml(version.note)}`;
  return (
    `📝 <b>Post LinkedIn · version ${number}</b>\n\n${escapeHtml(version.post)}` +
    (version.comment ? `\n\n💬 <b>Premier commentaire</b>\n${escapeHtml(version.comment)}` : "") +
    (version.note ? `\n\n🗒️ <i>${escapeHtml(version.note)}</i>` : "") +
    `\n\n<i>Réponds à ce message pour le modifier, ou OUI pour publier.</i>`
  );
}

/** Reuses the previous visual when the hook and photo prompt are unchanged, otherwise makes a new one. */
async function makeVisual(draft, version, index) {
  const previous = draft.versions.findLast((v) => v.image);
  if (previous && previous.hook === version.hook && previous.imagePrompt === version.imagePrompt) {
    return { path: previous.image, fresh: false };
  }
  const image = await compose(await generatePhoto(version.imagePrompt), version.hook);
  const path = `images/${draft.id}-${index}.jpg`;
  await store(path, image, "image/jpeg");
  return { path, image, fresh: true };
}

async function writeVersion(draft, replyTo) {
  const { added, text } = await write(draft.messages, draft.examples);
  draft.messages.push(...added);
  const version = parse(text);
  const index = draft.versions.length;
  let visual;
  if (version.post) {
    if (!version.hook || !version.imagePrompt) {
      version.imageError = "le visuel n'a pas été décrit";
    } else {
      try {
        visual = await makeVisual(draft, version, index);
        version.image = visual.path;
      } catch (err) {
        console.error(err);
        version.imageError = err.message.slice(0, 200);
      }
    }
  }
  draft.versions.push(version);
  await store(`drafts/${draft.id}.json`, draft);

  const pointer = { draft: draft.id, version: index };
  if (visual?.fresh) {
    const photo = await sendPhoto(visual.image, `Visuel · version ${index + 1}`, replyTo);
    await store(`messages/${photo.message_id}.json`, pointer);
  }
  if (version.imageError) {
    version.note = `${version.note ? `${version.note}\n` : ""}⚠️ Visuel indisponible (${version.imageError}). Réponds « refais l'image » pour réessayer.`;
  }
  const keyboard = version.post
    ? [[
        { text: "✅ Publier", callback_data: `pub:${draft.id}:${index}` },
        { text: "❌ Abandonner", callback_data: `drop:${draft.id}` },
      ]]
    : undefined;
  const sent = await say(render(version, index + 1), replyTo, keyboard);
  await store(`messages/${sent.message_id}.json`, pointer);
}

async function startDraft(alert, instruction) {
  await say("✍️ Je lis les articles et je rédige le post (environ une minute)…", alert.message_id);
  const links = linksOf(alert);
  const request =
    `Alerte reçue :\n\n${alert.text ?? alert.caption ?? ""}` +
    (links.length ? `\n\nLiens de l'alerte :\n${links.join("\n")}` : "") +
    (instruction ? `\n\nConsigne de Kevin : ${instruction}` : "");
  const draft = {
    id: crypto.randomUUID(),
    status: "open",
    createdAt: new Date().toISOString(),
    examples: await recentPosts(),
    messages: [{ role: "user", content: request }],
    versions: [],
  };
  await writeVersion(draft, alert.message_id);
}

async function openDraft(id, replyTo) {
  const draft = await load(`drafts/${id}.json`);
  if (!draft) {
    await say("Brouillon introuvable.", replyTo);
    return null;
  }
  if (draft.status !== "open") {
    await say(draft.status === "published" ? "Ce post est déjà publié." : "Ce brouillon a été abandonné.", replyTo);
    return null;
  }
  return draft;
}

async function revise(id, instruction, replyTo) {
  const draft = await openDraft(id, replyTo);
  if (!draft) return;
  await say("✍️ Je modifie…", replyTo);
  draft.messages.push({ role: "user", content: `Modification demandée par Kevin : ${instruction}` });
  await writeVersion(draft, replyTo);
}

async function publish(id, index, replyTo) {
  const draft = await openDraft(id, replyTo);
  if (!draft) return;
  const version = draft.versions[index];
  if (!version?.post) return say("Cette version ne contient pas de post à publier.", replyTo);
  if (!version.image) return say("Pas de visuel pour cette version : réponds « refais l'image » au brouillon.", replyTo);
  const imageUrl = await uploadImage(await loadBytes(version.image));
  const created = await zernio("POST", "/posts", {
    content: version.post,
    mediaItems: [{ url: imageUrl, type: "image" }],
    platforms: [{
      platform: "linkedin",
      accountId: LINKEDIN_ACCOUNT,
      ...(version.comment ? { platformSpecificData: { firstComment: version.comment } } : {}),
    }],
    publishNow: true,
  });
  const post = created.post ?? created;
  if (post.status !== "published") throw new Error(`publication ${post.status}`);
  draft.status = "published";
  draft.publishedVersion = index;
  await store(`drafts/${id}.json`, draft);
  const url = post.platforms?.[0]?.platformPostUrl;
  await say(`✅ Publié sur LinkedIn${url ? ` : ${url}` : "."}`, replyTo);
}

async function drop(id, replyTo) {
  const draft = await openDraft(id, replyTo);
  if (!draft) return;
  draft.status = "dropped";
  await store(`drafts/${id}.json`, draft);
  await say("🗑️ Brouillon abandonné.", replyTo);
}

// ---------- routing ----------

async function handle(update) {
  const query = update.callback_query;
  if (query) {
    if (String(query.from.id) !== TELEGRAM_CHAT_ID) return;
    await telegram("answerCallbackQuery", { callback_query_id: query.id });
    await clearButtons(query.message);
    const [action, id, index] = (query.data ?? "").split(":");
    const replyTo = query.message.message_id;
    if (action === "draft") return startDraft(query.message);
    if (action === "pub") return publish(id, Number(index), replyTo);
    if (action === "drop") return drop(id, replyTo);
    return;
  }

  const message = update.message;
  if (!message?.text || String(message.chat.id) !== TELEGRAM_CHAT_ID) return;
  const source = message.reply_to_message;
  if (!source) {
    if (linksOf(message).length) return startDraft(message);
    await say("Envoie-moi un lien ou transfère une alerte pour en tirer un post. Pour modifier un brouillon, réponds-lui.", message.message_id);
    return;
  }
  const pointer = await load(`messages/${source.message_id}.json`);
  if (!pointer) {
    if (linksOf(source).length) return startDraft(source, message.text);
    await say("Réponds à une alerte (un message avec des liens) ou à un brouillon.", message.message_id);
    return;
  }
  const answer = message.text.trim().toLowerCase();
  if (answer === "oui") return publish(pointer.draft, pointer.version, message.message_id);
  if (answer === "non") return drop(pointer.draft, message.message_id);
  return revise(pointer.draft, message.text, message.message_id);
}

export async function POST(request) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== TELEGRAM_WEBHOOK_SECRET) {
    return new Response(null, { status: 401 });
  }
  const update = await request.json();
  waitUntil(
    handle(update).catch((err) => {
      console.error(err);
      return say(`⚠️ Échec : ${escapeHtml(err.message.slice(0, 300))}`).catch(() => {});
    }),
  );
  return new Response(null, { status: 200 });
}

/** Points the bot's webhook at this deployment. Called once per deployment URL, with the webhook secret. */
export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${TELEGRAM_WEBHOOK_SECRET}`) {
    return new Response(null, { status: 401 });
  }
  const url = `https://${request.headers.get("host")}/api/telegram`;
  const result = await telegram("setWebhook", {
    url,
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
  return Response.json({ url, result });
}
