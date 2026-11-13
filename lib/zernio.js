const ZERNIO = "https://zernio.com/api/v1";
export const LINKEDIN_ACCOUNT = "6ae326288f95d757b1641c50";

/** Zernio API call; null when the resource does not exist. */
export async function zernio(method, path, body) {
  const res = await fetch(`${ZERNIO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`zernio ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Uploads an image to Zernio's storage and returns its public URL, for mediaItems. */
export async function uploadImage(image) {
  const { uploadUrl, publicUrl } = await zernio("POST", "/media/presign", {
    filename: "visuel.jpg",
    contentType: "image/jpeg",
  });
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: image });
  if (!res.ok) throw new Error(`envoi de l'image à Zernio : ${res.status}`);
  return publicUrl;
}

/** Last published LinkedIn posts, given to the writer as examples of Kevin's voice. */
export async function recentPosts(count = 3) {
  const data = await zernio("GET", `/posts?status=published&limit=${count}`);
  const posts = (data?.posts ?? data?.data ?? []).map((p) => p.content?.trim()).filter(Boolean);
  return posts.length ? posts.join("\n\n---\n\n") : "(aucun exemple disponible)";
}

export async function publishNow({ content, comment, imageUrl, accountId = LINKEDIN_ACCOUNT, mediaItems }) {
  const created = await zernio("POST", "/posts", {
    content,
    ...(imageUrl ? { mediaItems: [{ url: imageUrl, type: "image" }] } : mediaItems?.length ? { mediaItems } : {}),
    platforms: [{
      platform: "linkedin",
      accountId,
      ...(comment ? { platformSpecificData: { firstComment: comment } } : {}),
    }],
    publishNow: true,
  });
  const post = created.post ?? created;
  if (post.status !== "published") throw new Error(`publication ${post.status}: ${JSON.stringify(post.platforms)}`);
  return post.platforms?.[0]?.platformPostUrl ?? "";
}
