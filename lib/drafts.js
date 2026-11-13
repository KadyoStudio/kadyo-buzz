// LinkedIn drafts written by Claude on the news bot: a morning topic becomes a post, a buzz alert a brief.
// Kevin revises them by replying and publishes them from Telegram. Drafts live in the Blob store, never
// in Zernio, so the publication calendar never sees them.
import { write, parse } from "./writer.js";
import { generatePhoto, composeCard } from "./visual.js";
import { personPhoto, companyLogo } from "./media.js";
import { checkSource } from "./sources.js";
import { load, loadBytes, store } from "./store.js";
import { recentPosts, uploadImage, publishNow } from "./zernio.js";
import { news, escapeHtml } from "./telegram.js";
import { parisDate } from "./paris.js";
import { resolveLink } from "./gnews.js";

export const FORMATS = { post: "Post LinkedIn", breve: "Brève" };
const KICKERS = { post: "Décryptage", breve: "Actu" };

function render(version, number, format) {
  if (!version.post) return `🤔 <b>Pas de publication proposée</b>\n\n${escapeHtml(version.note)}`;
  const source = version.source.ok
    ? `✅ Source reconnue : ${escapeHtml(version.source.label)}`
    : `⛔ Source hors liste (${escapeHtml(version.source.label)}) : publication bloquée`;
  return (
    `📝 <b>${FORMATS[format]} · version ${number}</b>\n\n${escapeHtml(version.post)}` +
    (version.comment ? `\n\n💬 <b>Premier commentaire</b>\n${escapeHtml(version.comment)}` : "") +
    `\n\n${source}` +
    (version.note ? `\n\n🗒️ <i>${escapeHtml(version.note)}</i>` : "") +
    `\n\n<i>Réponds à ce message pour le modifier, ou OUI pour publier.</i>`
  );
}

const sameCard = (a, b) => ["headline", "fact", "person", "company", "scene"].every((k) => a?.[k] === b?.[k]);

/** Builds the card (free-licence photo of the person, or a generated scene, and the official logo); reused while its fields are unchanged. */
async function makeVisual(draft, version, index) {
  const previous = draft.versions.findLast((v) => v.image);
  if (previous && sameCard(previous.card, version.card)) return { path: previous.image, fresh: false };

  const { headline, fact, person, company, scene } = version.card;
  const portrait = person ? await personPhoto(person).catch(() => null) : null;
  let photo = portrait?.data;
  let credit = portrait?.credit;
  if (!photo && scene) {
    photo = await generatePhoto(scene);
    credit = "Illustration générée par IA";
  }
  const logo = company ? await companyLogo(company).catch(() => null) : null;
  const image = await composeCard({ kicker: `${KICKERS[draft.format]} · ${parisDate()}`, headline, fact, photo, logo, credit });
  const path = `images/${draft.id}-${index}.jpg`;
  await store(path, image, "image/jpeg");
  return { path, image, fresh: true };
}

async function writeVersion(draft, replyTo) {
  const { added, text } = await write(draft.messages, draft.examples);
  draft.messages.push(...added);
  const version = parse(text);
  const index = draft.versions.length;
  version.source = checkSource(version.comment, version.card.company);
  let visual;
  if (version.post) {
    if (!version.card.headline || !version.card.fact) {
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
    const photo = await news.sendPhoto(visual.image, `Visuel · version ${index + 1}`, replyTo);
    await store(`messages/${photo.message_id}.json`, pointer);
  }
  const shown = version.imageError
    ? { ...version, note: `${version.note ? `${version.note}\n` : ""}⚠️ Visuel indisponible (${version.imageError}). Réponds « refais l'image » pour réessayer.` }
    : version;
  const keyboard = version.post
    ? [[
        { text: "✅ Publier", callback_data: `pub:${draft.id}:${index}` },
        { text: "❌ Abandonner", callback_data: `drop:${draft.id}` },
      ]]
    : undefined;
  const sent = await news.say(render(shown, index + 1, draft.format), replyTo, keyboard);
  await store(`messages/${sent.message_id}.json`, pointer);
}

/** Writes the first version of a draft from `request` (what to write about), as a reply to `replyTo`. */
export async function startDraft({ request, replyTo, format }) {
  await news.say(`✍️ Je lis les articles et je rédige ${format === "breve" ? "la brève" : "le post"} (une à deux minutes)…`, replyTo);
  const draft = {
    id: crypto.randomUUID(),
    format,
    status: "open",
    createdAt: new Date().toISOString(),
    examples: await recentPosts(),
    messages: [{ role: "user", content: `Format : ${FORMATS[format]}\n\n${request}` }],
    versions: [],
  };
  await writeVersion(draft, replyTo);
}

/** Draft from an alert or a message with links; `instruction` is what Kevin asked, if anything. */
export async function draftFrom(alertText, links, replyTo, format, instruction = "") {
  const resolved = await Promise.all(links.map(resolveLink));
  return startDraft({
    format,
    replyTo,
    request:
      `Alerte reçue :\n\n${alertText}` +
      (resolved.length ? `\n\nLiens de l'alerte :\n${resolved.join("\n")}` : "") +
      (instruction ? `\n\nConsigne de Kevin : ${instruction}` : ""),
  });
}

async function openDraft(id, replyTo) {
  const draft = await load(`drafts/${id}.json`);
  if (!draft) {
    await news.say("Brouillon introuvable.", replyTo);
    return null;
  }
  if (draft.status !== "open") {
    await news.say(draft.status === "published" ? "Ce brouillon est déjà publié." : "Ce brouillon a été abandonné.", replyTo);
    return null;
  }
  return draft;
}

export async function revise(id, instruction, replyTo) {
  const draft = await openDraft(id, replyTo);
  if (!draft) return;
  await news.say("✍️ Je modifie…", replyTo);
  if (/br[eè]ve/i.test(instruction)) draft.format = "breve";
  draft.messages.push({ role: "user", content: `Modification demandée par Kevin : ${instruction}` });
  await writeVersion(draft, replyTo);
}

export async function publish(id, index, replyTo) {
  const draft = await openDraft(id, replyTo);
  if (!draft) return;
  const version = draft.versions[index];
  if (!version?.post) return news.say("Cette version ne contient rien à publier.", replyTo);
  if (!version.source?.ok) {
    return news.say("Publication bloquée : la source n'est pas dans la liste des sources fiables. Demande une autre source au bot, ou demande à Claude d'ajouter ce média à la liste.", replyTo);
  }
  if (!version.image) return news.say("Pas de visuel pour cette version : réponds « refais l'image » au brouillon.", replyTo);
  const imageUrl = await uploadImage(await loadBytes(version.image));
  const url = await publishNow({ content: version.post, comment: version.comment, imageUrl });
  draft.status = "published";
  draft.publishedVersion = index;
  await store(`drafts/${id}.json`, draft);
  await news.say(`✅ Publié sur LinkedIn${url ? ` : ${url}` : "."}`, replyTo);
}

export async function drop(id, replyTo) {
  const draft = await openDraft(id, replyTo);
  if (!draft) return;
  draft.status = "dropped";
  await store(`drafts/${id}.json`, draft);
  await news.say("🗑️ Brouillon abandonné.", replyTo);
}
