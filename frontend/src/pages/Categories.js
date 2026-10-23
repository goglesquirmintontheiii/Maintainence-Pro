import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Tags, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { useToast } from "../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal } from "../components/ui";
import { ColorPicker } from "../components/ColorPicker";
const COLORS = ["#1b5bd4", "#0a7f96", "#13805a", "#b8560b", "#c37a06", "#7a52c9", "#c4302b", "#3d6fb6", "#5d6880"];
export function Categories() {
    const { can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [q, setQ] = useState("");
    const [edit, setEdit] = useState(null);
    const [del, setDel] = useState(null);
    const data = useQuery({ queryKey: ["categories", q], queryFn: () => api(`/categories?q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
    const remove = useMutation({ mutationFn: (c) => api(`/categories/${c.id}`, { method: "DELETE" }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["categories"] }); qc.invalidateQueries({ queryKey: ["wo-options"] }); setDel(null); toast("Category deleted"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    const manage = can("categories.manage");
    return (_jsxs("div", { className: "page", children: [_jsxs("div", { className: "page-head", children: [_jsxs("div", { children: [_jsx("h1", { children: "Categories" }), _jsx("p", { className: "sub", children: "Label work orders by type of work, so you can filter, report and route them. A work order can have several." })] }), manage && _jsxs(Button, { variant: "primary", onClick: () => setEdit("new"), children: [_jsx(Plus, { size: 16 }), "New category"] })] }), _jsxs("div", { className: "search-in", style: { maxWidth: 360 }, children: [_jsx(Search, { size: 15, className: "faint" }), _jsx(Input, { placeholder: "Search categories", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search categories" })] }), _jsx("section", { className: "card", children: data.isLoading ? _jsx(ListSkeleton, {}) : data.data?.items.length === 0 ? _jsx(EmptyState, { icon: _jsx(Tags, { size: 26 }), title: "No categories", children: q ? "Nothing matches." : "Create categories like Electrical, Safety or Inspection." }) : (_jsx("div", { className: "table-wrap", children: _jsxs("table", { className: "table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Name" }), _jsx("th", { children: "Description" }), _jsx("th", { className: "num", children: "Work orders" }), manage && _jsx("th", {})] }) }), _jsx("tbody", { children: data.data?.items.map((c) => (_jsxs("tr", { children: [_jsx("td", { children: _jsxs("span", { className: "row", children: [_jsx("span", { className: "sw lg", style: { background: c.color } }), _jsx("b", { children: c.name })] }) }), _jsx("td", { className: "muted", children: c.description || _jsx("span", { className: "faint", children: "\u2014" }) }), _jsx("td", { className: "num", children: _jsx(Link, { to: `/work-orders?view=table`, onClick: () => { try {
                                                    sessionStorage.setItem("wo.filters", JSON.stringify([{ field: "category", op: "in", value: [c.id] }]));
                                                }
                                                catch { /* ignore */ } }, children: c.work_order_count ?? 0 }) }), manage && _jsxs("td", { className: "num", style: { whiteSpace: "nowrap" }, children: [_jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Edit ${c.name}`, onClick: () => setEdit(c), children: _jsx(Pencil, { size: 14 }) }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": `Delete ${c.name}`, onClick: () => setDel(c), children: _jsx(Trash2, { size: 14 }) })] })] }, c.id))) })] }) })) }), edit && _jsx(CategoryModal, { cat: edit === "new" ? undefined : edit, onClose: () => setEdit(null) }), del && _jsx(Modal, { title: `Delete ${del.name}?`, onClose: () => setDel(null), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setDel(null), children: "Keep it" }), _jsx(Button, { variant: "danger", className: "solid", onClick: () => remove.mutate(del), children: "Delete" })] }), children: _jsxs("p", { children: ["It will be removed from ", del.work_order_count ?? 0, " work order", del.work_order_count === 1 ? "" : "s", ". Their history keeps the old label."] }) })] }));
}
function CategoryModal({ cat, onClose }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const [f, setF] = useState({ name: cat?.name ?? "", color: cat?.color ?? COLORS[0], description: cat?.description ?? "" });
    const [err, setErr] = useState("");
    const m = useMutation({
        mutationFn: () => cat ? api(`/categories/${cat.id}`, { method: "PATCH", body: f }) : api("/categories", { method: "POST", body: f }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ["categories"] }); qc.invalidateQueries({ queryKey: ["wo-options"] }); toast(cat ? "Category saved" : "Category created"); onClose(); },
        onError: (e) => setErr(e.message),
    });
    return (_jsxs(Modal, { title: cat ? "Edit category" : "New category", onClose: onClose, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || m.isPending, onClick: () => m.mutate(), children: cat ? "Save" : "Create" })] }), children: [_jsx(Field, { label: "Name", children: (id) => _jsx(Input, { id: id, value: f.name, maxLength: 80, onChange: (e) => setF({ ...f, name: e.target.value }), placeholder: "e.g. Pneumatics" }) }), _jsx(Field, { label: "Description (optional)", children: (id) => _jsx(Input, { id: id, value: f.description, maxLength: 500, onChange: (e) => setF({ ...f, description: e.target.value }) }) }), _jsxs("div", { className: "field", children: [_jsx("span", { className: "label", children: "Colour" }), _jsx(ColorPicker, { value: f.color, onChange: (c) => setF({ ...f, color: c }), presets: COLORS })] }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
