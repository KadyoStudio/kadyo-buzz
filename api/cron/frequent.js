// Every 10 minutes: LinkedIn calendar (publication bot), then buzz detection (news bot).
// Each buzz alert gets its news brief drafted right away, up to MAX_BRIEFS per run.
import { tick } from "../../lib/calendar.js";
import { detect } from "../../lib/buzz.js";
import { news, escapeHtml } from "../../lib/telegram.js";
import { draftFrom } from "../../lib/drafts.js";

const MAX_BRIEFS = 2;
const stripTags = (html) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export async function GET(request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response(null, { status: 401 });
  }
  const errors = [];

  await tick().catch((err) => errors.push(`calendrier : ${err.message}`));

  const alerts = await detect().catch((err) => {
    errors.push(`buzz : ${err.message}`);
    return [];
  });
  for (const [i, alert] of alerts.entries()) {
    const auto = i < MAX_BRIEFS;
    const sent = await news.say(
      alert.text,
      undefined,
      auto ? undefined : [[{ text: "📰 Rédiger la brève", callback_data: "draft:breve" }]],
    );
    if (auto) {
      await draftFrom(stripTags(alert.text), alert.links, sent.message_id, "breve").catch((err) =>
        news.say(`⚠️ Brève non rédigée : ${escapeHtml(err.message.slice(0, 300))}`, sent.message_id),
      );
    }
  }

  if (errors.length) console.error(errors.join("\n"));
  return Response.json({ alerts: alerts.length, errors });
}
