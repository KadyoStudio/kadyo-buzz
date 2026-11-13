// LinkedIn publication calendar, on the publication bot.
// - calendar.json entries (Paris local time) are announced when their time comes.
//   Publier on an article: its slug joins the approved guides and the site is redeployed,
//   then the LinkedIn post goes out once the page answers. Publier on a post: the post goes out.
//   Plus tard: the entry is set aside (its Zernio draft is kept, to be rescheduled).
// - Zernio LinkedIn drafts that are not in the calendar are announced right away.
// State lives in the Blob store, one file per entry, so the cron and the webhook never overwrite each other.
import { readFile } from "node:fs/promises";
import { load, store, paths } from "./store.js";
import { zernio, publishNow } from "./zernio.js";
import { publication as bot, escapeHtml, fromKevin } from "./telegram.js";
import { parisNow } from "./paris.js";

const PUBLISHED = "published.json";
const SITE = "https://kadyostudio.com";
// Text after this line in a draft is published as the first comment (LinkedIn shows posts with a link in the caption less).
const COMMENT_MARKER = "\n[commentaire]\n";
const REDEPLOY_AFTER_MS = 15 * 60_000;
const MAX_DEPLOYS = 3;
// A draft younger than this waits one more run, so a calendar draft is never announced before its entry is pushed.
const DRAFT_GRACE = 20 * 60_000;

const entryPath = (id) => `calendar/entries/${id}.json`;
const draftPath = (id) => `calendar/drafts/${id}.json`;
const messagePath = (id) => `calendar/messages/${id}.json`;
const idOf = (post) => post._id ?? post.id;
const accountIdOf = (p) => (typeof p.accountId === "object" ? (p.accountId._id ?? p.accountId.id) : p.accountId);
const split = (content) => {
  const [text, comment = ""] = (content ?? "").split(COMMENT_MARKER);
  return { text: text.trim(), comment: comment.trim() };
};

// ---------- calendar and approved guides ----------

/** calendar.json of this deployment: a push to main redeploys the project with the new entries. */
async function entries() {
  return JSON.parse(await readFile(new URL("../calendar.json", import.meta.url), "utf8")).entries;
}

/** Slugs of the scheduled guides Kevin approved, served by /api/published and read by the site before each build. */
export const approvedGuides = async () => (await load(PUBLISHED)) ?? [];

/** Approves the guide and redeploys the site; running it again only redeploys. */
async function approve(slug) {
  const slugs = await approvedGuides();
  if (!slugs.includes(slug)) await store(PUBLISHED, [...slugs, slug]);
  const res = await fetch(process.env.VERCEL_DEPLOY_HOOK, { method: "POST" });
  if (!res.ok) throw new Error(`deploy hook ${res.status}`);
}

const isLive = async (slug) => (await fetch(`${SITE}/guides/${slug}`, { method: "HEAD" })).status === 200;

// ---------- Zernio drafts ----------

async function getDraft(id) {
  const data = await zernio("GET", `/posts/${id}`);
  const post = data?.post ?? data;
  return post?.status === "draft" ? post : null;
}

async function publishDraft(id) {
  const draft = await getDraft(id);
  if (!draft) throw new Error("brouillon introuvable dans Zernio");
  const { text, comment } = split(draft.content);
  const account = (draft.platforms ?? []).find((p) => p.platform === "linkedin");
  const url = await publishNow({
    content: text,
    comment,
    accountId: account ? accountIdOf(account) : undefined,
    mediaItems: draft.mediaItems?.map(({ url, type }) => ({ url, type })),
  });
  await zernio("DELETE", `/posts/${id}`);
  return url;
}

// ---------- messages ----------

const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
function label(at) {
  const [date, time] = at.split("T");
  const [y, m, d] = date.split("-").map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")} ${time.replace(":", "h")}`;
}

const buttons = (kind, id) => [[
  { text: "✅ Publier", callback_data: `cal:oui:${kind}:${id}` },
  { text: kind === "entry" ? "⏸️ Plus tard" : "🗑️ Abandonner", callback_data: `cal:non:${kind}:${id}` },
]];

async function announce(kind, id, head, content) {
  const { text, comment } = split(content);
  const message = await bot.say(
    `${head}\n\n${escapeHtml(text)}` +
      (comment ? `\n\n💬 <b>Premier commentaire</b>\n${escapeHtml(comment)}` : "") +
      `\n\n<i>Publier, ou réponds OUI / NON à ce message.</i>`,
    undefined,
    buttons(kind, id),
  );
  await store(messagePath(message.message_id), { kind, id });
  return message.message_id;
}

async function states() {
  const found = await paths("calendar/entries/");
  const all = await Promise.all(found.map(async (p) => [p.slice("calendar/entries/".length, -5), await load(p)]));
  return Object.fromEntries(all);
}

/** Next `days` days of the calendar, one line per publication. */
export async function calendarText(days) {
  const [calendar, state] = await Promise.all([entries(), states()]);
  const today = parisNow().date;
  const until = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const icon = { announced: "⏳", approved: "🚀", done: "✅", skipped: "⏸️" };
  const rows = calendar
    .filter((e) => e.at.slice(0, 10) >= today && e.at.slice(0, 10) <= until)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((e) => `${icon[state[e.id]?.status] ?? "🗓️"} ${label(e.at)} · ${e.type === "article" ? "Article + post" : "Post"} · ${escapeHtml(e.title)}`);
  return rows.length ? rows.join("\n") : "Rien de prévu.";
}

// ---------- cron ----------

/** Announces what is due, announces drafts made outside the calendar, follows approved articles. */
export async function tick() {
  const now = parisNow();
  const [calendar, state] = await Promise.all([entries(), states()]);

  for (const entry of calendar) {
    if (state[entry.id] || entry.at > now.stamp) continue;
    const draft = await getDraft(entry.draft);
    if (!draft) {
      await store(entryPath(entry.id), { status: "done" });
      continue;
    }
    const head =
      entry.type === "article"
        ? `📰 <b>Article du jour : ${escapeHtml(entry.title)}</b>\nPublier met l'article en ligne sur le site, puis publie ce post LinkedIn :`
        : `📅 <b>Post LinkedIn du jour</b>`;
    const messageId = await announce("entry", entry.id, head, draft.content);
    await store(entryPath(entry.id), { status: "announced", messageId });
  }

  const scheduled = new Set(calendar.map((e) => e.draft));
  const list = await zernio("GET", "/posts?status=draft&limit=50");
  const adHoc = (list?.posts ?? list?.data ?? []).filter(
    (p) =>
      p.status === "draft" &&
      !scheduled.has(idOf(p)) &&
      !/^calendrier/i.test(p.title ?? "") &&
      Date.now() - Date.parse(p.createdAt) >= DRAFT_GRACE &&
      (p.platforms ?? []).some((pl) => pl.platform === "linkedin"),
  );
  const known = new Set((await paths("calendar/drafts/")).map((p) => p.slice("calendar/drafts/".length, -5)));
  for (const post of adHoc) {
    if (known.has(idOf(post))) continue;
    const messageId = await announce("draft", idOf(post), "📝 <b>Post LinkedIn à valider</b>", post.content);
    await store(draftPath(idOf(post)), { messageId });
  }

  for (const entry of calendar) {
    const s = state[entry.id];
    if (entry.type !== "article" || s?.status !== "approved") continue;
    try {
      if (await isLive(entry.slug)) {
        const url = await publishDraft(entry.draft);
        await store(entryPath(entry.id), { ...s, status: "done" });
        await bot.say(`✅ Article en ligne : ${SITE}/guides/${entry.slug}\n✅ Post LinkedIn publié${url ? ` : ${url}` : "."}`, s.messageId);
      } else if (Date.now() - s.approvedAt > REDEPLOY_AFTER_MS * s.deploys) {
        if (s.deploys >= MAX_DEPLOYS) {
          await store(entryPath(entry.id), { ...s, status: "announced" });
          await bot.say("⚠️ L'article n'est toujours pas en ligne après plusieurs déploiements. Vérifie Vercel, puis réponds OUI pour réessayer.", s.messageId, buttons("entry", entry.id));
        } else {
          await approve(entry.slug);
          await store(entryPath(entry.id), { ...s, deploys: s.deploys + 1 });
        }
      }
    } catch (err) {
      console.error(err);
    }
  }
}

// ---------- answers ----------

async function decide(target, yes, replyTo) {
  if (target.kind === "draft") {
    if (!(await load(draftPath(target.id)))) return bot.say("Ce post a déjà été traité.", replyTo);
    if (yes) {
      const url = await publishDraft(target.id);
      await bot.say(`✅ Publié sur LinkedIn${url ? ` : ${url}` : "."}`, replyTo);
    } else {
      await zernio("DELETE", `/posts/${target.id}`);
      await bot.say("🗑️ Post abandonné.", replyTo);
    }
    await store(draftPath(target.id), { done: true });
    return;
  }

  const entry = (await entries()).find((e) => e.id === target.id);
  const s = await load(entryPath(target.id));
  if (!entry || s?.status !== "announced") return bot.say("Cette publication a déjà été traitée.", replyTo);
  if (!yes) {
    await store(entryPath(entry.id), { ...s, status: "skipped" });
    return bot.say("⏸️ Mis de côté. Le brouillon est conservé, il sera reprogrammé.", replyTo);
  }
  if (entry.type === "post") {
    const url = await publishDraft(entry.draft);
    await store(entryPath(entry.id), { ...s, status: "done" });
    return bot.say(`✅ Publié sur LinkedIn${url ? ` : ${url}` : "."}`, replyTo);
  }
  await approve(entry.slug);
  await store(entryPath(entry.id), { ...s, status: "approved", approvedAt: Date.now(), deploys: 1 });
  await bot.say("🚀 Article en cours de mise en ligne. Le post LinkedIn partira dès que la page sera accessible.", replyTo);
}

/** Publications still waiting for an answer. */
async function pending() {
  const state = await states();
  const items = Object.entries(state)
    .filter(([, s]) => s?.status === "announced")
    .map(([id, s]) => ({ kind: "entry", id, messageId: s.messageId }));
  for (const p of await paths("calendar/drafts/")) {
    const s = await load(p);
    if (s && !s.done) items.push({ kind: "draft", id: p.slice("calendar/drafts/".length, -5), messageId: s.messageId });
  }
  return items;
}

/** Webhook update of the publication bot. */
export async function onUpdate(update) {
  const query = update.callback_query;
  if (query) {
    if (!fromKevin(query.from)) return;
    await bot.call("answerCallbackQuery", { callback_query_id: query.id });
    const [scope, answer, kind, id] = (query.data ?? "").split(":");
    if (scope !== "cal") return;
    await bot.clearButtons(query.message);
    return decide({ kind, id }, answer === "oui", query.message.message_id);
  }

  const message = update.message;
  if (!message?.text || !fromKevin(message.chat)) return;
  const answer = message.text.trim().toLowerCase();
  if (answer.startsWith("/calendrier")) {
    return bot.say(`🗓️ <b>Calendrier des 4 prochaines semaines</b>\n\n${await calendarText(28)}`, message.message_id);
  }
  if (answer !== "oui" && answer !== "non") {
    return bot.say("Ici : le calendrier LinkedIn et les stats du site. Réponds OUI / NON à une publication, ou /calendrier.", message.message_id);
  }

  const repliedTo = message.reply_to_message?.message_id;
  let target = repliedTo ? await load(messagePath(repliedTo)) : null;
  if (!target && !repliedTo) {
    const open = await pending();
    if (open.length > 1) return bot.say("Plusieurs publications attendent : réponds directement au message concerné.", message.message_id);
    target = open[0];
  }
  if (!target) return bot.say("Rien à valider pour ce message.", message.message_id);
  return decide(target, answer === "oui", message.message_id);
}
