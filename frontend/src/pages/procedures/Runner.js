import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Procedures on a work order (r076: several per work order, each its own section): fill in fields, see progress and
// score, create corrective work orders on Fail / Flag / low score (r044/r179), add a library or one-off procedure (r210).
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ClipboardCheck, ClipboardList, MoreHorizontal, Plus, Search, Trash2, Wrench } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, Field, Input, Modal, Pill } from "../../components/ui";
import { FieldRow } from "./Fields";
import { ItemsEditor } from "./Builder";
import { isField, scoreOf, useLibrary, visibleIds } from "./types";
import "../../styles/procedures.css";
/** Renders a procedure's items (headings, sections, nested procedures, fields), hiding what conditions hide. */
export function ProcedureForm({ items, answers, ...rest }) {
    const values = useMemo(() => Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.skipped ? "__skipped__" : a.value])), [answers]);
    const vis = visibleIds(items, values);
    return _jsx("div", { className: "pr-form", children: items.filter((it) => vis.has(it.id)).map((it) => _jsx(ItemView, { it: it, vis: vis, answers: answers, ...rest }, it.id)) });
}
function ItemView({ it, vis, answers, onSave, ...rest }) {
    const [open, setOpen] = useState(true);
    if (it.type === "heading")
        return _jsx("h4", { className: "pr-heading", children: it.label });
    if (it.type === "section" || it.type === "procedure") {
        const kids = (it.items ?? []).filter((k) => vis.has(k.id));
        const fs = kids.filter((k) => isField(k.type));
        const done = fs.filter((k) => answers[k.id] && (answers[k.id].skipped || answers[k.id].value !== null && answers[k.id].value !== false)).length;
        return (_jsxs("div", { className: "pr-section" + (it.type === "procedure" ? " nested" : ""), children: [_jsxs("button", { type: "button", className: "pr-section-h", "aria-expanded": open, onClick: () => setOpen((o) => !o), children: [open ? _jsx(ChevronDown, { size: 16 }) : _jsx(ChevronRight, { size: 16 }), _jsx("span", { className: "grow", children: it.label || "Procedure" }), fs.length > 0 && _jsxs("span", { className: "small faint", children: [done, "/", fs.length] })] }), open && _jsxs("div", { className: "pr-section-b", children: [kids.map((k) => _jsx(ItemView, { it: k, vis: vis, answers: answers, onSave: onSave, ...rest }, k.id)), (it.items?.length ?? 0) === 0 && _jsx("div", { className: "small faint", children: "Empty section" })] })] }));
    }
    return _jsx(FieldRow, { item: it, answer: answers[it.id], onSave: (b) => onSave(it.id, b), ...rest });
}
/** Live preview (builder and library): answers kept locally. */
export function PreviewForm({ schema, refs }) {
    const [answers, setAnswers] = useState({});
    const score = scoreOf(schema, Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.value])));
    return (_jsxs("div", { className: "stack", style: { gap: 8 }, children: [schema.scoring?.enabled && _jsxs("div", { className: "row small muted", style: { justifyContent: "space-between" }, children: [_jsxs("span", { children: ["Score ", score === null ? "—" : `${score}%`] }), schema.scoring.goal !== null && _jsxs("span", { children: ["Goal ", schema.scoring.goal, "%"] })] }), schema.items.length === 0 ? _jsx("div", { className: "small faint", children: "Add fields to see them here." })
                : _jsx(ProcedureForm, { items: schema.items, answers: answers, preview: true, refs: refs, onSave: (fid, b) => {
                        if (!("value" in b))
                            return;
                        const v = b.value;
                        const result = typeof v === "string" && ["pass", "flag", "fail", "yes", "no", "na"].includes(v) ? v : "";
                        setAnswers((a) => ({ ...a, [fid]: { value: v, result, note: String(b.note ?? a[fid]?.note ?? ""), files: [], skipped: false, answered_by: null, answered_at: null } }));
                    } })] }));
}
// ------------------------------------------------------------------------------------------- on a work order
export function ProcedureRuns({ wo, onChange }) {
    const runs = (wo.procedures ?? []);
    const { can, session } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [adding, setAdding] = useState(false);
    const [prompt, setPrompt] = useState(null);
    const closed = wo.deleted || wo.status === "done" || wo.status === "canceled";
    const canFill = can("procedures.fill") && !closed;
    const canEdit = can("wo.edit") && !closed;
    if (!runs.length && !canEdit)
        return null;
    const setRun = (r) => qc.setQueryData(["work-order", wo.id], (prev) => prev ? { ...prev, procedures: (prev.procedures ?? []).map((x) => x.id === r.id ? r : x) } : prev);
    const save = async (run, fid, body) => {
        try {
            const res = await api(`/work-orders/${wo.id}/procedures/${run.id}/answers/${encodeURIComponent(fid)}`, { method: "PUT", body });
            setRun(res.run);
            if (res.corrective?.prompt)
                setPrompt({ run: res.run, p: res.corrective.prompt });
            if (res.corrective?.created)
                toast(`Created corrective work order #${res.corrective.created.number}`);
            onChange();
        }
        catch (e) {
            toast(e.message, { kind: "error" });
            throw e;
        }
    };
    return (_jsxs("section", { className: "pr-runs", "aria-label": "Procedures", children: [runs.map((r) => _jsx(RunCard, { wo: wo, run: r, canFill: canFill, canEdit: canEdit, tz: session.org?.timezone, onSave: (fid, b) => save(r, fid, b), onChange: onChange }, r.id)), canEdit && _jsx("div", { children: _jsxs(Button, { size: "sm", onClick: () => setAdding(true), children: [_jsx(Plus, { size: 15 }), "Add procedure"] }) }), adding && _jsx(AddProcedureDialog, { wo: wo, onClose: () => setAdding(false), onAdded: () => { setAdding(false); onChange(); } }), prompt && _jsx(CorrectiveDialog, { wo: wo, run: prompt.run, p: prompt.p, onClose: () => setPrompt(null), onCreated: () => { setPrompt(null); onChange(); } })] }));
}
function RunCard({ wo, run, canFill, canEdit, tz, onSave, onChange }) {
    const { toast } = useToast();
    const [confirm, setConfirm] = useState(false);
    const [open, setOpen] = useState(true);
    const remove = useMutation({ mutationFn: () => api(`/work-orders/${wo.id}/procedures/${run.id}`, { method: "DELETE" }),
        onSuccess: () => { setConfirm(false); toast("Procedure removed"); onChange(); }, onError: (e) => toast(e.message, { kind: "error" }) });
    const pct = run.progress.total ? Math.round((100 * run.progress.answered) / run.progress.total) : 0;
    const below = run.score !== null && run.goal !== null && run.score < run.goal;
    const answered = Object.keys(run.answers).length > 0;
    return (_jsxs("div", { className: "card pr-run", children: [_jsxs("div", { className: "pr-run-head", children: [_jsx("button", { type: "button", className: "pr-run-toggle", "aria-expanded": open, onClick: () => setOpen((o) => !o), "aria-label": open ? "Collapse" : "Expand", children: open ? _jsx(ChevronDown, { size: 18 }) : _jsx(ChevronRight, { size: 18 }) }), _jsx(ClipboardCheck, { size: 18, className: "faint" }), _jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsx("h3", { className: "pr-run-title", children: run.procedure?.name ?? "Procedure" }), _jsxs("div", { className: "small muted row wrap", style: { gap: 8 }, children: [_jsxs("span", { children: [run.progress.answered, " of ", run.progress.total, " done"] }), run.procedure && !run.procedure.one_off && _jsxs(Link, { to: `/procedures/${run.procedure.id}`, className: "faint", children: ["Version ", run.version] }), run.procedure?.one_off && _jsx("span", { className: "faint", children: "Only on this work order" }), run.status === "done" && _jsx(Pill, { tone: "success", children: "Completed" })] })] }), run.score !== null && _jsxs("div", { className: "pr-score" + (below ? " below" : ""), title: run.goal !== null ? `Goal ${run.goal}%` : undefined, children: [_jsxs("b", { children: [Math.round(run.score), "%"] }), run.goal !== null && _jsxs("span", { className: "small", children: ["goal ", run.goal, "%"] })] }), canEdit && _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { variant: "ghost", icon: true, "aria-label": "Procedure actions", onClick: t, children: _jsx(MoreHorizontal, { size: 18 }) }), width: 220, children: (close) => _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); setConfirm(true); }, children: [_jsx(Trash2, { size: 15 }), "Remove from work order"] }) })] }), _jsx("div", { className: "pr-progress", role: "progressbar", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": "Procedure progress", children: _jsx("span", { style: { width: `${pct}%` } }) }), open && _jsxs("div", { className: "pr-run-body", children: [_jsx(ProcedureForm, { items: run.schema.items, answers: run.answers, disabled: !canFill, tz: tz, refs: run.reference_files, onSave: onSave }), run.progress.missing_required.length > 0 && canFill && _jsxs("div", { className: "small muted pr-missing", children: ["Still needed to complete: ", run.progress.missing_required.slice(0, 6).join(", "), run.progress.missing_required.length > 6 ? "…" : ""] })] }), confirm && _jsx(Modal, { title: "Remove procedure?", onClose: () => setConfirm(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirm(false), children: "Keep it" }), _jsx(Button, { variant: "danger", onClick: () => remove.mutate(), disabled: remove.isPending, children: "Remove" })] }), children: _jsxs("p", { children: ["\u201C", run.procedure?.name, "\u201D comes off this work order", answered ? ", along with its answers" : "", "."] }) })] }));
}
function CorrectiveDialog({ wo, run, p, onClose, onCreated }) {
    const [title, setTitle] = useState(p.title);
    const { toast } = useToast();
    const create = useMutation({
        mutationFn: () => api(`/work-orders/${wo.id}/procedures/${run.id}/corrective`, { method: "POST", body: { field_id: p.field_id, title } }),
        onSuccess: (r) => { toast(`Created #${r.number}`, { action: { label: "Open", run: () => { window.location.assign(`/work-orders/${r.id}`); } } }); onCreated(); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const what = p.result === "low_score" ? `scored ${p.score}%, below the ${p.goal}% goal` : `was marked ${p.result === "fail" ? "Fail" : "Flag"}`;
    return (_jsxs(Modal, { title: "Create a corrective work order?", onClose: onClose, width: 480, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Not now" }), _jsxs(Button, { variant: "primary", disabled: !title.trim() || create.isPending, onClick: () => create.mutate(), children: [_jsx(Wrench, { size: 15 }), "Create work order"] })] }), children: [_jsxs("p", { children: [_jsx("b", { children: p.label }), " ", what, ". A follow-up work order keeps the fix from getting lost. It's linked to #", wo.number, " with the same asset and location."] }), _jsx(Field, { label: "Title", children: (id) => _jsx(Input, { id: id, value: title, maxLength: 255, onChange: (e) => setTitle(e.target.value) }) })] }));
}
export function AddProcedureDialog({ wo, onClose, onAdded }) {
    const lib = useLibrary(true);
    const { can } = useSession();
    const { toast } = useToast();
    const [tab, setTab] = useState("library");
    const [q, setQ] = useState("");
    const [name, setName] = useState("");
    const [items, setItems] = useState([]);
    const attached = new Set((wo.procedures ?? []).map((r) => r.procedure?.id));
    const add = useMutation({
        mutationFn: (body) => api(`/work-orders/${wo.id}/procedures`, { method: "POST", body }),
        onSuccess: (r) => { toast(`Added ${r.procedure?.name ?? "procedure"}`); onAdded(); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const shown = (lib.data?.items ?? []).filter((p) => !q || (p.name + " " + p.tags.join(" ") + " " + p.category).toLowerCase().includes(q.toLowerCase()));
    return (_jsxs(Modal, { title: "Add procedure", onClose: onClose, width: tab === "one_off" ? 760 : 560, footer: tab === "one_off" ? _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !name.trim() || !items.some((i) => isField(i.type) || (i.items ?? []).length) || add.isPending, onClick: () => add.mutate({ name, schema: { items, scoring: { enabled: false, goal: null } } }), children: "Add to work order" })] }) : undefined, children: [_jsxs("div", { className: "seg", role: "tablist", "aria-label": "Source", style: { marginBottom: 12 }, children: [_jsx("button", { type: "button", role: "tab", "aria-selected": tab === "library", className: "seg-btn" + (tab === "library" ? " on" : ""), onClick: () => setTab("library"), children: "From the library" }), _jsx("button", { type: "button", role: "tab", "aria-selected": tab === "one_off", className: "seg-btn" + (tab === "one_off" ? " on" : ""), onClick: () => setTab("one_off"), children: "Just for this work order" })] }), tab === "library" ? (_jsxs("div", { className: "stack", style: { gap: 8 }, children: [_jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search procedures", "aria-label": "Search procedures", value: q, onChange: (e) => setQ(e.target.value), autoFocus: true })] }), _jsx("div", { className: "pr-pick-list", children: lib.isLoading ? _jsx("div", { className: "small faint", style: { padding: 12 }, children: "Loading\u2026" }) : shown.length === 0
                            ? _jsx(EmptyState, { icon: _jsx(ClipboardList, { size: 24 }), title: q ? "No procedures match" : "No published procedures", children: can("procedures.manage") ? _jsxs(_Fragment, { children: ["Build one in ", _jsx(Link, { to: "/procedures", children: "Procedures" }), ", or make one just for this work order."] }) : "Ask an administrator to publish one." })
                            : shown.map((p) => (_jsxs("button", { type: "button", className: "pr-pick", disabled: add.isPending || attached.has(p.id), onClick: () => add.mutate({ procedure_id: p.id }), children: [_jsx(ClipboardCheck, { size: 18, className: "faint" }), _jsxs("span", { className: "grow", style: { minWidth: 0 }, children: [_jsx("b", { children: p.name }), _jsxs("span", { className: "small muted", style: { display: "block" }, children: [p.field_count, " fields", p.category ? ` · ${p.category}` : "", p.tags.length ? ` · ${p.tags.join(", ")}` : ""] })] }), attached.has(p.id) ? _jsx("span", { className: "small faint", children: "Added" }) : _jsx(Plus, { size: 16, className: "faint" })] }, p.id))) })] })) : (_jsxs("div", { className: "stack", style: { gap: 10 }, children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: name, maxLength: 255, onChange: (e) => setName(e.target.value), placeholder: "e.g. Extra checks for this job" }) }), _jsx("p", { className: "small muted", style: { margin: 0 }, children: "It's saved with this work order only and doesn't appear in the library." }), _jsx(ItemsEditor, { items: items, onChange: setItems, scoring: false, compact: true })] }))] }));
}
