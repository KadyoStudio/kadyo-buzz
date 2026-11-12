# kadyo-buzz

Every 10 minutes, checks a few public sources for fast-rising stories about AI, big tech, data centers,
cybersecurity and digital regulation, and sends a Telegram alert when one takes off.

## Sources and triggers

| Source | Trigger |
|---|---|
| Google News (France), one search per topic over the last hour | article count ≥ the topic's minimum **and** ≥ 2.5 × its usual level (median of the previous samples) |
| Google Trends trending searches, France and United States | a trending search matching `TREND_TERMS` reaches the traffic threshold (1,000+ in France, 20,000+ in the US) |
| Hacker News front page | a story matching `HN_TERMS` reaches 400 points within 12 hours |

Each story alerts once: 12 h cooldown per news topic, 24 h per trending search, 7 days per Hacker News story.
News topics need about an hour of samples before they can alert, so the first runs only record their baseline.

Topics, terms and thresholds are the constants at the top of `buzz.mjs`.

## Publication calendar (`publisher.mjs`)

`calendar.json` lists the scheduled publications, in Paris local time:

```json
{ "id": "2026-11-18-erp-ou-crm", "at": "2026-11-18T08:30", "type": "article",
  "slug": "erp-ou-crm", "title": "…", "draft": "<Zernio draft id>" }
```

- When an entry's time comes, its LinkedIn draft is sent to Telegram.
- `OUI` on a `post` publishes the draft. `OUI` on an `article` adds the slug to `published.json`
  (read by the site before each build, scheduled guides stay hidden otherwise), calls the Vercel
  deploy hook, and publishes the draft once `kadyostudio.com/guides/<slug>` answers (redeploys up to 3 times).
- `NON` sets the entry aside; its draft is kept for rescheduling.
- Zernio LinkedIn drafts that are not in the calendar (news posts) are sent right away.
- `/calendrier` lists the next four weeks; a recap of the week is sent on Monday from 07:00.

Answer by replying to the message concerned; a plain `OUI`/`NON` works when only one item is waiting.
Only messages from `TELEGRAM_CHAT_ID` are read. In a draft, the text after a `[commentaire]` line is
published as the first comment, where the link goes.

## State

`state.json` (per-topic article counts and already-sent alerts) is carried from one run to the next with the
GitHub Actions cache. If the cache is evicted, the detector simply rebuilds its baseline.

## Setup

Repository secrets:

- `TELEGRAM_BOT_TOKEN` (publication bot: calendar and LinkedIn approvals)
- `ACTU_BOT_TOKEN` (news bot @actu_kadyo_bot: buzz alerts; falls back to `TELEGRAM_BOT_TOKEN`)
- `TELEGRAM_CHAT_ID`
- `ZERNIO_API_KEY` (publication calendar; the step is skipped without it)
- `VERCEL_DEPLOY_HOOK` (deploy hook of the site, used when an article is approved)

## Local run

```bash
DRY_RUN=1 node buzz.mjs   # prints alerts instead of sending them
```

Requires Node 24 (built-in `fetch`), no dependencies.

GitHub's schedule is best effort (runs can be hours late): the site's Vercel Cron (`/api/cron/buzz`) starts the
workflow every 10 minutes through `workflow_dispatch`, the schedule stays as a fallback.
