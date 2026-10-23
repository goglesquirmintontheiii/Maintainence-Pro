import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Create / edit work order side panel (MaintainX opens new work orders in a side panel).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { FileText, ImagePlus, LayoutTemplate, X } from "lucide-react";
import { api, upload } from "../../lib/api";
import { useSession } from "../../lib/session";
import { atTime, fromLocalInput, toLocalInput, useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Drawer, Field, Input, Select } from "../../components/ui";
import { AssigneePicker, CategoryPicker } from "../../components/pickers";
import { AssetPicker, ClearableDate, LocationPicker } from "../../components/assetPickers";
import { useAssetList, useAssetOptions } from "../../lib/assets";
import { ProcedurePicker } from "../procedures/Picker";
import { applyRepeat, repeatFrom, RepeatField } from "../pm/WOParts";
import { NumberInput } from "../../components/NumberInput";
import { DropZone } from "../../components/DropZone";
import { WOFormParts } from "../parts/WOParts";
import { WOVendorsField } from "./WorkOrderVendors";
import { saveWOCustomer, useShowCustomerField, useWOCustomer, WOCustomerPicker } from "../vendors/WOCustomer";
const PRIOS = [["none", "None"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]];
export function fromDetail(wo) {
    return {
        title: wo.title, description: wo.description, priority: wo.priority, work_type: wo.work_type, start_at: wo.start_at, due_at: wo.due_at,
        estimated_minutes: wo.estimated_minutes, assignees: wo.assignees.map((a) => `${a.type}:${a.id}`), categories: wo.categories.map((c) => c.id),
        custom: wo.custom, parent_id: wo.parent_id, asset_id: wo.asset?.id ?? null, location_id: wo.location?.id ?? null,
        asset_ids: wo.assets ? wo.assets.map((a) => a.id) : wo.asset ? [wo.asset.id] : [],
        asset_tasks: (wo.asset_tasks ?? []).map((t) => t.asset.id),
    };
}
export function WorkOrderForm({ edit, init, onClose, onSaved }) {
    const opts = useWOOptions();
    const { can } = useSession();
    const qc = useQueryClient();
    const nav = useNavigate();
    const { toast } = useToast();
    const templates = useQuery({ queryKey: ["wo-templates"], queryFn: () => api("/work-order-templates"), enabled: !edit });
    const [f, setF] = useState(() => ({ priority: "none", work_type: "reactive", assignees: [], categories: [], custom: {}, ...(edit ? fromDetail(edit) : {}), ...init }));
    const [files, setFiles] = useState([]);
    const repeatBefore = useMemo(() => repeatFrom(edit?.recurrence), [edit]);
    const [repeat, setRepeat] = useState(repeatBefore);
    const [parts, setParts] = useState([]); // 0.5.0: parts the job needs (new work orders)
    const [customer, setCustomer] = useState(undefined); // 0.5.0 Customer field; undefined = unchanged
    const woCustomer = useWOCustomer(edit?.id);
    const showCustomer = useShowCustomerField();
    const [uploading, setUploading] = useState(0);
    const [pct, setPct] = useState(0);
    const [err, setErr] = useState("");
    const fileInput = useRef(null);
    const set = (patch) => setF((x) => ({ ...x, ...patch }));
    const assetOpts = useAssetOptions();
    const assetList = useAssetList();
    const [showTasks, setShowTasks] = useState(() => !!(edit?.asset_tasks?.length || init?.asset_tasks?.length));
    // Several assets (MP-124); the first is the primary one. Older callers pass asset_id only.
    const assetIds = f.asset_ids ?? (f.asset_id ? [f.asset_id] : []);
    const pickAssets = (ids) => {
        // MaintainX fills in the asset's location when you pick an asset (the first one's)
        const first = ids[0] ?? null;
        const a = first && first !== assetIds[0] ? assetList.data?.items.find((x) => x.id === first) : null;
        const st = f.asset_status?.asset_id && !ids.includes(f.asset_status.asset_id) ? null : f.asset_status;
        set({ asset_ids: ids, asset_id: first, ...(a?.location ? { location_id: a.location.id } : {}), asset_status: first ? st : null });
    };
    const askStatus = assetIds.length > 0 && can("assets.status") && (assetOpts.data?.settings.ask_status_on_work_orders ?? true);
    const required = new Set(opts.data?.settings.required_fields ?? []);
    const s = opts.data?.settings;
    const applyTemplate = (t, keep) => {
        const { due_in_days, ...d } = t.data;
        const due = due_in_days !== undefined && due_in_days !== null
            ? atTime(new Date(Date.now() + due_in_days * 86400000).toISOString().slice(0, 10), opts.data?.settings.default_due_time ?? "12:00") : undefined;
        setF((x) => ({ ...x, ...d, ...(due ? { due_at: due } : {}), custom: { ...(x.custom ?? {}), ...(d.custom ?? {}) }, template_id: t.id, ...(keep ?? {}) }));
        toast(`Filled in from “${t.name}”`);
    };
    const appliedInit = useRef(false);
    useEffect(() => {
        if (appliedInit.current || !init?.template_id || !templates.data)
            return;
        const t = templates.data.items.find((x) => x.id === init.template_id);
        appliedInit.current = true;
        if (t)
            applyTemplate(t, { ...(init.asset_id ? { asset_id: init.asset_id, asset_ids: [init.asset_id] } : {}), ...(init.asset_ids ? { asset_ids: init.asset_ids } : {}), ...(init.location_id ? { location_id: init.location_id } : {}) });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [templates.data, init?.template_id]);
    const payload = () => {
        const body = { ...f, assignees: (f.assignees ?? []).map((a) => a), file_ids: edit ? undefined : files.map((x) => x.id) };
        if (edit) {
            delete body.template_id;
            body.version = edit.version;
        }
        if (!f.asset_status?.status)
            delete body.asset_status;
        if (edit || !f.procedures?.length)
            delete body.procedures;
        if (f.asset_ids || f.asset_id) {
            body.asset_ids = assetIds;
            delete body.asset_id;
        }
        if (!can("assets.view")) {
            delete body.asset_id;
            delete body.asset_ids;
            delete body.asset_tasks;
        }
        if (!can("locations.view"))
            delete body.location_id;
        if (!edit && parts.length)
            body.parts = parts.map((p) => ({ part_id: p.part_id, quantity: p.quantity }));
        return body;
    };
    const save = useMutation({
        mutationFn: async () => {
            const wo = await applyRepeat(await (edit ? api(`/work-orders/${edit.id}`, { method: "PATCH", body: payload() }) : api("/work-orders", { method: "POST", body: payload() })), can("wo.edit") ? repeat : undefined, repeatBefore, (m) => toast(m, { kind: "error" }));
            await saveWOCustomer(wo.id, customer).catch((e) => toast(e.message, { kind: "error" }));
            return wo;
        },
        onSuccess: (wo) => {
            qc.invalidateQueries({ queryKey: ["work-orders"] });
            qc.invalidateQueries({ queryKey: ["wo-stats"] });
            qc.setQueryData(["work-order", wo.id], wo);
            toast(edit ? "Work order saved" : `Work order #${wo.number} created`);
            onClose();
            if (onSaved)
                onSaved(wo);
            else if (!edit)
                nav(`/work-orders/${wo.id}`);
        },
        onError: (e) => {
            const ae = e;
            if (ae.status === 409) {
                qc.invalidateQueries({ queryKey: ["work-order", edit?.id] });
                setErr("Someone else changed this work order while you were editing. Close this panel to see their changes, then edit again.");
            }
            else
                setErr(ae.message);
        },
    });
    const onFiles = async (list) => {
        if (!list)
            return;
        for (const file of Array.from(list)) {
            setUploading((n) => n + 1);
            try {
                const up = await upload(file, undefined, (p) => setPct(Math.round(p * 100)));
                setFiles((x) => [...x, up]);
            }
            catch (e) {
                toast(e.message, { kind: "error" });
            }
            finally {
                setUploading((n) => n - 1);
            }
        }
    };
    const dueDate = f.due_at ? toLocalInput(f.due_at) : "";
    const startDate = f.start_at ? toLocalInput(f.start_at) : "";
    const missing = useMemo(() => {
        const m = [];
        if (!f.title?.trim())
            m.push("title");
        if (required.has("due_date") && !f.due_at)
            m.push("due date");
        if (required.has("priority") && f.priority === "none")
            m.push("priority");
        if (required.has("description") && !f.description?.trim())
            m.push("description");
        if (required.has("assignees") && !(f.assignees ?? []).length)
            m.push("assignees");
        if (required.has("categories") && !(f.categories ?? []).length)
            m.push("categories");
        if (required.has("estimated_time") && !f.estimated_minutes)
            m.push("estimated time");
        if (!edit && required.has("attachment") && !files.length)
            m.push("a picture or file");
        for (const cf of opts.data?.custom_fields ?? [])
            if (cf.required && (f.custom?.[cf.id] ?? "") === "")
                m.push(cf.name);
        return m;
    }, [f, files.length, required, opts.data, edit]);
    const req = (k) => (required.has(k) ? " *" : "");
    useEffect(() => { setErr(""); }, [f]);
    return (_jsxs(Drawer, { title: edit ? `Edit work order #${edit.number}` : f.parent_id ? "New sub-work order" : "New work order", onClose: onClose, width: 620, footer: _jsxs(_Fragment, { children: [_jsx("span", { className: "small faint grow", children: missing.length ? `Still needed: ${missing.join(", ")}` : edit ? "" : `Will be #${opts.data?.next_number ?? "…"}` }), _jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: missing.length > 0 || save.isPending || uploading > 0, onClick: () => save.mutate(), children: save.isPending ? "Saving…" : edit ? "Save" : "Create" })] }), children: [!edit && (templates.data?.items.length ?? 0) > 0 && (_jsxs("div", { className: "row", children: [_jsx(LayoutTemplate, { size: 16, className: "faint" }), _jsxs(Select, { "aria-label": "Start from a template", value: "", onChange: (e) => { const t = templates.data?.items.find((x) => x.id === e.target.value); if (t)
                            applyTemplate(t); }, style: { maxWidth: 320 }, children: [_jsx("option", { value: "", children: "Start from a template\u2026" }), templates.data?.items.map((t) => _jsx("option", { value: t.id, children: t.name }, t.id))] })] })), _jsx(Field, { label: "What needs to be done? *", children: (id) => _jsx(Input, { id: id, value: f.title ?? "", maxLength: 255, placeholder: "e.g. Replace worn belt on Conveyor 3", onChange: (e) => set({ title: e.target.value }), onKeyDown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !missing.length)
                        save.mutate(); } }) }), _jsx(Field, { label: "Description" + req("description"), children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 4, maxLength: 4096, value: f.description ?? "", placeholder: "Add details, steps or safety notes", onChange: (e) => set({ description: e.target.value }) }) }), !edit && (_jsxs("div", { className: "field", children: [_jsxs("span", { className: "label", children: ["Pictures and files", req("attachment")] }), _jsx(DropZone, { onFiles: (fs) => void onFiles(fs), accept: WO_FILE_ACCEPT, children: _jsxs("div", { className: "dropzone", children: [_jsx(ImagePlus, { size: 20, className: "faint" }), _jsxs("span", { children: ["Drag photos or files here, or ", _jsx("button", { type: "button", className: "linkbtn", onClick: () => fileInput.current?.click(), children: "browse" })] }), _jsx("input", { ref: fileInput, type: "file", multiple: true, hidden: true, onChange: (e) => { void onFiles(e.target.files); e.target.value = ""; }, accept: WO_FILE_ACCEPT })] }) }), (files.length > 0 || uploading > 0) && _jsxs("div", { className: "row wrap", children: [files.map((x) => (_jsxs("span", { className: "chip", children: [x.is_image ? _jsx(ImagePlus, { size: 13 }) : _jsx(FileText, { size: 13 }), x.name, _jsx("button", { type: "button", className: "linkbtn", "aria-label": `Remove ${x.name}`, onClick: () => setFiles((fs) => fs.filter((y) => y.id !== x.id)), children: _jsx(X, { size: 12 }) })] }, x.id))), uploading > 0 && _jsxs("span", { className: "small faint", role: "status", children: ["Uploading ", uploading, "\u2026 ", pct, "%"] })] })] })), _jsxs("div", { className: "form-grid", children: [_jsx(Field, { label: "Assign to" + req("assignees"), className: "full", children: (id) => _jsx(AssigneePicker, { id: id, options: opts.data, value: f.assignees ?? [], onChange: (v) => set({ assignees: v }) }) }), _jsx(Field, { label: "Priority" + req("priority"), children: () => (_jsx("div", { className: "seg", role: "radiogroup", "aria-label": "Priority", children: PRIOS.map(([k, l]) => (_jsx("button", { type: "button", role: "radio", "aria-checked": f.priority === k, className: "seg-btn prio-" + k + (f.priority === k ? " on" : ""), onClick: () => set({ priority: k }), children: l }, k))) })) }), _jsx(Field, { label: "Work type", children: (id) => _jsxs(Select, { id: id, value: f.work_type, onChange: (e) => set({ work_type: e.target.value }), children: [_jsx("option", { value: "reactive", children: "Reactive" }), _jsx("option", { value: "preventive", children: "Preventive" }), _jsx("option", { value: "other", children: "Other" })] }) }), _jsx(Field, { label: "Due date" + req("due_date"), children: (id) => (_jsxs("div", { className: "row", children: [_jsx(ClearableDate, { id: id, label: "due date", type: "datetime-local", value: dueDate, onChange: (v) => set({ due_at: fromLocalInput(v) }) }), !f.due_at && _jsx(Button, { size: "sm", variant: "ghost", onClick: () => set({ due_at: atTime(new Date().toISOString().slice(0, 10), s?.default_due_time ?? "12:00") }), children: "Today" })] })) }), _jsx(Field, { label: "Start date", hint: "Hidden from To Do until this date.", children: (id) => _jsx(ClearableDate, { id: id, label: "start date", type: "datetime-local", value: startDate, onChange: (v) => set({ start_at: fromLocalInput(v) }) }) }), can("wo.edit") && _jsx(RepeatField, { value: repeat, onChange: setRepeat, rec: edit?.recurrence, dueAt: f.due_at, isSub: !!f.parent_id }), !edit && can("parts.use") && _jsx(Field, { label: "Parts", children: () => _jsx(WOFormParts, { value: parts, onChange: setParts }) }), _jsx(Field, { label: "Estimated time" + req("estimated_time"), children: (id) => (_jsxs("div", { className: "row", children: [_jsx(NumberInput, { id: id, min: 0, step: 1, integer: true, "aria-label": "Hours", placeholder: "0", empty: 0, value: f.estimated_minutes ? Math.floor(f.estimated_minutes / 60) : null, onValue: (h) => set({ estimated_minutes: (h ?? 0) * 60 + ((f.estimated_minutes ?? 0) % 60) || null }) }), _jsx("span", { className: "small muted", children: "h" }), _jsx(NumberInput, { min: 0, max: 59, step: 5, integer: true, "aria-label": "Minutes", placeholder: "0", empty: 0, value: f.estimated_minutes ? f.estimated_minutes % 60 : null, onValue: (m) => set({ estimated_minutes: Math.floor((f.estimated_minutes ?? 0) / 60) * 60 + (m ?? 0) || null }) }), _jsx("span", { className: "small muted", children: "min" })] })) }), _jsx(Field, { label: "Categories" + req("categories"), children: (id) => _jsx(CategoryPicker, { id: id, options: opts.data, value: f.categories ?? [], onChange: (v) => set({ categories: v }) }) }), !edit && can("procedures.view") && _jsx(Field, { label: "Procedures", children: (id) => _jsx(ProcedurePicker, { id: id, value: f.procedures ?? [], onChange: (v) => set({ procedures: v }) }) }), can("assets.view") && _jsx(Field, { label: assetIds.length > 1 ? "Assets" : "Asset", children: (id) => _jsx(AssetPicker, { id: id, multi: true, placeholder: "Pick one or more assets", value: assetIds, onChange: pickAssets }) }), can("locations.view") && _jsx(Field, { label: "Location", children: (id) => _jsx(LocationPicker, { id: id, value: f.location_id ?? null, onChange: (v) => set({ location_id: v }) }) }), showCustomer && _jsx(Field, { label: "Customer", children: (id) => _jsx(WOCustomerPicker, { id: id, value: customer !== undefined ? customer : woCustomer.data?.customer?.id ?? null, onChange: (cid, loc) => { setCustomer(cid); if (loc && !f.location_id && can("locations.view"))
                                set({ location_id: loc }); } }) }), can("vendors.view") && _jsx(WOVendorsField, { edit: edit, value: f.vendor_ids, onChange: (vendor_ids) => set({ vendor_ids }) }), askStatus && _jsx(AssetStatusField, { value: f.asset_status ?? null, onChange: (v) => set({ asset_status: v }), reasons: assetOpts.data?.statuses, assets: assetIds.map((id) => ({ id, name: assetList.data?.items.find((a) => a.id === id)?.name ?? "Asset" })) }), can("assets.view") && (showTasks
                        ? _jsx(Field, { label: "Asset task list", hint: "Each asset gets its own status and notes on the work order.", className: "full", children: (id) => (_jsx(AssetPicker, { id: id, multi: true, value: f.asset_tasks ?? [], onChange: (v) => set({ asset_tasks: v }), placeholder: "Add assets to work through" })) })
                        : _jsx("div", { className: "full", children: _jsx("button", { type: "button", className: "linkbtn small", onClick: () => setShowTasks(true), children: "+ Add an asset task list" }) }))] }), (opts.data?.custom_fields.length ?? 0) > 0 && _jsxs(_Fragment, { children: [_jsx("hr", { className: "divider", style: { margin: 0 } }), _jsx("div", { className: "form-grid", children: opts.data.custom_fields.map((cf) => (_jsx(CustomInput, { def: cf, value: f.custom?.[cf.id], onChange: (v) => set({ custom: { ...(f.custom ?? {}), [cf.id]: v } }) }, cf.id))) })] }), f.parent_id && _jsx("p", { className: "small muted", children: "This will be a sub-work order. Sub-work orders show on their parent with their own status." }), !can("wo.create") && _jsx("div", { className: "banner warning", children: "You can't create work orders with your role." }), err && _jsx("div", { className: "banner warning", role: "alert", children: err })] }));
}
export function CustomInput({ def, value, onChange }) {
    const label = def.name + (def.required ? " *" : "");
    const full = def.type === "textarea" ? "full" : "";
    const org = useSession().session.org;
    switch (def.type) {
        case "textarea": return _jsx(Field, { label: label, className: full, children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 3, value: value ?? "", onChange: (e) => onChange(e.target.value) }) });
        case "currency": return _jsx(Field, { label: label, hint: org?.currency, children: (id) => (_jsx(Input, { id: id, inputMode: "decimal", placeholder: "0.00", value: value ?? "", onChange: (e) => onChange(e.target.value.replace(/[^0-9.,-]/g, "")) })) });
        case "number": return _jsx(Field, { label: label, children: (id) => _jsx(Input, { id: id, type: "number", value: value ?? "", onChange: (e) => onChange(e.target.value === "" ? "" : Number(e.target.value)) }) });
        case "select": return _jsx(Field, { label: label, children: (id) => _jsxs(Select, { id: id, value: value ?? "", onChange: (e) => onChange(e.target.value), children: [_jsx("option", { value: "", children: "\u2014" }), def.options.map((o) => _jsx("option", { children: o }, o))] }) });
        case "date": return _jsx(Field, { label: label, children: (id) => _jsx(ClearableDate, { id: id, label: def.name, type: "date", value: value ?? "", onChange: (v) => onChange(v) }) });
        case "datetime": return _jsx(Field, { label: label, children: (id) => _jsx(ClearableDate, { id: id, label: def.name, type: "datetime-local", value: toLocalInput(value), onChange: (v) => onChange(fromLocalInput(v) ?? "") }) });
        case "checkbox": return _jsx(Field, { label: label, children: (id) => _jsxs("label", { className: "check", children: [_jsx("input", { id: id, type: "checkbox", checked: !!value, onChange: (e) => onChange(e.target.checked) }), _jsx("span", { children: "Yes" })] }) });
        case "link": return _jsx(Field, { label: label, hint: "A web address (https://\u2026) or phone link (tel:\u2026)", children: (id) => _jsx(Input, { id: id, type: "url", value: value ?? "", onChange: (e) => onChange(e.target.value), placeholder: "https://" }) });
        default: return _jsx(Field, { label: label, children: (id) => _jsx(Input, { id: id, maxLength: 4096, value: value ?? "", onChange: (e) => onChange(e.target.value) }) });
    }
}
const WO_FILE_ACCEPT = "image/*,.pdf,.doc,.docx,.xlsx,.csv,.txt,.mp4,.mov,.heic";
export function AssetStatusField({ value, onChange, reasons, assets }) {
    const cur = reasons?.find((r) => r.id === value?.status);
    const many = (assets?.length ?? 0) > 1;
    return (_jsx(Field, { label: "Asset status", hint: many ? "Optional: changes the chosen asset's status when you save." : "Optional: changes the asset's status when you save.", children: (id) => (_jsxs("div", { className: "row wrap", children: [many && _jsx(Select, { "aria-label": "Which asset", value: value?.asset_id ?? assets[0].id, style: { maxWidth: 200 }, onChange: (e) => onChange({ ...(value ?? { status: "" }), asset_id: e.target.value }), children: assets.map((a) => _jsx("option", { value: a.id, children: a.name }, a.id)) }), _jsxs(Select, { id: id, value: value?.status ?? "", style: { maxWidth: 170 }, onChange: (e) => onChange(e.target.value ? { status: e.target.value, downtime_type: e.target.value === "offline" ? "unplanned" : undefined, ...(value?.asset_id ? { asset_id: value.asset_id } : {}) } : null), children: [_jsx("option", { value: "", children: "Don't change" }), reasons?.map((r) => _jsx("option", { value: r.id, children: r.label }, r.id))] }), value?.status === "offline" && _jsxs(Select, { "aria-label": "Downtime", value: value.downtime_type ?? "unplanned", style: { maxWidth: 140 }, onChange: (e) => onChange({ ...value, downtime_type: e.target.value }), children: [_jsx("option", { value: "unplanned", children: "Unplanned" }), _jsx("option", { value: "planned", children: "Planned" })] }), value && (cur?.reasons.length ?? 0) > 0 && _jsxs(Select, { "aria-label": "Reason", value: value.reason ?? "", style: { maxWidth: 200 }, onChange: (e) => onChange({ ...value, reason: e.target.value }), children: [_jsx("option", { value: "", children: "No reason" }), cur.reasons.map((r) => _jsx("option", { children: r }, r))] })] })) }));
}
