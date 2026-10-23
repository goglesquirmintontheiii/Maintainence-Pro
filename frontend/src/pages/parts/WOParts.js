import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Parts on a work order (r029, r042, r219, r220): the section on the WO detail, the field on the WO form,
// and the cycle count lines when the work order is a count.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Package, Plus, Trash2, Undo2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, Field, Input, Modal, Pill, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { RunPanel } from "./CycleCounts";
import { qsOf, qty, STATUS_OPTIONS } from "./types";
import "./parts.css";
const AVAIL = {
    available: { tone: "success", label: "Available" }, partial: { tone: "warning", label: "Partly available" }, unavailable: { tone: "danger", label: "Not available" },
    issued: { tone: "info", label: "Used" }, none: { tone: "neutral", label: "Non-stock" },
};
function usePartPicker(search) {
    return useQuery({ queryKey: ["parts", "picker", search], queryFn: () => api(`/parts?per_page=50&sort=name&${qsOf({ q: search })}`), placeholderData: (p) => p });
}
/** Parts section on the work-order detail. */
export function WOPartsSection({ wo }) {
    const { can, session } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["wo-parts", wo.id], queryFn: () => api(`/work-orders/${wo.id}/parts`), enabled: can("parts.view") });
    const count = useQuery({ queryKey: ["wo-count", wo.id], queryFn: () => api(`/work-orders/${wo.id}/cycle-count`), enabled: can("parts.view") });
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState(null);
    const closed = ["done", "canceled"].includes(wo.status);
    const editable = can("parts.use") && !closed;
    const refresh = () => { qc.invalidateQueries({ queryKey: ["wo-parts", wo.id] }); qc.invalidateQueries({ queryKey: ["part"] }); qc.invalidateQueries({ queryKey: ["parts"] }); qc.invalidateQueries({ queryKey: ["wo", wo.id] }); };
    const err = (e) => toast(e.message, { kind: "error" });
    const patch = useMutation({ mutationFn: ({ l, body }) => api(`/work-orders/${wo.id}/parts/${l.id}`, { method: "PATCH", body }), onSuccess: refresh, onError: err });
    const ret = useMutation({ mutationFn: (l) => api(`/work-orders/${wo.id}/parts/${l.id}/return`, { method: "POST", body: {} }), onSuccess: () => { refresh(); toast("Returned to stock"); }, onError: err });
    const del = useMutation({ mutationFn: (l) => api(`/work-orders/${wo.id}/parts/${l.id}`, { method: "DELETE" }), onSuccess: refresh, onError: err });
    const items = q.data?.items ?? [];
    const cur = session.org?.currency;
    if (!can("parts.view"))
        return null;
    return (_jsxs(_Fragment, { children: [count.data?.run && _jsx(RunPanel, { run: count.data.run, onChange: () => count.refetch() }), (items.length > 0 || editable) && _jsxs("section", { className: "card wo-parts", children: [_jsxs("div", { className: "card-head", children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Parts" }), editable && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setAdding(true), children: [_jsx(Plus, { size: 14 }), "Add parts"] })] }), items.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No parts yet. Add what you used, or plan and reserve what the job needs." })
                        : items.map((l) => (_jsxs("div", { className: "list-row wo-part-row", children: [_jsx(Package, { size: 16, className: "faint" }), _jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsx("div", { className: "t", children: l.part.deleted ? l.part.name : _jsx(Link, { to: `/parts/${l.part.id}`, children: l.part.name }) }), _jsx("div", { className: "s", children: [l.part.part_number, l.location?.name, l.note].filter(Boolean).join(" · ") || " " })] }), _jsx("span", { className: "wo-part-qty", children: l.status === "issued" ? qty(l.used, l.part.unit) : qty(l.quantity, l.part.unit) }), _jsx(Pill, { tone: l.status === "issued" ? "info" : "neutral", children: l.status_label }), l.status !== "issued" && !l.part.non_stock && _jsxs(Pill, { tone: AVAIL[l.availability.state]?.tone ?? "neutral", children: [AVAIL[l.availability.state]?.label, l.availability.state === "partial" && l.availability.available ? ` (${l.availability.available})` : ""] }), l.status !== "issued" && l.availability.overcommitted && _jsx(Pill, { tone: "danger", children: "Overcommitted" }), q.data?.costs_visible && _jsx("span", { className: "small muted wo-part-cost", children: currency(l.line_cost, cur) }), editable && _jsx(Dropdown, { trigger: (_, t) => _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Actions for ${l.part.name}`, onClick: t, children: _jsx(MoreHorizontal, { size: 15 }) }), width: 220, children: (close) => _jsxs(_Fragment, { children: [l.status !== "issued" && _jsxs("button", { className: "menu-item", onClick: () => { close(); patch.mutate({ l, body: { status: "issued" } }); }, children: [_jsx(Package, { size: 15 }), "Mark as used"] }), _jsx("button", { className: "menu-item", onClick: () => { close(); setEditing(l); }, children: "Change quantity or status" }), l.status === "issued" && Number(l.used) > 0 && _jsxs("button", { className: "menu-item", onClick: () => { close(); ret.mutate(l); }, children: [_jsx(Undo2, { size: 15 }), "Return to stock"] }), _jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); del.mutate(l); }, children: [_jsx(Trash2, { size: 15 }), "Remove"] })] }) })] }, l.id))), q.data?.costs_visible && items.length > 0 && _jsxs("div", { className: "card-body row", style: { justifyContent: "flex-end" }, children: [_jsx("span", { className: "small muted", children: "Parts total" }), _jsx("b", { children: currency(q.data.total_cost, cur) })] })] }), adding && _jsx(AddPartsDialog, { woId: wo.id, onClose: () => setAdding(false), onDone: refresh }), editing && _jsx(EditLineDialog, { woId: wo.id, l: editing, onClose: () => setEditing(null), onDone: refresh })] }));
}
function AddPartsDialog({ woId, onClose, onDone }) {
    const [search, setSearch] = useState("");
    const parts = usePartPicker(search);
    const [rows, setRows] = useState([]);
    const [err, setErr] = useState("");
    const add = useMutation({
        mutationFn: async () => {
            for (const r of rows)
                await api(`/work-orders/${woId}/parts`, { method: "POST", body: { part_id: r.part_id, quantity: r.quantity, status: r.status, ...(r.location_id !== undefined ? { location_id: r.location_id } : {}) } });
        },
        onSuccess: () => { onDone(); onClose(); },
        onError: (e) => { setErr(e.message); onDone(); },
    });
    const pick = async (ids) => {
        const keep = rows.filter((r) => ids.includes(r.part_id));
        const added = ids.filter((id) => !rows.some((r) => r.part_id === id));
        const found = (parts.data?.items ?? []).filter((p) => added.includes(p.id));
        const fresh = await Promise.all(found.map(async (p) => {
            let stocks = [];
            try {
                const d = await api(`/parts/${p.id}`);
                stocks = d.stock.map((s) => ({ id: s.location?.id ?? null, name: `${s.location?.name ?? "No location"} (${s.on_hand})` }));
            }
            catch { /* keep empty */ }
            return { part_id: p.id, name: p.name, unit: p.unit, quantity: "1", location_id: stocks[0]?.id ?? null, status: "issued", stocks };
        }));
        setRows([...keep, ...fresh]);
    };
    return (_jsxs(Modal, { title: "Add parts", onClose: onClose, width: 640, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsxs(Button, { variant: "primary", disabled: !rows.length || add.isPending, onClick: () => add.mutate(), children: ["Add ", rows.length || "", " part", rows.length === 1 ? "" : "s"] })] }), children: [_jsx(MultiPicker, { label: "Parts", placeholder: "Search parts by name, number or barcode", value: rows.map((r) => r.part_id), onChange: pick, searchPlaceholder: "Search parts", options: [...rows.map((r) => ({ key: r.part_id, label: r.name })), ...(parts.data?.items ?? []).filter((p) => !rows.some((r) => r.part_id === p.id)).map((p) => ({
                        key: p.id, label: p.name, sub: [p.part_number, p.non_stock ? "Non-stock" : `${qty(p.available, p.unit)} available`].filter(Boolean).join(" · ")
                    }))] }), _jsx(Input, { "aria-label": "Filter parts", value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Narrow the list (name, number, barcode)" }), rows.map((r, i) => {
                const upd = (p) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...p } : x)));
                return (_jsxs("div", { className: "wo-add-row", children: [_jsx("b", { className: "grow", children: r.name }), _jsx(Input, { "aria-label": `Quantity of ${r.name}`, inputMode: "decimal", value: r.quantity, onChange: (e) => upd({ quantity: e.target.value }) }), r.stocks.length > 1 && _jsx(Select, { "aria-label": `Location for ${r.name}`, value: r.location_id ?? "none", onChange: (e) => upd({ location_id: e.target.value === "none" ? null : e.target.value }), children: r.stocks.map((s) => _jsx("option", { value: s.id ?? "none", children: s.name }, s.id ?? "none")) }), _jsx(Select, { "aria-label": `Status of ${r.name}`, value: r.status, onChange: (e) => upd({ status: e.target.value }), children: STATUS_OPTIONS.map(([k, l]) => _jsx("option", { value: k, children: l }, k)) })] }, r.part_id));
            }), _jsx("p", { className: "small faint", style: { margin: 0 }, children: "Used takes the parts out of stock now. Planned, Reserved, Kitted and Staged hold them for this work order; they're used when it's done." }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
function EditLineDialog({ woId, l, onClose, onDone }) {
    const { can } = useSession();
    const [quantity, setQuantity] = useState(l.quantity);
    const [status, setStatus] = useState(l.status);
    const [override, setOverride] = useState(l.unit_cost_override ?? "");
    const [note, setNote] = useState(l.note);
    const [err, setErr] = useState("");
    const m = useMutation({
        mutationFn: () => api(`/work-orders/${woId}/parts/${l.id}`, { method: "PATCH", body: { quantity, status, note, ...(can("costs.view") ? { unit_cost_override: override || null } : {}) } }),
        onSuccess: () => { onDone(); onClose(); }, onError: (e) => setErr(e.message),
    });
    return (_jsxs(Modal, { title: l.part.name, onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: m.isPending, onClick: () => m.mutate(), children: "Save" })] }), children: [_jsxs("div", { className: "part-grid2", children: [_jsx(Field, { label: `Quantity${l.part.unit !== "each" ? ` (${l.part.unit})` : ""}`, children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: quantity, onChange: (e) => setQuantity(e.target.value) }) }), _jsx(Field, { label: "Status", children: (id) => _jsx(Select, { id: id, value: status, onChange: (e) => setStatus(e.target.value), children: STATUS_OPTIONS.map(([k, lb]) => _jsx("option", { value: k, children: lb }, k)) }) })] }), can("costs.view") && _jsx(Field, { label: "Unit cost on this work order", hint: "Leave empty to use the part's cost.", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: override, placeholder: l.unit_cost ?? "", onChange: (e) => setOverride(e.target.value) }) }), _jsx(Field, { label: "Note", children: (id) => _jsx(Input, { id: id, value: note, maxLength: 500, onChange: (e) => setNote(e.target.value) }) }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
/** On the new-work-order form: parts the job needs (added as Planned; r219). */
export function WOFormParts({ value, onChange }) {
    const { can } = useSession();
    const [search, setSearch] = useState("");
    const parts = usePartPicker(search);
    if (!can("parts.use"))
        return null;
    return (_jsxs("div", { className: "stack", style: { gap: 6 }, children: [_jsx(MultiPicker, { label: "Parts", placeholder: "Add parts the job needs", value: value.map((v) => v.part_id), searchPlaceholder: "Search parts", onChange: (ids) => onChange([...value.filter((v) => ids.includes(v.part_id)),
                    ...(parts.data?.items ?? []).filter((p) => ids.includes(p.id) && !value.some((v) => v.part_id === p.id)).map((p) => ({ part_id: p.id, name: p.name, quantity: "1" }))]), options: [...value.map((v) => ({ key: v.part_id, label: v.name })), ...(parts.data?.items ?? []).filter((p) => !value.some((v) => v.part_id === p.id))
                        .map((p) => ({ key: p.id, label: p.name, sub: [p.part_number, p.non_stock ? "Non-stock" : `${qty(p.available, p.unit)} available`].filter(Boolean).join(" · ") }))] }), value.length === 0 && _jsx(Input, { "aria-label": "Filter parts", value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Narrow the parts list" }), value.map((v, i) => _jsxs("div", { className: "wo-add-row", children: [_jsx("span", { className: "grow", children: v.name }), _jsx(Input, { "aria-label": `Quantity of ${v.name}`, inputMode: "decimal", value: v.quantity, onChange: (e) => onChange(value.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x))) })] }, v.part_id))] }));
}
