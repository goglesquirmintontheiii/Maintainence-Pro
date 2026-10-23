import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Pieces shared by the Assets, Locations and asset settings screens (0.3.0).
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Download, ImagePlus, Users, X } from "lucide-react";
import { api, upload } from "../../lib/api";
import { ASSET_STATUS_LABEL } from "../../lib/assets";
import { useSession } from "../../lib/session";
import { dateTime } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, ListSkeleton, Pill } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { FileViewer } from "../../components/FileViewer";
import { DropZone } from "../../components/DropZone";
import "../../styles/assets.css";
export function AssetStatusPill({ status, reason }) {
    return _jsxs("span", { className: "pill " + status, title: reason || undefined, children: [_jsx("span", { className: "dot" }), ASSET_STATUS_LABEL[status], reason ? _jsxs("span", { className: "sub", children: ["\u00B7 ", reason] }) : null] });
}
export function Crumbs({ path, base, baseLabel }) {
    return (_jsxs("nav", { className: "crumbs small", "aria-label": "Breadcrumbs", children: [_jsx(Link, { to: base, children: baseLabel }), path.map((p) => _jsxs("span", { className: "row", style: { gap: 4 }, children: [_jsx(ChevronRight, { size: 12, className: "faint" }), _jsx(Link, { to: `${base}/${p.id}`, children: p.name })] }, p.id))] }));
}
export function useTeams() {
    const { can } = useSession();
    return useQuery({ queryKey: ["teams-lite"], queryFn: () => api("/teams"), staleTime: 60_000,
        enabled: can("teams.view") });
}
export function TeamsPicker({ value, onChange, id, disabled }) {
    const teams = useTeams();
    const opts = useMemo(() => (teams.data?.items ?? []).map((t) => ({ key: t.id, label: t.name,
        icon: _jsx("span", { className: "team-ic", style: { background: t.color }, children: _jsx(Users, { size: 12 }) }) })), [teams.data]);
    return _jsx(MultiPicker, { id: id, label: "Teams in charge", placeholder: "Add teams", options: opts, value: value, onChange: onChange, disabled: disabled, searchPlaceholder: "Search teams", renderValue: (sel) => _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: sel.map((s) => _jsxs("span", { className: "chip", children: [s.icon, s.label] }, s.key)) }) });
}
export function TeamChips({ teams }) {
    if (!teams.length)
        return _jsx("span", { className: "faint", children: "None" });
    return _jsx("span", { className: "row wrap", style: { gap: 4 }, children: teams.map((t) => _jsxs("span", { className: "chip", children: [_jsx("span", { className: "team-ic", style: { background: t.color }, children: _jsx(Users, { size: 11 }) }), t.name] }, t.id)) });
}
/** A section that opens and closes (used for Lifecycle, Warranty and Financials in forms). */
export function Collapsible({ title, children, defaultOpen = false, hint }) {
    const [open, setOpen] = useState(defaultOpen);
    return (_jsxs("section", { className: "collapsible" + (open ? " open" : ""), children: [_jsxs("button", { type: "button", className: "collapsible-head", "aria-expanded": open, onClick: () => setOpen((o) => !o), children: [open ? _jsx(ChevronDown, { size: 16 }) : _jsx(ChevronRight, { size: 16 }), _jsx("span", { className: "grow", children: title }), hint && _jsx("span", { className: "small faint", children: hint })] }), open && _jsx("div", { className: "collapsible-body form-grid", children: children })] }));
}
export const centsToInput = (c) => (c === null || c === undefined ? "" : (c / 100).toFixed(2));
export const inputToCents = (v) => {
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return v.trim() === "" || Number.isNaN(n) ? null : Math.round(n * 100);
};
export function fmtSeconds(s) {
    if (s <= 0)
        return "0 min";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return [d && `${d} d`, h && `${h} h`, !d && m && `${m} min`].filter(Boolean).join(" ") || "under a minute";
}
/** Photos picked in a create form: uploaded right away, sent as file_ids on save. */
export function PhotoPicker({ files, setFiles, label = "Add photos or files" }) {
    const input = useRef(null);
    const [busy, setBusy] = useState(0);
    const { toast } = useToast();
    const pick = async (list) => {
        if (!list)
            return;
        const out = [...files];
        for (const f of Array.from(list)) {
            setBusy((n) => n + 1);
            try {
                out.push(await upload(f));
            }
            catch (e) {
                toast(e.message, { kind: "error" });
            }
            finally {
                setBusy((n) => n - 1);
            }
        }
        setFiles(out);
    };
    return (_jsxs(DropZone, { className: "full", accept: "image/*,application/pdf", onFiles: (fs) => void pick(fs), children: [_jsx("input", { ref: input, type: "file", multiple: true, hidden: true, accept: "image/*,application/pdf", onChange: (e) => { void pick(e.target.files); e.target.value = ""; } }), _jsxs("button", { type: "button", className: "dropzone small", onClick: () => input.current?.click(), children: [_jsx(ImagePlus, { size: 16 }), busy ? "Uploading…" : label] }), files.length > 0 && _jsx("div", { className: "thumbs sm", children: files.map((f) => (_jsxs("figure", { className: "thumb", children: [f.is_image ? _jsx("img", { src: f.thumb_url ?? f.url, alt: f.name }) : _jsx("span", { className: "small", style: { padding: 6 }, children: f.name }), _jsx("button", { type: "button", className: "thumb-x", "aria-label": `Remove ${f.name}`, onClick: () => setFiles(files.filter((x) => x.id !== f.id)), children: _jsx(X, { size: 12 }) })] }, f.id))) })] }));
}
// Query keys of lists that show a record's picture, refreshed when its files change.
const LIST_KEYS = {
    asset: ["assets", "asset-tree", "asset-pick"],
    location: ["locations", "location-tree", "location-pick"],
    part: ["parts"],
    vendor: ["vendors"],
    customer: ["customers"],
};
/** Files attached to a saved record, with add and remove. */
export function FilesSection({ files, entityType, entityId, editable, queryKey, role = "photo" }) {
    const input = useRef(null);
    const qc = useQueryClient();
    const { toast } = useToast();
    const [view, setView] = useState(null);
    const [busy, setBusy] = useState(false);
    // A new or removed picture changes the record's thumbnail in lists and trees too, not just its own page (MP-121)
    const refresh = () => {
        void qc.invalidateQueries({ queryKey });
        for (const k of LIST_KEYS[entityType] ?? [])
            void qc.invalidateQueries({ queryKey: [k] });
    };
    const add = async (list) => {
        if (!list)
            return;
        setBusy(true);
        try {
            for (const f of Array.from(list))
                await upload(f, { entity_type: entityType, entity_id: entityId, role: f.type.startsWith("image/") ? role : "file" });
        }
        catch (e) {
            toast(e.message, { kind: "error" });
        }
        finally {
            setBusy(false);
            refresh();
        }
    };
    const remove = async (f) => {
        try {
            await api(`/files/links/${f.link_id}`, { method: "DELETE" });
            refresh();
            toast("Removed");
        }
        catch (e) {
            toast(e.message, { kind: "error" });
        }
    };
    const imgs = files.filter((f) => f.is_image), docs = files.filter((f) => !f.is_image);
    return (_jsx(DropZone, { onFiles: (fs) => void add(fs), disabled: !editable, className: "card", children: _jsxs("section", { className: "card-pad stack", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Photos and files" }), editable && _jsxs(_Fragment, { children: [_jsx("input", { ref: input, type: "file", multiple: true, hidden: true, onChange: (e) => { void add(e.target.files); e.target.value = ""; } }), _jsxs(Button, { size: "sm", onClick: () => input.current?.click(), disabled: busy, children: [_jsx(ImagePlus, { size: 14 }), busy ? "Uploading…" : "Add"] })] })] }), files.length === 0 && _jsx("span", { className: "small faint", children: "No photos or files yet. Add photos, manuals or drawings." }), imgs.length > 0 && _jsx("div", { className: "thumbs", children: imgs.map((f) => (_jsxs("figure", { className: "thumb", children: [_jsx("button", { type: "button", onClick: () => setView(f), "aria-label": `Open ${f.name}`, children: _jsx("img", { src: f.thumb_url ?? f.url, alt: f.name }) }), f.role === "warranty" && _jsx("span", { className: "cover-tag", children: "Warranty" }), editable && f.link_id && _jsx("button", { type: "button", className: "thumb-x", "aria-label": `Remove ${f.name}`, onClick: () => void remove(f), children: _jsx(X, { size: 12 }) })] }, f.id))) }), docs.length > 0 && _jsx("div", { className: "files", children: docs.map((f) => (_jsxs("div", { className: "file-row", children: [_jsx("button", { type: "button", className: "linkbtn grow", style: { textAlign: "left" }, onClick: () => setView(f), children: f.name }), f.role === "warranty" && _jsx(Pill, { tone: "info", children: "Warranty" }), _jsx("a", { className: "btn ghost sm icon", href: f.url + "?download=1", "aria-label": `Download ${f.name}`, children: _jsx(Download, { size: 14 }) }), editable && f.link_id && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Remove ${f.name}`, onClick: () => void remove(f), children: _jsx(X, { size: 14 }) })] }, f.id))) }), view && _jsx(Lightbox, { file: view, files: [...imgs, ...docs], onClose: () => setView(null) })] }) }));
}
/** One file, or a list with `index`, in the shared in-page viewer (MP-107). */
export function Lightbox({ file, files, onClose }) {
    const list = files?.length ? files : [file];
    return _jsx(FileViewer, { files: list, index: Math.max(0, list.findIndex((f) => f.id === file.id)), onClose: onClose });
}
const FIELD_NAMES = { parent_id: "parent", location_id: "location", types: "types", custom: "custom fields" };
function short(v) {
    if (v === null || v === undefined || v === "")
        return "empty";
    if (typeof v === "object")
        return Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : "changed";
    const s = String(v);
    return s.length > 40 ? s.slice(0, 40) + "…" : s;
}
export function HistoryList({ path, tz }) {
    const q = useQuery({ queryKey: ["history", path], queryFn: () => api(path) });
    if (!q.data)
        return _jsx(ListSkeleton, { rows: 4 });
    if (!q.data.items.length)
        return _jsx(EmptyState, { title: "No history yet" });
    return (_jsx("ol", { className: "history card", children: q.data.items.map((h) => (_jsxs("li", { className: "history-row", children: [_jsx("span", { className: "dot", "aria-hidden": "true" }), _jsxs("div", { className: "grow", children: [_jsxs("div", { children: [_jsx("b", { children: h.actor }), " ", h.summary.charAt(0).toLowerCase() + h.summary.slice(1)] }), Object.keys(h.changes).length > 0 && Object.keys(h.changes).length <= 4 && _jsx("div", { className: "small faint", children: Object.entries(h.changes).map(([k, [a, b]]) => _jsxs("span", { style: { marginRight: 10 }, children: [(FIELD_NAMES[k] ?? k.replace(/_cents$/, "").replace(/_/g, " ")), ": ", short(a), " \u2192 ", short(b)] }, k)) })] }), _jsx("span", { className: "small faint", style: { whiteSpace: "nowrap" }, children: dateTime(h.at, tz) })] }, h.id))) }));
}
/** Simple grouped bar chart (two series) drawn with SVG and design tokens. */
export function BarChart2({ data, aLabel, bLabel, labelFor }) {
    const W = 640, H = 200, pad = 28, top = Math.max(2, ...data.flatMap((d) => [d.a, d.b])), max = top % 2 ? top + 1 : top;
    const slot = (W - pad) / Math.max(1, data.length), bw = Math.max(3, Math.min(14, slot / 3));
    const step = Math.ceil(data.length / 8);
    return (_jsxs("figure", { className: "chart", "aria-label": `${aLabel} and ${bLabel} per week`, children: [_jsxs("svg", { viewBox: `0 0 ${W} ${H + 22}`, role: "img", preserveAspectRatio: "none", children: [[0, 0.5, 1].map((f) => _jsxs("g", { children: [_jsx("line", { x1: pad, x2: W, y1: H - f * (H - 10), y2: H - f * (H - 10), className: "grid" }), _jsx("text", { x: pad - 6, y: H - f * (H - 10) + 4, className: "axis", textAnchor: "end", children: Math.round(max * f) })] }, f)), data.map((d, i) => {
                        const x = pad + i * slot + slot / 2;
                        const ha = (d.a / max) * (H - 10), hb = (d.b / max) * (H - 10);
                        return _jsxs("g", { children: [_jsx("rect", { x: x - bw - 1, y: H - ha, width: bw, height: ha, className: "bar-a", children: _jsx("title", { children: `${labelFor(d.k)}: ${d.a} ${aLabel.toLowerCase()}` }) }), _jsx("rect", { x: x + 1, y: H - hb, width: bw, height: hb, className: "bar-b", children: _jsx("title", { children: `${labelFor(d.k)}: ${d.b} ${bLabel.toLowerCase()}` }) }), i % step === 0 && _jsx("text", { x: x, y: H + 16, className: "axis", textAnchor: "middle", children: labelFor(d.k) })] }, d.k);
                    })] }), _jsxs("figcaption", { className: "row small muted", style: { gap: 14 }, children: [_jsxs("span", { className: "row", style: { gap: 5 }, children: [_jsx("i", { className: "legend-sq a" }), aLabel] }), _jsxs("span", { className: "row", style: { gap: 5 }, children: [_jsx("i", { className: "legend-sq b" }), bLabel] })] })] }));
}
