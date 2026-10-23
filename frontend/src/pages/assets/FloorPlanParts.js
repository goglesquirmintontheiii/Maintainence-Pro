import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Parts lists pinned on a floor plan (0.5.0, MP-128): a small card at a spot on the plan that expands to the parts
// kept there and how many are on hand. Stored as a "parts" shape in the drawing, so it moves, undoes and saves with
// the rest of the edits. Stock comes live from GET /parts?ids=…
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Package, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Button, Checkbox, Field, Input, Modal } from "../../components/ui";
function usePartsById(ids, enabled) {
    const key = [...ids].sort().join(",");
    return useQuery({
        queryKey: ["parts-by-id", key],
        queryFn: () => api(`/parts?ids=${key}&per_page=100`),
        enabled: enabled && ids.length > 0, staleTime: 30_000,
    });
}
const fmtQty = (v) => (v === null || v === undefined ? "—" : String(Number(v)));
/** One pinned list. In the editor the card carries data-sid so it can be selected and moved like any shape. */
export function PartsListCard({ s, editing, onToggleDefault, onOpenPart }) {
    const { can } = useSession();
    const [openLocal, setOpenLocal] = useState(null);
    const open = editing ? !!s.open : openLocal ?? !!s.open;
    const ids = s.part_ids ?? [];
    const allowed = can("parts.view");
    const q = usePartsById(ids, open && allowed);
    const byId = new Map((q.data?.items ?? []).map((p) => [p.id, p]));
    const rows = ids.map((id) => byId.get(id)).filter((p) => !!p);
    const title = s.label || "Parts";
    return (_jsxs("div", { className: "plan-parts" + (open ? " open" : ""), "data-sid": editing ? s.id : undefined, style: { left: `${(s.x ?? 0) * 100}%`, top: `${(s.y ?? 0) * 100}%` }, onPointerDown: editing ? undefined : (e) => e.stopPropagation(), children: [_jsxs("button", { type: "button", className: "plan-parts-head", "aria-expanded": open, onPointerDown: editing ? (e) => e.stopPropagation() : undefined, onClick: (e) => { e.stopPropagation(); if (editing)
                    onToggleDefault?.(!open);
                else
                    setOpenLocal(!open); }, title: editing ? "Choose whether this list starts expanded" : undefined, children: [open ? _jsx(ChevronDown, { size: 14 }) : _jsx(ChevronRight, { size: 14 }), _jsx(Package, { size: 14, "aria-hidden": true }), _jsx("span", { className: "plan-parts-t", children: title }), _jsx("span", { className: "plan-parts-n", children: ids.length })] }), open && (_jsx("div", { className: "plan-parts-body", children: !allowed ? _jsx("div", { className: "small faint", children: "You don't have access to parts." })
                    : q.isLoading ? _jsx("div", { className: "small faint", children: "Loading\u2026" })
                        : q.isError ? _jsx("div", { className: "small faint", children: "Couldn't load the parts." })
                            : rows.length === 0 ? _jsx("div", { className: "small faint", children: "These parts were removed." })
                                : _jsx("ul", { children: rows.map((p) => {
                                        const n = Number(p.on_hand);
                                        const tone = p.on_hand === null ? "" : n <= 0 ? " out" : "";
                                        return (_jsxs("li", { children: [editing ? _jsx("span", { className: "grow", children: p.name })
                                                    : _jsx(Link, { className: "grow", to: `/parts/${p.id}`, onClick: () => onOpenPart?.(), children: p.name }), _jsxs("span", { className: "tnum plan-parts-q" + tone, title: "On hand", children: [fmtQty(p.on_hand), " ", p.unit] })] }, p.id));
                                    }) }) }))] }));
}
/** Pick the parts for a pinned list (new or edited). */
export function PartsListDialog({ current, onClose, onSave }) {
    const [q, setQ] = useState("");
    const [picked, setPicked] = useState(current?.part_ids ?? []);
    const [label, setLabel] = useState(current?.label ?? "");
    const [open, setOpen] = useState(current?.open ?? true);
    const found = useQuery({
        queryKey: ["parts-search", q],
        queryFn: () => api(`/parts?per_page=30&sort=name&q=${encodeURIComponent(q)}`),
        placeholderData: (p) => p,
    });
    const chosen = usePartsById(picked, true);
    const names = new Map([...(chosen.data?.items ?? []), ...(found.data?.items ?? [])].map((p) => [p.id, p.name]));
    const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 50 ? p : [...p, id]));
    return (_jsxs(Modal, { title: current ? "Edit parts list" : "Pin a parts list", onClose: onClose, width: 520, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !picked.length, onClick: () => onSave({ part_ids: picked, label: label.trim(), open }), children: current ? "Save list" : "Pin list" })] }), children: [_jsx(Field, { label: "Title", hint: "Optional, e.g. \u201CSpares by press 2\u201D.", children: (id) => _jsx(Input, { id: id, value: label, maxLength: 120, placeholder: "Parts", onChange: (e) => setLabel(e.target.value) }) }), picked.length > 0 && _jsx("div", { className: "row wrap", style: { gap: 6 }, "aria-label": "Chosen parts", children: picked.map((id) => (_jsxs("button", { type: "button", className: "chip", onClick: () => toggle(id), "aria-label": `Remove ${names.get(id) ?? "part"}`, children: [names.get(id) ?? "Part", " \u00D7"] }, id))) }), _jsxs("div", { className: "search-in", children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search parts by name or number", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search parts", autoFocus: true })] }), _jsxs("div", { className: "plan-parts-pick", role: "group", "aria-label": "Parts", children: [(found.data?.items ?? []).map((p) => (_jsx(Checkbox, { checked: picked.includes(p.id), onChange: () => toggle(p.id), label: _jsxs("span", { className: "row", style: { gap: 8 }, children: [_jsx("span", { className: "grow", children: p.name }), _jsxs("span", { className: "small faint tnum", children: [fmtQty(p.on_hand), " ", p.unit] })] }) }, p.id))), found.data && found.data.items.length === 0 && _jsx("div", { className: "small faint", children: "No parts match." })] }), _jsx(Checkbox, { checked: open, onChange: setOpen, label: "Show the list expanded" }), picked.length >= 50 && _jsx("div", { className: "small muted", children: "A list can hold up to 50 parts." })] }));
}
