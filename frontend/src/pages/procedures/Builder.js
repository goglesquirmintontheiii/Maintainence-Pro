import { createElement as _createElement } from "react";
import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Procedure builder (MP-034/035, r180–r185, r203): drag-and-drop items, every field type, sections and nested
// procedures, conditional logic, scoring with a goal, assignment, links and reference files, seasonal variants (r598),
// and a live preview. Saving writes the draft; publishing makes a new version (work orders keep the one they used).
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, Calendar, Camera, CheckSquare, ChevronDown, ClipboardCheck, Copy, DollarSign, Eye, FileText, Flag, Gauge, GitMerge, GripVertical, Hash, Heading, Layers, ListChecks, ListOrdered, MapPin, PenLine, Plus, Trash2, Type, Upload, X, CircleDot, } from "lucide-react";
import { api, upload } from "../../lib/api";
import { useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { DropZone } from "../../components/DropZone";
import { AssigneePicker } from "../../components/pickers";
import { Button, Dropdown, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { useMeterList } from "../automations/types";
import { PreviewForm } from "./Runner";
import { FIELD_HINT, FIELD_LABEL, FIELD_ORDER, MONTHS, COND_SOURCES, SCORABLE, fieldsBefore, fieldsOf, findItem, isField, newId, newItem, useLibrary, } from "./types";
import "../../styles/procedures.css";
export const FIELD_ICON = {
    checkbox: CheckSquare, text: Type, number: Hash, amount: DollarSign, multiple_choice: CircleDot, checklist: ListChecks, inspection: Flag,
    yes_no_na: ListOrdered, date: Calendar, file: Camera, signature: PenLine, meter_reading: Gauge, location_check_in: MapPin, heading: Heading,
    section: Layers, procedure: ClipboardCheck,
};
const BuilderCtx = createContext({ root: [], scoring: false, files: {}, addFile: () => { } });
// ---- tree helpers --------------------------------------------------------------------------------
function take(items, id) {
    let found = null;
    const rec = (xs) => xs.flatMap((it) => {
        if (it.id === id) {
            found = it;
            return [];
        }
        return it.type === "section" ? [{ ...it, items: rec(it.items ?? []) }] : [it];
    });
    return [rec(items), found];
}
function put(items, targetId, pos, node) {
    if (targetId === null)
        return [...items, node];
    const rec = (xs) => xs.flatMap((it) => {
        if (it.id === targetId) {
            if (pos === "inside")
                return [{ ...it, items: [...(it.items ?? []), node] }];
            return pos === "before" ? [node, it] : [it, node];
        }
        return it.type === "section" ? [{ ...it, items: rec(it.items ?? []) }] : [it];
    });
    return rec(items);
}
function parentOf(items, id) {
    for (const it of items) {
        if (it.type === "section") {
            if ((it.items ?? []).some((k) => k.id === id))
                return it;
            const p = parentOf(it.items ?? [], id);
            if (p)
                return p;
        }
    }
    return null;
}
function update(items, id, patch) {
    return items.map((it) => it.id === id ? { ...it, ...patch } : it.type === "section" ? { ...it, items: update(it.items ?? [], id, patch) } : it);
}
function reId(it, used) {
    let id = it.id;
    while (used.has(id))
        id = newId();
    used.add(id);
    return { ...it, id, condition: null, items: it.items?.map((k) => reId(k, used)) };
}
// ---- items editor (also used for one-off procedures on a work order) --------------------------------
export function ItemsEditor({ items, onChange, scoring, compact, files, addFile, selfId }) {
    const [sel, setSel] = useState(null);
    const [localFiles, setLocalFiles] = useState({});
    const drag = useRef(null);
    const [over, setOver] = useState(null);
    const { toast } = useToast();
    const ctx = { root: items, scoring, files: files ?? localFiles, addFile: addFile ?? ((f) => setLocalFiles((x) => ({ ...x, [f.id]: f }))), selfId, compact };
    const add = (type, into) => {
        const node = newItem(type);
        const target = into ?? sel;
        const tItem = target ? findItem(items, target) : undefined;
        let next;
        if (tItem && tItem.type === "section" && type !== "section")
            next = put(items, tItem.id, "inside", node);
        else if (tItem && !(type === "section" && parentOf(items, tItem.id)))
            next = put(items, tItem.id, "after", node);
        else if (tItem && type === "section")
            next = put(items, parentOf(items, tItem.id).id, "after", node);
        else
            next = [...items, node];
        onChange(next);
        setSel(node.id);
        setTimeout(() => document.getElementById(`pb-${node.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 30);
    };
    const move = (id, target, pos) => {
        if (id === target)
            return;
        const [rest, node] = take(items, id);
        if (!node)
            return;
        const tParent = pos === "inside" ? findItem(rest, target) : parentOf(rest, target);
        if (node.type === "section" && tParent) {
            toast("Sections can't go inside other sections.", { kind: "error" });
            return;
        }
        if (!findItem(rest, target))
            return; // dropped onto its own child
        onChange(put(rest, target, pos, node));
    };
    const step = (id, dir) => {
        const parent = parentOf(items, id);
        const sibs = parent ? parent.items ?? [] : items;
        const i = sibs.findIndex((x) => x.id === id);
        const j = i + dir;
        if (j < 0 || j >= sibs.length) {
            // step out of a section
            if (parent)
                move(id, parent.id, dir < 0 ? "before" : "after");
            return;
        }
        const other = sibs[j];
        const node = findItem(items, id);
        if (other.type === "section" && node.type !== "section")
            move(id, other.id, dir > 0 && (other.items ?? []).length === 0 ? "inside" : dir < 0 ? "inside" : "before");
        else
            move(id, other.id, dir < 0 ? "before" : "after");
    };
    const dnd = {
        start: (id) => { drag.current = id; },
        over: (e, it) => {
            if (!drag.current || drag.current === it.id)
                return;
            e.preventDefault();
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            const y = (e.clientY - r.top) / r.height;
            const pos = it.type === "section" && y > 0.3 && y < 0.7 ? "inside" : y < 0.5 ? "before" : "after";
            if (over?.id !== it.id || over.pos !== pos)
                setOver({ id: it.id, pos });
        },
        drop: (e) => { e.preventDefault(); e.stopPropagation(); if (drag.current && over)
            move(drag.current, over.id, over.pos); drag.current = null; setOver(null); },
        end: () => { drag.current = null; setOver(null); },
    };
    const count = fieldsOf({ items }).length;
    return (_jsx(BuilderCtx.Provider, { value: ctx, children: _jsxs("div", { className: "pb-items" + (compact ? " compact" : ""), children: [items.length === 0 && _jsx("div", { className: "pb-empty", children: "Add the first field. Drag fields to reorder them, and group them in sections." }), items.map((it) => _jsx(ItemCard, { it: it, sel: sel, setSel: setSel, over: over, dnd: dnd, onPatch: (id, p) => onChange(update(items, id, p)), onRemove: (id) => { onChange(take(items, id)[0]); if (sel === id)
                        setSel(null); }, onDuplicate: (id) => { const n = findItem(items, id); if (!n)
                        return; const used = new Set(fieldsOf({ items }).map((f) => f.id)); const copy = reId({ ...n, condition: n.condition }, used); onChange(put(items, id, "after", { ...copy, label: n.label ? `${n.label} (copy)`.slice(0, 512) : n.label })); setSel(copy.id); }, onStep: step, onAdd: add, onReplace: (id, nodes) => { let next = items; for (const n of [...nodes].reverse())
                        next = put(next, id, "after", n); onChange(take(next, id)[0]); } }, it.id)), _jsxs("div", { className: "row wrap pb-add-row", children: [_jsx(AddMenu, { onAdd: (t) => add(t), label: sel ? "Add field below" : "Add field" }), _jsxs("span", { className: "small faint", children: [count, " / 350 fields"] })] })] }) }));
}
function AddMenu({ onAdd, label, inSection }) {
    return (_jsx(Dropdown, { align: "left", width: 280, trigger: (_, t) => _jsxs(Button, { size: "sm", onClick: t, children: [_jsx(Plus, { size: 15 }), label] }), children: (close) => _jsx("div", { className: "pb-add-menu", children: FIELD_ORDER.filter((t) => !(inSection && t === "section")).map((t) => {
                const Icon = FIELD_ICON[t];
                return _jsxs("button", { type: "button", className: "menu-item", onClick: () => { close(); onAdd(t); }, children: [_jsx(Icon, { size: 15 }), _jsxs("span", { className: "grow", children: [_jsx("span", { children: FIELD_LABEL[t] }), FIELD_HINT[t] && _jsx("span", { className: "small faint", style: { display: "block" }, children: FIELD_HINT[t] })] })] }, t);
            }) }) }));
}
function ItemCard(props) {
    const { it, sel, setSel, over, dnd, onRemove, onDuplicate, onStep, onAdd } = props;
    const Icon = FIELD_ICON[it.type];
    const open = sel === it.id;
    const [handle, setHandle] = useState(false);
    const badges = [];
    if (it.required)
        badges.push("Required");
    if (it.condition)
        badges.push("Conditional");
    if (it.assignees?.length)
        badges.push("Assigned");
    const hint = over?.id === it.id ? " drop-" + over.pos : "";
    const head = (_jsxs("div", { className: "pb-card-head", onClick: () => setSel(open ? null : it.id), children: [_jsx("span", { className: "pb-grip", "aria-hidden": "true", onMouseDown: () => setHandle(true), onMouseUp: () => setHandle(false), onTouchStart: () => setHandle(true), children: _jsx(GripVertical, { size: 16 }) }), _jsx("span", { className: "pb-ic", children: _jsx(Icon, { size: 15 }) }), _jsxs("div", { className: "grow", style: { minWidth: 0 }, children: [_jsx("div", { className: "pb-card-label" + (it.label ? "" : " faint"), children: it.label || (it.type === "procedure" ? "Pick a procedure" : `Untitled ${FIELD_LABEL[it.type].toLowerCase()}`) }), _jsxs("div", { className: "small faint", children: [FIELD_LABEL[it.type], badges.length ? " · " + badges.join(" · ") : ""] })] }), _jsxs("span", { className: "pb-card-actions", onClick: (e) => e.stopPropagation(), children: [_jsx(Button, { variant: "ghost", icon: true, size: "sm", "aria-label": `Move ${it.label || "item"} up`, onClick: () => onStep(it.id, -1), children: _jsx(ArrowUp, { size: 14 }) }), _jsx(Button, { variant: "ghost", icon: true, size: "sm", "aria-label": `Move ${it.label || "item"} down`, onClick: () => onStep(it.id, 1), children: _jsx(ArrowDown, { size: 14 }) }), _jsx(Button, { variant: "ghost", icon: true, size: "sm", className: "pb-act-more", "aria-label": `Duplicate ${it.label || "item"}`, onClick: () => onDuplicate(it.id), children: _jsx(Copy, { size: 14 }) }), _jsx(Button, { variant: "ghost", icon: true, size: "sm", className: "pb-act-more", "aria-label": `Delete ${it.label || "item"}`, onClick: () => onRemove(it.id), children: _jsx(Trash2, { size: 14 }) })] })] }));
    return (_jsxs("div", { id: `pb-${it.id}`, className: "pb-card" + (open ? " open" : "") + (it.type === "section" ? " section" : "") + (it.type === "heading" ? " heading" : "") + hint, draggable: handle, onDragStart: (e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", it.id); dnd.start(it.id); }, onDragEnd: () => { setHandle(false); dnd.end(); }, onDragOver: (e) => dnd.over(e, it), onDrop: dnd.drop, children: [head, open && _jsx("div", { className: "pb-card-body", onClick: (e) => e.stopPropagation(), children: _jsx(ItemEditor, { ...props }) }), it.type === "section" && (_jsxs("div", { className: "pb-section-items", children: [(it.items ?? []).map((k) => _createElement(ItemCard, { ...props, key: k.id, it: k })), (it.items ?? []).length === 0 && _jsx("div", { className: "pb-empty small", children: "Drag fields here or add one." }), _jsx("div", { children: _jsx(AddMenu, { inSection: true, label: "Add to section", onAdd: (t) => onAdd(t, it.id) }) })] }))] }));
}
function ItemEditor({ it, onPatch, onReplace }) {
    const ctx = useContext(BuilderCtx);
    const opts = useWOOptions();
    const set = (p) => onPatch(it.id, p);
    const field = isField(it.type);
    return (_jsxs("div", { className: "pb-editor", children: [it.type === "procedure" ? _jsx(NestedPicker, { it: it, onPatch: set, onReplace: (nodes) => onReplace(it.id, nodes) }) : (_jsx(Field, { label: it.type === "section" ? "Section name" : it.type === "heading" ? "Heading" : "Field name", children: (id) => _jsx(Input, { id: id, value: it.label, maxLength: 512, autoFocus: true, onChange: (e) => set({ label: e.target.value }), placeholder: it.type === "checkbox" ? "e.g. Lockout applied" : "Name this field" }) })), field && _jsx(Field, { label: "Description", hint: "Shown under the field name", children: (id) => _jsx("textarea", { id: id, className: "textarea", rows: 2, value: it.description ?? "", maxLength: 4000, onChange: (e) => set({ description: e.target.value }) }) }), (it.type === "multiple_choice" || it.type === "checklist") && _jsx(OptionsEditor, { it: it, onPatch: set, scoring: ctx.scoring }), (it.type === "number" || it.type === "amount") && (_jsxs("div", { className: "pb-grid3", children: [_jsx(Field, { label: "Unit", children: (id) => _jsx(Input, { id: id, value: it.unit ?? "", maxLength: 30, placeholder: it.type === "amount" ? "$" : "e.g. psi", onChange: (e) => set({ unit: e.target.value }) }) }), _jsx(Field, { label: "Lowest allowed", children: (id) => _jsx(Input, { id: id, type: "number", step: "any", value: it.min ?? "", onChange: (e) => set({ min: e.target.value === "" ? undefined : Number(e.target.value) }) }) }), _jsx(Field, { label: "Highest allowed", children: (id) => _jsx(Input, { id: id, type: "number", step: "any", value: it.max ?? "", onChange: (e) => set({ max: e.target.value === "" ? undefined : Number(e.target.value) }) }) })] })), it.type === "meter_reading" && _jsx(MeterField, { it: it, onPatch: set }), it.type === "location_check_in" && (_jsxs("div", { className: "stack", style: { gap: 8 }, children: [_jsx(Field, { label: "Allowed distance (metres)", hint: "How close the technician must be to the work order's location (or its asset's)", children: (id) => _jsx(Input, { id: id, type: "number", min: 1, max: 5000, value: it.buffer_m ?? 10, onChange: (e) => set({ buffer_m: e.target.value === "" ? undefined : Number(e.target.value) }), style: { maxWidth: 140 } }) }), _jsx(Toggle, { checked: it.allow_skip !== false, onChange: (v) => set({ allow_skip: v }), label: "Allow skipping", hint: "Skips are recorded with the reason" })] })), it.type === "date" && _jsx(Toggle, { checked: !!it.with_time, onChange: (v) => set({ with_time: v || undefined }), label: "Include time" }), field && ctx.scoring && SCORABLE.includes(it.type) && it.type !== "multiple_choice" && (_jsx(Field, { label: it.type === "checklist" ? "Points per item" : "Points", hint: it.type === "inspection" ? "Pass earns all points, Flag half" : undefined, children: (id) => _jsx(Input, { id: id, type: "number", min: 0, max: 100, value: typeof it.points === "number" ? it.points : 1, style: { maxWidth: 100 }, onChange: (e) => set({ points: e.target.value === "" ? undefined : Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) }) }) })), field && _jsx("div", { className: "pb-toggles", children: _jsx(Toggle, { checked: !!it.required, onChange: (v) => set({ required: v || undefined }), label: "Required", hint: "Must be answered before the work order is Done" }) }), it.type !== "heading" && _jsx(ConditionEditor, { it: it, onPatch: set }), field && !ctx.compact && _jsx(Field, { label: "Assigned to", hint: "Only these people (or team members) can answer it, and the work order can't be completed until they do", children: (id) => _jsx(AssigneePicker, { id: id, options: opts.data, value: it.assignees ?? [], onChange: (v) => set({ assignees: v.length ? v : undefined }) }) }), field && _jsx(Field, { label: "Link", hint: "A web page with instructions, e.g. the manufacturer's manual", children: (id) => _jsx(Input, { id: id, type: "url", value: it.link ?? "", placeholder: "https://", maxLength: 2000, onChange: (e) => set({ link: e.target.value || undefined }) }) }), field && !ctx.compact && _jsx(RefFiles, { it: it, onPatch: set })] }));
}
function OptionsEditor({ it, onPatch, scoring }) {
    const opts = it.options ?? [];
    const pts = typeof it.points === "object" && it.points ? it.points : {};
    const perOption = scoring && it.type === "multiple_choice";
    const setOpt = (i, v) => {
        const next = opts.map((o, j) => j === i ? v : o);
        const p = perOption ? Object.fromEntries(Object.entries(pts).map(([k, n]) => [k === opts[i] ? v : k, n])) : undefined;
        onPatch(p ? { options: next, points: p } : { options: next });
    };
    return (_jsxs("fieldset", { className: "pb-options", children: [_jsxs("legend", { className: "small", children: ["Options", perOption && _jsx("span", { className: "faint", children: " \u00B7 points" })] }), opts.map((o, i) => (_jsxs("div", { className: "row", style: { gap: 6 }, children: [_jsx(Input, { value: o, "aria-label": `Option ${i + 1}`, maxLength: 512, onChange: (e) => setOpt(i, e.target.value) }), perOption && _jsx(Input, { type: "number", min: 0, max: 100, "aria-label": `Points for ${o}`, style: { width: 76 }, value: pts[o] ?? (i === 0 ? 1 : 0), onChange: (e) => onPatch({ points: { ...Object.fromEntries(opts.map((x, j) => [x, pts[x] ?? (j === 0 ? 1 : 0)])), [o]: Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))) } }) }), _jsx(Button, { variant: "ghost", icon: true, size: "sm", "aria-label": `Remove ${o || "option"}`, disabled: opts.length <= 1, onClick: () => onPatch({ options: opts.filter((_, j) => j !== i) }), children: _jsx(X, { size: 14 }) })] }, i))), _jsx("div", { children: _jsxs("button", { type: "button", className: "linkbtn small", onClick: () => onPatch({ options: [...opts, `Option ${opts.length + 1}`] }), disabled: opts.length >= 100, children: [_jsx(Plus, { size: 13 }), "Add option"] }) })] }));
}
function MeterField({ it, onPatch }) {
    const meters = useMeterList();
    return _jsx(Field, { label: "Meter", hint: "The reading is saved on the meter, and alarm or warning readings mark the step Fail or Flag", children: (id) => _jsxs(Select, { id: id, value: it.meter_id ?? "", onChange: (e) => onPatch({ meter_id: e.target.value || undefined }), children: [_jsx("option", { value: "", children: "Pick a meter" }), (meters.data?.items ?? []).map((m) => _jsxs("option", { value: m.id, children: [m.name, m.asset ? ` — ${m.asset.name}` : ""] }, m.id))] }) });
}
function RefFiles({ it, onPatch }) {
    const { files, addFile } = useContext(BuilderCtx);
    const ref = useRef(null);
    const [busy, setBusy] = useState(false);
    const { toast } = useToast();
    const ids = it.reference_file_ids ?? [];
    const attach = async (f) => {
        if (!f)
            return;
        setBusy(true);
        try {
            const up = await upload(f);
            addFile(up);
            onPatch({ reference_file_ids: [...(it.reference_file_ids ?? []), up.id] });
        }
        catch (x) {
            toast(x.message, { kind: "error" });
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsxs(DropZone, { className: "field", multiple: false, disabled: busy || ids.length >= 20, onFiles: (fs) => void attach(fs[0]), children: [_jsx("label", { children: "Reference files" }), _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [ids.map((id) => _jsxs("span", { className: "chip", children: [_jsx(FileText, { size: 12 }), files[id]?.name ?? "File", _jsx("button", { type: "button", className: "chip-x", "aria-label": `Remove ${files[id]?.name ?? "file"}`, onClick: () => onPatch({ reference_file_ids: ids.filter((x) => x !== id) }), children: _jsx(X, { size: 11 }) })] }, id)), _jsx("input", { ref: ref, type: "file", hidden: true, onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ""; void attach(f); } }), _jsxs("button", { type: "button", className: "linkbtn small", disabled: busy || ids.length >= 20, onClick: () => ref.current?.click(), children: [_jsx(Upload, { size: 13 }), busy ? "Uploading…" : "Attach a file"] })] }), _jsx("span", { className: "hint", children: "Manuals, diagrams or photos the technician can open from this step" })] }));
}
const ENUM_VALUES = (src) => src.type === "inspection" ? [{ key: "pass", label: "Pass" }, { key: "flag", label: "Flag" }, { key: "fail", label: "Fail" }]
    : src.type === "yes_no_na" ? [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }, { key: "na", label: "N/A" }]
        : (src.options ?? []).map((o) => ({ key: o, label: o }));
function ConditionEditor({ it, onPatch }) {
    const { root } = useContext(BuilderCtx);
    const sources = fieldsBefore(root, it.id).filter((f) => COND_SOURCES.includes(f.type) && f.label);
    const c = it.condition;
    const src = c ? sources.find((s) => s.id === c.field) : undefined;
    const set = (n) => onPatch({ condition: n });
    const pickSource = (id) => {
        const s = sources.find((x) => x.id === id);
        if (!s)
            return set(null);
        if (s.type === "checkbox")
            return set({ field: id, op: "eq", value: true });
        if (s.type === "number" || s.type === "amount")
            return set({ field: id, op: "gt", value: 0 });
        const vals = ENUM_VALUES(s);
        return set({ field: id, op: "in", value: s.type === "inspection" ? ["flag", "fail"] : vals.slice(0, 1).map((v) => v.key) });
    };
    if (!sources.length)
        return _jsx("div", { className: "small faint", children: "Conditions: add a checkbox, choice, inspection or number field above this one to show it only for certain answers." });
    return (_jsxs("fieldset", { className: "pb-cond", children: [_jsx("legend", { className: "small", children: it.type === "section" ? "Show this section" : "Show this field" }), _jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsxs(Select, { "aria-label": "Condition field", value: c?.field ?? "", onChange: (e) => pickSource(e.target.value), style: { maxWidth: 260 }, children: [_jsx("option", { value: "", children: "Always" }), sources.map((s) => _jsxs("option", { value: s.id, children: ["When \u201C", s.label.slice(0, 60), "\u201D"] }, s.id))] }), c && src && src.type === "checkbox" && (_jsxs(Select, { "aria-label": "Condition", value: c.op === "neq" ? "off" : "on", onChange: (e) => set({ field: c.field, op: e.target.value === "on" ? "eq" : "neq", value: true }), style: { width: "auto" }, children: [_jsx("option", { value: "on", children: "is checked" }), _jsx("option", { value: "off", children: "is not checked" })] })), c && src && (src.type === "number" || src.type === "amount") && _jsxs(_Fragment, { children: [_jsxs(Select, { "aria-label": "Condition", value: c.op, onChange: (e) => set({ ...c, op: e.target.value }), style: { width: "auto" }, children: [_jsx("option", { value: "gt", children: "is more than" }), _jsx("option", { value: "lt", children: "is less than" }), _jsx("option", { value: "eq", children: "is" }), _jsx("option", { value: "neq", children: "is not" }), _jsx("option", { value: "answered", children: "is answered" })] }), c.op !== "answered" && _jsx(Input, { type: "number", step: "any", "aria-label": "Value", value: String(c.value ?? ""), style: { width: 110 }, onChange: (e) => set({ ...c, value: e.target.value === "" ? 0 : Number(e.target.value) }) })] }), c && src && !["checkbox", "number", "amount"].includes(src.type) && _jsx(_Fragment, { children: _jsxs(Select, { "aria-label": "Condition", value: c.op === "answered" ? "answered" : c.op === "not_in" || c.op === "neq" ? "not_in" : "in", style: { width: "auto" }, onChange: (e) => set(e.target.value === "answered" ? { field: c.field, op: "answered" } : { field: c.field, op: e.target.value, value: Array.isArray(c.value) ? c.value : [] }), children: [_jsx("option", { value: "in", children: src.type === "checklist" ? "includes any of" : "is" }), _jsx("option", { value: "not_in", children: src.type === "checklist" ? "includes none of" : "is not" }), _jsx("option", { value: "answered", children: "is answered" })] }) })] }), c && src && !["checkbox", "number", "amount"].includes(src.type) && c.op !== "answered" && (_jsx("div", { className: "row wrap", style: { gap: 4, marginTop: 6 }, children: ENUM_VALUES(src).map((v) => {
                    const arr = Array.isArray(c.value) ? c.value : c.value !== undefined ? [String(c.value)] : [];
                    const on = arr.includes(v.key);
                    return _jsx("button", { type: "button", className: "pb-chip" + (on ? " on" : ""), "aria-pressed": on, onClick: () => set({ ...c, value: on ? arr.filter((x) => x !== v.key) : [...arr, v.key] }), children: v.label }, v.key);
                }) }))] }));
}
function NestedPicker({ it, onPatch, onReplace }) {
    const lib = useLibrary(true);
    const { selfId, root } = useContext(BuilderCtx);
    const { toast } = useToast();
    const [busy, setBusy] = useState(false);
    const merge = async () => {
        if (!it.procedure_id)
            return;
        setBusy(true);
        try {
            const d = await api(`/procedures/${it.procedure_id}`);
            const used = new Set(fieldsOf({ items: root }).map((f) => f.id).concat(root.map((r) => r.id)));
            const src = d.published?.schema.items ?? [];
            // keep conditions that point inside the merged procedure by re-mapping their ids
            const map = {};
            const re = (x) => { let id = x.id; while (used.has(id))
                id = newId(); used.add(id); map[x.id] = id; return { ...x, id, items: x.items?.map(re) }; };
            const fix = (x) => ({ ...x, condition: x.condition && map[x.condition.field] ? { ...x.condition, field: map[x.condition.field] } : null, items: x.items?.map(fix) });
            const isNestedSection = !!parentOfRoot(root, it.id);
            let nodes = src.map(re).map(fix);
            if (isNestedSection)
                nodes = nodes.flatMap((n) => n.type === "section" ? [{ ...newItem("heading"), label: n.label }, ...(n.items ?? [])] : [n]);
            onReplace(nodes);
            toast(`Merged ${d.name}. Changes to it won't affect this procedure.`);
        }
        catch (e) {
            toast(e.message, { kind: "error" });
        }
        finally {
            setBusy(false);
        }
    };
    const choices = (lib.data?.items ?? []).filter((p) => p.id !== selfId);
    return (_jsxs("div", { className: "stack", style: { gap: 8 }, children: [_jsx(Field, { label: "Procedure", hint: "Its fields appear here as they are when you publish. Publish again to pick up later changes.", children: (id) => _jsxs(Select, { id: id, value: it.procedure_id ?? "", onChange: (e) => { const p = choices.find((x) => x.id === e.target.value); onPatch({ procedure_id: p?.id, label: p?.name ?? "" }); }, children: [_jsx("option", { value: "", children: "Pick a published procedure" }), choices.map((p) => _jsx("option", { value: p.id, children: p.name }, p.id))] }) }), it.procedure_id && _jsx("div", { children: _jsxs(Button, { size: "sm", onClick: merge, disabled: busy, children: [_jsx(GitMerge, { size: 14 }), "Merge its fields into this procedure"] }) })] }));
}
const parentOfRoot = (root, id) => parentOf(root, id);
// ---- variants (r598) -----------------------------------------------------------------------------
function VariantsEditor({ value, onChange, selfId }) {
    const lib = useLibrary(true);
    const choices = (lib.data?.items ?? []).filter((p) => p.id !== selfId);
    const taken = (i) => new Set(value.flatMap((v, j) => j === i ? [] : v.months));
    return (_jsxs("div", { className: "stack", style: { gap: 10 }, children: [value.map((v, i) => (_jsxs("div", { className: "pb-variant", children: [_jsxs("div", { className: "row wrap", style: { gap: 6 }, children: [_jsx(Input, { "aria-label": "Variant name", value: v.name, maxLength: 60, placeholder: "e.g. Winter", onChange: (e) => onChange(value.map((x, j) => j === i ? { ...x, name: e.target.value } : x)), style: { maxWidth: 160 } }), _jsxs(Select, { "aria-label": "Use this procedure", value: v.procedure_id, onChange: (e) => onChange(value.map((x, j) => j === i ? { ...x, procedure_id: e.target.value } : x)), style: { maxWidth: 280 }, children: [_jsx("option", { value: "", children: "Pick the procedure to use" }), choices.map((p) => _jsx("option", { value: p.id, children: p.name }, p.id))] }), _jsx(Button, { variant: "ghost", icon: true, size: "sm", "aria-label": "Remove variant", onClick: () => onChange(value.filter((_, j) => j !== i)), children: _jsx(Trash2, { size: 14 }) })] }), _jsx("div", { className: "pb-months", role: "group", "aria-label": "Months", children: MONTHS.map((m, k) => {
                            const n = k + 1, on = v.months.includes(n), off = taken(i).has(n);
                            return _jsx("button", { type: "button", className: "pb-chip" + (on ? " on" : ""), "aria-pressed": on, disabled: off && !on, onClick: () => onChange(value.map((x, j) => j === i ? { ...x, months: on ? x.months.filter((y) => y !== n) : [...x.months, n].sort((a, b) => a - b) } : x)), children: m }, m);
                        }) })] }, i))), _jsx("div", { children: _jsxs("button", { type: "button", className: "linkbtn small", onClick: () => onChange([...value, { name: "", months: [], procedure_id: "" }]), children: [_jsx(Plus, { size: 13 }), "Add a seasonal variant"] }) })] }));
}
const blank = { name: "", description: "", category: "", tags: [], items: [], scoring: { enabled: false, goal: null }, variants: [] };
export function ProcedureBuilder({ id, init }) {
    const isNew = id === "new";
    const q = useQuery({ queryKey: ["procedure", id], queryFn: () => api(`/procedures/${id}`), enabled: !isNew });
    if (!isNew && !q.data)
        return q.isError ? _jsx("div", { className: "page", children: _jsxs("p", { children: ["That procedure doesn't exist or you can't edit it. ", _jsx(Link, { to: "/procedures", children: "Back to procedures" })] }) })
            : _jsx("div", { className: "page", children: _jsx(ListSkeleton, { rows: 6 }) });
    const d = q.data;
    const start = d ? {
        name: d.name, description: d.description, category: d.category, tags: d.tags, variants: d.variants,
        items: (d.draft ?? d.published)?.schema.items ?? [], scoring: (d.draft ?? d.published)?.schema.scoring ?? { enabled: false, goal: null },
    } : init ? { ...blank, name: init.name, items: init.schema.items, scoring: init.schema.scoring ?? blank.scoring } : blank;
    return _jsx(BuilderInner, { id: isNew ? null : id, detail: d, start: start }, id);
}
function BuilderInner({ id, detail, start }) {
    const [d, setD] = useState(start);
    const [dirty, setDirty] = useState(false);
    const [tab, setTab] = useState("edit");
    const [tagText, setTagText] = useState(start.tags.join(", "));
    const [files, setFiles] = useState(() => Object.fromEntries((detail?.files ?? []).map((f) => [f.id, f])));
    const [leaving, setLeaving] = useState(false);
    const nav = useNavigate();
    const qc = useQueryClient();
    const { toast } = useToast();
    const set = (p) => { setD((x) => ({ ...x, ...p })); setDirty(true); };
    useEffect(() => {
        if (!dirty)
            return;
        const h = (e) => { e.preventDefault(); e.returnValue = ""; };
        window.addEventListener("beforeunload", h);
        return () => window.removeEventListener("beforeunload", h);
    }, [dirty]);
    const schema = useMemo(() => ({ items: d.items, scoring: d.scoring }), [d.items, d.scoring]);
    const payload = () => ({ name: d.name.trim(), description: d.description, category: d.category.trim(), tags: tagText.split(",").map((t) => t.trim()).filter(Boolean),
        variants: d.variants.filter((v) => v.procedure_id && v.months.length).map((v) => ({ ...v, name: v.name.trim() || "Variant" })), schema });
    const save = useMutation({
        mutationFn: async (publish) => {
            let p = id ? await api(`/procedures/${id}`, { method: "PATCH", body: payload() })
                : await api("/procedures", { method: "POST", body: payload() });
            if (publish)
                p = await api(`/procedures/${p.id}/publish`, { method: "POST" });
            return { p, publish };
        },
        onSuccess: ({ p, publish }) => {
            setDirty(false);
            qc.setQueryData(["procedure", p.id], p);
            qc.invalidateQueries({ queryKey: ["procedures"] });
            qc.invalidateQueries({ queryKey: ["procedure", p.id] });
            toast(publish ? `Published version ${p.published?.number}` : "Draft saved");
            if (publish || !id)
                nav(publish ? `/procedures/${p.id}` : `/procedures/${p.id}/edit`, { replace: !id });
        },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const back = () => (dirty ? setLeaving(true) : nav(id ? `/procedures/${id}` : "/procedures"));
    const count = fieldsOf(schema).length;
    return (_jsxs("div", { className: "pb-page", children: [_jsxs("div", { className: "pb-top", children: [_jsx(Button, { variant: "ghost", icon: true, "aria-label": "Back", onClick: back, children: _jsx(ArrowLeft, { size: 18 }) }), _jsx(Input, { className: "pb-name", "aria-label": "Procedure name", placeholder: "Name this procedure", value: d.name, maxLength: 255, onChange: (e) => set({ name: e.target.value }) }), _jsx("span", { className: "desktop-only", children: detail?.status === "published" ? _jsxs(Pill, { tone: "success", children: ["Published v", detail.published?.number] }) : _jsx(Pill, { children: "Draft" }) }), _jsx("span", { className: "grow" }), _jsx(Button, { onClick: () => save.mutate(false), disabled: save.isPending || !d.name.trim(), children: "Save draft" }), _jsx(Button, { variant: "primary", onClick: () => save.mutate(true), disabled: save.isPending || !d.name.trim() || count === 0, children: "Publish" })] }), _jsxs("div", { className: "seg pb-tabs", role: "tablist", "aria-label": "Builder view", children: [_jsx("button", { type: "button", role: "tab", "aria-selected": tab === "edit", className: "seg-btn" + (tab === "edit" ? " on" : ""), onClick: () => setTab("edit"), children: "Edit" }), _jsxs("button", { type: "button", role: "tab", "aria-selected": tab === "preview", className: "seg-btn" + (tab === "preview" ? " on" : ""), onClick: () => setTab("preview"), children: [_jsx(Eye, { size: 14 }), "Preview"] })] }), _jsxs("div", { className: "pb-main tab-" + tab, children: [_jsxs("div", { className: "pb-edit", children: [_jsxs("details", { className: "card pb-meta", open: !id, children: [_jsxs("summary", { children: [_jsx("span", { className: "grow", children: "Details, scoring and variants" }), _jsx(ChevronDown, { size: 16, className: "faint" })] }), _jsxs("div", { className: "stack", style: { gap: 12, padding: "0 var(--s-4) var(--s-4)" }, children: [_jsx(Field, { label: "Description", children: (i) => _jsx("textarea", { id: i, className: "textarea", rows: 2, value: d.description, maxLength: 4000, onChange: (e) => set({ description: e.target.value }) }) }), _jsxs("div", { className: "pb-grid2", children: [_jsx(Field, { label: "Category", children: (i) => _jsx(Input, { id: i, value: d.category, maxLength: 80, placeholder: "e.g. Safety", onChange: (e) => set({ category: e.target.value }) }) }), _jsx(Field, { label: "Tags", hint: "Separate with commas", children: (i) => _jsx(Input, { id: i, value: tagText, placeholder: "e.g. Weekly, OSHA", onChange: (e) => { setTagText(e.target.value); setDirty(true); } }) })] }), _jsx(Toggle, { checked: d.scoring.enabled, onChange: (v) => set({ scoring: { ...d.scoring, enabled: v } }), label: "Score this procedure", hint: "Checkboxes, choices, checklists and inspections earn points; the score is a percent of the points available" }), d.scoring.enabled && _jsx(Field, { label: "Goal (%)", hint: "Below the goal, a corrective work order can be created", children: (i) => _jsx(Input, { id: i, type: "number", min: 0, max: 100, style: { maxWidth: 110 }, value: d.scoring.goal ?? "", onChange: (e) => set({ scoring: { ...d.scoring, goal: e.target.value === "" ? null : Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) } }) }) }), _jsxs("div", { className: "field", children: [_jsx("label", { children: "Seasonal variants" }), _jsx("span", { className: "hint", style: { marginBottom: 6 }, children: "In the months you pick, work orders get the other procedure instead of this one" }), _jsx(VariantsEditor, { value: d.variants, onChange: (v) => set({ variants: v }), selfId: id ?? undefined })] })] })] }), _jsx(ItemsEditor, { items: d.items, onChange: (items) => set({ items }), scoring: d.scoring.enabled, files: files, addFile: (f) => setFiles((x) => ({ ...x, [f.id]: f })), selfId: id ?? undefined })] }), _jsxs("aside", { className: "pb-preview card", "aria-label": "Preview", children: [_jsxs("div", { className: "card-head", children: [_jsxs("h2", { children: [_jsx(Eye, { size: 16 }), " Preview"] }), _jsx("span", { className: "small faint", children: "How technicians see it" })] }), _jsx("div", { className: "card-body", children: _jsx(PreviewForm, { schema: schema, refs: files }) })] })] }), leaving && _jsx(Modal, { title: "Leave without saving?", onClose: () => setLeaving(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setLeaving(false), children: "Keep editing" }), _jsx(Button, { variant: "danger", onClick: () => { setDirty(false); nav(id ? `/procedures/${id}` : "/procedures"); }, children: "Discard changes" })] }), children: _jsx("p", { children: "Your changes to this procedure haven't been saved." }) })] }));
}
export function FieldTypeIcon({ type, size = 15 }) {
    const I = FIELD_ICON[type];
    return _jsx(I, { size: size });
}
