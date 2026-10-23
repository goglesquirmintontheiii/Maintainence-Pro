import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// In-page file viewer (MP-107): large previews on a dark backdrop, zoom and pan, next/previous, and in-page
// previews for videos, audio, PDFs, text, spreadsheets, Word documents and Photoshop files. Never navigates
// to the raw file; Download is a button.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, FileText, Minus, Plus, RotateCcw, X } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "./ui";
import "../styles/viewer.css";
export function FileViewer({ files, index, onClose, actions }) {
    const [i, setI] = useState(() => Math.min(Math.max(index, 0), files.length - 1));
    const f = files[i];
    const go = useCallback((d) => setI((x) => (files.length ? (x + d + files.length) % files.length : 0)), [files.length]);
    const panel = useRef(null);
    useEffect(() => {
        const k = (e) => {
            if (e.defaultPrevented)
                return;
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
            else if (e.key === "ArrowRight" && files.length > 1 && !e.target.closest?.("input,textarea,video,audio")) {
                e.preventDefault();
                go(1);
            }
            else if (e.key === "ArrowLeft" && files.length > 1 && !e.target.closest?.("input,textarea,video,audio")) {
                e.preventDefault();
                go(-1);
            }
        };
        window.addEventListener("keydown", k, true); // capture: runs before drawers and dialogs underneath
        panel.current?.focus();
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => { window.removeEventListener("keydown", k, true); document.body.style.overflow = prev; };
    }, [go, onClose, files.length]);
    if (!f)
        return null;
    const isImage = f.is_image ?? ((f.content_type ?? "").startsWith("image/") && f.content_type !== "image/vnd.adobe.photoshop");
    return createPortal(_jsxs("div", { className: "viewer", role: "dialog", "aria-modal": "true", "aria-label": `Viewing ${f.name}`, ref: panel, tabIndex: -1, children: [_jsxs("div", { className: "viewer-bar", children: [_jsx("span", { className: "viewer-name", title: f.name, children: f.name }), files.length > 1 && _jsxs("span", { className: "viewer-count", children: [i + 1, " / ", files.length] }), _jsx("span", { className: "grow" }), actions?.(f), _jsxs("a", { className: "btn sm viewer-btn", href: f.url + (f.url.includes("?") ? "&" : "?") + "download=1", download: f.name, "aria-label": `Download ${f.name}`, children: [_jsx(Download, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Download" })] }), _jsx("button", { type: "button", className: "viewer-x", "aria-label": "Close viewer", onClick: onClose, children: _jsx(X, { size: 20 }) })] }), _jsxs("div", { className: "viewer-stage", children: [isImage ? _jsx(ZoomImage, { src: f.url, alt: f.name, onSwipe: files.length > 1 ? go : undefined }, f.id)
                        : _jsx(FilePreview, { file: f }, f.id), files.length > 1 && _jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: "viewer-nav prev", "aria-label": "Previous file", onClick: () => go(-1), children: _jsx(ChevronLeft, { size: 28 }) }), _jsx("button", { type: "button", className: "viewer-nav next", "aria-label": "Next file", onClick: () => go(1), children: _jsx(ChevronRight, { size: 28 }) })] })] }), files.length > 1 && files.length <= 40 && (_jsx("div", { className: "viewer-strip", role: "tablist", "aria-label": "Files", children: files.map((x, n) => (_jsx("button", { type: "button", role: "tab", "aria-selected": n === i, className: "viewer-chip" + (n === i ? " on" : ""), onClick: () => setI(n), title: x.name, children: x.thumb_url ? _jsx("img", { src: x.thumb_url, alt: "", loading: "lazy" }) : _jsx(FileText, { size: 18 }) }, x.id))) }))] }), document.body);
}
// ---------------------------------------------------------------- images: zoom and pan
function ZoomImage({ src, alt, onSwipe }) {
    const [t, setT] = useState({ s: 1, x: 0, y: 0 });
    const [loaded, setLoaded] = useState(false);
    const box = useRef(null);
    const pointers = useRef(new Map());
    const start = useRef(null);
    const clamp = (s) => Math.min(8, Math.max(1, s));
    const zoomAt = (ns, cx, cy) => setT((p) => {
        const s = clamp(ns);
        if (s === 1)
            return { s: 1, x: 0, y: 0 };
        const r = box.current.getBoundingClientRect();
        const ox = cx - r.left - r.width / 2, oy = cy - r.top - r.height / 2;
        return { s, x: ox - ((ox - p.x) * s) / p.s, y: oy - ((oy - p.y) * s) / p.s };
    });
    useEffect(() => {
        const el = box.current;
        if (!el)
            return;
        const wheel = (e) => { e.preventDefault(); zoomAt(t.s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); };
        el.addEventListener("wheel", wheel, { passive: false });
        return () => el.removeEventListener("wheel", wheel);
    });
    const center = () => { const r = box.current.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    return (_jsxs("div", { className: "viewer-zoom", ref: box, onDoubleClick: (e) => (t.s > 1 ? setT({ s: 1, x: 0, y: 0 }) : zoomAt(2.5, e.clientX, e.clientY)), onPointerDown: (e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const ps = [...pointers.current.values()];
            const mid = ps.length === 2 ? { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 } : ps[0];
            start.current = { t, dist: ps.length === 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0, mid, px: e.clientX, py: e.clientY };
        }, onPointerMove: (e) => {
            if (!pointers.current.has(e.pointerId) || !start.current)
                return;
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const ps = [...pointers.current.values()];
            const st = start.current;
            if (ps.length === 2 && st.dist) {
                const d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
                setT(() => {
                    const s = clamp(st.t.s * (d / st.dist));
                    const r = box.current.getBoundingClientRect();
                    const ox = st.mid.x - r.left - r.width / 2, oy = st.mid.y - r.top - r.height / 2;
                    return s === 1 ? { s: 1, x: 0, y: 0 } : { s, x: ox - ((ox - st.t.x) * s) / st.t.s, y: oy - ((oy - st.t.y) * s) / st.t.s };
                });
            }
            else if (ps.length === 1 && st.t.s > 1) {
                setT({ s: st.t.s, x: st.t.x + (e.clientX - st.px), y: st.t.y + (e.clientY - st.py) });
            }
        }, onPointerUp: (e) => {
            const st = start.current;
            pointers.current.delete(e.pointerId);
            if (st && st.t.s === 1 && onSwipe && pointers.current.size === 0) {
                const dx = e.clientX - st.px, dy = e.clientY - st.py;
                if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5)
                    onSwipe(dx < 0 ? 1 : -1);
            }
            start.current = pointers.current.size ? { ...st, t } : null;
        }, onPointerCancel: (e) => { pointers.current.delete(e.pointerId); start.current = null; }, children: [!loaded && _jsx("span", { className: "viewer-spinner", "aria-hidden": "true" }), _jsx("img", { src: src, alt: alt, draggable: false, onLoad: () => setLoaded(true), style: { transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, cursor: t.s > 1 ? "grab" : "zoom-in", opacity: loaded ? 1 : 0 } }), _jsxs("div", { className: "viewer-zoom-ctl", onPointerDown: (e) => e.stopPropagation(), onDoubleClick: (e) => e.stopPropagation(), children: [_jsx(Button, { size: "sm", icon: true, "aria-label": "Zoom out", onClick: () => { const c = center(); zoomAt(t.s / 1.5, c.x, c.y); }, children: _jsx(Minus, { size: 15 }) }), _jsxs("span", { className: "small", "aria-live": "polite", children: [Math.round(t.s * 100), "%"] }), _jsx(Button, { size: "sm", icon: true, "aria-label": "Zoom in", onClick: () => { const c = center(); zoomAt(t.s * 1.5, c.x, c.y); }, children: _jsx(Plus, { size: 15 }) }), _jsx(Button, { size: "sm", icon: true, "aria-label": "Fit to screen", onClick: () => setT({ s: 1, x: 0, y: 0 }), children: _jsx(RotateCcw, { size: 14 }) })] })] }));
}
// ---------------------------------------------------------------- everything else
function FilePreview({ file }) {
    const q = useQuery({ queryKey: ["file-preview", file.id], queryFn: () => api(`/files/${file.id}/preview`), staleTime: 60_000,
        refetchInterval: (query) => (query.state.data?.kind === "pending" ? 3000 : false) });
    const p = q.data;
    if (q.isError)
        return _jsx(Fallback, { file: file, reason: q.error.message });
    if (!p)
        return _jsx("span", { className: "viewer-spinner", "aria-label": "Loading preview" });
    switch (p.kind) {
        case "image": return _jsx(ZoomImage, { src: p.url, alt: file.name });
        case "video": return _jsx("video", { className: "viewer-media", src: p.url, controls: true, playsInline: true, preload: "metadata", "aria-label": file.name });
        case "audio": return _jsxs("div", { className: "viewer-doc viewer-audio", children: [_jsx(FileText, { size: 36 }), _jsx("b", { children: file.name }), _jsx("audio", { src: p.url, controls: true, preload: "metadata" })] });
        case "pdf": return _jsx("iframe", { className: "viewer-pdf", src: p.url, title: file.name });
        case "text": return _jsxs("div", { className: "viewer-doc", children: [_jsx("pre", { className: "viewer-text", children: p.text }), p.truncated && _jsx(Truncated, {})] });
        case "table": return _jsx(SheetPreview, { sheets: p.sheets ?? [], truncated: !!p.truncated });
        case "html": return _jsx("div", { className: "viewer-doc", children: _jsx("article", { className: "viewer-docx", children: htmlToReact(p.html ?? "") }) });
        case "pending": return _jsx(Fallback, { file: file, reason: p.reason ?? "Preparing a preview… This takes a few seconds.", busy: true });
        default: return _jsx(Fallback, { file: file, reason: p.reason ?? "This kind of file can't be shown in the browser. Download it to open it." });
    }
}
function Truncated() { return _jsx("p", { className: "small muted viewer-trunc", children: "Showing the beginning of the file. Download it to see everything." }); }
function Fallback({ file, reason, busy }) {
    return (_jsxs("div", { className: "viewer-doc viewer-fallback", children: [busy ? _jsx("span", { className: "viewer-spinner", "aria-hidden": "true" }) : _jsx(FileText, { size: 44 }), _jsx("b", { children: file.name }), _jsx("p", { className: "muted", children: reason }), !busy && _jsxs("a", { className: "btn primary", href: file.url + (file.url.includes("?") ? "&" : "?") + "download=1", download: file.name, children: [_jsx(Download, { size: 15 }), "Download"] })] }));
}
function SheetPreview({ sheets, truncated }) {
    const [n, setN] = useState(0);
    const sheet = sheets[n] ?? { name: "", rows: [] };
    const cols = Math.max(0, ...sheet.rows.map((r) => r.length));
    return (_jsxs("div", { className: "viewer-doc viewer-sheet", children: [sheets.length > 1 && _jsx("div", { className: "seg", role: "tablist", "aria-label": "Sheets", children: sheets.map((s, k) => (_jsx("button", { type: "button", role: "tab", "aria-selected": k === n, className: "seg-btn" + (k === n ? " on" : ""), onClick: () => setN(k), children: s.name || `Sheet ${k + 1}` }, k))) }), sheet.rows.length === 0 ? _jsx("p", { className: "muted", children: "This sheet is empty." }) : (_jsx("div", { className: "viewer-table-wrap", children: _jsx("table", { className: "viewer-table", children: _jsx("tbody", { children: sheet.rows.map((r, ri) => (_jsxs("tr", { className: ri === 0 ? "head" : "", children: [_jsx("th", { scope: "row", className: "rownum", children: ri + 1 }), Array.from({ length: cols }, (_, ci) => _jsx("td", { children: r[ci] ?? "" }, ci))] }, ri))) }) }) })), truncated && _jsx(Truncated, {})] }));
}
// The server already sanitises Word HTML (nh3). We still build React elements from an allowlist instead of
// injecting markup, so nothing unexpected can run even if the server ever changed.
const TAGS = new Set(["p", "br", "strong", "b", "em", "i", "u", "s", "sub", "sup", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td", "blockquote", "pre", "code", "img", "a", "hr"]);
function htmlToReact(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    let key = 0;
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE)
            return node.textContent;
        if (node.nodeType !== Node.ELEMENT_NODE)
            return null;
        const el = node;
        const tag = el.tagName.toLowerCase();
        const kids = Array.from(el.childNodes).map(walk);
        if (!TAGS.has(tag))
            return _jsx("span", { children: kids }, key++);
        const props = { key: key++ };
        if (tag === "img") {
            const src = el.getAttribute("src") ?? "";
            if (!/^data:image\/(png|jpeg|gif|webp);/i.test(src))
                return null;
            return _jsx("img", { src: src, alt: el.getAttribute("alt") ?? "" }, key++);
        }
        if (tag === "a") {
            const href = el.getAttribute("href") ?? "";
            if (!/^(https?:|mailto:)/i.test(href))
                return _jsx("span", { children: kids }, key++);
            Object.assign(props, { href, target: "_blank", rel: "noopener noreferrer nofollow" });
        }
        if (tag === "td" || tag === "th") {
            for (const a of ["colspan", "rowspan"]) {
                const v = Number(el.getAttribute(a));
                if (v > 1 && v < 100)
                    props[a === "colspan" ? "colSpan" : "rowSpan"] = v;
            }
        }
        if (tag === "br" || tag === "hr") {
            const Void = tag;
            return _jsx(Void, {}, key++);
        }
        const Tag = tag;
        return _jsx(Tag, { ...props, children: kids });
    };
    return Array.from(doc.body.childNodes).map(walk);
}
/** Opens a FileViewer for a list of files; returns [element, open(index)]. */
export function useFileViewer(files, actions) {
    const [at, setAt] = useState(null);
    const list = useMemo(() => files, [files]);
    const el = at === null ? null : _jsx(FileViewer, { files: list, index: at, onClose: () => setAt(null), actions: actions });
    return [el, setAt];
}
