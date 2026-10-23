import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Procedures library (MaintainX "Procedures", 0.4.0 MP-034–037): list with search, status, tag and category filters;
// detail with a preview, version history (r206), work-order history (r207) and analytics (r596); create blank, from a
// built-in template (r209) or by importing a CSV or PDF (MP-036); copy, archive, delete (r208); the builder at /:id/edit.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ArrowLeft, ClipboardCheck, ClipboardList, Copy, Download, FilePlus2, FileUp, LayoutTemplate, MoreHorizontal, Pencil, Plus, Search, Trash2, } from "lucide-react";
import { api, getCsrf } from "../../lib/api";
import { useSession } from "../../lib/session";
import { dateTime, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { DropZone } from "../../components/DropZone";
import { Button, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, StatusPill } from "../../components/ui";
import { ProcedureBuilder } from "./Builder";
import { PreviewForm } from "./Runner";
import { ProcedureAnalytics } from "./Analytics";
import { MONTHS, fieldsOf, useProcOptions, walk } from "./types";
import "../../styles/procedures.css";
// an imported schema waiting for the builder (the route change remounts the page, so it can't live in state)
let pendingImport = null;
export function ProceduresPage() {
    const { id, mode } = useParams();
    const [init] = useState(() => (id === "new" ? pendingImport : null));
    useEffect(() => { pendingImport = null; }, []);
    if (id && mode === "edit")
        return _jsx(ProcedureBuilder, { id: id, init: id === "new" ? init : null });
    return _jsx(Library, { id: id, onImported: (v) => { pendingImport = v; } });
}
function Library({ id, onImported }) {
    const { can } = useSession();
    const nav = useNavigate();
    const [params, setParams] = useSearchParams();
    const manage = can("procedures.manage");
    const [q, setQ] = useState("");
    const [status, setStatus] = useState(params.get("status") ?? "");
    const [tag, setTag] = useState(params.get("tag") ?? "");
    const [cat, setCat] = useState("");
    const [dialog, setDialog] = useState(null);
    useEffect(() => { const s = new URLSearchParams(params); if (tag)
        s.set("tag", tag);
    else
        s.delete("tag"); if (status)
        s.set("status", status);
    else
        s.delete("status"); setParams(s, { replace: true }); }, [tag, status]); // eslint-disable-line react-hooks/exhaustive-deps
    const qs = `q=${encodeURIComponent(q)}${status ? `&status=${status}` : ""}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}${cat ? `&category=${encodeURIComponent(cat)}` : ""}`;
    const list = useQuery({ queryKey: ["procedures", qs], queryFn: () => api(`/procedures?${qs}`), placeholderData: (p) => p });
    const items = list.data?.items ?? [];
    const filtered = !!(q || status || tag || cat);
    const newMenu = manage && (_jsx(Dropdown, { width: 250, trigger: (_, t) => _jsxs(Button, { variant: "primary", onClick: t, "aria-label": "New procedure", children: [_jsx(Plus, { size: 16 }), "New"] }), children: (close) => _jsxs(_Fragment, { children: [_jsxs("button", { className: "menu-item", onClick: () => { close(); nav("/procedures/new/edit"); }, children: [_jsx(FilePlus2, { size: 15 }), "Blank procedure"] }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setDialog("template"); }, children: [_jsx(LayoutTemplate, { size: 15 }), "From a template"] }), _jsxs("button", { className: "menu-item", onClick: () => { close(); setDialog("import"); }, children: [_jsx(FileUp, { size: 15 }), "Import a CSV or PDF"] })] }) }));
    return (_jsxs("div", { className: "wo-page", children: [_jsxs("div", { className: "split wo-split" + (id ? " has-detail" : ""), children: [_jsxs("div", { className: "split-list", children: [_jsxs("div", { className: "list-tools wo-list-tools", children: [_jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsx("h1", { style: { fontSize: "var(--fs-lg)" }, children: "Procedures" }), newMenu] }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search procedures", "aria-label": "Search procedures", value: q, onChange: (e) => setQ(e.target.value) })] }), _jsxs("div", { className: "pl-filters", children: [_jsxs(Select, { "aria-label": "Status", value: status, onChange: (e) => setStatus(e.target.value), children: [_jsx("option", { value: "", children: "Published and drafts" }), _jsx("option", { value: "published", children: "Published" }), _jsx("option", { value: "draft", children: "Drafts" }), _jsx("option", { value: "archived", children: "Archived" })] }), _jsxs(Select, { "aria-label": "Tag", value: tag, onChange: (e) => setTag(e.target.value), children: [_jsx("option", { value: "", children: "All tags" }), (list.data?.tags ?? []).map((t) => _jsx("option", { children: t }, t))] }), (list.data?.categories.length ?? 0) > 1 && _jsxs(Select, { "aria-label": "Category", value: cat, onChange: (e) => setCat(e.target.value), className: "span2", children: [_jsx("option", { value: "", children: "All categories" }), list.data.categories.map((c) => _jsx("option", { children: c }, c))] })] }), _jsxs("div", { className: "small muted", children: [list.data ? `${items.length} procedure${items.length === 1 ? "" : "s"}` : " ", filtered && _jsxs(_Fragment, { children: [" \u00B7 ", _jsx("button", { className: "linkbtn small", onClick: () => { setQ(""); setStatus(""); setTag(""); setCat(""); }, children: "Clear" })] })] })] }), _jsx("div", { className: "list", role: "list", children: list.isLoading ? _jsx(ListSkeleton, {}) : items.length === 0 ? (_jsx(EmptyState, { icon: _jsx(ClipboardList, { size: 26 }), title: filtered ? "No procedures match" : "No procedures yet", action: !filtered && manage ? _jsxs(Button, { variant: "primary", onClick: () => setDialog("template"), children: [_jsx(LayoutTemplate, { size: 15 }), "Start from a template"] }) : undefined, children: filtered ? "Try clearing the filters." : "Procedures are checklists technicians fill in on work orders: inspections, readings, photos and sign-offs." })) : items.map((p) => _jsx(ProcRow, { p: p, active: p.id === id }, p.id)) })] }), _jsx("div", { className: "split-detail", children: id ? _jsx(ProcedureView, { id: id }, id) : _jsx(EmptyState, { icon: _jsx(ClipboardCheck, { size: 28 }), title: "Select a procedure", children: "Pick one from the list to preview it and see where it's used." }) })] }), dialog === "template" && _jsx(TemplateDialog, { onClose: () => setDialog(null) }), dialog === "import" && _jsx(ImportDialog, { onClose: () => setDialog(null), onReady: (v) => { onImported(v); setDialog(null); nav("/procedures/new/edit"); } })] }));
}
function ProcRow({ p, active }) {
    return (_jsxs(Link, { to: `/procedures/${p.id}`, className: "list-row pl-row" + (active ? " active" : ""), role: "listitem", children: [_jsx("span", { className: "pl-ic " + p.status, "aria-hidden": "true", children: _jsx(ClipboardCheck, { size: 16 }) }), _jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsx("div", { className: "t", children: p.name }), _jsxs("div", { className: "s", children: [p.field_count, " field", p.field_count === 1 ? "" : "s", p.category ? ` · ${p.category}` : "", p.tags.length ? ` · ${p.tags.slice(0, 3).join(", ")}` : ""] })] }), _jsxs("div", { className: "pl-side", children: [p.status === "draft" ? _jsx(Pill, { children: "Draft" }) : p.status === "archived" ? _jsx(Pill, { children: "Archived" }) : p.has_unpublished_changes ? _jsx(Pill, { tone: "warning", children: "Unpublished changes" }) : null, _jsx("span", { className: "small faint", children: p.work_order_count ? `${p.work_order_count} work order${p.work_order_count === 1 ? "" : "s"}` : "Not used yet" })] })] }));
}
function ProcedureView({ id }) {
    const { can, session } = useSession();
    const tz = session.org?.timezone;
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["procedure", id], queryFn: () => api(`/procedures/${id}`) });
    const [tab, setTab] = useState("overview");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const refresh = (p) => { if (p)
        qc.setQueryData(["procedure", id], p); qc.invalidateQueries({ queryKey: ["procedures"] }); qc.invalidateQueries({ queryKey: ["procedure", id] }); };
    const err = (e) => toast(e.message, { kind: "error" });
    const archive = useMutation({ mutationFn: (archived) => api(`/procedures/${id}/archive`, { method: "POST", body: { archived } }),
        onSuccess: (p) => { refresh(p); toast(p.status === "archived" ? "Archived. It can't be added to new work orders." : "Restored to the library"); }, onError: err });
    const copy = useMutation({ mutationFn: () => api(`/procedures/${id}/copy`, { method: "POST" }),
        onSuccess: (p) => { refresh(); toast("Copied as a draft"); nav(`/procedures/${p.id}`); }, onError: err });
    const publish = useMutation({ mutationFn: () => api(`/procedures/${id}/publish`, { method: "POST" }),
        onSuccess: (p) => { refresh(p); toast(`Published version ${p.published?.number}`); }, onError: err });
    const del = useMutation({ mutationFn: () => api(`/procedures/${id}`, { method: "DELETE" }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["procedures"] });
            setConfirmDelete(false);
            nav("/procedures");
            toast("Procedure deleted", { action: { label: "Undo", run: () => { void api(`/procedures/${id}/restore`, { method: "POST" }).then(() => { qc.invalidateQueries({ queryKey: ["procedures"] }); nav(`/procedures/${id}`); }); } } });
        },
        onError: err });
    const exp = useMutation({
        mutationFn: () => api("/procedures/export", { method: "POST", body: { procedure_id: id, ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to + "T23:59:59").toISOString() } : {}) } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["exports"] }); toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }); },
        onError: err
    });
    if (q.isError)
        return _jsx(EmptyState, { icon: _jsx(ClipboardList, { size: 26 }), title: "Procedure not found", children: "It may have been deleted, or you don't have access to it." });
    if (!q.data)
        return _jsx("div", { className: "detail", children: _jsx(ListSkeleton, { rows: 4 }) });
    const p = q.data;
    const shown = p.published ?? p.draft;
    const manage = can("procedures.manage") && !p.deleted;
    return (_jsxs("div", { className: "detail wo-detail", children: [_jsxs(Link, { to: "/procedures", className: "row small mobile-only", children: [_jsx(ArrowLeft, { size: 14 }), "All procedures"] }), p.deleted && _jsxs("div", { className: "banner warning", children: [_jsx(Trash2, { size: 18 }), _jsx("div", { className: "grow", children: "This procedure was deleted." })] }), _jsxs("div", { className: "wo-head", children: [_jsxs("div", { className: "grow", children: [_jsxs("div", { className: "row small muted wrap", style: { gap: 8 }, children: [p.status === "published" ? _jsxs(Pill, { tone: "success", children: ["Published \u00B7 v", p.published?.number] }) : p.status === "archived" ? _jsx(Pill, { children: "Archived" }) : _jsx(Pill, { children: "Draft" }), p.has_unpublished_changes && _jsx(Pill, { tone: "warning", children: "Unpublished changes" }), p.category && _jsx("span", { children: p.category })] }), _jsx("h1", { className: "wo-title", children: p.name }), p.tags.length > 0 && _jsx("div", { className: "row wrap", style: { gap: 4, marginTop: 6 }, children: p.tags.map((t) => _jsx("span", { className: "chip", children: t }, t)) })] }), _jsxs("div", { className: "row", children: [manage && p.status !== "archived" && _jsxs(Button, { onClick: () => nav(`/procedures/${id}/edit`), "aria-label": "Edit", children: [_jsx(Pencil, { size: 15 }), _jsx("span", { className: "desktop-only", children: "Edit" })] }), manage && (p.status === "draft" || p.has_unpublished_changes) && _jsx(Button, { variant: "primary", onClick: () => publish.mutate(), disabled: publish.isPending, children: "Publish" }), _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { icon: true, "aria-label": "More actions", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 230, children: (close) => _jsxs(_Fragment, { children: [manage && _jsxs("button", { className: "menu-item", onClick: () => { close(); copy.mutate(); }, children: [_jsx(Copy, { size: 15 }), "Make a copy"] }), can("exports.use") && _jsxs("button", { className: "menu-item", onClick: () => { close(); exp.mutate(); }, children: [_jsx(Download, { size: 15 }), "Export answers (CSV)"] }), manage && (p.status === "archived"
                                            ? _jsxs("button", { className: "menu-item", onClick: () => { close(); archive.mutate(false); }, children: [_jsx(ArchiveRestore, { size: 15 }), "Unarchive"] })
                                            : _jsxs("button", { className: "menu-item", onClick: () => { close(); archive.mutate(true); }, children: [_jsx(Archive, { size: 15 }), "Archive"] })), can("procedures.delete") && !p.deleted && _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); setConfirmDelete(true); }, children: [_jsx(Trash2, { size: 15 }), "Delete"] })] })] }) })] })] }), _jsxs("div", { className: "pl-stats", children: [_jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Fields" }), _jsx("div", { className: "v", children: shown ? fieldsOf(shown.schema).length : 0 })] }), _jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Work orders" }), _jsx("div", { className: "v", children: p.work_order_count })] }), _jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Updated" }), _jsx("div", { className: "v pl-v-sm", title: dateTime(p.updated_at, tz), children: timeAgo(p.updated_at) })] })] }), _jsx("div", { className: "seg pl-tabs", role: "tablist", "aria-label": "Procedure", children: ["overview", "versions", "history", "analytics"].map((t) => (_jsx("button", { type: "button", role: "tab", "aria-selected": tab === t, className: "seg-btn" + (tab === t ? " on" : ""), onClick: () => setTab(t), children: { overview: "Overview", versions: "Versions", history: "Work orders", analytics: "Analytics" }[t] }, t))) }), (tab === "history" || tab === "analytics") && (_jsxs("div", { className: "row wrap small", style: { gap: 8 }, children: [_jsxs("label", { className: "row", style: { gap: 6 }, children: ["From ", _jsx(Input, { type: "date", value: from, onChange: (e) => setFrom(e.target.value), style: { width: 150 } })] }), _jsxs("label", { className: "row", style: { gap: 6 }, children: ["To ", _jsx(Input, { type: "date", value: to, onChange: (e) => setTo(e.target.value), style: { width: 150 } })] }), (from || to) && _jsx("button", { className: "linkbtn small", onClick: () => { setFrom(""); setTo(""); }, children: "All time" })] })), tab === "overview" && _jsxs(_Fragment, { children: [p.description && _jsx("p", { className: "prewrap", children: p.description }), p.variants.length > 0 && _jsxs("section", { className: "card card-pad small", children: [_jsx("b", { children: "Seasonal variants" }), p.variants.map((v) => _jsxs("div", { children: [v.name, ": ", _jsx(Link, { to: `/procedures/${v.procedure_id}`, children: "another procedure" }), " in ", v.months.map((m) => MONTHS[m - 1]).join(", ")] }, v.procedure_id + v.name))] }), _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: p.published ? `Version ${p.published.number}` : "Draft" }), _jsx("span", { className: "small faint", children: "Try it out. Nothing is saved." })] }), _jsx("div", { className: "card-body", children: shown ? _jsx(PreviewForm, { schema: shown.schema, refs: Object.fromEntries(p.files.map((f) => [f.id, f])) }) : _jsx("span", { className: "faint", children: "Empty" }) })] })] }), tab === "versions" && _jsx(Versions, { id: id, tz: tz }), tab === "history" && _jsx(History, { id: id, from: from, to: to, tz: tz }), tab === "analytics" && _jsx(ProcedureAnalytics, { id: id, from: from, to: to, tz: tz }), confirmDelete && _jsx(Modal, { title: "Delete procedure?", onClose: () => setConfirmDelete(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirmDelete(false), children: "Cancel" }), _jsx(Button, { variant: "danger", onClick: () => del.mutate(), disabled: del.isPending, children: "Delete" })] }), children: _jsxs("p", { children: ["\u201C", p.name, "\u201D leaves the library. Work orders that already use it keep their copy and answers."] }) })] }));
}
function Versions({ id, tz }) {
    const q = useQuery({ queryKey: ["procedure", id, "versions"], queryFn: () => api(`/procedures/${id}/versions`) });
    if (!q.data)
        return _jsx(ListSkeleton, { rows: 3 });
    return (_jsx("section", { className: "card", children: _jsx("ul", { className: "pl-versions", children: q.data.items.map((v) => {
                const c = v.changes ?? {};
                const parts = [["added", "Added"], ["edited", "Edited"], ["removed", "Removed"]].filter(([k]) => (c[k]?.length ?? 0) > 0);
                return (_jsxs("li", { children: [_jsxs("div", { className: "row wrap", style: { gap: 8 }, children: [_jsxs("b", { children: ["Version ", v.number] }), v.published_at ? _jsxs("span", { className: "small muted", title: dateTime(v.published_at, tz), children: ["Published ", timeAgo(v.published_at)] }) : _jsx(Pill, { children: "Draft" }), _jsxs("span", { className: "small faint", children: [v.field_count, " fields \u00B7 ", v.work_order_count ?? 0, " work order", v.work_order_count === 1 ? "" : "s"] })] }), v.number === 1 && v.published_at ? _jsx("div", { className: "small muted", children: "First version" })
                            : parts.length ? parts.map(([k, label]) => _jsxs("div", { className: "small pl-chg " + k, children: [_jsxs("b", { children: [label, ":"] }), " ", c[k].slice(0, 12).join(", "), c[k].length > 12 ? ` and ${c[k].length - 12} more` : ""] }, k))
                                : v.published_at && _jsx("div", { className: "small muted", children: "Details only" })] }, v.id));
            }) }) }));
}
function History({ id, from, to, tz }) {
    const qs = `${from ? `from=${encodeURIComponent(new Date(from).toISOString())}&` : ""}${to ? `to=${encodeURIComponent(new Date(to + "T23:59:59").toISOString())}` : ""}`;
    const q = useQuery({ queryKey: ["procedure", id, "history", qs], queryFn: () => api(`/procedures/${id}/history?${qs}`), placeholderData: (p) => p });
    if (!q.data)
        return _jsx(ListSkeleton, { rows: 3 });
    const h = q.data;
    return (_jsxs("div", { className: "stack", style: { gap: 12 }, children: [_jsxs("div", { className: "pl-stats two", children: [_jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Created" }), _jsx("div", { className: "v", children: h.created }), _jsx("div", { className: "small muted", children: "Work orders with this procedure" })] }), _jsxs("div", { className: "card tile", children: [_jsx("div", { className: "k", children: "Completed" }), _jsx("div", { className: "v", children: h.completed }), _jsx("div", { className: "small muted", children: from || to ? "In this date range" : "All time" })] })] }), _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h2", { children: "Recent work orders" }) }), h.recent.length === 0 ? _jsx("div", { className: "card-body small muted", children: "Not used on any work orders yet." }) : (_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Work order" }), _jsx("th", { children: "Status" }), _jsx("th", { className: "desktop-only", children: "Completed" }), _jsx("th", { children: "Score" })] }) }), _jsx("tbody", { children: h.recent.map((w) => _jsxs("tr", { children: [_jsx("td", { children: _jsxs(Link, { to: `/work-orders/${w.id}`, children: ["#", w.number, " ", w.title] }) }), _jsx("td", { children: _jsx(StatusPill, { status: w.status }) }), _jsx("td", { className: "small desktop-only", children: w.completed_at ? dateTime(w.completed_at, tz) : "—" }), _jsx("td", { className: "tnum", children: w.score === null ? "—" : `${Math.round(w.score)}%` })] }, w.id)) })] }) }))] })] }));
}
function TemplateDialog({ onClose }) {
    const opts = useProcOptions();
    const nav = useNavigate();
    const qc = useQueryClient();
    const { toast } = useToast();
    const make = useMutation({ mutationFn: (key) => api("/procedures", { method: "POST", body: { template: key } }),
        onSuccess: (p) => { qc.invalidateQueries({ queryKey: ["procedures"] }); toast("Created a draft from the template"); onClose(); nav(`/procedures/${p.id}/edit`); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsx(Modal, { title: "Start from a template", onClose: onClose, width: 560, children: _jsx("div", { className: "pr-pick-list", children: (opts.data?.templates ?? []).map((t) => (_jsxs("button", { type: "button", className: "pr-pick", disabled: make.isPending, onClick: () => make.mutate(t.key), children: [_jsx(LayoutTemplate, { size: 18, className: "faint" }), _jsxs("span", { className: "grow", style: { minWidth: 0 }, children: [_jsx("b", { children: t.name }), _jsx("span", { className: "small muted", style: { display: "block" }, children: t.description }), _jsxs("span", { className: "small faint", children: [t.field_count, " fields \u00B7 ", t.category] })] })] }, t.key))) }) }));
}
function ImportDialog({ onClose, onReady }) {
    const ref = useRef(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const [res, setRes] = useState(null);
    const send = async (f) => {
        setBusy(true);
        setErr("");
        setRes(null);
        const fd = new FormData();
        fd.append("file", f);
        try {
            const r = await fetch("/api/v1/procedures/import", { method: "POST", body: fd, credentials: "same-origin", headers: { "X-CSRF-Token": getCsrf(), Accept: "application/json" } });
            const data = await r.json().catch(() => ({}));
            if (!r.ok)
                throw new Error(data.message || "That file couldn't be imported.");
            setRes(data);
        }
        catch (e) {
            setErr(e.message);
        }
        finally {
            setBusy(false);
        }
    };
    const all = res ? walk(res.schema.items, true) : [];
    return (_jsx(Modal, { title: "Import a procedure", onClose: onClose, width: 560, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !res || !res.name.trim(), onClick: () => res && onReady(res), children: "Review in the builder" })] }), children: _jsxs("div", { className: "stack", style: { gap: 10 }, children: [_jsxs("p", { className: "small muted", style: { margin: 0 }, children: [_jsx("b", { children: "CSV:" }), " one row per field with the columns ", _jsx("span", { className: "mono", children: "type, label, options, required, description" }), ". Separate options with ", _jsx("span", { className: "mono", children: "|" }), "; a row with type ", _jsx("span", { className: "mono", children: "section" }), " starts a section.", _jsx("br", {}), _jsx("b", { children: "PDF:" }), " numbered or bulleted lines become inspection checks or checkboxes, and headings become headings. Review everything before publishing."] }), _jsx("input", { ref: ref, type: "file", accept: ".csv,.txt,.pdf,text/csv,application/pdf", hidden: true, onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f)
                        void send(f); } }), _jsx(DropZone, { multiple: false, accept: ".csv,.txt,.pdf,text/csv,application/pdf", disabled: busy, label: "Drop the file to read it", onFiles: (fs) => void send(fs[0]), children: _jsxs("div", { className: "dropzone small", children: [_jsx(FileUp, { size: 18, className: "faint" }), _jsxs("span", { children: ["Drag a CSV or PDF here, or ", _jsx("button", { type: "button", className: "linkbtn", onClick: () => ref.current?.click(), disabled: busy, children: busy ? "reading…" : "choose a file" })] })] }) }), err && _jsx("div", { className: "banner warning small", children: err }), res && _jsxs(_Fragment, { children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: res.name, maxLength: 255, onChange: (e) => setRes({ ...res, name: e.target.value }) }) }), _jsxs("div", { className: "small muted", children: ["Found ", fieldsOf(res.schema).length, " fields", all.some((i) => i.type === "section") ? ` in ${all.filter((i) => i.type === "section").length} sections` : "", ":"] }), _jsxs("ul", { className: "pl-import-list small", children: [all.slice(0, 40).map((i) => _jsxs("li", { className: i.type, children: [i.label, _jsxs("span", { className: "faint", children: [" \u00B7 ", i.type.replace(/_/g, " ")] })] }, i.id)), all.length > 40 && _jsxs("li", { className: "faint", children: ["and ", all.length - 40, " more"] })] })] })] }) }));
}
