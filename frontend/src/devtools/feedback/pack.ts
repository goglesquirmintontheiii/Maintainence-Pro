// TEMPORARY (feedback capture, 0.4.2). Remove by 1.9.0 (2.0.0 at the latest). See ./README.md.
// Screenshots and the capture code: JSON -> gzip -> base64, prefixed so the checklist recognises it.

import type { Box, ElementInfo } from "./inspect";

export const PREFIX_GZIP = "MPRO-FB1:";
export const PREFIX_PLAIN = "MPRO-FB0:";

export type Kind = "feature" | "change" | "bug" | "note";
export type Priority = "high" | "med" | "low" | "none";

export type Shot = { data: string; w: number; h: number; scale: number }; // data URL; scale = image px per CSS px

export type Capture = {
  v: 1;
  tool: "mpro-feedback";
  created: string;
  kind: Kind;
  priority: Priority;
  text: string;
  app: { version?: string; role?: string; org?: string };
  page: Record<string, unknown>;
  target: "element" | "area";
  element?: ElementInfo;
  area?: Box;
  shot?: Shot;
  elements?: ElementInfo[];
};

const MAX_SIDE = 2000;          // image pixels
const MAX_BYTES = 900_000;      // keep codes pasteable (base64 of the image)

/** Screenshot of a viewport rectangle (CSS px). Our own overlay is left out. */
export async function screenshot(area: Box): Promise<Shot> {
  const { toCanvas } = await import("html-to-image"); // loaded only when someone takes a screenshot
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const full = await toCanvas(document.body, {
    pixelRatio: ratio,
    width: innerWidth,
    height: innerHeight,
    skipFonts: true,            // MPro uses system fonts; nothing to embed
    cacheBust: false,
    backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
    style: scrollX || scrollY ? { transform: `translate(${-scrollX}px, ${-scrollY}px)` } : undefined,
    filter: (n) => !(n instanceof Element && n.hasAttribute("data-mpro-feedback")),
  });
  let scale = ratio;
  const longest = Math.max(area.w, area.h) * scale;
  if (longest > MAX_SIDE) scale = (MAX_SIDE / Math.max(area.w, area.h));
  for (let attempt = 0; attempt < 5; attempt++) {
    const w = Math.max(1, Math.round(area.w * scale)), h = Math.max(1, Math.round(area.h * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(full, area.x * ratio, area.y * ratio, area.w * ratio, area.h * ratio, 0, 0, w, h);
    let data = c.toDataURL("image/webp", 0.86);
    if (!data.startsWith("data:image/webp")) data = c.toDataURL("image/jpeg", 0.88); // Safari can't encode WebP
    if (data.length <= MAX_BYTES || attempt === 4) return { data, w, h, scale: Math.round(scale * 1000) / 1000 };
    scale *= 0.75;
  }
  throw new Error("unreachable");
}

function toB64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The text to paste into the checklist. */
export async function encode(c: Capture): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(c));
  if (typeof CompressionStream === "undefined") return PREFIX_PLAIN + toB64(json);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  return PREFIX_GZIP + toB64(gz);
}

let cachedApp: Capture["app"] | null = null;
export async function appInfo(): Promise<Capture["app"]> {
  if (cachedApp) return cachedApp;
  try {
    const r = await fetch("/api/v1/auth/session", { credentials: "same-origin", headers: { Accept: "application/json" } });
    const s = await r.json();
    cachedApp = { version: s.version, role: s.role_label || s.role || undefined, org: s.org?.name };
  } catch {
    cachedApp = {};
  }
  return cachedApp;
}
