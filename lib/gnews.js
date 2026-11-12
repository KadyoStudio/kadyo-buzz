// Google News links (news.google.com/rss/articles/…) hide the article's address: the page carries a signature
// and a timestamp that Google's own decoding endpoint exchanges for the real URL.
const ARTICLE = /^https:\/\/news\.google\.com\/(?:rss\/)?articles\/([^?/#]+)/;
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; kadyo-buzz)", Cookie: "CONSENT=YES+" };

async function decode(id) {
  const page = await fetch(`https://news.google.com/articles/${id}?hl=en-US&gl=US&ceid=US:en&ucbcb=1`, { headers: HEADERS });
  const html = await page.text();
  const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!signature || !timestamp) return null;
  const request = [
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id,
    Number(timestamp),
    signature,
  ];
  const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ "f.req": JSON.stringify([[["Fbv4je", JSON.stringify(request), null, "generic"]]]) }),
  });
  const payload = JSON.parse((await res.text()).split("\n\n")[1])[0][2];
  return JSON.parse(payload)[1] ?? null;
}

/** Real article URL behind a Google News link; any other URL, or a failed decoding, is returned as is. */
export async function resolveLink(url) {
  const id = url.match(ARTICLE)?.[1];
  if (!id) return url;
  try {
    return (await decode(id)) ?? url;
  } catch {
    return url;
  }
}
