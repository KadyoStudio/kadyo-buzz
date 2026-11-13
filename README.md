# kadyo-buzz

Kevin's Telegram alerts and LinkedIn publishing, on the Vercel project `kadyo-buzz` (Vercel Cron, Node functions,
private Blob store). Two bots write to the same private chat:

| Bot | Messages | Kevin answers |
|---|---|---|
| **News bot** (@actu_kadyo_bot) | 08:00 · three topics of the moment | `1`, `2` or `3` (or the button): the topic becomes a LinkedIn post |
| | Buzz alert, as soon as a story takes off | its news brief is drafted right away |
| | Drafts (post or brief) with their visual | a reply revises the draft, **Publier** or `OUI` publishes it |
| **Publication bot** | 08:00 · site stats (Monday: the week, and the LinkedIn calendar of the week) | — |
| | Calendar posts and articles when their time comes | **Publier** / `OUI`, **Plus tard** / `NON`, `/calendrier` |

## Layout

```
api/telegram.js         webhook of the news bot
api/publication.js      webhook of the publication bot
api/cron/frequent.js    every 10 min: calendar, then buzz detection and automatic briefs
api/cron/morning.js     06:00 and 07:00 UTC, goes on only at 08:00 in Paris: stats + topics
api/published.js        approved guides, read by the site before each build
lib/buzz.js             sources, topics, thresholds of the buzz detector
lib/topics.js           morning topics (Claude with web search on the reliable sources)
lib/drafts.js           drafts: writing, visual, revision, publishing through Zernio
lib/prompt.js           writing instructions (post and brief formats, sources, visual)
lib/sources.js          reliable sources, the only ones allowed as first comment
lib/calendar.js         LinkedIn calendar (calendar.json + Zernio drafts)
lib/report.js           site stats (Vercel Web Analytics + Search Console)
```

## Buzz detection (`lib/buzz.js`)

| Source | Trigger |
|---|---|
| Google News (France), one search per topic over the last hour | article count ≥ the topic's minimum **and** ≥ 2.5 × its usual level (median of the previous samples) |
| Google Trends trending searches, France and United States | a trending search matching `TREND_TERMS` reaches the traffic threshold (1,000+ in France, 20,000+ in the US) |
| Hacker News front page | a story matching `HN_TERMS` reaches 400 points within 12 hours |

Each story alerts once: 12 h cooldown per news topic, 24 h per trending search, 7 days per Hacker News story.
News topics need about an hour of samples before they can alert. The first two alerts of a run get their brief
drafted automatically; the others carry a **Rédiger la brève** button.

## Posts and briefs (`lib/drafts.js`)

Claude (`lib/writer.js`, instructions in `lib/prompt.js`) reads the source articles, then writes in Kevin's voice,
using his last published posts as examples.

- **Post** (morning topic): the news seen from the reader's business and Kadyo Studio's trade, with a concrete
  takeaway. **Brief** (buzz): 4 to 5 sentences, the news, why, the possible impact in the conditional, a closing
  question.
- **Sources** (`lib/sources.js`): the source quoted in the first comment must be a listed media or official site, or
  the official site of the company concerned. Otherwise publishing is blocked.
- **Visual** (`lib/visual.js`, `lib/media.js`): 1600x900 card with headline, key fact, the free-licence photo of the
  person (Wikidata P18 on Wikimedia Commons, credited on the image) and the company's official logo (Wikidata P154).
  Without a free photo, Gemini generates a scene without identifiable faces, credited as AI-generated.

Drafts are stored in the Blob store, never in Zernio, so the calendar never sees them.

## Calendar (`lib/calendar.js`)

`calendar.json` lists the scheduled publications, in Paris local time; a push to `main` redeploys it.

```json
{ "id": "2026-11-18-erp-ou-crm", "at": "2026-11-18T08:30", "type": "article",
  "slug": "erp-ou-crm", "title": "…", "draft": "<Zernio draft id>" }
```

- **Publier** on a `post` publishes the Zernio draft. On an `article`, it adds the slug to the approved guides
  (served by `/api/published`, read by the site before each build), calls the site's deploy hook, and publishes the
  draft once `kadyostudio.com/guides/<slug>` answers (redeploys up to 3 times).
- **Plus tard** sets the entry aside; its draft is kept for rescheduling.
- Zernio LinkedIn drafts that are not in the calendar are announced right away. In a Zernio draft, the text after a
  `[commentaire]` line is published as the first comment.

## State

Blob store: `state/buzz.json` (detector), `calendar/` (one file per entry and per Zernio draft), `drafts/`, `images/`,
`messages/` (Telegram message → draft or topics), `topics/`, `published.json`.

## Environment variables (Vercel)

`ACTU_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN` (publication bot), `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`,
`CRON_SECRET`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ZERNIO_API_KEY`, `VERCEL_DEPLOY_HOOK` (site),
`VERCEL_ANALYTICS_TOKEN`, `GSC_CREDENTIALS` (service account JSON), `BLOB_READ_WRITE_TOKEN` (set by the store).
`DRY_RUN=1` (Preview only) prints the Telegram messages to the logs instead of sending them.

After a change of domain, point both webhooks at it:

```bash
curl -H "Authorization: Bearer $TELEGRAM_WEBHOOK_SECRET" https://<domain>/api/telegram
curl -H "Authorization: Bearer $TELEGRAM_WEBHOOK_SECRET" https://<domain>/api/publication
```

A cron can be run by hand with `Authorization: Bearer $CRON_SECRET`; `/api/cron/morning?force` ignores the hour.
