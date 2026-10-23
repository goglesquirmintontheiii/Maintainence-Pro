import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Create or edit a part (r221 required fields, r237 duplicate warning, custom fields, vendors, stock on create).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Button, Checkbox, Drawer, Field, Input, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker, LocationPicker } from "../../components/assetPickers";
import { CustomInput } from "../workorders/Form";
import { TeamsPicker } from "../assets/shared";
import { usePartFields, usePartOptions } from "./types";
const TEXT = ["name", "part_number", "description", "unit", "unit_cost", "barcode", "manufacturer", "mpn", "lead_time_days"];
const REQ_LABEL = { part_number: "part_number", description: "description", unit_cost: "unit_cost", barcode: "barcode", lead_time_days: "lead_time_days" };
function initial(p) {
    const f = Object.fromEntries(TEXT.map((k) => [k, ""]));
    f.unit = "each";
    if (!p)
        return f;
    for (const k of TEXT) {
        const v = p[k];
        f[k] = v === null || v === undefined ? "" : String(v);
    }
    return f;
}
export function PartForm({ edit, onClose, onSaved }) {
    const opts = usePartOptions();
    const fields = usePartFields();
    const { can } = useSession();
    const vendorsQ = useQuery({ queryKey: ["vendors", "options"], queryFn: () => api("/vendors?per_page=500&sort=name"),
        enabled: can("vendors.view"), retry: false });
    const [f, setF] = useState(() => initial(edit));
    const [nonStock, setNonStock] = useState(edit?.non_stock ?? false);
    const [types, setTypes] = useState(edit?.types.map((t) => t.id) ?? []);
    const [teams, setTeams] = useState(edit?.teams.map((t) => t.id) ?? []);
    const [assets, setAssets] = useState(edit?.assets.map((a) => a.id) ?? []);
    const [vendors, setVendors] = useState(() => (edit?.vendors ?? []).map((v) => ({ vendor_id: v.vendor.id, vendor_part_number: v.vendor_part_number,
        unit_cost: v.unit_cost ?? "", lead_time_days: v.lead_time_days === null ? "" : String(v.lead_time_days), preferred: v.preferred })));
    const [stock, setStock] = useState(edit ? [] : [{ location_id: null, area: "", min_qty: "", max_qty: "", initial_quantity: "" }]);
    const [custom, setCustom] = useState(edit?.custom ?? {});
    const [dups, setDups] = useState([]);
    const [err, setErr] = useState("");
    const required = new Set(opts.data?.settings.required_fields ?? []);
    const costs = can("costs.view");
    const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
    const label = (text, key) => text + (required.has(key) ? " *" : "");
    // Possible duplicates (r237): same name, barcode or vendor part number.
    useEffect(() => {
        const name = f.name.trim(), barcode = f.barcode.trim(), vpn = vendors.map((v) => v.vendor_part_number.trim()).find(Boolean) ?? "";
        if (name.length < 3 && !barcode && !vpn) {
            setDups([]);
            return;
        }
        const t = setTimeout(() => {
            const qs = new URLSearchParams({ name, barcode, vendor_part_number: vpn, ...(edit ? { exclude: edit.id } : {}) });
            api(`/parts/duplicates?${qs}`).then((r) => setDups(r.items)).catch(() => setDups([]));
        }, 400);
        return () => clearTimeout(t);
    }, [f.name, f.barcode, vendors, edit]);
    const payload = () => {
        const b = { ...f, non_stock: nonStock, type_ids: types, team_ids: teams, asset_ids: assets, custom,
            lead_time_days: f.lead_time_days === "" ? null : Number(f.lead_time_days) };
        if (!costs)
            delete b.unit_cost;
        if (can("vendors.view"))
            b.vendors = vendors.filter((v) => v.vendor_id).map((v) => ({ ...v, unit_cost: costs ? v.unit_cost || null : undefined,
                lead_time_days: v.lead_time_days === "" ? null : Number(v.lead_time_days) }));
        if (!can("assets.view"))
            delete b.asset_ids;
        if (edit)
            b.version = edit.version;
        else if (!nonStock)
            b.stock = stock.filter((s) => s.location_id || s.min_qty || s.max_qty || s.initial_quantity || s.area)
                .map((s) => ({ ...s, min_qty: s.min_qty || null, max_qty: s.max_qty || null, initial_quantity: can("parts.stock") ? s.initial_quantity || null : null }));
        return b;
    };
    const m = useMutation({
        mutationFn: () => edit ? api(`/parts/${edit.id}`, { method: "PATCH", body: payload() }) : api("/parts", { method: "POST", body: payload() }),
        onSuccess: onSaved,
        onError: (e) => setErr(e.message),
    });
    const vendorOpts = vendorsQ.data?.items ?? [];
    return (_jsx(Drawer, { title: edit ? "Edit part" : "New part", onClose: onClose, width: 620, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || m.isPending, onClick: () => m.mutate(), children: edit ? "Save" : "Create part" })] }), children: _jsxs("div", { className: "stack", style: { gap: 12 }, children: [_jsx(Field, { label: "Name *", children: (id) => _jsx(Input, { id: id, value: f.name, maxLength: 255, onChange: (e) => set("name", e.target.value), placeholder: "e.g. Ball bearing 6205-2RS" }) }), dups.length > 0 && _jsx("div", { className: "banner info", role: "status", children: _jsxs("div", { children: ["Possible duplicate", dups.length === 1 ? "" : "s", ": ", dups.map((d, i) => _jsxs("span", { children: [i > 0 && ", ", _jsxs(Link, { to: `/parts/${d.id}`, target: "_blank", children: [d.name, d.part_number ? ` (${d.part_number})` : ""] })] }, d.id))] }) }), _jsxs("div", { className: "part-grid2", children: [_jsx(Field, { label: label("Part number", REQ_LABEL.part_number), children: (id) => _jsx(Input, { id: id, value: f.part_number, maxLength: 120, onChange: (e) => set("part_number", e.target.value) }) }), _jsx(Field, { label: label("Barcode", "barcode"), children: (id) => _jsx(Input, { id: id, value: f.barcode, maxLength: 120, onChange: (e) => set("barcode", e.target.value), placeholder: "Scan or type" }) }), _jsx(Field, { label: "Unit", children: (id) => _jsxs(_Fragment, { children: [_jsx(Input, { id: id, list: "part-units", value: f.unit, maxLength: 30, onChange: (e) => set("unit", e.target.value) }), _jsx("datalist", { id: "part-units", children: (opts.data?.units ?? []).map((u) => _jsx("option", { value: u }, u)) })] }) }), costs && _jsx(Field, { label: label("Unit cost", "unit_cost"), children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: f.unit_cost, onChange: (e) => set("unit_cost", e.target.value), placeholder: "0.00" }) }), _jsx(Field, { label: "Manufacturer", children: (id) => _jsx(Input, { id: id, value: f.manufacturer, maxLength: 120, onChange: (e) => set("manufacturer", e.target.value) }) }), _jsx(Field, { label: "Manufacturer part number", children: (id) => _jsx(Input, { id: id, value: f.mpn, maxLength: 120, onChange: (e) => set("mpn", e.target.value) }) }), _jsx(Field, { label: label("Lead time (days)", "lead_time_days"), children: (id) => _jsx(Input, { id: id, type: "number", min: 0, max: 3650, value: f.lead_time_days, onChange: (e) => set("lead_time_days", e.target.value) }) })] }), _jsx(Field, { label: label("Description", "description"), children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 3, value: f.description, maxLength: 5000, onChange: (e) => set("description", e.target.value) }) }), _jsx(Checkbox, { checked: nonStock, onChange: setNonStock, disabled: !!edit && !edit.non_stock && Number(edit.on_hand ?? 0) !== 0, label: "Non-stock part (bought when needed, quantities aren't tracked)" }), _jsx(Field, { label: label("Part types", "part_types"), children: (id) => _jsx(MultiPicker, { id: id, label: "Part types", placeholder: "No types", value: types, onChange: setTypes, options: (opts.data?.types ?? []).map((t) => ({ key: t.id, label: t.name + (t.critical ? " (critical)" : ""), icon: _jsx("span", { className: "sw lg", style: { background: t.color } }) })) }) }), _jsx(Field, { label: label("Teams in charge", "teams"), children: (id) => _jsx(TeamsPicker, { id: id, value: teams, onChange: setTeams }) }), can("assets.view") && _jsx(Field, { label: label("Used on assets", "assets"), children: (id) => _jsx(AssetPicker, { id: id, multi: true, value: assets, onChange: setAssets, placeholder: "No assets" }) }), can("vendors.view") && _jsxs("fieldset", { className: "part-fieldset", children: [_jsx("legend", { children: label("Vendors", "vendors") }), vendors.map((v, i) => (_jsxs("div", { className: "part-vendor-row", children: [_jsxs(Select, { "aria-label": "Vendor", value: v.vendor_id, onChange: (e) => setVendors((vs) => vs.map((x, j) => (j === i ? { ...x, vendor_id: e.target.value } : x))), children: [_jsx("option", { value: "", children: "Pick a vendor" }), vendorOpts.map((o) => _jsx("option", { value: o.id, children: o.name }, o.id))] }), _jsx(Input, { "aria-label": "Vendor part number", placeholder: "Vendor part #", value: v.vendor_part_number, maxLength: 120, onChange: (e) => setVendors((vs) => vs.map((x, j) => (j === i ? { ...x, vendor_part_number: e.target.value } : x))) }), costs && _jsx(Input, { "aria-label": "Vendor price", placeholder: "Price", inputMode: "decimal", value: v.unit_cost, onChange: (e) => setVendors((vs) => vs.map((x, j) => (j === i ? { ...x, unit_cost: e.target.value } : x))) }), _jsxs("label", { className: "check small", children: [_jsx("input", { type: "radio", name: "preferred-vendor", checked: v.preferred, onChange: () => setVendors((vs) => vs.map((x, j) => ({ ...x, preferred: j === i }))) }), _jsx("span", { children: "Preferred" })] }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove vendor", onClick: () => setVendors((vs) => vs.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 14 }) })] }, i))), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setVendors((vs) => [...vs, { vendor_id: "", vendor_part_number: "", unit_cost: "", lead_time_days: "", preferred: vs.length === 0 }]), children: [_jsx(Plus, { size: 14 }), "Add vendor"] })] }), !edit && !nonStock && _jsxs("fieldset", { className: "part-fieldset", children: [_jsx("legend", { children: "Where it's kept" }), stock.map((s, i) => {
                            const upd = (p) => setStock((ss) => ss.map((x, j) => (j === i ? { ...x, ...p } : x)));
                            return (_jsxs("div", { className: "part-stock-row", children: [_jsx(LocationPicker, { value: s.location_id, onChange: (v) => upd({ location_id: v }), placeholder: "No location" }), _jsx(Input, { "aria-label": label("Area or bin", "area"), placeholder: label("Area / bin", "area"), value: s.area, maxLength: 120, onChange: (e) => upd({ area: e.target.value }) }), _jsx(Input, { "aria-label": label("Minimum", "min_qty"), placeholder: label("Min", "min_qty"), inputMode: "decimal", value: s.min_qty, onChange: (e) => upd({ min_qty: e.target.value }) }), _jsx(Input, { "aria-label": label("Maximum", "max_qty"), placeholder: label("Max", "max_qty"), inputMode: "decimal", value: s.max_qty, onChange: (e) => upd({ max_qty: e.target.value }) }), can("parts.stock") && _jsx(Input, { "aria-label": "Quantity in stock now", placeholder: "In stock", inputMode: "decimal", value: s.initial_quantity, onChange: (e) => upd({ initial_quantity: e.target.value }) }), stock.length > 1 && _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Remove location", onClick: () => setStock((ss) => ss.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 14 }) })] }, i));
                        }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setStock((ss) => [...ss, { location_id: null, area: "", min_qty: "", max_qty: "", initial_quantity: "" }]), children: [_jsx(Plus, { size: 14 }), "Add location"] })] }), (fields.data?.items ?? []).map((c) => _jsx(CustomInput, { def: c, value: custom[c.id], onChange: (v) => setCustom((x) => ({ ...x, [c.id]: v })) }, c.id)), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }) }));
}
