// LinkedIn visual of a news post, same layout as _INTERNA/07_Outils/images/visuel-linkedin.mjs:
// generated photo, translucent dark green panel on the left with a kicker and the hook, logotype bottom right.
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const asset = (name) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
const SERIF = asset("SourceSerif4-Regular.ttf");
const MONO = asset("DMMono-Medium.ttf");
const SYMBOL_FILE = asset("kadyo-symbol-green-512.png");

const IMAGE_MODEL = "gemini-3-pro-image";
const W = 1600;
const H = 900;
const PANEL = 620;
const PAD = 72;
const SYMBOL = 48;

const escapeMarkup = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function generatePhoto(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" } },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`gemini ${res.status}: ${data.error?.message ?? "erreur inconnue"}`);
  const image = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!image) throw new Error("gemini n'a renvoyé aucune image");
  return Buffer.from(image.data, "base64");
}

const text = (markup, font, fontfile, width) =>
  sharp({ text: { text: markup, font, fontfile, width, dpi: 72, rgba: true, wrap: "word" } })
    .png()
    .toBuffer({ resolveWithObject: true });

export async function compose(photo, hook, label = "ACTU") {
  const kicker = await text(
    `<span foreground="#B9D3CA" letter_spacing="2400">${escapeMarkup(label.toUpperCase())}</span>`,
    "DM Mono 26",
    MONO,
  );
  const title = await text(
    `<span foreground="#FFFFFF" line_height="0.92">${escapeMarkup(hook)}</span>`,
    "Source Serif 4 76",
    SERIF,
    PANEL - PAD * 2,
  );
  const wordmark = await text(
    '<span foreground="#FFFFFF" font_weight="500">KADYO</span><span foreground="#C8FF00" font_weight="500">.</span><span foreground="#B8B8B8">studio</span>',
    "DM Mono 30",
    MONO,
  );

  const background = await sharp(photo).resize(W, H, { fit: "cover", position: "centre" }).toBuffer();
  const panel = Buffer.from(
    `<svg width="${PANEL}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${PANEL}" height="${H}" fill="#2F5D50" fill-opacity="0.72"/></svg>`,
  );
  const symbol = await sharp(SYMBOL_FILE).resize({ width: SYMBOL }).toBuffer();
  const plateW = 20 + SYMBOL + 14 + wordmark.info.width + 20;
  const plateH = 16 + SYMBOL + 16;
  const plate = Buffer.from(
    `<svg width="${plateW}" height="${plateH}" xmlns="http://www.w3.org/2000/svg"><rect width="${plateW}" height="${plateH}" rx="6" fill="#1A1A1A" fill-opacity="0.72"/></svg>`,
  );
  const plateLeft = W - 40 - plateW;
  const plateTop = H - 40 - plateH;
  const top = Math.round((H - (kicker.info.height + 28 + title.info.height)) / 2);

  return sharp(background)
    .composite([
      { input: panel, left: 0, top: 0 },
      { input: kicker.data, left: PAD, top },
      { input: title.data, left: PAD, top: top + kicker.info.height + 28 },
      { input: plate, left: plateLeft, top: plateTop },
      { input: symbol, left: plateLeft + 20, top: plateTop + 16 },
      { input: wordmark.data, left: plateLeft + 20 + SYMBOL + 14, top: plateTop + Math.round((plateH - wordmark.info.height) / 2) },
    ])
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}
