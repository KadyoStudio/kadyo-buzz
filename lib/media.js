// Free-licence photo of a person and official logo of a company, through Wikidata (P18 image, P154 logo)
// and Wikimedia Commons (licence and author of the file).
const HEADERS = { "User-Agent": "kadyo-buzz/1.0 (https://github.com/KadyoStudio/kadyo-buzz)" };
const FREE_LICENCE = /^(cc0|public domain|pd\b|cc by(-sa)? \d)/i;
const HUMAN = "Q5";

async function json(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`wikimedia ${res.status}`);
  return res.json();
}

async function entity(name) {
  const params = new URLSearchParams({ action: "wbsearchentities", search: name, language: "fr", uselang: "fr", format: "json", limit: "5" });
  const { search = [] } = await json(`https://www.wikidata.org/w/api.php?${params}`);
  return search.map((s) => s.id);
}

async function claims(id) {
  const { claims = {} } = await json(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${id}&format=json`);
  const values = (p) => (claims[p] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter(Boolean);
  return { isHuman: values("P31").some((v) => v.id === HUMAN), image: values("P18")[0], logo: values("P154")[0] };
}

const strip = (html = "") => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

async function commonsFile(file, width) {
  const params = new URLSearchParams({
    action: "query", titles: `File:${file}`, prop: "imageinfo", iiprop: "url|extmetadata", format: "json",
    ...(width ? { iiurlwidth: String(width) } : {}),
  });
  const { query } = await json(`https://commons.wikimedia.org/w/api.php?${params}`);
  const info = Object.values(query?.pages ?? {})[0]?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata ?? {};
  const res = await fetch(width && info.thumburl ? info.thumburl : info.url, { headers: HEADERS });
  if (!res.ok) return null;
  return {
    data: Buffer.from(await res.arrayBuffer()),
    licence: strip(meta.LicenseShortName?.value),
    author: strip(meta.Artist?.value).slice(0, 60),
  };
}

/** Photo of the person under a free licence, with its credit, or null. */
export async function personPhoto(name) {
  for (const id of await entity(name)) {
    const { isHuman, image } = await claims(id);
    if (!isHuman) continue;
    if (!image) return null;
    const file = await commonsFile(image, 1280);
    if (!file || !FREE_LICENCE.test(file.licence)) return null;
    return { data: file.data, credit: `Photo : ${file.author || "auteur inconnu"}, ${file.licence}, Wikimedia Commons` };
  }
  return null;
}

/** Official logo file of the company or institution, or null. */
export async function companyLogo(name) {
  for (const id of await entity(name)) {
    const { isHuman, logo } = await claims(id);
    if (isHuman || !logo) continue;
    const file = await commonsFile(logo);
    return file?.data ?? null;
  }
  return null;
}
