// Webhook of the news bot (@actu_kadyo_bot): morning topics picked by number, drafts revised by reply,
// published with OUI or the Publier button. A link or a forwarded alert also starts a draft.
import { waitUntil } from "@vercel/functions";
import { news, escapeHtml, fromKevin, signedByTelegram } from "../lib/telegram.js";
import { load } from "../lib/store.js";
import { draftFrom, revise, publish, drop, FORMATS } from "../lib/drafts.js";
import { pickTopic, latestTopics } from "../lib/topics.js";

const formatOf = (instruction = "") => (/br[eè]ve/i.test(instruction) ? "breve" : "post");
const TOPIC_NUMBER = /^\s*([1-3])\s*$/;

/** Links of a Telegram message: clickable titles (text_link) and bare URLs. */
function linksOf(message) {
  const text = message.text ?? message.caption ?? "";
  return (message.entities ?? message.caption_entities ?? [])
    .map((e) => (e.type === "text_link" ? e.url : e.type === "url" ? text.slice(e.offset, e.offset + e.length) : null))
    .filter(Boolean);
}

const fromMessage = (message, format, instruction) =>
  draftFrom(message.text ?? message.caption ?? "", linksOf(message), message.message_id, format, instruction);

const FORMAT_BUTTONS = [[
  { text: `✍️ ${FORMATS.post}`, callback_data: "draft:post" },
  { text: `📰 ${FORMATS.breve}`, callback_data: "draft:breve" },
]];

async function handle(update) {
  const query = update.callback_query;
  if (query) {
    if (!fromKevin(query.from)) return;
    await news.call("answerCallbackQuery", { callback_query_id: query.id });
    await news.clearButtons(query.message);
    const [action, id, index] = (query.data ?? "").split(":");
    const replyTo = query.message.message_id;
    // Format buttons sit on the alert itself, or on the bot's question below a forwarded alert or a link.
    if (action === "draft") return fromMessage(query.message.reply_to_message ?? query.message, id === "breve" ? "breve" : "post");
    if (action === "topic") return pickTopic(id, Number(index), replyTo);
    if (action === "pub") return publish(id, Number(index), replyTo);
    if (action === "drop") return drop(id, replyTo);
    return;
  }

  const message = update.message;
  if (!message?.text || !fromKevin(message.chat)) return;
  const number = message.text.match(TOPIC_NUMBER)?.[1];
  const source = message.reply_to_message;

  if (!source) {
    if (number) {
      const latest = await latestTopics();
      if (latest) return pickTopic(latest.date, Number(number) - 1, latest.messageId);
    }
    if (linksOf(message).length) return news.say("Quel format ?", message.message_id, FORMAT_BUTTONS);
    return news.say(
      "Réponds 1, 2 ou 3 aux sujets du matin, ou réponds à un brouillon pour le modifier. Un lien ou une alerte transférée me fait rédiger une publication.",
      message.message_id,
    );
  }

  const pointer = await load(`messages/${source.message_id}.json`);
  if (pointer?.topics) {
    if (number) return pickTopic(pointer.topics, Number(number) - 1, source.message_id);
    return news.say("Réponds 1, 2 ou 3 pour choisir le sujet.", message.message_id);
  }
  if (!pointer) {
    if (linksOf(source).length) return fromMessage(source, formatOf(message.text), message.text);
    return news.say("Réponds à une alerte, aux sujets du matin ou à un brouillon.", message.message_id);
  }
  const answer = message.text.trim().toLowerCase();
  if (answer === "oui") return publish(pointer.draft, pointer.version, message.message_id);
  if (answer === "non") return drop(pointer.draft, message.message_id);
  return revise(pointer.draft, message.text, message.message_id);
}

export async function POST(request) {
  if (!signedByTelegram(request)) return new Response(null, { status: 401 });
  const update = await request.json();
  waitUntil(
    handle(update).catch((err) => {
      console.error(err);
      return news.say(`⚠️ Échec : ${escapeHtml(err.message.slice(0, 300))}`).catch(() => {});
    }),
  );
  return new Response(null, { status: 200 });
}

/** Points the bot's webhook at this deployment. Called once per domain, with the webhook secret. */
export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.TELEGRAM_WEBHOOK_SECRET}`) {
    return new Response(null, { status: 401 });
  }
  const url = `https://${request.headers.get("host")}/api/telegram`;
  return Response.json({ url, result: await news.setWebhook(url) });
}
