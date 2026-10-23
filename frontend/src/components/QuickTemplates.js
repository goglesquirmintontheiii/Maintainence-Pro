import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// One-tap work orders from templates (0.4.0, MP-119): a "From template" menu for the work-order list and the asset
// page. Tapping a template creates the work order straight away; "Review first" opens the full form prefilled
// (/work-orders?new=1&template=<id>&asset=<id>).
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Pin, Zap } from "lucide-react";
import "../styles/automations.css";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { useToast } from "./Toast";
import { Button, Dropdown } from "./ui";
function useQuickTemplates(assetId) {
    const { can } = useSession();
    const nav = useNavigate();
    const qc = useQueryClient();
    const { toast } = useToast();
    const t = useQuery({ queryKey: ["wo-templates", "popular"], queryFn: () => api("/work-order-templates?sort=popular"),
        staleTime: 30_000, enabled: can("wo.create") });
    const items = can("wo.create") ? (t.data?.items ?? []).slice(0, 8) : [];
    const review = (tpl) => nav(`/work-orders?new=1&template=${tpl.id}${assetId ? `&asset=${assetId}` : ""}`);
    const go = async (tpl) => {
        try {
            const wo = await api(`/work-order-templates/${tpl.id}/create`, { method: "POST", body: assetId ? { asset_id: assetId } : {} });
            qc.invalidateQueries({ queryKey: ["work-orders"] });
            qc.invalidateQueries({ queryKey: ["wo-templates"] });
            qc.invalidateQueries({ queryKey: ["wo-stats"] });
            qc.invalidateQueries({ queryKey: ["asset"] });
            toast(`Work order #${wo.number} created from “${tpl.name}”`);
            nav(`/work-orders/${wo.id}`);
        }
        catch (e) {
            // e.g. a required field the template doesn't fill: open the form prefilled instead
            toast(e.message, { kind: "error" });
            review(tpl);
        }
    };
    return { items, go, review };
}
/** The template rows themselves, for use inside an existing menu (the asset page's "More actions"). */
export function QuickTemplateItems({ assetId, close, label = "Create in one tap" }) {
    const { items, go, review } = useQuickTemplates(assetId);
    if (!items.length)
        return null;
    return _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-label", children: label }), items.map((x) => (_jsxs("div", { className: "qt-item", children: [_jsxs("button", { className: "menu-item", onClick: () => { close(); void go(x); }, title: `Create a work order from “${x.name}” now`, children: [x.pinned ? _jsx(Pin, { size: 15 }) : _jsx(Zap, { size: 15 }), _jsx("span", { className: "grow", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: x.name })] }), _jsx("button", { type: "button", className: "qt-review", onClick: () => { close(); review(x); }, "aria-label": `Review ${x.name} first`, children: "Review first" })] }, x.id)))] });
}
/** A "From template" button with its own menu (the work-order list toolbar). */
export function QuickTemplates({ assetId, compact = false }) {
    const { items } = useQuickTemplates(assetId);
    if (!items.length)
        return null;
    return (_jsx(Dropdown, { width: 300, className: "qt-drop", trigger: (open, toggle) => (_jsxs(Button, { onClick: toggle, "aria-expanded": open, "aria-haspopup": "menu", "aria-label": "New work order from a template", title: "New work order from a template", children: [_jsx(Zap, { size: 15 }), !compact && _jsx("span", { className: "desktop-only", children: "From template" }), _jsx(ChevronDown, { size: 14, className: "faint" })] })), children: (close) => _jsx(QuickTemplateItems, { assetId: assetId, close: close }) }));
}
