// Morning topics: at 08:00 the news bot proposes three current topics; Kevin answers 1, 2 or 3 and the
// chosen one becomes a LinkedIn post (lib/drafts.js).
import { ask } from "./writer.js";
import { SOURCES, checkSource } from "./sources.js";
import { load, store } from "./store.js";
import { news, escapeHtml } from "./telegram.js";
import { parisNow } from "./paris.js";
import { startDraft } from "./drafts.js";

const HISTORY = "topics/history.json";
const HISTORY_SIZE = 40;

const sourceList = Object.entries(SOURCES)
  .map(([group, domains]) => `- ${group} : ${domains.join(", ")}`)
  .join("\n");

const SYSTEM = `Tu prépares la veille du matin de Kevin Antonetti, fondateur solo de Kadyo Studio (Bretagne) : il digitalise les entreprises, automatise leurs process et y intègre l'IA (outils de gestion et CRM sur mesure, agents IA, automatisations, sites, audit des process). Ses lecteurs LinkedIn : dirigeants de TPE, PME et franchises, responsables de service dans les grands groupes, indépendants, en France.

## Ta mission
Trouve les 3 sujets d'actualité du moment (publiés dans les 48 dernières heures) sur lesquels Kevin peut écrire un post LinkedIn utile qui lui amène des abonnés et montre qu'il connaît son marché. Un bon sujet :
- fait parler (repris par plusieurs médias de la liste), et un dirigeant de PME a une raison de s'y intéresser ;
- touche le métier de Kevin : IA en entreprise, outils numériques, automatisation, données, cybersécurité, réglementation numérique ou fiscale des entreprises (facturation électronique, RGPD, AI Act…), grandes entreprises de la tech, économie des PME ;
- permet une réflexion concrète : qu'est-ce que ça change pour une entreprise, et comment en tirer parti.
Les 3 sujets sont différents les uns des autres. Pas de politique partisane, de fait divers ni de sujet déjà proposé récemment (liste fournie).

## Sources
Cherche avec web_search (il ne renvoie que des sites de la liste) et lis les articles avec web_fetch. Chaque sujet a une source de cette liste, ou le site officiel de l'entreprise ou de l'institution concernée :
${sourceList}
Jamais de blog, d'agrégateur, de presse d'opinion ni de média polémique. Chaque fait du résumé vient de l'article lu.

## Format de réponse (strict)
Uniquement un tableau JSON, sans rien avant ni après :
[{"titre": "<le sujet en moins de 12 mots>", "resume": "<les faits, 2 phrases>", "angle": "<la réflexion que Kevin peut apporter aux entreprises, 1 phrase>", "media": "<nom du média>", "url": "<url de l'article lu>", "entreprise": "<entreprise ou institution concernée, ou vide>"}]`;

function parseTopics(text) {
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  const topics = JSON.parse(json);
  return topics
    .filter((t) => t.titre && t.resume && t.url && checkSource(t.url, t.entreprise).ok)
    .slice(0, 3);
}

/** Finds the morning topics, sends them on the news bot and keeps them for Kevin's answer. */
export async function sendTopics() {
  const { date } = parisNow();
  const history = (await load(HISTORY).catch(() => null)) ?? [];
  const request =
    `Nous sommes le ${date}. Propose les 3 sujets du moment.` +
    (history.length ? `\n\nDéjà proposés récemment :\n${history.map((t) => `- ${t}`).join("\n")}` : "");
  const { text } = await ask([{ type: "text", text: SYSTEM }], [{ role: "user", content: request }]);
  const topics = parseTopics(text);
  if (!topics.length) throw new Error("aucun sujet sourcé trouvé ce matin");

  const blocks = topics.map(
    (t, i) =>
      `<b>${i + 1}. ${escapeHtml(t.titre)}</b>\n${escapeHtml(t.resume)}\n➜ <i>${escapeHtml(t.angle)}</i>\n<a href="${escapeHtml(t.url)}">${escapeHtml(t.media || "Source")}</a>`,
  );
  const message = await news.say(
    `☀️ <b>Les sujets du moment</b>\n\n${blocks.join("\n\n")}\n\n<i>Réponds 1, 2 ou 3 : je rédige le post LinkedIn.</i>`,
    undefined,
    [topics.map((_, i) => ({ text: `${i + 1}`, callback_data: `topic:${date}:${i}` }))],
  );
  await Promise.all([
    store(`topics/${date}.json`, topics),
    store(`messages/${message.message_id}.json`, { topics: date }),
    store("topics/latest.json", { date, messageId: message.message_id }),
    store(HISTORY, [...history, ...topics.map((t) => t.titre)].slice(-HISTORY_SIZE)),
  ]);
}

/** Starts the post on the topic Kevin picked (index from 0). */
export async function pickTopic(date, index, replyTo) {
  const topics = await load(`topics/${date}.json`);
  const topic = topics?.[index];
  if (!topic) return news.say("Je ne retrouve pas ce sujet.", replyTo);
  return startDraft({
    format: "post",
    replyTo,
    request:
      `Sujet choisi par Kevin dans la veille du matin :\n\n` +
      `Titre : ${topic.titre}\nFaits : ${topic.resume}\nAngle proposé : ${topic.angle}\nSource : ${topic.url}`,
  });
}

/** Plain "1", "2" or "3" sent without replying: the latest morning topics. */
export async function latestTopics() {
  return load("topics/latest.json");
}
