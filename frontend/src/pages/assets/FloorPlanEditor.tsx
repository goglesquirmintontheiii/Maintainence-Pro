// Full-screen floor plan viewer and editor (MP-110). Draw rooms and areas (rectangles, ellipses, polygons), lines,
// arrows, freehand marks and text over the plan image; place asset pins; merge shapes into a group; bind a shape to a
// location or an asset so clicking it opens that record. Edits are saved as one drawing with optimistic concurrency
// (someone else saving first → 409 → reload). Export a PNG of the plan with the edits, optionally carrying the edit
// data so it can be imported again.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight, Circle, Download, Group, Hexagon, Link2, MapPin, Maximize, Minus, MousePointer2, PenLine, Pencil, Plus, Redo2, Save, Slash,
  Square, Trash2, Type, Undo2, Ungroup, Upload, X,
} from "lucide-react";
import { api, ApiError } from "../../lib/api";
import type { FloorPlan, FloorPlanPin } from "../../lib/assets";
import { embedInPng, readFromPng } from "../../lib/pngMeta";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, Field, Input, Modal } from "../../components/ui";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
import {
  arrowHead, bbox, DEFAULT_STYLE, descendants, drawOnCanvas, FILE_FORMAT, intersects, isClosed, leaves, newId, PALETTE, parents, parseDrawing,
  scale, textLines, topOf, translate, union, UNITS, type Box, type Pt, type Shape, type ShapeType,
} from "./floorplanShapes";
import "../../styles/viewer.css";
import { ColorPicker } from "../../components/ColorPicker";

type Tool = "select" | "pin" | Exclude<ShapeType, "group">;
const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: "select", label: "Select and move", key: "V", icon: <MousePointer2 size={17} /> },
  { id: "rect", label: "Rectangle", key: "R", icon: <Square size={17} /> },
  { id: "ellipse", label: "Ellipse", key: "O", icon: <Circle size={17} /> },
  { id: "polygon", label: "Polygon (click points, double-click or Enter to finish)", key: "P", icon: <Hexagon size={17} /> },
  { id: "line", label: "Line", key: "L", icon: <Slash size={17} /> },
  { id: "arrow", label: "Arrow", key: "A", icon: <ArrowUpRight size={17} /> },
  { id: "freehand", label: "Freehand", key: "F", icon: <PenLine size={17} /> },
  { id: "text", label: "Text", key: "T", icon: <Type size={17} /> },
  { id: "pin", label: "Asset pin", key: "I", icon: <MapPin size={17} /> },
];
type Style = { stroke: string; fill: string; stroke_width: number; fill_opacity: number; font_size: number };
type Drag =
  | { kind: "move"; start: Pt; before: Shape[]; ids: string[]; moved: boolean }
  | { kind: "scale"; corner: number; box: Box; before: Shape[]; ids: string[] }
  | { kind: "vertex"; id: string; index: number; before: Shape[] }
  | { kind: "draw"; id: string; start: Pt; before: Shape[] }
  | { kind: "marquee"; start: Pt; cur: Pt; add: boolean }
  | { kind: "pin"; id: string; at: Pt; moved: boolean };

const toShapes = (plan: FloorPlan): Shape[] => ((plan.annotations?.shapes ?? []) as unknown as Shape[]);

/** Read-only drawing layer used on the location card and in view mode. */
export function PlanShapes({ shapes, aspect, onOpen, interactive = true }: {
  shapes: Shape[]; aspect: number; onOpen?: (s: Shape) => void; interactive?: boolean;
}) {
  const par = useMemo(() => parents(shapes), [shapes]);
  const byId = useMemo(() => new Map(shapes.map((s) => [s.id, s])), [shapes]);
  const linkOf = (s: Shape): Shape | null => {
    let cur: Shape | undefined = s;
    for (let i = 0; cur && i < 20; i++) {
      if (cur.location_id || cur.asset_id) return cur;
      const p = par.get(cur.id);
      cur = p ? byId.get(p) : undefined;
    }
    return null;
  };
  return (
    <svg className="plan-svg" viewBox={`0 0 ${UNITS} ${UNITS * aspect}`} preserveAspectRatio="none" aria-hidden={!interactive}>
      {shapes.map((s) => {
        if (s.type === "group") return null;
        const link = interactive ? linkOf(s) : null;
        const title = link ? (link.label || (link.location_id ? "Open location" : "Open asset")) : s.label;
        return (
          <g key={s.id} className={link ? "plan-link" : undefined} onClick={link && onOpen ? (e) => { e.stopPropagation(); onOpen(link); } : undefined}
            role={link ? "link" : undefined} tabIndex={link ? 0 : undefined} aria-label={link ? title : undefined}
            onKeyDown={link && onOpen ? (e) => { if (e.key === "Enter") onOpen(link); } : undefined}>
            {title && <title>{title}</title>}
            <ShapeSvg s={s} aspect={aspect} hit={!!link} />
          </g>);
      })}
    </svg>
  );
}

function ShapeSvg({ s, aspect, hit }: { s: Shape; aspect: number; hit?: boolean }) {
  const H = UNITS * aspect;
  const stroke = s.stroke && s.stroke !== "none" ? s.stroke : "none";
  const fill = s.fill && s.fill !== "none" && isClosed(s) ? s.fill : "none";
  const sw = s.stroke_width ?? DEFAULT_STYLE.stroke_width;
  const common = { stroke, strokeWidth: sw, fill, fillOpacity: s.fill_opacity ?? DEFAULT_STYLE.fill_opacity, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  const hitProps = hit ? { pointerEvents: (isClosed(s) ? "all" : "stroke") as "all" | "stroke" } : {};
  const pts = (s.points ?? []).map(([x, y]) => [x * UNITS, y * H] as [number, number]);
  const ptsAttr = pts.map((p) => p.join(",")).join(" ");
  switch (s.type) {
    case "rect": return <rect x={(s.x ?? 0) * UNITS} y={(s.y ?? 0) * H} width={(s.w ?? 0) * UNITS} height={(s.h ?? 0) * H} {...common} {...hitProps} />;
    case "ellipse": return <ellipse cx={((s.x ?? 0) + (s.w ?? 0) / 2) * UNITS} cy={((s.y ?? 0) + (s.h ?? 0) / 2) * H} rx={((s.w ?? 0) * UNITS) / 2} ry={((s.h ?? 0) * H) / 2} {...common} {...hitProps} />;
    case "polygon": return <polygon points={ptsAttr} {...common} {...hitProps} />;
    case "text": {
      const fs = s.font_size ?? DEFAULT_STYLE.font_size;
      return (
        <text x={(s.x ?? 0) * UNITS} y={(s.y ?? 0) * H} fontSize={fs} fontWeight={600} fill={stroke === "none" ? DEFAULT_STYLE.stroke : stroke}
          stroke="#ffffff" strokeWidth={Math.max(2, fs * 0.16)} paintOrder="stroke" strokeLinejoin="round" dominantBaseline="text-before-edge"
          style={{ fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }} pointerEvents={hit ? "all" : undefined}>
          {textLines(s).map((l, i) => <tspan key={i} x={(s.x ?? 0) * UNITS} dy={i ? fs * 1.2 : 0}>{l || " "}</tspan>)}
        </text>);
    }
    default: {
      const head = s.type === "arrow" ? arrowHead(pts, sw) : null;
      return (
        <>
          {hit && <polyline points={ptsAttr} fill="none" stroke="transparent" strokeWidth={Math.max(sw, 16)} pointerEvents="stroke" />}
          <polyline points={ptsAttr} {...common} fill="none" />
          {head && stroke !== "none" && <polygon points={head.map((p) => p.join(",")).join(" ")} fill={stroke} stroke="none" />}
        </>);
    }
  }
}

// ---------------------------------------------------------------- the full-screen editor
export function FloorPlanEditor({ locId, plan, editable, startEditing = false, onClose, onChanged }: {
  locId: string; plan: FloorPlan; editable: boolean; startEditing?: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { toast } = useToast();
  const nav = useNavigate();
  const qc = useQueryClient();
  const base = `/locations/${locId}/floor-plans/${plan.id}`;
  const [editing, setEditing] = useState(editable && startEditing);
  const [shapes, setShapes] = useState<Shape[]>(() => toShapes(plan));
  const [saved, setSaved] = useState<{ shapes: Shape[]; version: number }>(() => ({ shapes: toShapes(plan), version: plan.annotations_version ?? 0 }));
  const [past, setPast] = useState<Shape[][]>([]);
  const [future, setFuture] = useState<Shape[][]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [style, setStyle] = useState<Style>({ ...DEFAULT_STYLE });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [poly, setPoly] = useState<{ pts: Pt[]; hover: Pt | null } | null>(null);
  const [pinDraft, setPinDraft] = useState<{ x: number; y: number } | null>(null);
  const [pinMoves, setPinMoves] = useState<Record<string, Pt>>({});
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [binding, setBinding] = useState<"location" | "asset" | null>(null);
  const [conflict, setConflict] = useState(false);
  const [askClose, setAskClose] = useState<null | "close" | "view">(null);
  const [withData, setWithData] = useState(true);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [stageSize, setStageSize] = useState({ w: 800, h: 600 });
  const [focusText, setFocusText] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const importIn = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const aspect = natural ? natural.h / natural.w : 0.66;
  const H = UNITS * aspect;

  const byId = useMemo(() => new Map(shapes.map((s) => [s.id, s])), [shapes]);
  const par = useMemo(() => parents(shapes), [shapes]);
  const dirty = useMemo(() => JSON.stringify(shapes) !== JSON.stringify(saved.shapes), [shapes, saved]);
  const selLeaves = useMemo(() => leaves(sel, byId), [sel, byId]);
  const selBox = useMemo(() => union(selLeaves.map((id) => bbox(byId.get(id)!, aspect))), [selLeaves, byId, aspect]);
  const single = sel.length === 1 ? byId.get(sel[0]) ?? null : null;

  // a new text shape: put the cursor in its text box
  useEffect(() => {
    if (!(focusText && single?.id === focusText)) return;
    // after the click that placed the text has finished moving focus
    window.setTimeout(() => { textRef.current?.focus(); textRef.current?.select(); setFocusText(null); }, 0);
  }, [focusText, single]);
  // a newer saved drawing arrives while nothing is changed here → show it
  useEffect(() => {
    if (!dirty && (plan.annotations_version ?? 0) !== saved.version) {
      const s = toShapes(plan);
      setShapes(s); setSaved({ shapes: s, version: plan.annotations_version ?? 0 });
    }
  }, [plan, dirty, saved.version]);

  // fit the plan into the stage
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitW = Math.max(160, Math.min(stageSize.w - 32, (stageSize.h - 32) / aspect));
  const boxW = fitW * zoom;
  const unitPx = boxW / UNITS; // screen pixels per plan unit
  const hs = 9 / unitPx; // handle size in plan units

  // ------------------------------------------------ history
  const commit = useCallback((next: Shape[], before?: Shape[]) => {
    setPast((p) => [...p.slice(-99), before ?? shapes]);
    setFuture([]);
    setShapes(next);
  }, [shapes]);
  const undo = () => { if (!past.length) return; setFuture((f) => [shapes, ...f]); setShapes(past[past.length - 1]); setPast((p) => p.slice(0, -1)); setSel([]); };
  const redo = () => { if (!future.length) return; setPast((p) => [...p, shapes]); setShapes(future[0]); setFuture((f) => f.slice(1)); setSel([]); };
  const updateLeaves = (ids: string[], f: (s: Shape) => Shape, before?: Shape[]) => {
    const set = new Set(ids);
    const src = before ?? shapes;
    return src.map((s) => (set.has(s.id) ? f(s) : s));
  };

  // ------------------------------------------------ actions
  const remove = (ids = sel) => {
    if (!ids.length) return;
    const gone = descendants(ids, byId);
    commit(shapes.filter((s) => !gone.has(s.id)).map((s) => (s.type === "group" ? { ...s, children: (s.children ?? []).filter((c) => !gone.has(c)) } : s))
      .filter((s) => s.type !== "group" || (s.children ?? []).length >= 2));
    setSel([]);
  };
  const merge = () => {
    if (sel.length < 2) return;
    const g: Shape = { id: newId(), type: "group", children: [...sel] };
    commit([...shapes, g]); setSel([g.id]);
    toast("Merged into one group");
  };
  const ungroup = () => {
    const groups = sel.filter((id) => byId.get(id)?.type === "group");
    if (!groups.length) return;
    const kids = groups.flatMap((id) => byId.get(id)?.children ?? []);
    commit(shapes.filter((s) => !groups.includes(s.id))); setSel(kids);
  };
  const order = (front: boolean) => {
    const ids = new Set(selLeaves);
    const moving = shapes.filter((s) => ids.has(s.id)), rest = shapes.filter((s) => !ids.has(s.id));
    commit(front ? [...rest, ...moving] : [...moving, ...rest]);
  };
  const setProp = (patch: Partial<Shape>, onTop = false) => {
    if (!sel.length) return;
    const ids = onTop ? sel : selLeaves;
    commit(updateLeaves(ids, (s) => ({ ...s, ...patch })));
  };
  const applyStyle = (patch: Partial<Style>) => {
    setStyle((s) => ({ ...s, ...patch }));
    if (sel.length) setProp(patch as Partial<Shape>);
  };
  const nudge = (dx: number, dy: number) => { if (selLeaves.length) commit(updateLeaves(selLeaves, (s) => translate(s, dx, dy))); };

  const save = useMutation({
    mutationFn: () => api<{ annotations: { shapes: Shape[] }; version: number }>(`${base}/annotations`, { method: "PUT", body: { annotations: { shapes }, version: saved.version } }),
    onSuccess: (d) => {
      setSaved({ shapes: d.annotations.shapes, version: d.version }); setShapes(d.annotations.shapes); setConflict(false);
      toast("Floor plan saved"); onChanged(); void qc.invalidateQueries({ queryKey: ["location", locId] });
    },
    onError: (e) => { if ((e as ApiError).status === 409) setConflict(true); else toast((e as ApiError).message, { kind: "error" }); },
  });
  const reload = async () => {
    try {
      const d = await api<{ annotations: { shapes: Shape[] }; version: number }>(`${base}/annotations`);
      setShapes(d.annotations.shapes); setSaved({ shapes: d.annotations.shapes, version: d.version });
      setPast([]); setFuture([]); setSel([]); setConflict(false); onChanged();
      toast("Loaded the latest drawing");
    } catch (e) { toast((e as ApiError).message, { kind: "error" }); }
  };
  const movePin = useMutation({
    mutationFn: (p: { id: string; x: number; y: number }) => api(`${base}/pins/${p.id}`, { method: "PATCH", body: { x: p.x, y: p.y } }),
    onSuccess: () => onChanged(), onError: (e) => toast((e as ApiError).message, { kind: "error" }),
    onSettled: (_d, _e, p) => setPinMoves((m) => { const n = { ...m }; delete n[p.id]; return n; }),
  });
  const delPin = useMutation({
    mutationFn: (id: string) => api(`${base}/pins/${id}`, { method: "DELETE" }),
    onSuccess: () => { onChanged(); toast("Pin removed"); }, onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });

  const exportPng = async () => {
    const im = img.current;
    if (!im || !natural) return;
    try {
      const c = document.createElement("canvas");
      c.width = natural.w; c.height = natural.h;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(im, 0, 0, natural.w, natural.h);
      drawOnCanvas(ctx, shapes, plan.pins, natural.w, natural.h);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
      if (!blob) throw new Error("Couldn't create the image.");
      let out: Blob = blob;
      if (withData) {
        const json = JSON.stringify({ format: FILE_FORMAT, version: 1, plan: plan.name, shapes, pins: plan.pins.map(({ x, y, label, asset_id }) => ({ x, y, label, asset_id })) });
        out = new Blob([embedInPng(await blob.arrayBuffer(), json)], { type: "image/png" });
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(out);
      a.download = `${plan.name || "floor plan"}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast((e as Error).message || "Export failed", { kind: "error" }); }
  };
  const importPng = async (file: File | undefined) => {
    if (!file) return;
    const json = readFromPng(await file.arrayBuffer());
    const got = json ? parseDrawing(json) : null;
    if (!got) { toast("This image doesn't contain floor plan edits. Export one with “Include edit data” turned on.", { kind: "error" }); return; }
    commit(got); setSel([]);
    toast(`Restored ${got.filter((s) => s.type !== "group").length} shapes. Save to keep them.`);
  };

  // ------------------------------------------------ pointer handling
  const frac = (e: { clientX: number; clientY: number }): Pt => {
    const r = box.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const clamp01 = (p: Pt): Pt => [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))];
  const hitShape = (t: EventTarget | null) => (t as Element | null)?.closest?.("[data-sid]")?.getAttribute("data-sid") ?? null;
  const newShape = (type: Shape["type"], p: Pt): Shape => {
    const st = { stroke: style.stroke, stroke_width: style.stroke_width };
    if (type === "rect" || type === "ellipse") return { id: newId(), type, x: p[0], y: p[1], w: 0, h: 0, ...st, fill: style.fill, fill_opacity: style.fill_opacity };
    if (type === "text") return { id: newId(), type, x: p[0], y: p[1], w: 0, h: 0, text: "Text", stroke: style.stroke, font_size: style.font_size };
    return { id: newId(), type, points: [p, p], ...st };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!editing || e.button !== 0) return;
    setMenu(null);
    const p = frac(e);
    const target = e.target as Element;
    if (target.closest(".plan-pin")) return;
    if (tool === "pin") { setPinDraft({ x: clamp01(p)[0], y: clamp01(p)[1] }); return; }
    if (tool === "polygon") return; // handled on click
    if (tool === "text") {
      e.preventDefault(); // keep focus for the text box
      const s = newShape("text", p);
      commit([...shapes, s]); setSel([s.id]); setTool("select"); setFocusText(s.id);
      return;
    }
    box.current!.setPointerCapture(e.pointerId);
    if (tool !== "select") {
      const s = newShape(tool, p);
      setShapes([...shapes, s]); setSel([s.id]);
      setDrag({ kind: "draw", id: s.id, start: p, before: shapes });
      return;
    }
    const handle = target.closest("[data-handle]")?.getAttribute("data-handle");
    if (handle && selBox) {
      if (handle.startsWith("v")) setDrag({ kind: "vertex", id: sel[0], index: Number(handle.slice(1)), before: shapes });
      else setDrag({ kind: "scale", corner: Number(handle), box: selBox, before: shapes, ids: selLeaves });
      return;
    }
    const sid = hitShape(target);
    if (sid) {
      const top = topOf(sid, par);
      let next = sel;
      if (e.shiftKey) next = sel.includes(top) ? sel.filter((x) => x !== top) : [...sel, top];
      else if (!sel.includes(top)) next = [top];
      setSel(next);
      setDrag({ kind: "move", start: p, before: shapes, ids: leaves(next, byId), moved: false });
      return;
    }
    if (!e.shiftKey) setSel([]);
    setDrag({ kind: "marquee", start: p, cur: p, add: e.shiftKey });
  };
  const onMove = (e: React.PointerEvent) => {
    const p = frac(e);
    if (poly) { setPoly({ ...poly, hover: p }); }
    if (!drag) return;
    if (drag.kind === "pin") { setPinMoves((m) => ({ ...m, [drag.id]: clamp01(p) })); setDrag({ ...drag, moved: true }); return; }
    if (drag.kind === "marquee") { setDrag({ ...drag, cur: p }); return; }
    if (drag.kind === "move") {
      const dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
      if (!drag.moved && Math.hypot(dx * boxW, dy * boxW * aspect) < 3) return;
      setShapes(updateLeaves(drag.ids, (s) => translate(s, dx, dy), drag.before));
      if (!drag.moved) setDrag({ ...drag, moved: true });
      return;
    }
    if (drag.kind === "draw") {
      setShapes(drag.before.concat([(() => {
        const s = shapes.find((x) => x.id === drag.id)!;
        if (s.type === "rect" || s.type === "ellipse") {
          let [x0, y0] = drag.start, x1 = p[0], y1 = p[1];
          if (e.shiftKey) { const d = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0) / aspect); x1 = x0 + Math.sign(x1 - x0 || 1) * d; y1 = y0 + Math.sign(y1 - y0 || 1) * d * aspect; }
          [x0, x1] = [Math.min(x0, x1), Math.max(x0, x1)]; [y0, y1] = [Math.min(y0, y1), Math.max(y0, y1)];
          return { ...s, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }
        if (s.type === "freehand") {
          const last = s.points![s.points!.length - 1];
          return Math.hypot((p[0] - last[0]) * boxW, (p[1] - last[1]) * boxW * aspect) > 3 && s.points!.length < 1000 ? { ...s, points: [...s.points!, p] } : s;
        }
        return { ...s, points: [drag.start, p] };
      })()]));
      return;
    }
    if (drag.kind === "vertex") {
      setShapes(drag.before.map((s) => (s.id === drag.id && s.points ? { ...s, points: s.points.map((q, i) => (i === drag.index ? p : q)) } : s)));
      return;
    }
    if (drag.kind === "scale") {
      const b = drag.box;
      const ox = drag.corner === 0 || drag.corner === 3 ? b.x + b.w : b.x;
      const oy = drag.corner === 0 || drag.corner === 1 ? b.y + b.h : b.y;
      const cx = drag.corner === 0 || drag.corner === 3 ? b.x : b.x + b.w;
      const cy = drag.corner === 0 || drag.corner === 1 ? b.y : b.y + b.h;
      let sx = b.w ? (p[0] - ox) / (cx - ox) : 1, sy = b.h ? (p[1] - oy) / (cy - oy) : 1;
      if (e.shiftKey || drag.ids.some((id) => byId.get(id)?.type === "text")) { const k = Math.max(Math.abs(sx), Math.abs(sy)); sx = Math.sign(sx || 1) * k; sy = Math.sign(sy || 1) * k; }
      setShapes(updateLeaves(drag.ids, (s) => scale(s, ox, oy, sx, sy), drag.before));
    }
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === "pin") { const at = pinMoves[d.id]; if (d.moved && at) movePin.mutate({ id: d.id, x: at[0], y: at[1] }); return; }
    if (d.kind === "marquee") {
      const m: Box = { x: Math.min(d.start[0], d.cur[0]), y: Math.min(d.start[1], d.cur[1]), w: Math.abs(d.cur[0] - d.start[0]), h: Math.abs(d.cur[1] - d.start[1]) };
      if (m.w * boxW < 4 && m.h * boxW * aspect < 4) return;
      const hit = new Set<string>();
      for (const s of shapes) if (s.type !== "group" && intersects(m, bbox(s, aspect))) hit.add(topOf(s.id, par));
      setSel(d.add ? [...new Set([...sel, ...hit])] : [...hit]);
      return;
    }
    if (d.kind === "draw") {
      const s = shapes.find((x) => x.id === d.id);
      const b = s ? bbox(s, aspect) : null;
      if (!s || !b || (b.w * boxW < 4 && b.h * boxW * aspect < 4)) { setShapes(d.before); setSel([]); return; } // a click, not a drag
      commit(shapes, d.before);
      return;
    }
    if (d.kind === "move" && !d.moved) return;
    if (JSON.stringify(shapes) !== JSON.stringify(d.before)) commit(shapes, d.before);
  };
  const onClick = (e: React.MouseEvent) => {
    if (!editing || tool !== "polygon") return;
    const p = frac(e);
    if (poly && poly.pts.length >= 3) {
      const [fx, fy] = poly.pts[0];
      if (Math.hypot((p[0] - fx) * boxW, (p[1] - fy) * boxW * aspect) < 12) { finishPoly(); return; }
    }
    setPoly({ pts: [...(poly?.pts ?? []), p], hover: p });
  };
  const finishPoly = (pts = poly?.pts ?? []) => {
    const clean = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 0.0005);
    setPoly(null);
    if (clean.length < 3) return;
    const s: Shape = { id: newId(), type: "polygon", points: clean, stroke: style.stroke, stroke_width: style.stroke_width, fill: style.fill, fill_opacity: style.fill_opacity };
    commit([...shapes, s]); setSel([s.id]);
  };
  const onContext = (e: React.MouseEvent) => {
    if (!editing) return;
    const sid = hitShape(e.target);
    if (!sid) return;
    e.preventDefault();
    const top = topOf(sid, par);
    if (!sel.includes(top)) setSel([top]);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // ------------------------------------------------ keyboard
  const modalOpen = !!(pinDraft || binding || askClose);
  const tryClose = useCallback(() => { if (dirty) setAskClose("close"); else onClose(); }, [dirty, onClose]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (modalOpen || e.defaultPrevented) return;
      const typing = !!(e.target as HTMLElement).closest?.("input,textarea,select,[contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        e.preventDefault();
        if (menu) setMenu(null);
        else if (poly) setPoly(null);
        else if (typing) (e.target as HTMLElement).blur();
        else if (editing && sel.length) setSel([]);
        else if (editing && tool !== "select") setTool("select");
        else tryClose();
        return;
      }
      if (typing || !editing) return;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === "g") { e.preventDefault(); if (e.shiftKey) ungroup(); else merge(); return; }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) save.mutate(); return; }
      if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); setSel([...new Set(shapes.filter((s) => s.type !== "group").map((s) => topOf(s.id, par)))]); return; }
      if (e.key === "Enter" && poly) { e.preventDefault(); finishPoly(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && sel.length) { e.preventDefault(); remove(); return; }
      const step = e.shiftKey ? 0.01 : 0.002;
      const arrows: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (arrows[e.key] && sel.length) { e.preventDefault(); nudge(...arrows[e.key]); return; }
      if (!mod && !e.altKey) {
        const t = TOOLS.find((x) => x.key === e.key.toUpperCase());
        if (t) { e.preventDefault(); setTool(t.id); setPoly(null); }
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  // ctrl/⌘ + wheel zooms
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const w = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setZoom((z) => Math.min(6, Math.max(1, z * Math.exp(-e.deltaY * 0.002)))); };
    el.addEventListener("wheel", w, { passive: false });
    return () => el.removeEventListener("wheel", w);
  }, []);

  const openLink = (s: Shape) => {
    if (editing) return;
    onClose();
    nav(s.location_id ? `/locations/${s.location_id}` : `/assets/${s.asset_id}`);
  };
  const pins = plan.pins.map((p) => ({ ...p, ...(pinMoves[p.id] ? { x: pinMoves[p.id][0], y: pinMoves[p.id][1] } : {}) }));
  const marquee = drag?.kind === "marquee" ? { x: Math.min(drag.start[0], drag.cur[0]), y: Math.min(drag.start[1], drag.cur[1]), w: Math.abs(drag.cur[0] - drag.start[0]), h: Math.abs(drag.cur[1] - drag.start[1]) } : null;
  const selLink = single && (single.location_id || single.asset_id) ? single : null;

  return createPortal(
    <div className={"viewer fp" + (editing ? " editing" : "")} role="dialog" aria-modal="true" aria-label={`Floor plan: ${plan.name}`}>
      <div className="viewer-bar">
        <span className="viewer-name" title={plan.name}>{plan.name}</span>
        {editing && dirty && <span className="viewer-count">Unsaved changes</span>}
        <span className="grow" />
        {editing ? <>
          <input ref={importIn} type="file" accept="image/png" hidden onChange={(e) => { void importPng(e.target.files?.[0]); e.target.value = ""; }} />
          <Button size="sm" className="viewer-btn" onClick={() => importIn.current?.click()} title="Restore edits from a PNG exported with edit data"><Upload size={15} /><span className="desktop-only">Import</span></Button>
          <Button size="sm" className="viewer-btn" onClick={() => (dirty ? setAskClose("view") : setEditing(false))}>Done</Button>
          <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}><Save size={15} />{save.isPending ? "Saving…" : "Save"}</Button>
        </> : editable && <Button size="sm" className="viewer-btn" onClick={() => { setEditing(true); setTool("select"); }}><Pencil size={15} />Edit</Button>}
        <Dropdown width={260} trigger={(_, t) => <Button size="sm" className="viewer-btn" onClick={t} aria-label="Export PNG"><Download size={15} /><span className="desktop-only">Export</span></Button>}>
          {(close) => <div className="stack" style={{ padding: 12, gap: 10 }}>
            <Checkbox checked={withData} onChange={setWithData} label="Include edit data" />
            <div className="small muted">Stores the drawing inside the PNG so it can be imported again to restore the edits.</div>
            <Button variant="primary" size="sm" onClick={() => { close(); void exportPng(); }} disabled={!natural}><Download size={14} />Download PNG</Button>
          </div>}
        </Dropdown>
        <button type="button" className="viewer-x" aria-label="Close floor plan" onClick={tryClose}><X size={20} /></button>
      </div>
      {conflict && <div className="fp-banner" role="alert">Someone else changed this floor plan's drawing. Reload to see their changes (your unsaved edits will be lost).
        <Button size="sm" onClick={() => void reload()}>Reload</Button><Button size="sm" variant="ghost" onClick={() => setConflict(false)}>Dismiss</Button></div>}
      {editing && (
        <div className="fp-tools" role="toolbar" aria-label="Drawing tools">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" className={"fp-tool" + (tool === t.id ? " on" : "")} aria-pressed={tool === t.id} title={`${t.label} (${t.key})`} aria-label={t.label}
              onClick={() => { setTool(t.id); setPoly(null); }}>{t.icon}</button>))}
          <span className="fp-sep" />
          <button type="button" className="fp-tool" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!past.length} onClick={undo}><Undo2 size={17} /></button>
          <button type="button" className="fp-tool" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!future.length} onClick={redo}><Redo2 size={17} /></button>
          <button type="button" className="fp-tool" title="Merge into group (Ctrl+G)" aria-label="Merge into group" disabled={sel.length < 2} onClick={merge}><Group size={17} /></button>
          <button type="button" className="fp-tool" title="Ungroup (Ctrl+Shift+G)" aria-label="Ungroup" disabled={!sel.some((id) => byId.get(id)?.type === "group")} onClick={ungroup}><Ungroup size={17} /></button>
          <button type="button" className="fp-tool" title="Delete (Del)" aria-label="Delete selected" disabled={!sel.length} onClick={() => remove()}><Trash2 size={17} /></button>
        </div>)}
      <div className="fp-main">
        <div className="fp-stage" ref={stage}>
          <div ref={box} className={"fp-box plan-box" + (editing ? " editing tool-" + tool : "")} style={{ width: boxW } as CSSProperties}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClick={onClick}
            onDoubleClick={(e) => { if (poly) { e.preventDefault(); finishPoly(poly.pts.slice(0, -1)); } }} onContextMenu={onContext}>
            <img ref={img} src={plan.url} alt={`Floor plan: ${plan.name}`} draggable={false} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
            {editing ? (
              <svg className="plan-svg editing" viewBox={`0 0 ${UNITS} ${H}`} preserveAspectRatio="none">
                {shapes.map((s) => s.type === "group" ? null : <g key={s.id} data-sid={s.id} className="fp-shape"><ShapeSvg s={s} aspect={aspect} hit /></g>)}
                {poly && <polyline points={[...poly.pts, ...(poly.hover ? [poly.hover] : [])].map(([x, y]) => `${x * UNITS},${y * H}`).join(" ")}
                  fill={style.fill === "none" ? "none" : style.fill} fillOpacity={style.fill_opacity} stroke={style.stroke} strokeWidth={style.stroke_width} strokeDasharray={`${6 / unitPx} ${4 / unitPx}`} />}
                {poly?.pts.map(([x, y], i) => <circle key={i} cx={x * UNITS} cy={y * H} r={(i === 0 ? 6 : 4) / unitPx} fill="#fff" stroke={style.stroke} strokeWidth={1.5 / unitPx} />)}
                {selLeaves.length > 1 && selLeaves.map((id) => { const b = bbox(byId.get(id)!, aspect); return <rect key={id} className="fp-sel-part" x={b.x * UNITS} y={b.y * H} width={b.w * UNITS} height={b.h * H} strokeWidth={1 / unitPx} />; })}
                {selBox && !drag?.kind.match(/draw/) && <>
                  <rect className="fp-sel" x={selBox.x * UNITS - 4 / unitPx} y={selBox.y * H - 4 / unitPx} width={selBox.w * UNITS + 8 / unitPx} height={selBox.h * H + 8 / unitPx}
                    strokeWidth={1.5 / unitPx} strokeDasharray={`${5 / unitPx} ${4 / unitPx}`} />
                  {single?.points && single.type !== "freehand" ? single.points.map(([x, y], i) => (
                    <circle key={i} data-handle={`v${i}`} className="fp-handle" cx={x * UNITS} cy={y * H} r={hs * 0.6} strokeWidth={1.5 / unitPx} />))
                    : [[selBox.x, selBox.y], [selBox.x + selBox.w, selBox.y], [selBox.x + selBox.w, selBox.y + selBox.h], [selBox.x, selBox.y + selBox.h]].map(([x, y], i) => (
                      <rect key={i} data-handle={String(i)} className={"fp-handle c" + i} x={x * UNITS - hs / 2} y={y * H - hs / 2} width={hs} height={hs} strokeWidth={1.5 / unitPx} />))}
                </>}
                {marquee && <rect className="fp-marquee" x={marquee.x * UNITS} y={marquee.y * H} width={marquee.w * UNITS} height={marquee.h * H} strokeWidth={1 / unitPx} />}
              </svg>
            ) : <PlanShapes shapes={shapes} aspect={aspect} onOpen={openLink} />}
            {pins.map((p) => (
              <PinButton key={p.id} p={p} editing={editing && tool === "select"}
                onDown={(e) => { e.stopPropagation(); box.current!.setPointerCapture(e.pointerId); setDrag({ kind: "pin", id: p.id, at: [p.x, p.y], moved: false }); }}
                onOpen={() => { if (!editing && p.asset_id) { onClose(); nav(`/assets/${p.asset_id}`); } }}
                onDelete={() => delPin.mutate(p.id)} />))}
          </div>
        </div>
        {editing && (
          <aside className="fp-panel" aria-label="Shape options">
            <div className="fp-panel-h">{sel.length ? (single ? SHAPE_NAME[single.type] : `${sel.length} items`) : "New shapes"}</div>
            <div className="fp-row col"><span className="fp-lbl">Colour</span>
              <Swatches value={single?.stroke ?? style.stroke} onPick={(c) => applyStyle({ stroke: c })} label="Line colour" /></div>
            {(!single || isClosed(single) || single.type === "group") && <div className="fp-row col"><span className="fp-lbl">Fill</span>
              <Swatches value={single?.fill ?? style.fill} onPick={(c) => applyStyle({ fill: c })} none label="Fill colour" /></div>}
            {(!single || single.type !== "text") && <label className="fp-row"><span className="fp-lbl">Line</span>
              <input type="range" min={0} max={20} step={1} value={single?.stroke_width ?? style.stroke_width} onChange={(e) => applyStyle({ stroke_width: Number(e.target.value) })} aria-label="Line width" />
              <span className="small tnum">{single?.stroke_width ?? style.stroke_width}</span></label>}
            {(!single || isClosed(single) || single.type === "group") && <label className="fp-row"><span className="fp-lbl">Opacity</span>
              <input type="range" min={0} max={1} step={0.05} value={single?.fill_opacity ?? style.fill_opacity} onChange={(e) => applyStyle({ fill_opacity: Number(e.target.value) })} aria-label="Fill opacity" />
              <span className="small tnum">{Math.round((single?.fill_opacity ?? style.fill_opacity) * 100)}%</span></label>}
            {(!single || single.type === "text") && <label className="fp-row"><span className="fp-lbl">Text size</span>
              <input type="range" min={8} max={120} step={1} value={single?.font_size ?? style.font_size} onChange={(e) => applyStyle({ font_size: Number(e.target.value) })} aria-label="Text size" />
              <span className="small tnum">{single?.font_size ?? style.font_size}</span></label>}
            {single?.type === "text" && <Field label="Text">{(id) => <textarea ref={textRef} id={id} className="input" rows={2} maxLength={500} value={single.text ?? ""}
              onChange={(e) => setShapes(shapes.map((s) => (s.id === single.id ? { ...s, text: e.target.value } : s)))}
              onFocus={() => setPast((p) => [...p.slice(-99), shapes])} />}</Field>}
            {sel.length > 0 && <>
              {single && <Field label="Label" hint="Shown when people hover or tap it.">{(id) => <Input id={id} value={single.label ?? ""} maxLength={120}
                onChange={(e) => setShapes(shapes.map((s) => (s.id === single.id ? { ...s, label: e.target.value } : s)))} onFocus={() => setPast((p) => [...p.slice(-99), shapes])} />}</Field>}
              {single && <div className="fp-link">
                {selLink ? <span className="row small" style={{ gap: 6 }}><Link2 size={14} />{selLink.location_id ? "Opens a location" : "Opens an asset"}
                  <Button size="sm" variant="ghost" onClick={() => setProp({ location_id: undefined, asset_id: undefined }, true)}>Remove link</Button></span>
                  : <span className="small muted">Not linked.</span>}
                <div className="row" style={{ gap: 6 }}><Button size="sm" onClick={() => setBinding("location")}><MapPin size={14} />Bind to location…</Button>
                  <Button size="sm" onClick={() => setBinding("asset")}>Link to asset…</Button></div>
              </div>}
              <div className="row wrap" style={{ gap: 6 }}>
                <Button size="sm" onClick={() => order(true)}>Bring to front</Button><Button size="sm" onClick={() => order(false)}>Send to back</Button>
                {sel.length > 1 && <Button size="sm" onClick={merge}><Group size={14} />Merge</Button>}
              </div>
            </>}
            <p className="small muted fp-help">{HELP[tool]}</p>
          </aside>)}
        <div className="fp-zoom viewer-zoom-ctl">
          <Button size="sm" icon aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(1, z / 1.25))} disabled={zoom <= 1}><Minus size={16} /></Button>
          <span className="small tnum">{Math.round(zoom * 100)}%</span>
          <Button size="sm" icon aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(6, z * 1.25))} disabled={zoom >= 6}><Plus size={16} /></Button>
          <Button size="sm" icon aria-label="Fit to screen" onClick={() => setZoom(1)}><Maximize size={15} /></Button>
        </div>
      </div>
      {menu && (
        <div className="menu fp-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 320) }} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); setBinding("location"); }}><MapPin size={14} />Bind to location…</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); setBinding("asset"); }}><Link2 size={14} />Link to asset…</button>
          {sel.length > 1 && <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); merge(); }}><Group size={14} />Merge into group</button>}
          {sel.some((id) => byId.get(id)?.type === "group") && <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); ungroup(); }}><Ungroup size={14} />Ungroup</button>}
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); order(true); }}>Bring to front</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(null); order(false); }}>Send to back</button>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item danger" onClick={() => { setMenu(null); remove(); }}><Trash2 size={14} />Delete</button>
        </div>)}
      {menu && <div className="fp-menu-away" onPointerDown={() => setMenu(null)} />}
      {pinDraft && <AddPin base={base} at={pinDraft} onClose={() => setPinDraft(null)} onDone={() => { setPinDraft(null); onChanged(); toast("Pin added"); }} />}
      {binding && <BindDialog kind={binding} current={sel.length === 1 ? byId.get(sel[0]) ?? null : null} count={sel.length} onClose={() => setBinding(null)}
        onPick={(id, label) => {
          setBinding(null);
          if (!sel.length) return;
          // several separate shapes → merge them first so one link covers them all
          if (sel.length > 1) {
            const g: Shape = { id: newId(), type: "group", children: [...sel], label, ...(binding === "location" ? { location_id: id } : { asset_id: id }) };
            commit([...shapes, g]); setSel([g.id]);
          } else commit(updateLeaves(sel, (s) => ({ ...s, label: s.label || label, location_id: binding === "location" ? id : undefined, asset_id: binding === "asset" ? id : undefined })));
        }} />}
      {askClose && <Modal title="Discard unsaved changes?" onClose={() => setAskClose(null)} footer={<>
        <Button onClick={() => setAskClose(null)}>Keep editing</Button>
        <Button variant="danger" onClick={() => { const a = askClose; setAskClose(null); setShapes(saved.shapes); setPast([]); setFuture([]); setSel([]); if (a === "close") onClose(); else setEditing(false); }}>Discard</Button>
        <Button variant="primary" onClick={() => { const a = askClose; setAskClose(null); save.mutate(undefined, { onSuccess: () => { if (a === "close") onClose(); else setEditing(false); } }); }}>Save</Button></>}>
        <p>Your drawing on {plan.name} has changes that aren't saved.</p></Modal>}
    </div>,
    document.body,
  );
}

const SHAPE_NAME: Record<ShapeType, string> = { rect: "Rectangle", ellipse: "Ellipse", polygon: "Polygon", line: "Line", arrow: "Arrow", freehand: "Freehand", text: "Text", group: "Group" };
const HELP: Record<Tool, string> = {
  select: "Click to select, Shift+click to add, drag an empty area to select several. Right-click a shape to bind it to a location.",
  rect: "Drag to draw a rectangle. Hold Shift for a square.", ellipse: "Drag to draw an ellipse. Hold Shift for a circle.",
  polygon: "Click to add corners. Click the first point, double-click or press Enter to finish; Esc cancels.",
  line: "Drag to draw a line.", arrow: "Drag to draw an arrow.", freehand: "Drag to draw freely.", text: "Click where the text should go, then type it here.",
  pin: "Click the plan to pin an asset or a label.",
};

function Swatches({ value, onPick, none, label }: { value: string; onPick: (c: string) => void; none?: boolean; label: string }) {
  return <span className="fp-swatches"><ColorPicker value={value} onChange={onPick} presets={PALETTE} allowNone={none} label={label} size="sm" /></span>;
}

function PinButton({ p, editing, onDown, onOpen, onDelete }: { p: FloorPlanPin; editing: boolean; onDown: (e: React.PointerEvent) => void; onOpen: () => void; onDelete: () => void }) {
  return (
    <button type="button" className={"plan-pin" + (p.asset_status ? " " + p.asset_status : "") + (editing ? " grab" : "")} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
      title={p.label} aria-label={`${p.label}${p.asset_id ? " (asset)" : ""}`}
      onPointerDown={editing ? onDown : (e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onOpen(); }}
      onKeyDown={(e) => { if (editing && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); e.stopPropagation(); onDelete(); } }}>
      <MapPin size={22} /><span className="plan-pin-label">{p.label}</span>
    </button>
  );
}

function BindDialog({ kind, current, count, onClose, onPick }: { kind: "location" | "asset"; current: Shape | null; count: number; onClose: () => void; onPick: (id: string, label: string) => void }) {
  const [loc, setLoc] = useState<string | null>(current?.location_id ?? null);
  const [asset, setAsset] = useState<string[]>(current?.asset_id ? [current.asset_id] : []);
  const [label, setLabel] = useState(current?.label ?? "");
  const id = kind === "location" ? loc : asset[0];
  return (
    <Modal title={kind === "location" ? "Bind to location" : "Link to asset"} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!id} onClick={() => id && onPick(id, label.trim())}>{kind === "location" ? "Bind" : "Link"}</Button></>}>
      <p className="small muted" style={{ marginTop: 0 }}>Clicking {count > 1 ? `these ${count} shapes (they'll be merged into a group)` : "this shape"} will open the {kind}.</p>
      {kind === "location" ? <Field label="Location">{(fid) => <LocationPicker id={fid} value={loc} onChange={setLoc} />}</Field>
        : <Field label="Asset">{(fid) => <AssetPicker id={fid} value={asset} onChange={setAsset} />}</Field>}
      <Field label="Label" hint="Optional. Shown when people hover or tap it, e.g. “Boiler room”.">{(fid) => <Input id={fid} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />}</Field>
    </Modal>
  );
}

export function AddPin({ base, at, onClose, onDone }: { base: string; at: { x: number; y: number }; onClose: () => void; onDone: () => void }) {
  const [asset, setAsset] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");
  const m = useMutation({ mutationFn: () => api(`${base}/pins`, { method: "POST", body: { ...at, asset_id: asset[0] ?? null, label } }), onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title="Add a pin" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={(!asset.length && !label.trim()) || m.isPending} onClick={() => m.mutate()}>Add pin</Button></>}>
      <Field label="Asset">{(id) => <AssetPicker id={id} value={asset} onChange={setAsset} placeholder="Pick an asset" />}</Field>
      <Field label="Label" hint="Optional for assets. Use a label alone for things like an exit or an electrical panel.">{(id) => <Input id={id} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />}</Field>
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}
