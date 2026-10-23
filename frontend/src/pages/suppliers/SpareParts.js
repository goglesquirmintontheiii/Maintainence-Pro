import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// 0.5.0 asset "Spare parts" tab (MP-089): parts used on the asset with their stock and preferred supplier,
// spare parts to buy, and where the asset was purchased.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Pill } from "../../components/ui";
import { ProductCard, ProductLinksPanel } from "./ProductLinksPanel";
import "./suppliers.css";
export function SparePartsTab({ assetId, canEdit }) {
    const { can } = useSession();
    const q = useQuery({ queryKey: ["asset-spare-parts", assetId], queryFn: () => api(`/assets/${assetId}/spare-parts`) });
    const parts = q.data?.parts ?? [];
    return (_jsxs("div", { className: "stack", children: [can("parts.view") && _jsxs("section", { className: "card", children: [_jsx("div", { className: "card-head", children: _jsx("h3", { className: "sec-h", style: { margin: 0 }, children: "Parts for this asset" }) }), q.isLoading ? _jsx("div", { className: "card-body small faint", children: "Loading\u2026" })
                        : parts.length === 0 ? _jsx("div", { className: "card-body small faint", children: "No parts are linked to this asset. Add the asset on a part to see it here." })
                            : parts.map((p) => _jsxs("div", { children: [_jsxs(Link, { to: `/parts/${p.id}`, className: "list-row", children: [_jsxs("span", { className: "grow", children: [_jsx("span", { className: "t", children: p.name }), _jsx("span", { className: "s", children: [p.part_number, p.non_stock ? "Non-stock" : `${Number(p.on_hand)} ${p.unit || ""} on hand`].filter(Boolean).join(" · ") })] }), !p.non_stock && Number(p.on_hand) <= 0 && _jsx(Pill, { tone: "danger", children: "Out of stock" })] }), p.link && _jsx(ProductCard, { link: p.link, canEdit: false, compact: true, queryKey: ["asset-spare-parts", assetId] })] }, p.id))] }), _jsx(ProductLinksPanel, { entityType: "asset", entityId: assetId, role: "spare_part", canEdit: canEdit }), _jsx(ProductLinksPanel, { entityType: "asset", entityId: assetId, role: "purchased_from", canEdit: canEdit })] }));
}
