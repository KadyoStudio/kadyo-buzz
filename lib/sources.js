// Sources that may be cited under a post. Kevin validates every addition.
export const SOURCES = {
  Officiel: [
    "service-public.fr", "economie.gouv.fr", "impots.gouv.fr", "legifrance.gouv.fr", "cnil.fr", "cyber.gouv.fr",
    "assemblee-nationale.fr", "senat.fr", "europa.eu", "bpifrance.fr", "sec.gov",
  ],
  "Presse nationale": [
    "afp.com", "lemonde.fr", "lefigaro.fr", "lesechos.fr", "latribune.fr", "leparisien.fr", "liberation.fr", "lepoint.fr",
    "lexpress.fr", "challenges.fr", "capital.fr", "francetvinfo.fr", "radiofrance.fr", "bfmtv.com", "20minutes.fr",
    "ouest-france.fr",
  ],
  "Tech et business": [
    "lemagit.fr", "zdnet.fr", "01net.com", "numerama.com", "journaldunet.com", "usine-digitale.fr",
    "lemondeinformatique.fr", "silicon.fr", "maddyness.com", "frandroid.com",
  ],
  International: [
    "reuters.com", "apnews.com", "bloomberg.com", "ft.com", "wsj.com", "nytimes.com", "theguardian.com", "bbc.com",
    "bbc.co.uk", "theverge.com", "techcrunch.com", "arstechnica.com", "wired.com",
  ],
};

const ALLOWED = Object.values(SOURCES).flat();
const letters = (s) => s.normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();

/**
 * Checks the first URL of the comment: listed media and official sites, or the official site of the
 * company the post is about (its name in the domain, e.g. nvidianews.nvidia.com for Nvidia).
 */
export function checkSource(comment, company) {
  const match = comment.match(/https?:\/\/[^\s)]+/);
  if (!match) return { ok: false, label: "aucun lien" };
  let host;
  try {
    host = new URL(match[0]).hostname.replace(/^www\./, "");
  } catch {
    return { ok: false, label: "lien invalide" };
  }
  if (ALLOWED.some((d) => host === d || host.endsWith(`.${d}`))) return { ok: true, label: host };
  const name = company ? letters(company) : "";
  if (name.length >= 3 && letters(host).includes(name)) return { ok: true, label: `${host} (site officiel)` };
  return { ok: false, label: host };
}
