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

## LinkedIn posts approved from Telegram

`linkedin.mjs` runs in the same job. It sends every LinkedIn draft found in Zernio to Telegram, then reads the
replies: `OUI` (as a reply to that message) publishes it, `NON` deletes the draft. With a single pending draft,
a plain `OUI` or `NON` is enough. Only messages from `TELEGRAM_CHAT_ID` are taken into account.

In a draft, the text after a `[commentaire]` line is published as the first comment, where the link goes.

## State

`state.json` (per-topic article counts and already-sent alerts) is carried from one run to the next with the
GitHub Actions cache. If the cache is evicted, the detector simply rebuilds its baseline.

## Setup

Repository secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `ZERNIO_API_KEY` (LinkedIn approval; the step is skipped without it)

## Local run

```bash
DRY_RUN=1 node buzz.mjs   # prints alerts instead of sending them
```

Requires Node 24 (built-in `fetch`), no dependencies.

GitHub may delay scheduled runs by a few minutes when its runners are busy.
