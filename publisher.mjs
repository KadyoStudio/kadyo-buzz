// Publication calendar driven from Telegram.
// - calendar.json entries (Paris local time) are announced on Telegram when their time comes.
//   OUI on an article: its slug is added to published.json, the site is redeployed, and the
//   LinkedIn post goes out once the page answers. OUI on a post: the LinkedIn post goes out.
//   NON: the entry is set aside (its draft is kept, to be rescheduled).
// - Zernio LinkedIn drafts that are not in the calendar (news posts) are announced right away.
// - /calendrier lists the next four weeks; a recap of the week is sent on Monday morning.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const STATE_FILE = process.env.STATE_FILE ?? "state.json";
const { ZERNIO_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VERCEL_DEPLOY_HOOK, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
const ZERNIO = "https://zernio.com/api/v1";
const TELEGRAM = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const SITE = "https://kadyostudio.com";
// Text after this line in a draft is published as the first comment (LinkedIn shows posts with a link in the caption less).
const COMMENT_MARKER = "\n[commentaire]\n";
const REDEPLOY_AFTER_MS = 15 * 60_000;
const MAX_DEPLOYS = 3;

if (!ZERNIO_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.log("publisher: missing ZERNIO_API_KEY or Telegram secrets, skipped");
  process.exit(0);
}

// ---------- helpers ----------

async function zernio(method, path, body) {
  const res = await fetch(`${ZERNIO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ZERNIO_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 404) return null;
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

const say = (text, replyTo) =>
  telegram("sendMessage", {
    chat_id: TELEGRAM_CHAT_ID,
    text: text.length > 4000 ? `${text.slice(0, 3990)}…` : text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
  });

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const idOf = (post) => post._id ?? post.id;
const accountIdOf = (p) => (typeof p.accountId === "object" ? (p.accountId._id ?? p.accountId.id) : p.accountId);
const split = (content) => {
  const [text, comment = ""] = (content ?? "").split(COMMENT_MARKER);
  return { text: text.trim(), comment: comment.trim() };
};

/** Paris wall-clock time as "YYYY-MM-DDTHH:MM", comparable with calendar entries. */
function parisNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { stamp: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`, weekday: parts.weekday };
}

const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
function label(at) {
  const [date, time] = at.split("T");
  const [y, m, d] = date.split("-").map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} ${time.replace(":", "h")}`;
}

async function getDraft(id) {
  const data = await zernio("GET", `/posts/${id}`);
  if (!data) return null;
  const post = data.post ?? data;
  return post.status === "draft" ? post : null;
}

async function publishDraft(id) {
  const draft = await getDraft(id);
  if (!draft) throw new Error("brouillon introuvable dans Zernio");
  const { text, comment } = split(draft.content);
  const created = await zernio("POST", "/posts", {
    content: text,
    platforms: (draft.platforms ?? [])
      .filter((p) => p.platform === "linkedin")
      .map((p) => ({
        platform: "linkedin",
        accountId: accountIdOf(p),
        ...(comment ? { platformSpecificData: { firstComment: comment } } : {}),
      })),
    ...(draft.mediaItems?.length ? { mediaItems: draft.mediaItems.map(({ url, type }) => ({ url, type })) } : {}),
    publishNow: true,
  });
  const post = created.post ?? created;
  if (post.status !== "published") throw new Error(`publication ${post.status}: ${JSON.stringify(post.platforms)}`);
  await zernio("DELETE", `/posts/${id}`);
  return post.platforms?.[0]?.platformPostUrl ?? "";
}

async function github(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`github ${method} ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function approveSlug(slug) {
  const file = await github("GET", "contents/published.json");
  const slugs = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  if (slugs.includes(slug)) return;
  await github("PUT", "contents/published.json", {
    message: `publish: ${slug}`,
    content: Buffer.from(`${JSON.stringify([...slugs, slug], null, 2)}\n`).toString("base64"),
    sha: file.sha,
  });
}

async function deploy() {
  if (!VERCEL_DEPLOY_HOOK) throw new Error("VERCEL_DEPLOY_HOOK manquant");
  const res = await fetch(VERCEL_DEPLOY_HOOK, { method: "POST" });
  if (!res.ok) throw new Error(`deploy hook ${res.status}`);
}

const isLive = async (slug) => (await fetch(`${SITE}/guides/${slug}`, { method: "HEAD" })).status === 200;

// ---------- state ----------

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
state.entries ??= {};
state.drafts ??= {};
state.tgOffset ??= 0;
const calendar = JSON.parse(readFileSync("calendar.json", "utf8")).entries;
const published = JSON.parse(readFileSync("published.json", "utf8"));
const now = parisNow();

// ---------- announce calendar entries whose time has come ----------

for (const entry of calendar) {
  if (state.entries[entry.id] || entry.at > now.stamp) continue;
  const draft = await getDraft(entry.draft);
  if (!draft) {
    // Already published or removed (e.g. state lost from the cache): nothing to ask.
    state.entries[entry.id] = { status: "done" };
    continue;
  }
  const { text, comment } = split(draft.content);
  const head =
    entry.type === "article"
      ? `📰 <b>Article du jour : ${escapeHtml(entry.title)}</b>\nOUI met l'article en ligne sur le site, puis publie ce post LinkedIn :`
      : `📅 <b>Post LinkedIn du jour</b>`;
  const message = await say(
    `${head}\n\n${escapeHtml(text)}` +
      (comment ? `\n\n💬 <b>Premier commentaire</b>\n${escapeHtml(comment)}` : "") +
      `\n\n<i>Réponds OUI à ce message pour publier, NON pour le mettre de côté.</i>`,
  );
  state.entries[entry.id] = { status: "announced", messageId: message.message_id };
}

// ---------- announce drafts outside the calendar (news posts) ----------

const scheduledDrafts = new Set(calendar.map((e) => e.draft));
const list = await zernio("GET", "/posts?status=draft&limit=50");
const adHoc = (list?.posts ?? list?.data ?? []).filter(
  (p) => p.status === "draft" && !scheduledDrafts.has(idOf(p)) && (p.platforms ?? []).some((pl) => pl.platform === "linkedin"),
);
const adHocIds = new Set(adHoc.map(idOf));
for (const id of Object.keys(state.drafts)) if (!adHocIds.has(id)) delete state.drafts[id];
for (const post of adHoc) {
  if (state.drafts[idOf(post)]) continue;
  const { text, comment } = split(post.content);
  const message = await say(
    `📝 <b>Post LinkedIn à valider</b>\n\n${escapeHtml(text)}` +
      (comment ? `\n\n💬 <b>Premier commentaire</b>\n${escapeHtml(comment)}` : "") +
      `\n\n<i>Réponds OUI à ce message pour publier, NON pour l'abandonner.</i>`,
  );
  state.drafts[idOf(post)] = message.message_id;
}

// ---------- read answers ----------

function pending() {
  const items = [];
  for (const entry of calendar) {
    const s = state.entries[entry.id];
    if (s?.status === "announced") items.push({ kind: "entry", entry, messageId: s.messageId });
  }
  for (const [id, messageId] of Object.entries(state.drafts)) items.push({ kind: "draft", id, messageId });
  return items;
}

function calendarText(days) {
  const until = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const icon = { announced: "⏳", approved: "🚀", done: "✅", skipped: "⏸️" };
  const rows = calendar
    .filter((e) => e.at.slice(0, 10) >= now.stamp.slice(0, 10) && e.at.slice(0, 10) <= until)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => `${icon[state.entries[e.id]?.status] ?? "🗓️"} ${label(e.at)} · ${e.type === "article" ? "Article + post" : "Post"} · ${escapeHtml(e.title)}`);
  return rows.length ? rows.join("\n") : "Rien de prévu.";
}

const updates = await telegram("getUpdates", { offset: state.tgOffset + 1, allowed_updates: ["message"] });
for (const update of updates) {
  state.tgOffset = Math.max(state.tgOffset, update.update_id);
  const message = update.message;
  if (!message || String(message.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
  const answer = (message.text ?? "").trim().toLowerCase();

  if (answer.startsWith("/calendrier")) {
    await say(`🗓️ <b>Calendrier des 4 prochaines semaines</b>\n\n${calendarText(28)}`, message.message_id);
    continue;
  }
  if (answer !== "oui" && answer !== "non") continue;

  const open = pending();
  const repliedTo = message.reply_to_message?.message_id;
  const target = repliedTo ? open.find((p) => p.messageId === repliedTo) : open.length === 1 ? open[0] : undefined;
  if (!target) {
    if (!repliedTo && open.length > 1) await say("Plusieurs publications attendent : réponds directement au message concerné.");
    continue;
  }

  try {
    if (target.kind === "draft") {
      if (answer === "oui") {
        const url = await publishDraft(target.id);
        await say(`✅ Publié sur LinkedIn${url ? ` : ${url}` : "."}`, target.messageId);
      } else {
        await zernio("DELETE", `/posts/${target.id}`);
        await say("🗑️ Post abandonné.", target.messageId);
      }
      delete state.drafts[target.id];
      continue;
    }

    const { entry } = target;
    const s = state.entries[entry.id];
    if (answer === "non") {
      s.status = "skipped";
      await say("⏸️ Mis de côté. Le brouillon est conservé, il sera reprogrammé.", target.messageId);
    } else if (entry.type === "post") {
      const url = await publishDraft(entry.draft);
      s.status = "done";
      await say(`✅ Publié sur LinkedIn${url ? ` : ${url}` : "."}`, target.messageId);
    } else {
      await approveSlug(entry.slug);
      await deploy();
      Object.assign(s, { status: "approved", approvedAt: Date.now(), deploys: 1 });
      await say("🚀 Article en cours de mise en ligne. Le post LinkedIn partira dès que la page sera accessible.", target.messageId);
    }
  } catch (err) {
    console.error(err.message);
    await say(`⚠️ Échec : ${escapeHtml(err.message.slice(0, 300))}`, target.messageId);
  }
}

// ---------- approved articles: post on LinkedIn once the page is live ----------

for (const entry of calendar) {
  const s = state.entries[entry.id];
  if (entry.type !== "article" || s?.status !== "approved") continue;
  try {
    if (await isLive(entry.slug)) {
      const url = await publishDraft(entry.draft);
      s.status = "done";
      await say(`✅ Article en ligne : ${SITE}/guides/${entry.slug}\n✅ Post LinkedIn publié${url ? ` : ${url}` : "."}`, s.messageId);
    } else if (Date.now() - s.approvedAt > REDEPLOY_AFTER_MS * s.deploys) {
      if (s.deploys >= MAX_DEPLOYS) {
        s.status = "announced";
        await say("⚠️ L'article n'est toujours pas en ligne après plusieurs déploiements. Vérifie Vercel, puis réponds OUI pour réessayer.", s.messageId);
      } else {
        await deploy();
        s.deploys += 1;
      }
    }
  } catch (err) {
    console.error(err.message);
  }
}

// ---------- Monday recap ----------

const today = now.stamp.slice(0, 10);
if (now.weekday === "Mon" && now.stamp.slice(11) >= "07:00" && state.lastRecap !== today) {
  await say(`🗓️ <b>Au programme cette semaine</b>\n\n${calendarText(6)}\n\n<i>/calendrier pour voir les 4 prochaines semaines.</i>`);
  state.lastRecap = today;
}

writeFileSync(STATE_FILE, JSON.stringify(state));
console.log(`publisher: ${pending().length} pending, ${published.length} approved guide(s)`);
