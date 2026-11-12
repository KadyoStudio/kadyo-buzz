// LinkedIn visual of a news post or brief: 1600x900 card, same size as the other LinkedIn visuals.
import sharp from "sharp";
import { fileURLToPath } from "node:url";

const asset = (name) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
const SERIF = asset("SourceSerif4-Regular.ttf");
const MONO = asset("DMMono-Medium.ttf");
const SYMBOL_FILE = asset("kadyo-symbol-green-512.png");

const IMAGE_MODEL = "gemini-3-pro-image";
const W = 1600;
const H = 900;
const PAD = 72;

const text = (markup, font, fontfile, width) =>
  sharp({ text: { text: markup, font, fontfile, width, dpi: 72, rgba: true, wrap: "word" } })
    .png()
    .toBuffer({ resolveWithObject: true });

const escapeMarkup = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function generatePhoto(prompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "3:4", imageSize: "2K" } },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`gemini ${res.status}: ${data.error?.message ?? "erreur inconnue"}`);
  const image = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!image) throw new Error("gemini n'a renvoyé aucune image");
  return Buffer.from(image.data, "base64");
}

const PHOTO_W = 620;
const COLUMN = W - PHOTO_W - PAD * 2;

/**
 * 16:9 news card, same size as the other LinkedIn visuals: blueprint grid background with the kicker,
 * logotype, headline, key fact box and company logo on the left; the photo full height on the right,
 * with its credit.
 */
export async function composeCard({ kicker, headline, fact, photo, logo, credit }) {
  const lines = [];
  for (let x = 0; x <= W; x += 50) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`);
  for (let y = 0; y <= H; y += 50) lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`);
  const background = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#F0EDEA"/><g stroke="#E3DED7" stroke-width="1">${lines.join("")}</g></svg>`,
  );

  const label = await text(`<span foreground="#2F5D50" letter_spacing="2400">${escapeMarkup(kicker.toUpperCase())}</span>`, "DM Mono 24", MONO);
  const wordmark = await text(
    '<span foreground="#1A1A1A" font_weight="500">KADYO</span><span foreground="#C8FF00" font_weight="500">.</span><span foreground="#5E5A55">studio</span>',
    "DM Mono 24",
    MONO,
  );
  const symbol = await sharp(SYMBOL_FILE).resize({ width: 36 }).toBuffer();
  const title = await text(`<span foreground="#1A1A1A" line_height="0.95">${escapeMarkup(headline)}</span>`, "Source Serif 4 80", SERIF, COLUMN);
  const BOX_PAD = 30;
  const factText = await text(`<span foreground="#1A1A1A" line_height="1.1">${escapeMarkup(fact)}</span>`, "Source Serif 4 30", SERIF, COLUMN - BOX_PAD * 2 - 8);

  const titleTop = 132;
  const boxTop = titleTop + title.info.height + 36;
  const boxH = factText.info.height + BOX_PAD * 2;
  const box = Buffer.from(
    `<svg width="${COLUMN}" height="${boxH}" xmlns="http://www.w3.org/2000/svg"><rect width="${COLUMN}" height="${boxH}" rx="14" fill="#FFFFFF"/><rect width="8" height="${boxH}" fill="#2F5D50"/></svg>`,
  );
  const layers = [
    { input: label.data, left: PAD, top: 64 },
    { input: symbol, left: PAD + COLUMN - wordmark.info.width - 48, top: 56 },
    { input: wordmark.data, left: PAD + COLUMN - wordmark.info.width, top: 56 + Math.round((36 - wordmark.info.height) / 2) },
    { input: title.data, left: PAD, top: titleTop },
    { input: box, left: PAD, top: boxTop },
    { input: factText.data, left: PAD + BOX_PAD + 8, top: boxTop + BOX_PAD },
  ];

  if (logo) {
    const room = H - PAD - (boxTop + boxH + 40);
    const rendered = await sharp(logo, { density: 400 })
      .resize({ width: 340, height: Math.max(40, Math.min(110, room)), fit: "inside" })
      .png()
      .toBuffer({ resolveWithObject: true });
    layers.push({ input: rendered.data, left: PAD, top: H - PAD - rendered.info.height });
  }
  if (photo) {
    const cropped = await sharp(photo).resize(PHOTO_W, H, { fit: "cover", position: sharp.strategy.attention }).toBuffer();
    layers.push({ input: cropped, left: W - PHOTO_W, top: 0 });
    if (credit) {
      const creditText = await text(`<span foreground="#FFFFFF">${escapeMarkup(credit)}</span>`, "DM Mono 14", MONO, PHOTO_W - 40);
      const stripH = creditText.info.height + 24;
      const strip = Buffer.from(
        `<svg width="${PHOTO_W}" height="${stripH}" xmlns="http://www.w3.org/2000/svg"><rect width="${PHOTO_W}" height="${stripH}" fill="#1A1A1A" fill-opacity="0.6"/></svg>`,
      );
      layers.push({ input: strip, left: W - PHOTO_W, top: H - stripH });
      layers.push({ input: creditText.data, left: W - PHOTO_W + 20, top: H - stripH + 12 });
    }
  }

  return sharp(background).composite(layers).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

