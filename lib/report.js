// Daily site stats (Vercel Web Analytics + Search Console) for the publication bot.
// Monday adds the past week compared with the one before.
import { createSign } from "node:crypto";

const SITE = "https://kadyostudio.com";
const GSC_PROPERTY = "sc-domain:kadyostudio.com";
const VERCEL_TEAM_ID = "team_TqB0qi92Vpkzzcli2AD1ELfR";
const VERCEL_PROJECT_ID = "prj_7f1Bb0qAq3FUrtxuNNgrzF37yU6x";
const DAY = 86_400_000;

const env = process.env;

export async function siteReport() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const day = (n) => new Date(today.getTime() - n * DAY).toISOString().slice(0, 10);

  const alerts = [];
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (error) {
      alerts.push(`${label} indisponible (${error.message})`);
      return null;
    }
  };

  async function getJson(url, init) {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function vercel(kind, params) {
    const query = new URLSearchParams({ projectId: VERCEL_PROJECT_ID, teamId: VERCEL_TEAM_ID, ...params });
    return getJson(`https://api.vercel.com/v1/query/web-analytics/${kind}/aggregate?${query}`, {
      headers: { Authorization: `Bearer ${env.VERCEL_ANALYTICS_TOKEN}` },
    }).then((body) => body.data);
  }

  const range = (from, to) => ({ since: `${day(from)}T00:00:00.000Z`, until: `${day(to)}T23:59:59.000Z` });

  async function googleToken() {
    const creds = JSON.parse(env.GSC_CREDENTIALS);
    const now = Math.floor(Date.now() / 1000);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(creds.private_key, "base64url");
    const body = await getJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    return body.access_token;
  }

  function gsc(token, path, payload) {
    return getJson(path, {
      method: payload ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload && JSON.stringify(payload),
    });
  }

  const site = encodeURIComponent(GSC_PROPERTY);
  const searchAnalytics = (token, from, to, dimensions = [], rowLimit = 5) =>
    gsc(token, `https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`, {
      startDate: day(from),
      endDate: day(to),
      dimensions,
      rowLimit,
    }).then((body) => body.rows ?? []);

  async function inspectSitemapUrls(token) {
    const xml = await fetch(`${SITE}/sitemap.xml`).then((res) => res.text());
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]).href);
    const missing = [];
    for (let i = 0; i < urls.length; i += 5) {
      await Promise.all(
        urls.slice(i, i + 5).map(async (url) => {
          const body = await gsc(token, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
            inspectionUrl: url,
            siteUrl: GSC_PROPERTY,
            languageCode: "fr-FR",
          });
          if (body.inspectionResult.indexStatusResult.verdict !== "PASS") missing.push(new URL(url).pathname);
        }),
      );
    }
    return { total: urls.length, missing: missing.sort() };
  }

  const html = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const fr = (n, digits = 0) => n.toLocaleString("fr-FR", { maximumFractionDigits: digits });
  const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const list = (rows, label, value) => rows.map((row) => `${html(label(row))} ${value(row)}`).join(" · ") || "aucune";
  const shortDate = (n) =>
    new Date(today.getTime() - n * DAY).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "UTC",
    });
  const delta = (current, previous) => `${fr(current)} (sem. préc. : ${fr(previous)})`;

  const isMonday = today.getUTCDay() === 1;
  const visitsBy = (by, limit = 5) => vercel("visits", { by, limit: String(limit), ...range(1, 1) });

  const [days, paths, referrers, countries, devices, events, home] = await Promise.all([
    safe("Vercel", () => vercel("visits", { by: "day", ...range(14, 1) })),
    safe("Vercel", () => visitsBy("requestPath")),
    safe("Vercel", () => visitsBy("referrerHostname")),
    safe("Vercel", () => visitsBy("country")),
    safe("Vercel", () => visitsBy("deviceType")),
    safe("Vercel", () => vercel("events", { by: "eventName", limit: "20", ...range(1, 1) })),
    fetch(SITE)
      .then((res) => res.status)
      .catch(() => 0),
  ]);
  if (home !== 200) alerts.push(`L'accueil répond ${home || "pas"} (attendu : 200)`);
  if (events?.some((row) => row.eventName === "form_error")) alerts.push("Erreur d'envoi du formulaire (form_error)");

  const token = await safe("Search Console", googleToken);
  const [gscTotal, gscQueries, gscPages, sitemaps, index] = token
    ? await Promise.all([
        safe("Search Console", () => searchAnalytics(token, 3, 3)),
        safe("Search Console (requêtes)", () => searchAnalytics(token, 3, 3, ["query"])),
        safe("Search Console (pages)", () => searchAnalytics(token, 3, 3, ["page"])),
        safe("Search Console (sitemap)", () =>
          gsc(token, `https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps`),
        ),
        safe("Search Console (indexation)", () => inspectSitemapUrls(token)),
      ])
    : [];
  for (const sitemap of sitemaps?.sitemap ?? []) {
    if (Number(sitemap.errors) > 0) alerts.push(`Sitemap en erreur : ${sitemap.errors} erreur(s)`);
  }

  const lines = [
    `<b>Kadyo Studio · ${new Date(today.getTime() - DAY).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</b>`,
  ];
  if (alerts.length) lines.push("", ...[...new Set(alerts)].map((alert) => `⚠️ ${html(alert)}`));

  if (days) {
    const yesterday = days.at(-1);
    const average = sum(days.slice(-8, -1), "pageviews") / 7;
    lines.push(
      "",
      "<b>Trafic</b>",
      `${yesterday.visitors} visiteurs · ${yesterday.pageviews} pages vues (moy. 7 j : ${fr(average, 1)})`,
    );
  }
  if (paths)
    lines.push(
      `Pages : ${list(
        paths,
        (row) => row.requestPath,
        (row) => row.pageviews,
      )}`,
    );
  if (referrers)
    lines.push(
      `Sources : ${list(
        referrers,
        (row) => row.referrerHostname || "direct",
        (row) => row.visitors,
      )}`,
    );
  if (countries)
    lines.push(
      `Pays : ${list(
        countries,
        (row) => row.country,
        (row) => row.visitors,
      )}`,
    );
  if (devices)
    lines.push(
      `Appareils : ${list(
        devices,
        (row) => row.deviceType,
        (row) => row.visitors,
      )}`,
    );
  if (events)
    lines.push(
      `Conversions : ${list(
        events,
        (row) => row.eventName,
        (row) => row.count,
      )}`,
    );

  if (gscTotal) {
    const total = gscTotal[0] ?? { impressions: 0, clicks: 0 };
    lines.push(
      "",
      `<b>Google · ${shortDate(3)}</b>`,
      `${total.impressions} impressions · ${total.clicks} clics${total.position ? ` · pos. ${fr(total.position, 1)}` : ""}`,
    );
  }
  const searchRow = (row) => `(${row.impressions} imp., pos. ${fr(row.position, 1)})`;
  if (gscQueries?.length) lines.push(`Requêtes : ${list(gscQueries, (row) => row.keys[0], searchRow)}`);
  if (gscPages?.length) lines.push(`Pages : ${list(gscPages, (row) => new URL(row.keys[0]).pathname, searchRow)}`);
  if (index) {
    lines.push("", `<b>Index</b> : ${index.total - index.missing.length} / ${index.total} pages`);
    if (index.missing.length) lines.push(`Non indexées : ${html(index.missing.join(", "))}`);
  }

  if (isMonday) {
    const [weekEvents, previousEvents, gscWeek, gscPrevious] = await Promise.all([
      safe("Vercel", () => vercel("events", { by: "eventName", limit: "20", ...range(7, 1) })),
      safe("Vercel", () => vercel("events", { by: "eventName", limit: "20", ...range(14, 8) })),
      token && safe("Search Console (semaine)", () => searchAnalytics(token, 9, 3)),
      token && safe("Search Console (semaine)", () => searchAnalytics(token, 16, 10)),
    ]);
    lines.push("", "<b>Semaine écoulée</b>");
    if (days) {
      const week = days.slice(-7);
      const previous = days.slice(-14, -7);
      lines.push(`Pages vues : ${delta(sum(week, "pageviews"), sum(previous, "pageviews"))}`);
      lines.push(`Visiteurs (somme des jours) : ${delta(sum(week, "visitors"), sum(previous, "visitors"))}`);
    }
    if (weekEvents && previousEvents)
      lines.push(`Conversions : ${delta(sum(weekEvents, "count"), sum(previousEvents, "count"))}`);
    if (gscWeek && gscPrevious) {
      lines.push(`Impressions Google : ${delta(gscWeek[0]?.impressions ?? 0, gscPrevious[0]?.impressions ?? 0)}`);
      lines.push(`Clics Google : ${delta(gscWeek[0]?.clicks ?? 0, gscPrevious[0]?.clicks ?? 0)}`);
    }
  }

  return lines.join("\n");
}
