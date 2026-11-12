import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM } from "./prompt.js";
import { SOURCES } from "./sources.js";

const client = new Anthropic();
const MAX_CONTINUATIONS = 4;
const TOOLS = [
  {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 12,
    allowed_domains: Object.values(SOURCES).flat(),
    user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" },
  },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
];

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
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system,
      tools: TOOLS,
      messages: [...history, ...added],
    });
    if (response.stop_reason === "refusal") throw new Error("la rédaction a été refusée par le modèle");
    added.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;
    const text = response.content
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
