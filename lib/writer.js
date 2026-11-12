import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM } from "./prompt.js";
import { SOURCES } from "./sources.js";

const client = new Anthropic();
const MAX_CONTINUATIONS = 4;
// Sites that block Anthropic's crawler can be neither searched nor read: the API rejects them by name,
// so they are dropped from the search and the request is retried.
let searchable = Object.values(SOURCES).flat();
const tools = () => [
  {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 12,
    allowed_domains: searchable,
    user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" },
  },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
];

function unreachable(err) {
  const list = err?.status === 400 && err.message.match(/not accessible to our user agent: \[([^\]]*)\]/)?.[1];
  return list ? [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}

async function create(params) {
  for (;;) {
    try {
      return await client.beta.messages.create({ ...params, tools: tools() });
    } catch (err) {
      const blocked = unreachable(err);
      if (!blocked.length) throw err;
      searchable = searchable.filter((domain) => !blocked.includes(domain));
      if (!searchable.length) throw err;
    }
  }
}

/**
 * Runs one writing turn. Returns the assistant messages to append to the history
 * (append-only: thinking blocks stay valid for the next revision) and the final text.
 */
export async function write(history, examples) {
  const system = [
    { type: "text", text: SYSTEM },
    { type: "text", text: `## Posts déjà publiés par Kevin (sa voix)\n\n${examples}`, cache_control: { type: "ephemeral" } },
  ];
  const added = [];
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const response = await create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system,
      messages: [...history, ...added],
    });
    if (response.stop_reason === "refusal") throw new Error("la rédaction a été refusée par le modèle");
    added.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;
    // Text written between searches is the model thinking aloud; the answer is what follows the last tool block.
    const lastTool = response.content.findLastIndex((block) => block.type !== "text" && block.type !== "thinking");
    const text = response.content
      .slice(lastTool + 1)
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    return { added, text };
  }
  throw new Error("la recherche des sources n'a pas abouti");
}

const NONE = /^(aucune?|none|-)?$/i;

/** Splits the model's answer into the post, its first comment, the card fields and the note for Kevin. */
export function parse(text) {
  const sections = { post: "", commentaire: "", visuel: "", note: "" };
  let current = "post";
  for (const line of text.split("\n")) {
    const marker = line.trim().match(/^\[(commentaire|visuel|note)\]$/);
    if (marker) current = marker[1];
    else sections[current] += `${line}\n`;
  }
  const field = (name) => {
    const value = sections.visuel.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, "mi"))?.[1].trim() ?? "";
    return NONE.test(value) ? "" : value;
  };
  return {
    post: sections.post.trim(),
    comment: sections.commentaire.trim(),
    card: {
      headline: field("titre"),
      fact: field("fait"),
      person: field("personne"),
      company: field("entreprise"),
      scene: field("image"),
    },
    note: sections.note.trim(),
  };
}
