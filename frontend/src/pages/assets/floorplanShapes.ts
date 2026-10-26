// Floor plan drawing layer (MP-110): shape model, geometry helpers and a canvas renderer for PNG export.
// Coordinates are fractions (0–1) of the plan image. Line widths and text sizes are in "plan units": 1000 units = the
// image's width, so a drawing looks the same at any size and in the exported PNG.
import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import type { FloorPlanPin } from "../../lib/assets";

export type ShapeType = "rect" | "ellipse" | "polygon" | "line" | "arrow" | "freehand" | "text" | "group" | "parts";
export type Pt = [number, number];
export type Shape = {
  id: string; type: ShapeType;
  x?: number; y?: number; w?: number; h?: number; points?: Pt[]; children?: string[]; text?: string;
  stroke?: string; fill?: string; stroke_width?: number; fill_opacity?: number; font_size?: number;
  label?: string; location_id?: string; asset_id?: string;
  /** merged polygon (MP-128): every outline and hole, filled even-odd; `points` mirrors the first outline */
  rings?: Pt[][];
  /** pinned parts list (MP-128): the parts shown, and whether the list starts expanded */
  part_ids?: string[]; open?: boolean;
  /** text label style (MP-132); missing keys keep the original look (bold sans-serif with a white outline) */
  font?: FontKey; bold?: boolean; italic?: boolean; outline?: string; outline_width?: number;
};
export type FontKey = "sans" | "serif" | "mono" | "rounded";
export const FONTS: [FontKey, string, string][] = [
  ["sans", "Sans", 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
  ["serif", "Serif", 'Georgia, "Times New Roman", serif'],
  ["mono", "Mono", 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'],
  ["rounded", "Rounded", 'ui-rounded, "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif'],
];
/** How a text label is drawn, shared by the editor, the viewer, the location card and the PNG export. */
export function textLook(s: Shape) {
  const fs = s.font_size ?? DEFAULT_STYLE.font_size;
  const family = (FONTS.find((f) => f[0] === (s.font ?? "sans")) ?? FONTS[0])[2];
  const outline = s.outline === undefined ? "#ffffff" : s.outline;
  const width = s.outline_width ?? Math.max(2, fs * 0.16);
  return { fs, family, weight: s.bold === false ? 400 : 600, italic: !!s.italic, outline: outline === "none" || width <= 0 ? null : outline, outlineWidth: width };
}
export type Drawing = { shapes: Shape[] };
export type Box = { x: number; y: number; w: number; h: number };

export const UNITS = 1000;
export const DEFAULT_STYLE = { stroke: "#1b5bd4", fill: "none", stroke_width: 4, fill_opacity: 0.18, font_size: 28 };
export const PALETTE = ["#1b5bd4", "#0f8a5f", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#334155", "#ffffff"];
export const FILE_FORMAT = "mpro.floorplan";

export const newId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const isGroup = (s: Shape) => s.type === "group";
export const isClosed = (s: Shape) => s.type === "rect" || s.type === "ellipse" || s.type === "polygon";

/** child id → group id */
export function parents(shapes: Shape[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of shapes) if (s.type === "group") for (const c of s.children ?? []) m.set(c, s.id);
  return m;
}
/** The outermost group containing a shape (or the shape itself). */
export function topOf(id: string, par: Map<string, string>): string {
  let cur = id;
  const seen = new Set<string>();
  while (par.has(cur) && !seen.has(cur)) { seen.add(cur); cur = par.get(cur)!; }
  return cur;
}
/** All drawable (non-group) shape ids under the given ids. */
export function leaves(ids: Iterable<string>, byId: Map<string, Shape>): string[] {
  const out = new Set<string>();
  const walk = (id: string, depth: number) => {
    const s = byId.get(id);
    if (!s || depth > 20) return;
    if (s.type === "group") (s.children ?? []).forEach((c) => walk(c, depth + 1));
    else out.add(id);
  };
  for (const id of ids) walk(id, 0);
  return [...out];
}
/** Ids under the given ids including groups (for deleting). */
export function descendants(ids: Iterable<string>, byId: Map<string, Shape>): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id)) return;
    const s = byId.get(id);
    if (!s) return;
    out.add(id);
    if (s.type === "group") (s.children ?? []).forEach(walk);
  };
  for (const id of ids) walk(id);
  return out;
}

export function textLines(s: Shape) { return (s.text || " ").split("\n"); }
/** Bounding box in fractions. `aspect` = image height / width. */
export function bbox(s: Shape, aspect: number): Box {
  if (s.rings?.length) {
    const all = s.rings.flat();
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (s.points?.length) {
    const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (s.type === "text") {
    const fs = s.font_size ?? DEFAULT_STYLE.font_size;
    const lines = textLines(s);
    const longest = Math.max(...lines.map((l) => l.length), 1);
    const per = s.font === "mono" ? 0.62 : s.bold === false ? 0.52 : 0.56;
    return { x: s.x ?? 0, y: s.y ?? 0, w: (longest * fs * per) / UNITS, h: (lines.length * fs * 1.2) / (UNITS * aspect) };
  }
  return { x: s.x ?? 0, y: s.y ?? 0, w: s.w ?? 0, h: s.h ?? 0 };
}
export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}
export function intersects(a: Box, b: Box) { return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h; }

const r5 = (n: number) => Math.round(n * 100000) / 100000;
const clampC = (n: number) => Math.min(1.5, Math.max(-0.5, r5(n)));

export function translate(s: Shape, dx: number, dy: number): Shape {
  if (s.rings) {
    const rings = s.rings.map((r) => r.map(([x, y]) => [clampC(x + dx), clampC(y + dy)] as Pt));
    return { ...s, rings, points: rings[0] };
  }
  if (s.points) return { ...s, points: s.points.map(([x, y]) => [clampC(x + dx), clampC(y + dy)] as Pt) };
  return { ...s, x: clampC((s.x ?? 0) + dx), y: clampC((s.y ?? 0) + dy) };
}
/** Scale about an origin; flips are normalised so width and height stay positive. */
export function scale(s: Shape, ox: number, oy: number, sx: number, sy: number): Shape {
  const mx = (x: number) => clampC(ox + (x - ox) * sx), my = (y: number) => clampC(oy + (y - oy) * sy);
  if (s.rings) {
    const rings = s.rings.map((r) => r.map(([x, y]) => [mx(x), my(y)] as Pt));
    return { ...s, rings, points: rings[0] };
  }
  if (s.points) return { ...s, points: s.points.map(([x, y]) => [mx(x), my(y)] as Pt) };
  if (s.type === "text") {
    const fs = Math.min(200, Math.max(4, Math.round((s.font_size ?? DEFAULT_STYLE.font_size) * Math.abs(sy) * 10) / 10));
    return { ...s, x: mx(s.x ?? 0), y: my(s.y ?? 0), font_size: fs };
  }
  const x1 = mx(s.x ?? 0), x2 = mx((s.x ?? 0) + (s.w ?? 0)), y1 = my(s.y ?? 0), y2 = my((s.y ?? 0) + (s.h ?? 0));
  return { ...s, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.min(2, r5(Math.abs(x2 - x1))), h: Math.min(2, r5(Math.abs(y2 - y1))) };
}

// ---- Merge (MP-128): a true union of closed shapes, holes kept --------------------------------------------------
const ELLIPSE_STEPS = 48;
/** The outline(s) of a closed shape as rings of points (ellipses become 48-sided polygons). */
export function ringsOf(s: Shape): Pt[][] {
  if (s.rings?.length) return s.rings;
  if (s.type === "polygon" && s.points && s.points.length >= 3) return [s.points];
  const x = s.x ?? 0, y = s.y ?? 0, w = s.w ?? 0, h = s.h ?? 0;
  if (s.type === "rect") return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
  if (s.type === "ellipse") {
    const cx = x + w / 2, cy = y + h / 2;
    return [Array.from({ length: ELLIPSE_STEPS }, (_, i) => {
      const a = (i / ELLIPSE_STEPS) * Math.PI * 2;
      return [r5(cx + (w / 2) * Math.cos(a)), r5(cy + (h / 2) * Math.sin(a))] as Pt;
    })];
  }
  return [];
}
const closeRing = (r: Pt[]): Pt[] => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
const openRing = (r: Pt[]): Pt[] => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);
/** A shape as polygon-clipping geometry: each ring on its own, combined even-odd (outline XOR holes). */
function geomOf(s: Shape): MultiPolygon {
  const rings = ringsOf(s).filter((r) => r.length >= 3).map((r) => closeRing(r));
  if (rings.length <= 1) return rings.map((r) => [r]) as MultiPolygon;
  // rings of an earlier merge: rebuild holes with an even-odd xor so they stay holes
  return polygonClipping.xor([rings[0]] as Polygon, ...rings.slice(1).map((r) => [r] as Polygon));
}
/**
 * Union of closed shapes into one polygon shape with every outline and hole (rings). Returns null when there are
 * fewer than two closed shapes or the union is empty. The style comes from the first (bottom-most) shape.
 */
export function mergeShapes(parts: Shape[]): Shape | null {
  const closed = parts.filter((s) => isClosed(s) && ringsOf(s).length);
  if (closed.length < 2) return null;
  const [first, ...rest] = closed.map(geomOf);
  const out = polygonClipping.union(first, ...rest);
  const rings = out.flatMap((poly) => poly.map((r) => openRing(r.map(([x, y]) => [r5(x), r5(y)] as Pt)))).filter((r) => r.length >= 3);
  if (!rings.length) return null;
  const base = closed[0];
  const label = closed.map((s) => s.label).find(Boolean);
  const link = closed.find((s) => s.location_id || s.asset_id);
  return {
    id: newId(), type: "polygon", points: rings[0], rings: rings.length > 1 ? rings : undefined,
    stroke: base.stroke, fill: base.fill, stroke_width: base.stroke_width, fill_opacity: base.fill_opacity,
    ...(label ? { label } : {}), ...(link ? { location_id: link.location_id, asset_id: link.asset_id } : {}),
  };
}
/** SVG path data for rings (plan units). */
export function ringsPath(rings: Pt[][], H: number): string {
  return rings.map((r) => r.map(([x, y], i) => `${i ? "L" : "M"}${r5(x * UNITS)} ${r5(y * H)}`).join(" ") + " Z").join(" ");
}

/** Arrow head triangle (plan units) for the last segment. */
export function arrowHead(pts: [number, number][], sw: number): [number, number][] | null {
  if (pts.length < 2) return null;
  const [x1, y1] = pts[pts.length - 2], [x2, y2] = pts[pts.length - 1];
  const a = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(14, sw * 4), half = Math.max(7, sw * 2.2);
  const bx = x2 - Math.cos(a) * len, by = y2 - Math.sin(a) * len;
  return [[x2, y2], [bx + Math.sin(a) * half, by - Math.cos(a) * half], [bx - Math.sin(a) * half, by + Math.cos(a) * half]];
}

/** Draw shapes and pins on a canvas the size of the plan image (export). */
export function drawOnCanvas(ctx: CanvasRenderingContext2D, shapes: Shape[], pins: FloorPlanPin[], W: number, H: number) {
  const k = W / UNITS; // plan units → pixels
  const P = (p: Pt): [number, number] => [p[0] * W, p[1] * H];
  for (const s of shapes) {
    if (s.type === "group" || s.type === "parts") continue;
    const stroke = s.stroke && s.stroke !== "none" ? s.stroke : null;
    const fill = s.fill && s.fill !== "none" ? s.fill : null;
    const sw = (s.stroke_width ?? DEFAULT_STYLE.stroke_width) * k;
    ctx.save();
    ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.lineWidth = sw;
    if (stroke) ctx.strokeStyle = stroke;
    if (s.type === "text") {
      const look = textLook(s);
      const fs = look.fs * k;
      ctx.font = `${look.italic ? "italic " : ""}${look.weight} ${fs}px ${look.family}`;
      ctx.textBaseline = "top";
      textLines(s).forEach((line, i) => {
        const x = (s.x ?? 0) * W, y = (s.y ?? 0) * H + i * fs * 1.2;
        if (look.outline) { ctx.lineWidth = look.outlineWidth * k; ctx.strokeStyle = look.outline; ctx.strokeText(line, x, y); }
        ctx.fillStyle = stroke ?? DEFAULT_STYLE.stroke; ctx.fillText(line, x, y);
      });
      ctx.restore();
      continue;
    }
    ctx.beginPath();
    if (s.type === "rect") ctx.rect((s.x ?? 0) * W, (s.y ?? 0) * H, (s.w ?? 0) * W, (s.h ?? 0) * H);
    else if (s.type === "ellipse") ctx.ellipse(((s.x ?? 0) + (s.w ?? 0) / 2) * W, ((s.y ?? 0) + (s.h ?? 0) / 2) * H, ((s.w ?? 0) * W) / 2, ((s.h ?? 0) * H) / 2, 0, 0, Math.PI * 2);
    else if (s.rings?.length) {
      for (const r of s.rings) { r.map(P).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
    } else if (s.points?.length) {
      const pts = s.points.map(P);
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.type === "polygon") ctx.closePath();
    }
    if (fill && isClosed(s)) { ctx.globalAlpha = s.fill_opacity ?? DEFAULT_STYLE.fill_opacity; ctx.fillStyle = fill; ctx.fill(s.rings ? "evenodd" : "nonzero"); ctx.globalAlpha = 1; }
    if (stroke && sw > 0) ctx.stroke();
    if (s.type === "arrow" && s.points && stroke) {
      const head = arrowHead(s.points.map(P), sw);
      if (head) { ctx.beginPath(); head.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = stroke; ctx.fill(); }
    }
    ctx.restore();
  }
  // pins: a dot with the label above it
  const colour: Record<string, string> = { online: "#0f8a5f", offline: "#dc2626", do_not_track: "#64748b" };
  for (const p of pins) {
    const x = p.x * W, y = p.y * H, r = Math.max(6, 9 * k);
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y - r, r, 0, Math.PI * 2);
    ctx.fillStyle = colour[p.asset_status ?? ""] ?? "#1b5bd4"; ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.35); ctx.strokeStyle = "#ffffff"; ctx.stroke();
    if (p.label) {
      const fs = Math.max(11, 16 * k);
      ctx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.lineWidth = Math.max(2, fs * 0.2); ctx.strokeStyle = "#ffffff"; ctx.strokeText(p.label, x, y - 2.2 * r);
      ctx.fillStyle = "#172033"; ctx.fillText(p.label, x, y - 2.2 * r);
    }
    ctx.restore();
  }
}

/** Light check of a drawing read back from an exported PNG; the server validates fully on save. */
export function parseDrawing(json: string): Shape[] | null {
  try {
    const d = JSON.parse(json) as { format?: string; shapes?: unknown };
    if (d.format !== FILE_FORMAT || !Array.isArray(d.shapes)) return null;
    return (d.shapes as Shape[]).filter((s) => s && typeof s.id === "string" && typeof s.type === "string");
  } catch { return null; }
}
