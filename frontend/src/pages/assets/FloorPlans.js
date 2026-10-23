import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Floor plans on a location: upload a plan image; the card shows the plan with its pins and drawing, and opens the
// full-screen viewer/editor (FloorPlanEditor) to zoom, draw, pin assets and link areas to locations (MP-110).
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, MapPin, Maximize2, Pencil, Trash2 } from "lucide-react";
import { api, upload } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Modal } from "../../components/ui";
import { FloorPlanEditor, PlanShapes } from "./FloorPlanEditor";
import { DropZone } from "../../components/DropZone";
export function FloorPlans({ loc, editable }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const input = useRef(null);
    const [current, setCurrent] = useState(0);
    const [busy, setBusy] = useState(false);
    const refresh = () => qc.invalidateQueries({ queryKey: ["location", loc.id] });
    const add = async (file) => {
        if (!file)
            return;
        setBusy(true);
        try {
            const f = await upload(file);
            await api(`/locations/${loc.id}/floor-plans`, { method: "POST", body: { name: file.name.replace(/\.[^.]+$/, ""), file_id: f.id } });
            await refresh();
            setCurrent(loc.floor_plans.length);
            toast("Floor plan added");
        }
        catch (e) {
            toast(e.message, { kind: "error" });
        }
        finally {
            setBusy(false);
        }
    };
    const plans = loc.floor_plans;
    const plan = plans[Math.min(current, plans.length - 1)];
    return (_jsx(DropZone, { className: "card", disabled: !editable || busy, multiple: false, accept: "image/png,image/jpeg,image/webp", label: "Drop an image to add it as a floor plan", onFiles: (fs) => void add(fs[0]), children: _jsxs("section", { children: [_jsxs("div", { className: "card-head wrap", children: [_jsx("div", { className: "seg", role: "tablist", "aria-label": "Floor plans", children: plans.map((p, i) => (_jsx("button", { type: "button", role: "tab", "aria-selected": plan?.id === p.id, className: "seg-btn" + (plan?.id === p.id ? " on" : ""), onClick: () => setCurrent(i), children: p.name }, p.id))) }), editable && _jsxs(_Fragment, { children: [_jsx("input", { ref: input, type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true, onChange: (e) => { void add(e.target.files?.[0]); e.target.value = ""; } }), _jsxs(Button, { size: "sm", onClick: () => input.current?.click(), disabled: busy, children: [_jsx(ImagePlus, { size: 14 }), busy ? "Uploading…" : "Add floor plan"] })] })] }), !plan ? _jsx(EmptyState, { icon: _jsx(MapPin, { size: 24 }), title: "No floor plans", children: "Upload a floor plan image (PNG, JPG or WebP) and pin assets on it, so people can find equipment fast." })
                    : _jsx(PlanCanvas, { loc: loc, plan: plan, editable: editable, onChanged: refresh }, plan.id)] }) }));
}
function PlanCanvas({ loc, plan, editable, onChanged }) {
    const nav = useNavigate();
    const { toast } = useToast();
    const [open, setOpen] = useState(null);
    const [confirm, setConfirm] = useState(false);
    const [aspect, setAspect] = useState(0.66);
    const base = `/locations/${loc.id}/floor-plans/${plan.id}`;
    const delPlan = useMutation({ mutationFn: () => api(base, { method: "DELETE" }), onSuccess: () => { onChanged(); toast("Floor plan removed"); }, onError: (e) => toast(e.message, { kind: "error" }) });
    const shapes = (plan.annotations?.shapes ?? []);
    return (_jsxs("div", { className: "card-body stack", children: [_jsxs("div", { className: "plan-box fp-preview", role: "button", tabIndex: 0, "aria-label": `Open ${plan.name} full screen`, title: "Open full screen", onClick: () => setOpen("view"), onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpen("view");
                } }, children: [_jsx("img", { src: plan.url, alt: `Floor plan: ${plan.name}`, draggable: false, onLoad: (e) => setAspect(e.currentTarget.naturalHeight / e.currentTarget.naturalWidth || 0.66) }), _jsx(PlanShapes, { shapes: shapes, aspect: aspect, onOpen: (s) => nav(s.location_id ? `/locations/${s.location_id}` : `/assets/${s.asset_id}`) }), plan.pins.map((p) => (_jsxs("button", { type: "button", className: "plan-pin" + (p.asset_status ? " " + p.asset_status : ""), style: { left: `${p.x * 100}%`, top: `${p.y * 100}%` }, title: p.label, "aria-label": `${p.label}${p.asset_id ? " (asset)" : ""}`, onClick: (e) => { e.stopPropagation(); if (p.asset_id)
                            nav(`/assets/${p.asset_id}`);
                        else
                            setOpen("view"); }, children: [_jsx(MapPin, { size: 22 }), _jsx("span", { className: "plan-pin-label", children: p.label })] }, p.id))), _jsxs("span", { className: "fp-open-hint", children: [_jsx(Maximize2, { size: 14 }), "Open"] })] }), _jsxs("div", { className: "row small muted wrap", style: { justifyContent: "space-between" }, children: [_jsx("span", { children: editable ? "Open the plan to zoom in, or edit it to draw rooms, add pins and link areas to locations." : "Click the plan to open it full screen. Click a pin or a linked area to open it." }), editable && _jsxs("span", { className: "row", style: { gap: 6 }, children: [_jsxs(Button, { size: "sm", onClick: () => setOpen("edit"), children: [_jsx(Pencil, { size: 14 }), "Edit plan"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setConfirm(true), children: [_jsx(Trash2, { size: 14 }), "Remove this plan"] })] })] }), open && _jsx(FloorPlanEditor, { locId: loc.id, plan: plan, editable: editable, startEditing: open === "edit", onClose: () => setOpen(null), onChanged: onChanged }), confirm && _jsx(Modal, { title: "Remove floor plan?", onClose: () => setConfirm(false), footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: () => setConfirm(false), children: "Cancel" }), _jsx(Button, { variant: "danger", onClick: () => { setConfirm(false); delPlan.mutate(); }, children: "Remove" })] }), children: _jsxs("p", { children: [plan.name, ", its pins and its drawing will be removed."] }) })] }));
}
