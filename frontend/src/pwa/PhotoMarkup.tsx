// Camera capture and photo mark-up (0.6.0, r067/r315): take a photo on the phone, draw arrows, circles, lines and
// text on it, and attach the marked-up copy. The original is kept (attached too, unless the person unticks it).
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { ArrowUpRight, Camera, Circle, Pencil, Type, Undo2 } from "lucide-react";
import { Button, Checkbox, Modal } from "../components/ui";

type Pt = { x: number; y: number };
type Shape = { kind: "pen"; color: string; w: number; pts: Pt[] } | { kind: "arrow"; color: string; w: number; a: Pt; b: Pt } | { kind: "circle"; color: string; w: number; a: Pt; b: Pt }
  | { kind: "text"; color: string; w: number; at: Pt; text: string };
type Tool = "arrow" | "circle" | "pen" | "text";
const MAX_SIDE = 2000;
// mark-up colours come from the design tokens so they read well in both themes (G-17)
const COLOR_TOKENS = ["--c-danger", "--c-warning", "--c-success", "--c-info", "--c-text", "--c-panel"];

function tokenColor(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "red"; }

function draw(ctx: CanvasRenderingContext2D, img: HTMLImageElement, shapes: Shape[]) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const s of shapes) {
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.w;
    if (s.kind === "pen") {
      ctx.beginPath(); s.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    } else if (s.kind === "circle") {
      ctx.beginPath();
      ctx.ellipse((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2, Math.abs(s.b.x - s.a.x) / 2 || 1, Math.abs(s.b.y - s.a.y) / 2 || 1, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.kind === "arrow") {
      const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x), head = s.w * 4;
      ctx.beginPath(); ctx.moveTo(s.a.x, s.a.y); ctx.lineTo(s.b.x, s.b.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s.b.x, s.b.y);
      ctx.lineTo(s.b.x - head * Math.cos(ang - 0.45), s.b.y - head * Math.sin(ang - 0.45));
      ctx.lineTo(s.b.x - head * Math.cos(ang + 0.45), s.b.y - head * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
    } else {
      ctx.font = `600 ${s.w * 7}px system-ui, sans-serif`; ctx.textBaseline = "top";
      ctx.lineWidth = Math.max(2, s.w * 0.9); ctx.strokeStyle = s.color === tokenColor("--c-panel") ? tokenColor("--c-text") : tokenColor("--c-panel");
      ctx.strokeText(s.text, s.at.x, s.at.y); ctx.fillText(s.text, s.at.x, s.at.y);
    }
  }
}

/** Mark up one photo. `onSave(markedUp, keepOriginal)` gets a JPEG of the photo with the drawing. */
export function PhotoMarkup({ src, name, onSave, onClose, offerOriginal = false }: { src: string | Blob; name: string; offerOriginal?: boolean;
  onSave: (file: File, keepOriginal: boolean) => void | Promise<void>; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>("arrow");
  const colors = useMemo(() => COLOR_TOKENS.map(tokenColor), []);
  const [color, setColor] = useState(colors[0]);
  const [typing, setTyping] = useState<{ at: Pt; css: Pt; text: string } | null>(null);
  const [keep, setKeep] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const url = typeof src === "string" ? src : URL.createObjectURL(src);
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setFailed(true);
    i.src = url;
    return () => { if (typeof src !== "string") URL.revokeObjectURL(url); };
  }, [src]);

  useEffect(() => {
    if (!img || !canvas.current) return;
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.current.width = Math.round(img.naturalWidth * k); canvas.current.height = Math.round(img.naturalHeight * k);
  }, [img]);
  const lineW = img ? Math.max(3, Math.round(Math.max(canvas.current?.width ?? 800, canvas.current?.height ?? 800) / 220)) : 4;
  useEffect(() => { const ctx = canvas.current?.getContext("2d"); if (ctx && img) draw(ctx, img, draft ? [...shapes, draft] : shapes); }, [img, shapes, draft]);

  const pos = (e: RPointerEvent<HTMLCanvasElement>): { p: Pt; css: Pt } => {
    const r = e.currentTarget.getBoundingClientRect();
    const css = { x: e.clientX - r.left, y: e.clientY - r.top };
    return { p: { x: (css.x / r.width) * e.currentTarget.width, y: (css.y / r.height) * e.currentTarget.height }, css };
  };
  const down = (e: RPointerEvent<HTMLCanvasElement>) => {
    const { p, css } = pos(e);
    if (tool === "text") { setTyping({ at: p, css, text: "" }); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft(tool === "pen" ? { kind: "pen", color, w: lineW, pts: [p] } : { kind: tool, color, w: lineW, a: p, b: p });
  };
  const move = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const { p } = pos(e);
    setDraft(draft.kind === "pen" ? { ...draft, pts: [...draft.pts, p] } : draft.kind === "text" ? draft : { ...draft, b: p });
  };
  const up = () => {
    if (!draft) return;
    const tiny = draft.kind !== "pen" && draft.kind !== "text" && Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y) < lineW * 2;
    if (!tiny) setShapes((s) => [...s, draft]);
    setDraft(null);
  };
  const commitText = () => {
    if (typing?.text.trim()) setShapes((s) => [...s, { kind: "text", color, w: lineW, at: typing.at, text: typing.text.trim() }]);
    setTyping(null);
  };
  const save = async () => {
    if (!canvas.current) return;
    setSaving(true);
    try {
      if (!shapes.length && typeof src !== "string") { // nothing drawn: attach the photo as it is
        await onSave(src instanceof File ? src : new File([src], name, { type: src.type || "image/jpeg" }), false);
        return;
      }
      const blob = await new Promise<Blob | null>((res) => canvas.current!.toBlob(res, "image/jpeg", 0.9));
      if (!blob) return;
      const base = name.replace(/\.[a-z0-9]+$/i, "");
      await onSave(new File([blob], `${base} (marked up).jpg`, { type: "image/jpeg" }), offerOriginal && keep);
    } finally { setSaving(false); }
  };
  const tools: [Tool, string, typeof Pencil][] = [["arrow", "Arrow", ArrowUpRight], ["circle", "Circle", Circle], ["pen", "Draw", Pencil], ["text", "Text", Type]];
  return (
    <Modal title="Mark up photo" onClose={onClose} width={900}
      footer={<>{offerOriginal && <span className="grow"><Checkbox checked={keep} onChange={setKeep} label="Also attach the original" /></span>}
        <Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()} disabled={!img || saving}>{saving ? "Saving…" : "Attach"}</Button></>}>
      {failed ? <p className="muted">This picture couldn't be opened for mark-up.</p> : (
        <div className="annot">
          <div className="annot-tools" role="toolbar" aria-label="Mark-up tools">
            {tools.map(([k, l, Icon]) => <Button key={k} size="sm" className={tool === k ? "on" : ""} aria-pressed={tool === k} onClick={() => setTool(k)}><Icon size={16} />{l}</Button>)}
            <span className="grow" />
            {colors.map((c, i) => <button key={i} type="button" className={"annot-swatch" + (c === color ? " on" : "")} style={{ background: c }}
              aria-label={`Colour ${i + 1}`} aria-pressed={c === color} onClick={() => setColor(c)} />)}
            <Button size="sm" variant="ghost" icon aria-label="Undo" disabled={!shapes.length} onClick={() => setShapes((s) => s.slice(0, -1))}><Undo2 size={16} /></Button>
          </div>
          <div className="annot-stage">
            <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="Photo to mark up" />
            {typing && <input className="input annot-text" autoFocus value={typing.text} placeholder="Type, then Enter"
              style={{ left: typing.css.x, top: typing.css.y }} onChange={(e) => setTyping({ ...typing, text: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") commitText(); if (e.key === "Escape") setTyping(null); }} onBlur={commitText} />}
          </div>
          <p className="small muted" style={{ margin: 0 }}>Drag on the photo to draw. Pick Text, then tap where the words go.</p>
        </div>)}
    </Modal>);
}

/** "Take photo" on phones: opens the camera, then lets the person mark the photo up before it's attached. */
export function CameraButton({ onFiles, disabled }: { onFiles: (files: File[]) => void | Promise<void>; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [shot, setShot] = useState<File | null>(null);
  return <>
    <Button size="sm" variant="ghost" className="mobile-only" disabled={disabled} onClick={() => input.current?.click()}><Camera size={14} />Take photo</Button>
    <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setShot(f); }} />
    {shot && <PhotoMarkup src={shot} name={shot.name || "photo.jpg"} offerOriginal onClose={() => setShot(null)}
      onSave={async (marked, keepOriginal) => { const f = shot; setShot(null); await onFiles(keepOriginal ? [f, marked] : [marked]); }} />}
  </>;
}
