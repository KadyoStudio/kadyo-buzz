// Webhook of the publication bot: answers on the LinkedIn calendar (Publier / Plus tard, OUI / NON, /calendrier).
import { waitUntil } from "@vercel/functions";
import { publication, escapeHtml, signedByTelegram } from "../lib/telegram.js";
import { onUpdate } from "../lib/calendar.js";

export async function POST(request) {
  if (!signedByTelegram(request)) return new Response(null, { status: 401 });
  const update = await request.json();
  waitUntil(
    onUpdate(update).catch((err) => {
      console.error(err);
      return publication.say(`⚠️ Échec : ${escapeHtml(err.message.slice(0, 300))}`).catch(() => {});
    }),
  );
  return new Response(null, { status: 200 });
}

/** Points the bot's webhook at this deployment. Called once per domain, with the webhook secret. */
export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.TELEGRAM_WEBHOOK_SECRET}`) {
    return new Response(null, { status: 401 });
  }
  const url = `https://${request.headers.get("host")}/api/publication`;
  return Response.json({ url, result: await publication.setWebhook(url) });
}
