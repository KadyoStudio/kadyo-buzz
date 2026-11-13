// Private Vercel Blob store: drafts, images, message pointers and the state of the crons.
import { get, put, list } from "@vercel/blob";

export async function load(path) {
  const found = await get(path, { access: "private", useCache: false });
  return found ? new Response(found.stream).json() : null;
}

export async function loadBytes(path) {
  const found = await get(path, { access: "private", useCache: false });
  if (!found) throw new Error(`fichier introuvable : ${path}`);
  return Buffer.from(await new Response(found.stream).arrayBuffer());
}

export const store = (path, data, contentType = "application/json") =>
  put(path, contentType === "application/json" ? JSON.stringify(data) : data, {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType,
  });

/** Pathnames stored under a prefix. */
export async function paths(prefix) {
  const found = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    found.push(...page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return found;
}
