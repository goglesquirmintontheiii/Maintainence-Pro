// In-page file viewer (MP-107): large previews on a dark backdrop, zoom and pan, next/previous, and in-page
// previews for videos, audio, PDFs, text, spreadsheets, Word documents and Photoshop files. Never navigates
// to the raw file; Download is a button.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, FileText, Minus, Plus, RotateCcw, X } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "./ui";
import "../styles/viewer.css";

export type ViewerFile = { id: string; name: string; url: string; thumb_url?: string | null; content_type?: string; is_image?: boolean; size?: number };

type Preview = {
  id: string; name: string; content_type: string; size: number;
  kind: "image" | "video" | "audio" | "pdf" | "text" | "table" | "html" | "pending" | "none";
  url?: string; text?: string; html?: string; truncated?: boolean; reason?: string;
  sheets?: { name: string; rows: string[][] }[];
};

export function FileViewer({ files, index, onClose, actions }: {
  files: ViewerFile[]; index: number; onClose: () => void; actions?: (f: ViewerFile) => ReactNode;
}) {
  const [i, setI] = useState(() => Math.min(Math.max(index, 0), files.length - 1));
  const f = files[i];
  const go = useCallback((d: number) => setI((x) => (files.length ? (x + d + files.length) % files.length : 0)), [files.length]);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowRight" && files.length > 1 && !(e.target as HTMLElement).closest?.("input,textarea,video,audio")) { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft" && files.length > 1 && !(e.target as HTMLElement).closest?.("input,textarea,video,audio")) { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", k, true); // capture: runs before drawers and dialogs underneath
    panel.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", k, true); document.body.style.overflow = prev; };
  }, [go, onClose, files.length]);
  if (!f) return null;
  const isImage = f.is_image ?? ((f.content_type ?? "").startsWith("image/") && f.content_type !== "image/vnd.adobe.photoshop");
  return createPortal(
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Viewing ${f.name}`} ref={panel} tabIndex={-1}>
      <div className="viewer-bar">
        <span className="viewer-name" title={f.name}>{f.name}</span>
        {files.length > 1 && <span className="viewer-count">{i + 1} / {files.length}</span>}
        <span className="grow" />
        {actions?.(f)}
        <a className="btn sm viewer-btn" href={f.url + (f.url.includes("?") ? "&" : "?") + "download=1"} download={f.name} aria-label={`Download ${f.name}`}>
          <Download size={15} /><span className="desktop-only">Download</span></a>
        <button type="button" className="viewer-x" aria-label="Close viewer" onClick={onClose}><X size={20} /></button>
      </div>
      <div className="viewer-stage">
        {isImage ? <ZoomImage key={f.id} src={f.url} alt={f.name} onSwipe={files.length > 1 ? go : undefined} />
          : <FilePreview key={f.id} file={f} />}
        {files.length > 1 && <>
          <button type="button" className="viewer-nav prev" aria-label="Previous file" onClick={() => go(-1)}><ChevronLeft size={28} /></button>
          <button type="button" className="viewer-nav next" aria-label="Next file" onClick={() => go(1)}><ChevronRight size={28} /></button>
        </>}
      </div>
      {files.length > 1 && files.length <= 40 && (
        <div className="viewer-strip" role="tablist" aria-label="Files">{files.map((x, n) => (
          <button key={x.id} type="button" role="tab" aria-selected={n === i} className={"viewer-chip" + (n === i ? " on" : "")} onClick={() => setI(n)} title={x.name}>
            {x.thumb_url ? <img src={x.thumb_url} alt="" loading="lazy" /> : <FileText size={18} />}
          </button>))}</div>)}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- images: zoom and pan
function ZoomImage({ src, alt, onSwipe }: { src: string; alt: string; onSwipe?: (d: number) => void }) {
  const [t, setT] = useState({ s: 1, x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ t: typeof t; dist: number; mid: { x: number; y: number }; px: number; py: number } | null>(null);
  const clamp = (s: number) => Math.min(8, Math.max(1, s));
  const zoomAt = (ns: number, cx: number, cy: number) => setT((p) => {
    const s = clamp(ns);
    if (s === 1) return { s: 1, x: 0, y: 0 };
    const r = box.current!.getBoundingClientRect();
    const ox = cx - r.left - r.width / 2, oy = cy - r.top - r.height / 2;
    return { s, x: ox - ((ox - p.x) * s) / p.s, y: oy - ((oy - p.y) * s) / p.s };
  });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(t.s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });
  const center = () => { const r = box.current!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  return (
    <div className="viewer-zoom" ref={box}
      onDoubleClick={(e) => (t.s > 1 ? setT({ s: 1, x: 0, y: 0 }) : zoomAt(2.5, e.clientX, e.clientY))}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const ps = [...pointers.current.values()];
        const mid = ps.length === 2 ? { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 } : ps[0];
        start.current = { t, dist: ps.length === 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0, mid, px: e.clientX, py: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId) || !start.current) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const ps = [...pointers.current.values()];
        const st = start.current;
        if (ps.length === 2 && st.dist) {
          const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
          setT(() => {
            const s = clamp(st.t.s * (d / st.dist));
            const r = box.current!.getBoundingClientRect();
            const ox = st.mid.x - r.left - r.width / 2, oy = st.mid.y - r.top - r.height / 2;
            return s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: ox - ((ox - st.t.x) * s) / st.t.s, y: oy - ((oy - st.t.y) * s) / st.t.s };
          });
        } else if (ps.length === 1 && st.t.s > 1) {
          setT({ s: st.t.s, x: st.t.x + (e.clientX - st.px), y: st.t.y + (e.clientY - st.py) });
        }
      }}
      onPointerUp={(e) => {
        const st = start.current;
        pointers.current.delete(e.pointerId);
        if (st && st.t.s === 1 && onSwipe && pointers.current.size === 0) {
          const dx = e.clientX - st.px, dy = e.clientY - st.py;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1);
        }
        start.current = pointers.current.size ? { ...st!, t } : null;
      }}
      onPointerCancel={(e) => { pointers.current.delete(e.pointerId); start.current = null; }}>
      {!loaded && <span className="viewer-spinner" aria-hidden="true" />}
      <img src={src} alt={alt} draggable={false} onLoad={() => setLoaded(true)}
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, cursor: t.s > 1 ? "grab" : "zoom-in", opacity: loaded ? 1 : 0 }} />
      <div className="viewer-zoom-ctl" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <Button size="sm" icon aria-label="Zoom out" onClick={() => { const c = center(); zoomAt(t.s / 1.5, c.x, c.y); }}><Minus size={15} /></Button>
        <span className="small" aria-live="polite">{Math.round(t.s * 100)}%</span>
        <Button size="sm" icon aria-label="Zoom in" onClick={() => { const c = center(); zoomAt(t.s * 1.5, c.x, c.y); }}><Plus size={15} /></Button>
        <Button size="sm" icon aria-label="Fit to screen" onClick={() => setT({ s: 1, x: 0, y: 0 })}><RotateCcw size={14} /></Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- everything else
function FilePreview({ file }: { file: ViewerFile }) {
  const q = useQuery({ queryKey: ["file-preview", file.id], queryFn: () => api<Preview>(`/files/${file.id}/preview`), staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.kind === "pending" ? 3000 : false) });
  const p = q.data;
  if (q.isError) return <Fallback file={file} reason={(q.error as Error).message} />;
  if (!p) return <span className="viewer-spinner" aria-label="Loading preview" />;
  switch (p.kind) {
    case "image": return <ZoomImage src={p.url!} alt={file.name} />;
    case "video": return <video className="viewer-media" src={p.url} controls playsInline preload="metadata" aria-label={file.name} />;
    case "audio": return <div className="viewer-doc viewer-audio"><FileText size={36} /><b>{file.name}</b><audio src={p.url} controls preload="metadata" /></div>;
    case "pdf": return <iframe className="viewer-pdf" src={p.url} title={file.name} />;
    case "text": return <div className="viewer-doc"><pre className="viewer-text">{p.text}</pre>{p.truncated && <Truncated />}</div>;
    case "table": return <SheetPreview sheets={p.sheets ?? []} truncated={!!p.truncated} />;
    case "html": return <div className="viewer-doc"><article className="viewer-docx">{htmlToReact(p.html ?? "")}</article></div>;
    case "pending": return <Fallback file={file} reason="Preparing a preview… This takes a few seconds for Photoshop files." busy />;
    default: return <Fallback file={file} reason={p.reason ?? "This kind of file can't be shown in the browser. Download it to open it."} />;
  }
}

function Truncated() { return <p className="small muted viewer-trunc">Showing the beginning of the file. Download it to see everything.</p>; }

function Fallback({ file, reason, busy }: { file: ViewerFile; reason: string; busy?: boolean }) {
  return (
    <div className="viewer-doc viewer-fallback">
      {busy ? <span className="viewer-spinner" aria-hidden="true" /> : <FileText size={44} />}
      <b>{file.name}</b><p className="muted">{reason}</p>
      {!busy && <a className="btn primary" href={file.url + (file.url.includes("?") ? "&" : "?") + "download=1"} download={file.name}><Download size={15} />Download</a>}
    </div>
  );
}

function SheetPreview({ sheets, truncated }: { sheets: { name: string; rows: string[][] }[]; truncated: boolean }) {
  const [n, setN] = useState(0);
  const sheet = sheets[n] ?? { name: "", rows: [] };
  const cols = Math.max(0, ...sheet.rows.map((r) => r.length));
  return (
    <div className="viewer-doc viewer-sheet">
      {sheets.length > 1 && <div className="seg" role="tablist" aria-label="Sheets">{sheets.map((s, k) => (
        <button key={k} type="button" role="tab" aria-selected={k === n} className={"seg-btn" + (k === n ? " on" : "")} onClick={() => setN(k)}>{s.name || `Sheet ${k + 1}`}</button>))}</div>}
      {sheet.rows.length === 0 ? <p className="muted">This sheet is empty.</p> : (
        <div className="viewer-table-wrap"><table className="viewer-table">
          <tbody>{sheet.rows.map((r, ri) => (
            <tr key={ri} className={ri === 0 ? "head" : ""}>
              <th scope="row" className="rownum">{ri + 1}</th>
              {Array.from({ length: cols }, (_, ci) => <td key={ci}>{r[ci] ?? ""}</td>)}</tr>))}</tbody>
        </table></div>)}
      {truncated && <Truncated />}
    </div>
  );
}

// The server already sanitises Word HTML (nh3). We still build React elements from an allowlist instead of
// injecting markup, so nothing unexpected can run even if the server ever changed.
const TAGS = new Set(["p", "br", "strong", "b", "em", "i", "u", "s", "sub", "sup", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "blockquote", "pre", "code", "img", "a", "hr"]);
function htmlToReact(html: string): ReactNode {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  let key = 0;
  const walk = (node: Node): ReactNode => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    const kids = Array.from(el.childNodes).map(walk);
    if (!TAGS.has(tag)) return <span key={key++}>{kids}</span>;
    const props: Record<string, unknown> = { key: key++ };
    if (tag === "img") {
      const src = el.getAttribute("src") ?? "";
      if (!/^data:image\/(png|jpeg|gif|webp);/i.test(src)) return null;
      return <img key={key++} src={src} alt={el.getAttribute("alt") ?? ""} />;
    }
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:)/i.test(href)) return <span key={key++}>{kids}</span>;
      Object.assign(props, { href, target: "_blank", rel: "noopener noreferrer nofollow" });
    }
    if (tag === "td" || tag === "th") {
      for (const a of ["colspan", "rowspan"]) { const v = Number(el.getAttribute(a)); if (v > 1 && v < 100) props[a === "colspan" ? "colSpan" : "rowSpan"] = v; }
    }
    if (tag === "br" || tag === "hr") { const Void = tag; return <Void key={key++} />; }
    const Tag = tag as keyof JSX.IntrinsicElements;
    return <Tag {...props}>{kids}</Tag>;
  };
  return Array.from(doc.body.childNodes).map(walk);
}

/** Opens a FileViewer for a list of files; returns [element, open(index)]. */
export function useFileViewer(files: ViewerFile[], actions?: (f: ViewerFile) => ReactNode): [ReactNode, (i: number) => void] {
  const [at, setAt] = useState<number | null>(null);
  const list = useMemo(() => files, [files]);
  const el = at === null ? null : <FileViewer files={list} index={at} onClose={() => setAt(null)} actions={actions} />;
  return [el, setAt];
}
