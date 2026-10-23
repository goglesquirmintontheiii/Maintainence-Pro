import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Create or edit a purchase order (MP-042): vendor, lines (parts or free text), taxes and additional costs,
// addresses, budget and due date. People who can only request POs get a "Submit request" button.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Lock, Package, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency } from "../../lib/format";
import { Button, Checkbox, Drawer, Field, Input, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { LocationPicker } from "../../components/assetPickers";
import { usePOOptions } from "./types";
const blankLine = () => ({ part_id: null, description: "", part_number: "", unit: "each", quantity: "1", unit_cost: "", location_id: null, taxable: true });
export function useVendorsLite() {
    return useQuery({ queryKey: ["vendors", "lite"], queryFn: () => api("/vendors?per_page=500&sort=name"), staleTime: 30_000 });
}
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
export function POForm({ edit, prefill, onClose, onSaved }) {
    const opts = usePOOptions();
    const vendors = useVendorsLite();
    const { session } = useSession();
    const can = opts.data?.can;
    const manager = !!can?.manage;
    const costsVisible = can ? can.costs : true;
    const [vendorId, setVendorId] = useState(edit?.vendor?.id ?? prefill?.vendor_id ?? "");
    const [title, setTitle] = useState(edit?.title ?? "");
    const [customNumber, setCustomNumber] = useState(edit?.custom_number ?? "");
    const [due, setDue] = useState(edit?.due_on ?? "");
    const [notes, setNotes] = useState(edit?.notes ?? "");
    const [contacts, setContacts] = useState(edit?.vendor_contact_ids ?? []);
    const [ship, setShip] = useState(edit?.shipping_address?.id ?? "");
    const [bill, setBill] = useState(edit?.billing_address?.id ?? "");
    const [budget, setBudget] = useState(edit?.budget?.budget_id ?? "");
    const [lines, setLines] = useState(() => edit ? edit.lines.map((l) => ({ id: l.id, part_id: l.part?.id ?? null, part_name: l.part?.name, description: l.description,
        part_number: l.part_number, unit: l.unit, quantity: l.quantity, unit_cost: l.unit_cost ?? "", location_id: l.location_id, taxable: l.taxable, locked: l.locked, received: l.received })) : []);
    const [costs, setCosts] = useState(() => (edit?.costs ?? []).map((c) => ({ label: c.label, kind: c.kind, value: c.value, is_tax: c.is_tax, taxable: c.taxable })));
    const [err, setErr] = useState("");
    const [warnings, setWarnings] = useState([]);
    // "Order this part" handoff: /purchase-orders?new=1&part_id=…&vendor_id=…&quantity=…
    const prePart = useQuery({ queryKey: ["part", prefill?.part_id], enabled: !edit && !!prefill?.part_id,
        queryFn: () => api(`/parts/${prefill?.part_id}`) });
    useEffect(() => {
        const p = prePart.data;
        if (!p || lines.length)
            return;
        const pv = p.vendors.find((v) => v.vendor.id === prefill?.vendor_id) ?? p.vendors.find((v) => v.preferred) ?? p.vendors[0];
        if (!vendorId && pv)
            setVendorId(pv.vendor.id);
        const restock = p.stock.find((s) => Number(s.restock_quantity) > 0);
        setLines([{ part_id: p.id, part_name: p.name, description: p.name, part_number: pv?.vendor_part_number || p.part_number, unit: p.unit,
                quantity: prefill?.quantity || restock?.restock_quantity || "1", unit_cost: pv?.unit_cost ?? p.unit_cost ?? "", location_id: restock?.location?.id ?? null, taxable: true }]);
    }, [prePart.data]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (!edit && !prefill?.part_id && !lines.length)
        setLines([blankLine()]); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const vendor = vendors.data?.items.find((v) => v.id === vendorId);
    const cur = vendor?.currency || edit?.currency || session.org?.currency || "USD";
    const totals = useMemo(() => {
        const sub = lines.reduce((s, l) => s + n(l.quantity) * n(l.unit_cost), 0);
        let taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + n(l.quantity) * n(l.unit_cost), 0);
        let extra = 0;
        for (const c of costs.filter((c) => !c.is_tax)) {
            const a = c.kind === "fixed" ? n(c.value) : sub * n(c.value) / 100;
            extra += a;
            if (c.taxable)
                taxable += a;
        }
        for (const c of costs.filter((c) => c.is_tax))
            extra += c.kind === "fixed" ? n(c.value) : taxable * n(c.value) / 100;
        return { sub, total: sub + extra };
    }, [lines, costs]);
    const body = (asRequest) => ({
        vendor_id: vendorId || null, title, custom_number: customNumber, due_on: due || null, notes, vendor_contact_ids: vendorId ? contacts : [],
        shipping_address_id: ship || null, billing_address_id: bill || null, budget_id: budget || null,
        lines: lines.filter((l) => l.description.trim() || l.part_id).map((l) => ({ id: l.id, part_id: l.part_id, description: l.description, part_number: l.part_number, unit: l.unit,
            quantity: l.quantity, unit_cost: costsVisible ? l.unit_cost : undefined, location_id: l.location_id, taxable: l.taxable })),
        ...(costsVisible ? { costs } : {}),
        ...(edit ? { version: edit.version } : { as_request: asRequest, work_order_id: prefill?.work_order_id }),
    });
    const save = useMutation({
        mutationFn: (asRequest) => edit ? api(`/purchase-orders/${edit.id}`, { method: "PATCH", body: body(false) }) : api("/purchase-orders", { method: "POST", body: body(asRequest) }),
        onSuccess: (po) => { if (po.warnings?.length)
            setWarnings(po.warnings); onSaved(po); },
        onError: (e) => setErr(e.message),
    });
    const setLine = (i, p) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
    const valid = lines.some((l) => l.description.trim() || l.part_id) && lines.every((l) => (!l.description.trim() && !l.part_id) || n(l.quantity) > 0);
    return (_jsx(Drawer, { title: edit ? `Edit ${edit.display_number}` : "New Purchase Order", onClose: onClose, width: 760, footer: _jsxs(_Fragment, { children: [_jsx("span", { className: "grow small muted", children: costsVisible && _jsxs(_Fragment, { children: ["Total ", _jsx("b", { children: currency(totals.total, cur) })] }) }), _jsx(Button, { onClick: onClose, children: "Cancel" }), !edit && manager && _jsx(Button, { onClick: () => save.mutate(true), disabled: !valid || save.isPending, title: "Save it as a request someone reviews first", children: "Save as request" }), _jsx(Button, { variant: "primary", disabled: !valid || save.isPending, onClick: () => save.mutate(false), children: edit ? "Save" : manager ? "Create" : "Submit request" })] }), children: _jsxs("div", { className: "stack po-form", style: { gap: 14 }, children: [!edit && !manager && _jsx("div", { className: "banner info", children: "This becomes a request. Someone who manages purchase orders reviews it before it's ordered." }), _jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Vendor", children: (id) => (_jsx(MultiPicker, { id: id, single: true, label: "Vendor", placeholder: "Pick a vendor", value: vendorId ? [vendorId] : [], onChange: (v) => { setVendorId(v[0] ?? ""); setContacts([]); }, options: (vendors.data?.items ?? []).map((v) => ({ key: v.id, label: v.name })) })) }), _jsx(Field, { label: "Title", children: (id) => _jsx(Input, { id: id, value: title, maxLength: 255, placeholder: opts.data?.settings.default_title || "Purchase Order", onChange: (e) => setTitle(e.target.value) }) }), _jsx(Field, { label: "Due date", hint: "When you expect it to arrive", children: (id) => _jsx(Input, { id: id, type: "date", value: due, onChange: (e) => setDue(e.target.value) }) }), _jsx(Field, { label: "PO number", hint: `Leave empty for the next number (${opts.data?.settings.number_prefix ?? "PO-"}…)`, children: (id) => _jsx(Input, { id: id, value: customNumber, maxLength: 60, onChange: (e) => setCustomNumber(e.target.value) }) })] }), vendor && vendor.contacts.length > 0 && _jsx(Field, { label: "Send to", hint: "Leave empty to use the vendor's purchase order contact", children: (id) => (_jsx(MultiPicker, { id: id, label: "Vendor contacts", placeholder: "Purchase order contact", value: contacts, onChange: setContacts, options: vendor.contacts.map((c) => ({ key: c.id, label: c.name, sub: c.email + (c.is_po_contact ? " · PO contact" : "") })) })) }), _jsxs("section", { children: [_jsx("h3", { className: "sec-h", children: "Items" }), _jsx("div", { className: "po-lines", children: lines.map((l, i) => _jsx(LineEditor, { l: l, costs: costsVisible, cur: cur, onChange: (p) => setLine(i, p), onRemove: l.locked ? undefined : () => setLines((ls) => ls.filter((_, j) => j !== i)) }, l.id ?? `n${i}`)) }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setLines((ls) => [...ls, blankLine()]), children: [_jsx(Plus, { size: 14 }), "Add item"] })] }), costsVisible && _jsxs("section", { children: [_jsx("h3", { className: "sec-h", children: "Taxes and additional costs" }), costs.map((c, i) => (_jsxs("div", { className: "po-cost-row", children: [_jsx(Input, { "aria-label": "Label", value: c.label, placeholder: c.is_tax ? "Sales tax" : "Shipping", onChange: (e) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, label: e.target.value } : x)) }), _jsxs(Select, { "aria-label": "Type", value: `${c.is_tax ? "tax" : "cost"}`, onChange: (e) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, is_tax: e.target.value === "tax", taxable: e.target.value === "tax" ? false : x.taxable } : x)), children: [_jsx("option", { value: "cost", children: "Additional cost" }), _jsx("option", { value: "tax", children: "Tax" })] }), _jsxs(Select, { "aria-label": "Fixed or percent", value: c.kind, onChange: (e) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, kind: e.target.value } : x)), children: [_jsx("option", { value: "fixed", children: cur }), _jsx("option", { value: "percent", children: "%" })] }), _jsx(Input, { "aria-label": "Amount", inputMode: "decimal", value: c.value, onChange: (e) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, value: e.target.value } : x)) }), !c.is_tax ? _jsx(Checkbox, { checked: c.taxable, onChange: (v) => setCosts((cs) => cs.map((x, j) => j === i ? { ...x, taxable: v } : x)), label: "Taxed" }) : _jsx("span", {}), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove", onClick: () => setCosts((cs) => cs.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 14 }) })] }, i))), _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setCosts((cs) => [...cs, { label: "Sales tax", kind: "percent", value: "", is_tax: true, taxable: false }]), children: [_jsx(Plus, { size: 14 }), "Tax"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setCosts((cs) => [...cs, { label: "Shipping", kind: "fixed", value: "", is_tax: false, taxable: false }]), children: [_jsx(Plus, { size: 14 }), "Additional cost"] })] }), _jsxs("div", { className: "po-sum", children: [_jsx("span", { children: "Subtotal" }), _jsx("b", { children: currency(totals.sub, cur) }), _jsx("span", { children: "Total" }), _jsx("b", { children: currency(totals.total, cur) })] })] }), _jsxs("div", { className: "po-form-grid", children: [_jsx(Field, { label: "Ship to", children: (id) => _jsxs(Select, { id: id, value: ship, onChange: (e) => setShip(e.target.value), children: [_jsx("option", { value: "", children: "Default" }), (opts.data?.addresses ?? []).filter((a) => a.kind !== "billing").map((a) => _jsx("option", { value: a.id, children: a.label || a.line1 }, a.id))] }) }), !opts.data?.settings.single_address && _jsx(Field, { label: "Bill to", children: (id) => _jsxs(Select, { id: id, value: bill, onChange: (e) => setBill(e.target.value), children: [_jsx("option", { value: "", children: "Default" }), (opts.data?.addresses ?? []).filter((a) => a.kind !== "shipping").map((a) => _jsx("option", { value: a.id, children: a.label || a.line1 }, a.id))] }) }), (opts.data?.budgets ?? []).length > 0 && _jsx(Field, { label: "Budget", children: (id) => _jsxs(Select, { id: id, value: budget, onChange: (e) => setBudget(e.target.value), children: [_jsx("option", { value: "", children: "None" }), (opts.data?.budgets ?? []).map((b) => _jsx("option", { value: b.id, children: b.name }, b.id))] }) })] }), _jsx(Field, { label: "Notes", hint: "Printed on the purchase order", children: (id) => _jsx("textarea", { id: id, className: "input", rows: 3, value: notes, maxLength: 4096, onChange: (e) => setNotes(e.target.value) }) }), warnings.map((w) => _jsx("div", { className: "banner warning", children: w }, w)), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }) }));
}
function LineEditor({ l, costs, cur, onChange, onRemove }) {
    const [search, setSearch] = useState("");
    const parts = useQuery({ queryKey: ["parts", "po-pick", search], enabled: search.length > 0,
        queryFn: () => api(`/parts?per_page=8&q=${encodeURIComponent(search)}`) });
    return (_jsxs("div", { className: "po-line" + (l.locked ? " locked" : ""), children: [_jsxs("div", { className: "po-line-main", children: [l.part_id ? _jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx(Package, { size: 15, className: "faint" }), _jsx("span", { className: "grow t", children: l.part_name ?? l.description }), !l.locked && _jsx("button", { type: "button", className: "linkbtn small", onClick: () => onChange({ part_id: null, part_name: undefined }), children: "Unlink part" })] })
                        : _jsxs("div", { className: "po-part-search", children: [_jsx(Input, { "aria-label": "Item", placeholder: "Search parts or type an item", value: l.description, disabled: l.locked, onChange: (e) => { onChange({ description: e.target.value }); setSearch(e.target.value.trim()); }, onBlur: () => setTimeout(() => setSearch(""), 150) }), search && (parts.data?.items ?? []).length > 0 && _jsx("div", { className: "menu po-part-menu", role: "listbox", "aria-label": "Parts", children: (parts.data?.items ?? []).map((p) => _jsxs("button", { type: "button", className: "menu-item", role: "option", "aria-selected": false, onMouseDown: (e) => e.preventDefault(), onClick: () => { onChange({ part_id: p.id, part_name: p.name, description: p.name, part_number: p.part_number, unit: p.unit, unit_cost: p.unit_cost ?? l.unit_cost }); setSearch(""); }, children: [_jsx(Package, { size: 14 }), _jsxs("span", { className: "grow", children: [p.name, p.part_number && _jsxs("span", { className: "small faint", children: [" \u00B7 ", p.part_number] })] })] }, p.id)) })] }), l.locked && _jsxs("span", { className: "small faint row", style: { gap: 4 }, children: [_jsx(Lock, { size: 12 }), l.received, " received \u2014 this line can't change"] })] }), _jsxs("div", { className: "po-line-fields", children: [_jsx(Input, { "aria-label": "Part number", placeholder: "Part #", value: l.part_number, disabled: l.locked, onChange: (e) => onChange({ part_number: e.target.value }) }), _jsx(Input, { "aria-label": "Quantity", inputMode: "decimal", value: l.quantity, disabled: l.locked, onChange: (e) => onChange({ quantity: e.target.value }) }), _jsx(Input, { "aria-label": "Unit", value: l.unit, disabled: l.locked, onChange: (e) => onChange({ unit: e.target.value }) }), costs && _jsx(Input, { "aria-label": `Unit cost (${cur})`, placeholder: "Unit cost", inputMode: "decimal", value: l.unit_cost, disabled: l.locked, onChange: (e) => onChange({ unit_cost: e.target.value }) }), costs && _jsx("span", { className: "po-line-amt", children: currency(n(l.quantity) * n(l.unit_cost), cur) }), onRemove ? _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove item", onClick: onRemove, children: _jsx(Trash2, { size: 14 }) }) : _jsx("span", {})] }), l.part_id && !l.locked && _jsxs("div", { className: "po-line-loc", children: [_jsx("span", { className: "small muted", children: "Receive into" }), _jsx(LocationPicker, { value: l.location_id, onChange: (v) => onChange({ location_id: v }), placeholder: "Part's main location" }), _jsx(Checkbox, { checked: l.taxable, onChange: (v) => onChange({ taxable: v }), label: "Taxed" })] }), !l.part_id && !l.locked && _jsx("div", { className: "po-line-loc", children: _jsx(Checkbox, { checked: l.taxable, onChange: (v) => onChange({ taxable: v }), label: "Taxed" }) })] }));
}
