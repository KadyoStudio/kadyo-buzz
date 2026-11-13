// Buzz detector: checks a few public sources for fast-rising stories and returns the alerts to send.
// Its state (per-topic article counts, alerts already sent) lives in the Blob store.
import { load, store } from "./store.js";

const STATE = "state/buzz.json";
const HOUR = 3600_000;

// Google News (France): number of articles published in the last hour, per topic.
// An alert fires when the count is at least `min` and at least SURGE x its usual level.
const NEWS_TOPICS = [
  { name: "Nvidia", q: "nvidia", min: 8 },
  { name: "OpenAI / ChatGPT", q: "openai OR chatgpt", min: 10 },
  { name: "Anthropic / Claude", q: "anthropic", min: 5 },
  { name: "Mistral AI", q: '"mistral ai"', min: 4 },
  { name: "Intelligence artificielle", q: '"intelligence artificielle"', min: 40 },
  { name: "Bulle de l'IA", q: '"bulle de l\'IA" OR "bulle IA" OR "bulle de l\'intelligence artificielle"', min: 4 },
  { name: "Data centers", q: '"data center" OR "data centers" OR "centre de données" OR datacenter', min: 8 },
  { name: "Bourse tech", q: '"valeurs technologiques" OR nasdaq OR "valeurs de l\'IA"', min: 10 },
  { name: "Cyberattaque", q: 'cyberattaque OR rançongiciel OR ransomware OR "fuite de données"', min: 12 },
  { name: "CNIL / RGPD", q: "CNIL OR RGPD", min: 6 },
  { name: "AI Act", q: '"AI Act" OR "règlement européen sur l\'IA"', min: 4 },
  { name: "NIS2", q: "NIS2 OR \"loi résilience\"", min: 3 },
  { name: "Facturation électronique", q: '"facturation électronique"', min: 5 },
  {
    name: "Panne géante",
    q: 'panne (Microsoft OR Azure OR Outlook OR Teams OR AWS OR Amazon OR Google OR Gmail OR Cloudflare OR WhatsApp OR Instagram OR Facebook OR Orange OR SFR OR Bouygues OR Free OR "carte bancaire")',
    min: 8,
  },
  { name: "Microsoft", q: "microsoft", min: 15 },
  { name: "Google", q: "google OR alphabet", min: 20 },
  { name: "Apple", q: "apple", min: 20 },
  { name: "Meta", q: '"meta" OR facebook OR zuckerberg', min: 15 },
  { name: "Amazon", q: "amazon OR AWS", min: 15 },
  { name: "Elon Musk / Tesla / X", q: '"elon musk" OR tesla OR xai OR starlink', min: 20 },
];
const SURGE = 2.5;
const MIN_BASELINE_SAMPLES = 6;
const HISTORY_SAMPLES = 36;
const NEWS_COOLDOWN = 12 * HOUR;

// Google Trends: a trending search matching these terms fires an alert once it reaches the traffic threshold.
const TRENDS = [
  { geo: "FR", label: "France", minTraffic: 1000 },
  { geo: "US", label: "États-Unis", minTraffic: 20000 },
];
const TREND_TERMS = [
  "nvidia", "jensen huang", "openai", "chatgpt", "sam altman", "anthropic", "mistral ai", "deepseek",
  "google gemini", "copilot", "intelligence artificielle", "ia", "ai", "data center", "datacenter",
  "centre de donnees", "cyberattaque", "piratage", "fuite de donnees", "ransomware", "rancongiciel",
  "cnil", "rgpd", "anssi", "nis2", "ai act", "tsmc", "semiconducteur", "nasdaq", "bulle ia",
  "panne", "microsoft", "outlook", "azure", "aws", "cloudflare", "apple", "meta", "zuckerberg", "elon musk",
];
const TREND_COOLDOWN = 24 * HOUR;

// Hacker News front page: stories on these terms with a fast-growing score.
const HN_TERMS = [
  "nvidia", "openai", "chatgpt", "anthropic", "claude", "mistral", "deepseek", "gemini", "llm", "ai",
  "data center", "datacenter", "gpu", "breach", "ransomware", "gdpr", "ai act",
];
const HN_MIN_POINTS = 400;
const HN_MAX_AGE = 12 * HOUR;
const HN_COOLDOWN = 7 * 24 * HOUR;

const normalize = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const matcher = (terms) => {
  const re = new RegExp(`(^|[^a-z0-9])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})($|[^a-z0-9])`);
  return (text) => re.test(normalize(text));
};
const matchesTrend = matcher(TREND_TERMS);
const matchesHn = matcher(HN_TERMS);

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decodeXml = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]).trim() : "";
};
const items = (xml) => xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; kadyo-buzz)" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function loadState() {
  const state = await load(STATE).catch(() => null);
  return state?.news && state?.alerted ? state : { news: {}, alerted: {} };
}

function canAlert(state, key, cooldown, now) {
  const last = state.alerted[key];
  return !last || now - last > cooldown;
}

async function checkNews(state, now) {
  const alerts = [];
  for (const topic of NEWS_TOPICS) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${topic.q} when:1h`)}&hl=fr&gl=FR&ceid=FR:fr`;
    let entries;
    try {
      entries = items(await get(url));
    } catch (err) {
      console.error(`news ${topic.name}: ${err.message}`);
      continue;
    }
    const count = entries.length;
    const history = state.news[topic.name] ?? [];
    const baseline = history.length >= MIN_BASELINE_SAMPLES ? median(history.slice(0, -3)) : null;
    state.news[topic.name] = [...history, count].slice(-HISTORY_SAMPLES);
    console.log(`news ${topic.name}: ${count} (baseline ${baseline ?? "n/a"})`);

    if (baseline === null || count < topic.min || count < SURGE * Math.max(baseline, 1)) continue;
    const key = `news:${topic.name}`;
    if (!canAlert(state, key, NEWS_COOLDOWN, now)) continue;
    state.alerted[key] = now;

    const headlines = entries.slice(0, 3).map((e) => `• <a href="${escapeHtml(tag(e, "link"))}">${escapeHtml(tag(e, "title"))}</a>`);
    const search = `https://news.google.com/search?q=${encodeURIComponent(topic.q)}&hl=fr&gl=FR&ceid=FR:fr`;
    alerts.push({
      text:
        `🔥 <b>Buzz : ${escapeHtml(topic.name)}</b>\n` +
        `${count} articles en 1 h dans la presse française (habituellement ~${Math.round(baseline)}).\n` +
        `${headlines.join("\n")}\n<a href="${search}">Tous les articles</a>`,
      links: entries.slice(0, 3).map((e) => tag(e, "link")),
    });
  }
  return alerts;
}

async function checkTrends(state, now) {
  const alerts = [];
  for (const { geo, label, minTraffic } of TRENDS) {
    let entries;
    try {
      entries = items(await get(`https://trends.google.com/trending/rss?geo=${geo}`));
    } catch (err) {
      console.error(`trends ${geo}: ${err.message}`);
      continue;
    }
    for (const e of entries) {
      const title = tag(e, "title");
      const traffic = Number.parseInt(tag(e, "ht:approx_traffic").replace(/\D/g, ""), 10) || 0;
      if (traffic < minTraffic || !matchesTrend(title)) continue;
      const key = `trend:${geo}:${normalize(title)}`;
      if (!canAlert(state, key, TREND_COOLDOWN, now)) continue;
      state.alerted[key] = now;
      const news = `https://news.google.com/search?q=${encodeURIComponent(title)}&hl=fr&gl=FR&ceid=FR:fr`;
      alerts.push({
        text:
          `📈 <b>Tendance Google ${label} : ${escapeHtml(title)}</b>\n` +
          `${traffic.toLocaleString("fr-FR")}+ recherches récentes.\n<a href="${news}">Voir l'actualité</a>`,
        links: [...e.matchAll(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/g)].map((m) => decodeXml(m[1]).trim()),
      });
    }
  }
  return alerts;
}

async function checkHackerNews(state, now) {
  let hits;
  try {
    hits = JSON.parse(await get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50")).hits;
  } catch (err) {
    console.error(`hn: ${err.message}`);
    return [];
  }
  const alerts = [];
  for (const hit of hits) {
    const age = now - hit.created_at_i * 1000;
    if (!(hit.points >= HN_MIN_POINTS) || age > HN_MAX_AGE || !matchesHn(hit.title)) continue;
    const key = `hn:${hit.objectID}`;
    if (!canAlert(state, key, HN_COOLDOWN, now)) continue;
    state.alerted[key] = now;
    const hours = Math.max(1, Math.round(age / HOUR));
    const discussion = `https://news.ycombinator.com/item?id=${hit.objectID}`;
    alerts.push({
      text:
        `🌍 <b>Buzz tech mondial (Hacker News)</b>\n${escapeHtml(hit.title)}\n` +
        `${hit.points} points et ${hit.num_comments} commentaires en ${hours} h.\n` +
        `<a href="${escapeHtml(hit.url ?? discussion)}">Article</a> · <a href="${discussion}">Discussion</a>`,
      links: [hit.url ?? discussion],
    });
  }
  return alerts;
}

/** Runs every source once and returns the new alerts ({ text, links }). */
export async function detect() {
  const now = Date.now();
  const state = await loadState();
  const alerts = [
    ...(await checkNews(state, now)),
    ...(await checkTrends(state, now)),
    ...(await checkHackerNews(state, now)),
  ];
  for (const [key, at] of Object.entries(state.alerted)) {
    if (now - at > HN_COOLDOWN) delete state.alerted[key];
  }
  await store(STATE, state);
  return alerts;
}
