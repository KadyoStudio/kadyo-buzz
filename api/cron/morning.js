// 08:00 in Paris: site stats and, on Monday, the week's calendar (publication bot); the topics of the
// moment (news bot). Vercel Cron runs in UTC: it fires at 06:00 and 07:00 and only the run that lands
// at 08:00 in Paris goes on, so the time holds across daylight saving changes.
import { siteReport } from "../../lib/report.js";
import { calendarText } from "../../lib/calendar.js";
import { sendTopics } from "../../lib/topics.js";
import { publication, news, escapeHtml } from "../../lib/telegram.js";
import { parisNow } from "../../lib/paris.js";

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response(null, { status: 401 });
  }
  const now = parisNow();
  const force = new URL(request.url).searchParams.has("force");
  if (now.hour !== 8 && !force) return Response.json({ skipped: `${now.hour} h à Paris` });

  const stats = (async () => {
    let text = await siteReport();
    if (now.weekday === "Mon") {
      text += `\n\n🗓️ <b>LinkedIn cette semaine</b>\n${await calendarText(6)}\n<i>/calendrier pour les 4 prochaines semaines.</i>`;
    }
    await publication.say(text);
  })().catch((err) => publication.say(`⚠️ Stats du site indisponibles : ${escapeHtml(err.message.slice(0, 300))}`));

  const topics = sendTopics().catch((err) =>
    news.say(`⚠️ Sujets du matin indisponibles : ${escapeHtml(err.message.slice(0, 300))}`),
  );

  await Promise.all([stats, topics]);
  return Response.json({ ok: true });
}
