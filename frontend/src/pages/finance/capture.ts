// Receipt pages from the phone camera: auto-crop to the paper and straighten (deskew) in the browser, then read them
// with on-device OCR (tesseract.js, the same files as nameplate scanning). Nothing leaves the device until upload.
import { ocrImage } from "../../components/Nameplate";

const MAX_SIDE = 1800; // big enough for OCR, small enough to upload quickly on a phone
const PROBE = 360; // analysis size

type Gray = { w: number; h: number; px: Uint8ClampedArray };

function toGray(src: CanvasImageSource, w: number, h: number): Gray {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const px = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) px[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return { w, h, px };
}

/** Otsu's threshold between paper (bright) and the table / background. */
function otsu(px: Uint8ClampedArray): number {
  const hist = new Array(256).fill(0);
  for (const v of px) hist[v]++;
  const total = px.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

/** Longest run of indexes whose score passes `min`, allowing gaps of up to `gap` indexes. */
function longestRun(scores: number[], min: number, gap = 3): [number, number] | null {
  let best: [number, number] | null = null, start = -1, last = -1;
  const keep = (a: number, b: number) => { if (!best || b - a > best[1] - best[0]) best = [a, b]; };
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < min) continue;
    if (start < 0) start = i;
    else if (i - last > gap + 1) { keep(start, last); start = i; }
    last = i;
  }
  if (start >= 0) keep(start, last);
  return best;
}

/** Bounding box of the receipt paper in probe coordinates, or null when the photo is already just the paper. */
export function findPaper(g: Gray): { x: number; y: number; w: number; h: number } | null {
  const t = otsu(g.px);
  const rows = new Array(g.h).fill(0), cols = new Array(g.w).fill(0);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.px[y * g.w + x] > t) { rows[y]++; cols[x]++; }
  const r = longestRun(rows.map((n) => n / g.w), 0.25), c = longestRun(cols.map((n) => n / g.h), 0.25);
  if (!r || !c) return null;
  const box = { x: c[0], y: r[0], w: c[1] - c[0] + 1, h: r[1] - r[0] + 1 };
  const frac = (box.w * box.h) / (g.w * g.h);
  if (frac > 0.92 || frac < 0.12) return null; // nothing to crop, or not confident
  const pad = 4;
  return { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), w: Math.min(g.w - box.x + pad, box.w + 2 * pad),
    h: Math.min(g.h - box.y + pad, box.h + 2 * pad) };
}

/** Skew angle in degrees (-12…12): the rotation that makes text lines sharpest in the horizontal projection. */
export function findSkew(g: Gray): number {
  const t = Math.min(otsu(g.px), 200);
  const pts: [number, number][] = [];
  for (let y = 0; y < g.h; y += 1) for (let x = 0; x < g.w; x += 1) if (g.px[y * g.w + x] < t - 20) pts.push([x - g.w / 2, y - g.h / 2]);
  if (pts.length < 200) return 0;
  const sample = pts.length > 12000 ? pts.filter((_, i) => i % Math.ceil(pts.length / 12000) === 0) : pts;
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180, s = Math.sin(a), co = Math.cos(a);
    const bins = new Map<number, number>();
    for (const [x, y] of sample) { const b = Math.round(y * co - x * s); bins.set(b, (bins.get(b) ?? 0) + 1); }
    let v = 0; for (const n of bins.values()) v += n * n;
    return v;
  };
  let best = 0, bestScore = score(0);
  for (let d = -12; d <= 12; d += 1) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
  for (let d = best - 0.9; d <= best + 0.9; d += 0.3) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
  return Math.abs(best) < 0.4 ? 0 : Math.round(best * 10) / 10;
}

export type Page = { blob: Blob; url: string; cropped: boolean; angle: number };

/** Crop to the paper, straighten and shrink one photo. Falls back to the original if anything fails. */
export async function preparePage(file: Blob, opts: { crop?: boolean; deskew?: boolean } = {}): Promise<Page> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, PROBE / Math.max(bmp.width, bmp.height));
    const probe = toGray(bmp, Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
    const box = opts.crop === false ? null : findPaper(probe);
    const sx = box ? box.x / k : 0, sy = box ? box.y / k : 0;
    const sw = box ? Math.min(bmp.width - sx, box.w / k) : bmp.width, sh = box ? Math.min(bmp.height - sy, box.h / k) : bmp.height;
    let angle = 0;
    if (opts.deskew !== false) {
      const kk = Math.min(1, PROBE / Math.max(sw, sh));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(sw * kk)); c.height = Math.max(1, Math.round(sh * kk));
      c.getContext("2d")!.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
      angle = findSkew(toGray(c, c.width, c.height));
    }
    const s = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.round(sw * s), h = Math.round(sh * s);
    const rad = (-angle * Math.PI) / 180;
    const ow = Math.round(Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad)));
    const oh = Math.round(Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)));
    const out = document.createElement("canvas");
    out.width = ow; out.height = oh;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, ow, oh);
    ctx.translate(ow / 2, oh / 2); ctx.rotate(rad);
    ctx.drawImage(bmp, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    bmp.close?.();
    const blob = await new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.86));
    return { blob, url: URL.createObjectURL(blob), cropped: !!box, angle };
  } catch {
    return { blob: file, url: URL.createObjectURL(file), cropped: false, angle: 0 };
  }
}

/** Read every page on the device; returns the text of all pages (empty when the reader can't load). */
export async function readPages(pages: Blob[], onProgress?: (fraction: number, status: string) => void): Promise<string> {
  const texts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const r = await ocrImage(pages[i], (p, s) => onProgress?.((i + p) / pages.length, s));
    texts.push(r.text);
  }
  return texts.join("\n");
}
