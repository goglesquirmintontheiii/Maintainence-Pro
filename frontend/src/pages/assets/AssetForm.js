import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Create / edit asset side panel.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScanText } from "lucide-react";
import { api, upload } from "../../lib/api";
import { NameplateScan } from "../../components/Nameplate";
import { useAssetOptions } from "../../lib/assets";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker, ClearableDate, LocationPicker } from "../../components/assetPickers";
import { CustomInput } from "../workorders/Form";
import { centsToInput, Collapsible, inputToCents, PhotoPicker, TeamsPicker } from "./shared";
import { WarrantyFiles } from "./WarrantyFiles";
const TEXT = ["name", "description", "manufacturer", "model", "serial_number", "barcode", "criticality", "warranty_provider", "warranty_terms", "disposal_method", "disposal_notes"];
const NUM = ["year", "expected_life_years", "replacement_year", "useful_life_years"];
const DATES = ["commissioned_on", "disposed_on", "warranty_start", "warranty_end", "purchase_date", "depreciation_start"];
const MONEY = ["purchase_price_cents", "salvage_value_cents", "replacement_cost_cents", "disposal_value_cents"];
function initial(a) {
    const f = { name: "" };
    if (!a) {
        for (const k of [...TEXT, ...NUM, ...DATES, ...MONEY])
            f[k] ??= "";
        return f;
    }
    const src = {
        name: a.name, description: a.description, manufacturer: a.manufacturer, model: a.model, serial_number: a.serial_number, barcode: a.barcode,
        criticality: a.criticality, year: a.year, warranty_provider: a.warranty.provider, warranty_terms: a.warranty.terms, warranty_start: a.warranty.start,
        warranty_end: a.warranty.end, commissioned_on: a.lifecycle.commissioned_on, expected_life_years: a.lifecycle.expected_life_years,
        replacement_year: a.lifecycle.replacement_year, disposed_on: a.lifecycle.disposed_on, disposal_method: a.lifecycle.disposal_method,
        disposal_notes: a.lifecycle.disposal_notes, purchase_date: a.financials?.purchase_date, useful_life_years: a.financials?.useful_life_years,
        depreciation_start: a.financials?.depreciation_start,
    };
    for (const k of [...TEXT, ...NUM, ...DATES])
        f[k] = src[k] === null || src[k] === undefined ? "" : String(src[k]);
    for (const k of MONEY)
        f[k] = centsToInput(a.financials?.[k]);
    return f;
}
export function AssetForm({ edit, parentId, onClose, onSaved }) {
    const opts = useAssetOptions();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [f, setF] = useState(() => initial(edit));
    const [parent, setParent] = useState(edit?.parent_id ? [edit.parent_id] : parentId ? [parentId] : []);
    const [location, setLocation] = useState(edit?.location?.id ?? null);
    const [types, setTypes] = useState(edit?.types.map((t) => t.id) ?? []);
    const [teams, setTeams] = useState(edit?.teams.map((t) => t.id) ?? []);
    const [custom, setCustom] = useState(edit?.custom ?? {});
    const [files, setFiles] = useState([]);
    const [warrantyFiles, setWarrantyFiles] = useState([]);
    const [err, setErr] = useState("");
    const [plate, setPlate] = useState(false);
    const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
    const fromPlate = async (r) => {
        // r594: create an asset from a nameplate photo; filled fields are only suggestions until saved
        setPlate(false);
        setF((x) => ({ ...x, manufacturer: r.manufacturer || x.manufacturer, model: r.model || x.model, serial_number: r.serial_number || x.serial_number,
            year: r.year ? String(r.year) : x.year, name: x.name || [r.manufacturer, r.model].filter(Boolean).join(" ") }));
        if (!edit) {
            try {
                const up = await upload(r.file);
                setFiles((fs) => [...fs, up]);
            }
            catch (e) {
                toast(e.message, { kind: "error" });
            }
        }
        toast("Filled in from the nameplate. Check the details before saving.");
    };
    const fin = !!opts.data?.can.financials;
    const makers = useQuery({ queryKey: ["asset-catalog"], queryFn: () => api("/asset-catalog"), staleTime: 300_000 });
    const models = useQuery({ queryKey: ["asset-catalog", f.manufacturer], enabled: !!f.manufacturer.trim(), staleTime: 300_000,
        queryFn: () => api(`/asset-catalog?manufacturer=${encodeURIComponent(f.manufacturer.trim())}`) });
    const body = () => {
        const b = {};
        for (const k of TEXT)
            b[k] = f[k];
        for (const k of NUM)
            b[k] = f[k] === "" ? null : Number(f[k]);
        for (const k of DATES)
            b[k] = f[k] || null;
        if (fin)
            for (const k of MONEY)
                b[k] = inputToCents(f[k]);
        if (!fin) {
            delete b.purchase_date;
            delete b.useful_life_years;
            delete b.depreciation_start;
        }
        Object.assign(b, { parent_id: parent[0] ?? null, location_id: location, types, teams, custom });
        if (!edit) {
            b.file_ids = files.map((x) => x.id);
            b.warranty_file_ids = warrantyFiles.map((x) => x.id);
        }
        else
            b.version = edit.version;
        return b;
    };
    const save = useMutation({
        mutationFn: () => edit ? api(`/assets/${edit.id}`, { method: "PATCH", body: body() }) : api("/assets", { method: "POST", body: body() }),
        onSuccess: (a) => {
            qc.invalidateQueries({ queryKey: ["assets"] });
            qc.invalidateQueries({ queryKey: ["asset-pick"] });
            qc.invalidateQueries({ queryKey: ["asset-tree"] });
            qc.setQueryData(["asset", a.id], a);
            toast(edit ? "Asset saved" : `Asset ${a.name} created`);
            onSaved(a);
        },
        onError: (e) => {
            const ae = e;
            setErr(ae.status === 409 ? "Someone else changed this asset while you were editing. Close this panel to see their changes, then try again." : ae.message);
        },
    });
    const fields = (opts.data?.custom_fields ?? []).filter((c) => !c.scope_id || types.includes(c.scope_id));
    const typeOpts = (opts.data?.types ?? []).map((t) => ({ key: t.id, label: t.name, icon: _jsx("span", { className: "sw lg", style: { background: t.color } }) }));
    const date = (k, label) => _jsx(Field, { label: label, children: (id) => _jsx(ClearableDate, { id: id, type: "date", label: label, value: f[k], onChange: (v) => set(k, v) }) });
    const num = (k, label, hint) => _jsx(Field, { label: label, hint: hint, children: (id) => _jsx(Input, { id: id, type: "number", inputMode: "numeric", value: f[k], onChange: (e) => set(k, e.target.value) }) });
    const money = (k, label) => _jsx(Field, { label: label, children: (id) => _jsx(Input, { id: id, inputMode: "decimal", placeholder: "0.00", value: f[k], onChange: (e) => set(k, e.target.value) }) });
    return (_jsxs(Drawer, { title: edit ? "Edit asset" : "New asset", onClose: onClose, width: 620, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx("span", { className: "grow" }), _jsx(Button, { variant: "primary", disabled: !f.name.trim() || save.isPending, onClick: () => { setErr(""); save.mutate(); }, children: save.isPending ? "Saving…" : edit ? "Save" : "Create asset" })] }), children: [_jsxs("form", { className: "form-grid", onSubmit: (e) => { e.preventDefault(); save.mutate(); }, children: [_jsx(Field, { label: "Asset name *", className: "full", children: (id) => _jsx(Input, { id: id, value: f.name, maxLength: 255, autoFocus: true, onChange: (e) => set("name", e.target.value), placeholder: "e.g. Air Compressor 2" }) }), _jsx(Field, { label: "Description", className: "full", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 3, value: f.description, onChange: (e) => set("description", e.target.value) }) }), _jsxs("div", { className: "full row wrap", children: [_jsxs(Button, { size: "sm", onClick: () => setPlate(true), children: [_jsx(ScanText, { size: 14 }), "Read a nameplate photo"] }), _jsx("span", { className: "small faint", children: "Fills in manufacturer, model, serial number and year. Text is read on this device." })] }), !edit && _jsx(PhotoPicker, { files: files, setFiles: setFiles, label: "Add photos (nameplate, overview) or documents" }), _jsx(Field, { label: "Parent asset", hint: "Sub-assets show under their parent in the tree.", children: (id) => _jsx(AssetPicker, { id: id, value: parent, onChange: setParent, exclude: edit ? [edit.id] : [], placeholder: "None (top level)" }) }), _jsx(Field, { label: "Location", children: (id) => _jsx(LocationPicker, { id: id, value: location, onChange: setLocation, placeholder: parent.length ? "Same as parent" : "None" }) }), _jsx(Field, { label: "Criticality", children: (id) => _jsx(Select, { id: id, value: f.criticality, onChange: (e) => set("criticality", e.target.value), children: (opts.data?.criticality ?? [{ id: "", label: "None" }]).map((c) => _jsx("option", { value: c.id, children: c.label }, c.id)) }) }), _jsx(Field, { label: "Asset types", children: (id) => _jsx(MultiPicker, { id: id, label: "Asset types", placeholder: "Add types", options: typeOpts, value: types, onChange: setTypes, searchPlaceholder: "Search types", renderValue: (sel) => _jsx("span", { className: "row", style: { gap: 4, flexWrap: "wrap" }, children: sel.map((s) => _jsxs("span", { className: "chip", children: [s.icon, s.label] }, s.key)) }) }) }), _jsx(Field, { label: "Manufacturer", children: (id) => _jsxs(_Fragment, { children: [_jsx(Input, { id: id, list: "mfr-list", value: f.manufacturer, maxLength: 120, onChange: (e) => set("manufacturer", e.target.value) }), _jsx("datalist", { id: "mfr-list", children: (makers.data?.manufacturers ?? []).map((m) => _jsx("option", { value: m }, m)) })] }) }), _jsx(Field, { label: "Model", children: (id) => _jsxs(_Fragment, { children: [_jsx(Input, { id: id, list: "model-list", value: f.model, maxLength: 120, onChange: (e) => set("model", e.target.value) }), _jsx("datalist", { id: "model-list", children: (models.data?.models ?? []).map((m) => _jsx("option", { value: m }, m)) })] }) }), _jsx(Field, { label: "Serial number", children: (id) => _jsx(Input, { id: id, value: f.serial_number, maxLength: 120, onChange: (e) => set("serial_number", e.target.value) }) }), num("year", "Year"), _jsx(Field, { label: "Barcode", hint: "An existing barcode or tag number; scanning it finds this asset.", children: (id) => _jsx(Input, { id: id, value: f.barcode, maxLength: 200, onChange: (e) => set("barcode", e.target.value) }) }), _jsx(Field, { label: "Teams in charge", children: (id) => _jsx(TeamsPicker, { id: id, value: teams, onChange: setTeams }) }), fields.map((c) => _jsx(CustomInput, { def: c, value: custom[c.id], onChange: (v) => setCustom((x) => ({ ...x, [c.id]: v })) }, c.id)), _jsxs("div", { className: "full stack", style: { gap: 8 }, children: [_jsxs(Collapsible, { title: "Lifecycle", hint: "Commissioned, expected life, replacement, disposal", children: [date("commissioned_on", "Commissioned on"), num("expected_life_years", "Expected life (years)"), num("replacement_year", "Planned replacement year"), date("disposed_on", "Disposed on"), _jsx(Field, { label: "Disposal method", children: (id) => _jsxs(Select, { id: id, value: f.disposal_method, onChange: (e) => set("disposal_method", e.target.value), children: [_jsx("option", { value: "", children: "\u2014" }), (opts.data?.disposal_methods ?? []).map((m) => _jsx("option", { value: m, children: m[0].toUpperCase() + m.slice(1) }, m))] }) }), _jsx(Field, { label: "Disposal notes", className: "full", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: f.disposal_notes, onChange: (e) => set("disposal_notes", e.target.value) }) })] }), _jsxs(Collapsible, { title: "Warranty", defaultOpen: !!f.warranty_end || !!edit?.warranty.files?.length, children: [date("warranty_start", "Warranty start"), date("warranty_end", "Warranty end"), _jsx(Field, { label: "Provider", className: "full", children: (id) => _jsx(Input, { id: id, value: f.warranty_provider, maxLength: 200, onChange: (e) => set("warranty_provider", e.target.value) }) }), _jsx(Field, { label: "Terms", className: "full", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: f.warranty_terms, onChange: (e) => set("warranty_terms", e.target.value) }) }), _jsxs("div", { className: "full", children: [_jsx("span", { className: "small", style: { fontWeight: 600 }, children: "Warranty documents" }), edit ? _jsx(WarrantyFiles, { assetId: edit.id, files: edit.warranty.files ?? [] }) : _jsx(WarrantyFiles, { files: warrantyFiles, setFiles: setWarrantyFiles })] })] }), fin && _jsxs(Collapsible, { title: "Financials", hint: "Straight-line depreciation", children: [money("purchase_price_cents", "Purchase price"), date("purchase_date", "Purchase date"), num("useful_life_years", "Useful life (years)"), money("salvage_value_cents", "Salvage value"), date("depreciation_start", "Depreciation starts"), money("replacement_cost_cents", "Replacement cost"), money("disposal_value_cents", "Disposal value")] })] }), err && _jsx("div", { className: "banner warning full", role: "alert", children: err })] }), plate && _jsx(NameplateScan, { onResult: (r) => void fromPlate(r), onClose: () => setPlate(false) })] }));
}
