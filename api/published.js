// Slugs of the scheduled guides approved on Telegram, fetched by the site before each build
// (scripts/published-guides.mjs). Public: it only lists guides that are about to be online.
import { approvedGuides } from "../lib/calendar.js";

export async function GET() {
  return Response.json(await approvedGuides(), { headers: { "Cache-Control": "no-store" } });
}
