import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// 0.5.0 supplier product cards on a part or an asset (MP-084/085/087/088/089).
// Everything shown comes from MPro's own copy: product text is plain text (React escapes it) and pictures are the
// copies saved in MPro's file storage, never the supplier's image address.
import { Fragment, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BarChart3, ExternalLink, MoreHorizontal, Package, Pencil, Plus, RefreshCw, ShoppingCart, Star, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency, dateTime, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Dropdown, Field, Input, Modal, Pill } from "../../components/ui";
import { AVAILABILITY } from "./types";
import { PunchOutButton } from "./PunchOut";
import "./suppliers.css";
const ROLE_TITLE = { listing: "Supplier products", spare_part: "Spare parts to buy", purchased_from: "Purchased from" };
const ROLE_EMPTY = {
    listing: "Paste a link to this part on a supplier's site (Grainger, McMaster-Carr, Amazon…) to see its price and stock here.",
    spare_part: "Paste links to spare parts for this asset on supplier sites.",
    purchased_from: "Paste the link to where this asset was bought.",
};
const linksKey = (entityType, entityId, role) => ["product-links", entityType, entityId, role ?? "all"];
export function ProductLinksPanel({ entityType, entityId, role, canEdit = false }) {
    const { can } = useSession();
    const r = role ?? (entityType === "part" ? "listing" : "spare_part");
    const q = useQuery({
        queryKey: linksKey(entityType, entityId, r),
        queryFn: () => api(`/product-links?entity_type=${entityType}&entity_id=${entityId}&role=${r}`),
        enabled: can("parts.view") || can("assets.view"),
        // keep polling briefly while a newly added product is still being read
        refetchInterval: (query) => (query.state.data?.items.some((l) => l.product?.fetch_status === "pending") ? 3000 : false),
    });
    const [adding, setAdding] = useState(false);
    const [comparing, setComparing] = useState(false);
    const edit = canEdit && can("suppliers.links");
    const items = q.data?.items ?? [];
    if (q.isError)
        return null;
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h3", { className: "sec-h", style: { margin: 0 }, children: ROLE_TITLE[r] }), _jsxs("div", { className: "row", children: [items.length > 1 && _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setComparing(true), children: [_jsx(BarChart3, { size: 14 }), "Compare"] }), r === "listing" && can("po.request") && _jsx(PunchOutButton, {}), edit && _jsxs(Button, { size: "sm", onClick: () => setAdding(true), children: [_jsx(Plus, { size: 14 }), "Add link"] })] })] }), q.isLoading ? _jsx("div", { className: "card-body small faint", children: "Loading\u2026" })
                : items.length === 0 ? _jsx("div", { className: "card-body small faint", children: ROLE_EMPTY[r] })
                    : _jsx("div", { className: "pl-list", children: items.map((l) => _jsx(ProductCard, { link: l, canEdit: edit, queryKey: linksKey(entityType, entityId, r) }, l.id)) }), adding && _jsx(AddLinkDialog, { entityType: entityType, entityId: entityId, role: r, onClose: () => setAdding(false), queryKey: linksKey(entityType, entityId, r) }), comparing && _jsx(CompareDialog, { entityType: entityType, entityId: entityId, onClose: () => setComparing(false) })] }));
}
export function ProductCard({ link, canEdit, queryKey, compact }) {
    const { session, can } = useSession();
    const { toast } = useToast();
    const qc = useQueryClient();
    const nav = useNavigate();
    const [editing, setEditing] = useState(false);
    const [history, setHistory] = useState(false);
    const [reorder, setReorder] = useState(false);
    const p = link.product;
    const cur = p?.currency || session.org?.currency || "USD";
    const err = (e) => toast(e.message, { kind: "error" });
    const done = () => qc.invalidateQueries({ queryKey });
    const refresh = useMutation({ mutationFn: () => api(`/product-links/${link.id}/refresh`, { method: "POST" }), onSuccess: () => { toast("Checking the supplier's page…"); setTimeout(done, 1500); }, onError: err });
    const prefer = useMutation({ mutationFn: () => api(`/product-links/${link.id}`, { method: "PATCH", body: { preferred: true } }), onSuccess: done, onError: err });
    const del = useMutation({ mutationFn: () => api(`/product-links/${link.id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Link removed"); }, onError: err });
    const avail = p?.availability ? AVAILABILITY[p.availability] : undefined;
    return (_jsxs("div", { className: "pl-card", children: [_jsx(ProductImage, { product: p }), _jsxs("div", { className: "pl-body", children: [_jsxs("a", { className: "pl-title", href: link.url, target: "_blank", rel: "noopener noreferrer nofollow", children: [link.title || link.url, " ", _jsx(ExternalLink, { size: 12 })] }), _jsxs("div", { className: "pl-meta", children: [_jsx("span", { children: link.supplier_name }), (link.supplier_sku || link.external_id) && _jsx("span", { className: "mono", children: link.supplier_sku || link.external_id }), link.mpn && _jsxs("span", { children: ["MPN ", _jsx("span", { className: "mono", children: link.mpn })] }), link.pack_size && _jsxs("span", { children: ["Pack of ", Number(link.pack_size), link.unit ? ` ${link.unit}` : ""] }), link.preferred && !compact && _jsx(Pill, { tone: "info", children: "Preferred" }), avail && _jsx(Pill, { tone: avail.tone, children: avail.label })] }), _jsxs("div", { className: "row", style: { gap: 12, flexWrap: "wrap" }, children: [link.price && _jsxs("span", { className: "pl-price", children: [currency(link.price, cur), p?.price_unit ? _jsxs("span", { className: "small faint", children: [" / ", p.price_unit] }) : null] }), link.price_from === "typed" && _jsx("span", { className: "small faint", children: "price typed in" }), link.last_paid_price && _jsxs("span", { className: "small muted", children: ["Last paid ", currency(link.last_paid_price, session.org?.currency)] }), p?.fetched_at && _jsxs("span", { className: "small faint", title: dateTime(p.fetched_at), children: ["Checked ", timeAgo(p.fetched_at)] })] }), p?.price_may_have_changed && p.price && _jsxs("div", { className: "pl-note", children: [_jsx(AlertTriangle, { size: 13 }), "Price may have changed: last checked over a day ago."] }), p?.fetch_status === "pending" && _jsx("div", { className: "small faint", children: "Reading the supplier's page\u2026" }), (p?.fetch_status === "blocked" || p?.fetch_status === "failed") && _jsxs("div", { className: "small faint", children: [p.fetch_error || "Couldn't read this page.", " The link still works."] }), p?.availability === "discontinued" && _jsxs("div", { className: "pl-note danger", children: [_jsx(AlertTriangle, { size: 13 }), "Discontinued.", p.replacement_url && _jsxs(_Fragment, { children: [" ", _jsx("a", { href: p.replacement_url, target: "_blank", rel: "noopener noreferrer nofollow", children: "See the replacement" })] })] }), link.note && _jsx("div", { className: "small muted", children: link.note })] }), _jsxs("div", { className: "pl-actions", children: [link.entity_type === "part" && can("po.request") && _jsxs(Button, { size: "sm", onClick: () => setReorder(true), children: [_jsx(ShoppingCart, { size: 14 }), "Reorder"] }), !link.preferred && canEdit && link.role !== "purchased_from" && _jsx(Button, { size: "sm", variant: "ghost", icon: true, title: "Make preferred", "aria-label": "Make preferred", onClick: () => prefer.mutate(), children: _jsx(Star, { size: 15 }) }), link.preferred && !compact && link.role !== "purchased_from" && _jsx(Star, { size: 15, className: "pl-star", "aria-label": "Preferred" }), _jsx(Dropdown, { trigger: (_o, t) => _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "More", onClick: t, children: _jsx(MoreHorizontal, { size: 16 }) }), children: (close) => _jsxs(_Fragment, { children: [_jsxs("button", { className: "menu-item", onClick: () => { close(); setHistory(true); }, children: [_jsx(BarChart3, { size: 15 }), "Price history"] }), canEdit && _jsxs("button", { className: "menu-item", onClick: () => { close(); refresh.mutate(); }, children: [_jsx(RefreshCw, { size: 15 }), "Check now"] }), canEdit && _jsxs("button", { className: "menu-item", onClick: () => { close(); setEditing(true); }, children: [_jsx(Pencil, { size: 15 }), "Edit"] }), canEdit && _jsxs(_Fragment, { children: [_jsx("div", { className: "menu-sep" }), _jsxs("button", { className: "menu-item", style: { color: "var(--c-danger)" }, onClick: () => { close(); del.mutate(); }, children: [_jsx(Trash2, { size: 15 }), "Remove link"] })] })] }) })] }), editing && _jsx(EditLinkDialog, { link: link, onClose: () => setEditing(false), queryKey: queryKey }), history && p && _jsx(HistoryDialog, { link: link, product: p, onClose: () => setHistory(false) }), reorder && _jsx(ReorderDialog, { link: link, onClose: () => setReorder(false), onDone: (url) => { setReorder(false); nav(url); } })] }));
}
export function ProductImage({ product }) {
    const src = product?.thumb_url || product?.image_url;
    const [broken, setBroken] = useState(false);
    return _jsx("div", { className: "pl-img", children: src && !broken ? _jsx("img", { src: src, alt: "", loading: "lazy", onError: () => setBroken(true) }) : _jsx(Package, { size: 24 }) });
}
function AddLinkDialog({ entityType, entityId, role, onClose, queryKey }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const [url, setUrl] = useState("");
    const [title, setTitle] = useState("");
    const [price, setPrice] = useState("");
    const [packSize, setPackSize] = useState("");
    const [error, setError] = useState("");
    const rec = useQuery({
        queryKey: ["recognize", url],
        queryFn: () => api("/suppliers/recognize", { method: "POST", body: { url } }),
        enabled: url.trim().length > 6, retry: false, staleTime: 60_000,
    });
    const add = useMutation({
        mutationFn: () => api("/product-links", { method: "POST", body: { entity_type: entityType, entity_id: entityId, role, url,
                manual_title: title, manual_price: price || null, pack_size: packSize || null } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey }); toast("Link added. Reading the product page…"); onClose(); },
        onError: (e) => setError(e.message),
    });
    const m = rec.data;
    return (_jsx(Modal, { title: "Add a supplier link", onClose: onClose, width: 520, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: !url.trim() || add.isPending, onClick: () => add.mutate(), children: "Add link" })] }), children: _jsxs("div", { className: "stack", children: [_jsx(Field, { label: "Product link", error: error, children: (id) => _jsx(Input, { id: id, autoFocus: true, placeholder: "https://www.grainger.com/product/\u2026", value: url, onChange: (e) => { setUrl(e.target.value); setError(""); } }) }), m && _jsx("div", { className: "small muted", children: m.supplier_key === "other" ? "Not a supplier MPro knows yet. It will still try to read the page."
                        : _jsxs(_Fragment, { children: [m.supplier_name, m.external_id && _jsxs(_Fragment, { children: [" \u00B7 ", m.id_label || "Item", " ", _jsx("span", { className: "mono", children: m.external_id })] }), m.needs_resolving && " · short link, opened to find the product"] }) }), rec.isError && _jsx("div", { className: "small", style: { color: "var(--c-danger)" }, children: rec.error.message }), _jsx("div", { className: "small faint", children: "Some sites block automatic readers. If yours does, the name and price you type below are shown instead." }), _jsxs("div", { className: "pl-grid2", children: [_jsx(Field, { label: "Name (optional)", children: (id) => _jsx(Input, { id: id, value: title, onChange: (e) => setTitle(e.target.value) }) }), _jsx(Field, { label: "Price (optional)", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: price, onChange: (e) => setPrice(e.target.value) }) })] }), _jsx(Field, { label: "Pack size", hint: "How many units one purchase gives you.", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", placeholder: "1", value: packSize, onChange: (e) => setPackSize(e.target.value) }) })] }) }));
}
function EditLinkDialog({ link, onClose, queryKey }) {
    const qc = useQueryClient();
    const [f, setF] = useState({
        supplier_sku: link.supplier_sku, mpn: link.mpn, pack_size: link.pack_size ?? "", unit: link.unit, note: link.note,
        manual_title: link.manual_title, manual_price: link.manual_price ?? "", alert_price_change_pct: link.alert_price_change_pct ?? "",
        alert_out_of_stock: link.alert_out_of_stock,
    });
    const [error, setError] = useState("");
    const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
    const save = useMutation({
        mutationFn: () => api(`/product-links/${link.id}`, { method: "PATCH", body: { ...f, pack_size: f.pack_size || null, manual_price: f.manual_price || null,
                alert_price_change_pct: f.alert_price_change_pct || null } }),
        onSuccess: () => { qc.invalidateQueries({ queryKey }); onClose(); },
        onError: (e) => setError(e.message),
    });
    return (_jsx(Modal, { title: "Edit supplier link", onClose: onClose, width: 560, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsx(Button, { variant: "primary", disabled: save.isPending, onClick: () => save.mutate(), children: "Save" })] }), children: _jsxs("div", { className: "stack", children: [error && _jsx("div", { className: "small", style: { color: "var(--c-danger)" }, children: error }), _jsxs("div", { className: "pl-grid2", children: [_jsx(Field, { label: "Supplier SKU", children: (id) => _jsx(Input, { id: id, value: f.supplier_sku, onChange: set("supplier_sku") }) }), _jsx(Field, { label: "Manufacturer part number (MPN)", children: (id) => _jsx(Input, { id: id, value: f.mpn, onChange: set("mpn") }) }), _jsx(Field, { label: "Pack size", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: f.pack_size, onChange: set("pack_size") }) }), _jsx(Field, { label: "Unit", children: (id) => _jsx(Input, { id: id, placeholder: "each, box, ft", value: f.unit, onChange: set("unit") }) }), _jsx(Field, { label: "Name if the page can't be read", children: (id) => _jsx(Input, { id: id, value: f.manual_title, onChange: set("manual_title") }) }), _jsx(Field, { label: "Price if the page can't be read", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: f.manual_price, onChange: set("manual_price") }) })] }), _jsx(Field, { label: "Note", children: (id) => _jsx(Input, { id: id, value: f.note, onChange: set("note") }) }), _jsx("h4", { className: "sec-h", style: { margin: "8px 0 0" }, children: "Alerts" }), _jsx(Field, { label: "Email me when the price changes by at least (%)", hint: "Leave empty for no price alerts.", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", placeholder: "10", value: f.alert_price_change_pct, onChange: set("alert_price_change_pct") }) }), _jsx(Checkbox, { checked: f.alert_out_of_stock, onChange: (v) => setF({ ...f, alert_out_of_stock: v }), label: "Email me when it goes out of stock or is discontinued" }), _jsx("div", { className: "small faint", children: "Alerts go to whoever added the link and to the teams on the part." })] }) }));
}
function HistoryDialog({ link, product, onClose }) {
    const q = useQuery({ queryKey: ["product-prices", product.id], queryFn: () => api(`/products/${product.id}/prices`) });
    const pts = (q.data?.items ?? []).filter((x) => x.price !== null);
    const specs = Object.entries(product.specs || {});
    return (_jsx(Modal, { title: link.title || "Price history", onClose: onClose, width: 640, footer: _jsx(Button, { onClick: onClose, children: "Close" }), children: _jsxs("div", { className: "stack", children: [q.isLoading ? _jsx("div", { className: "small faint", children: "Loading\u2026" }) : pts.length === 0 ? _jsx("div", { className: "small faint", children: "No prices recorded yet." })
                    : _jsx(PriceChart, { points: pts, cur: product.currency || "USD" }), pts.length > 0 && _jsxs("div", { className: "small muted", children: [pts.length, " price ", pts.length === 1 ? "check" : "checks", " in the last year. Lowest ", currency(Math.min(...pts.map((x) => Number(x.price))), product.currency || "USD"), ", highest ", currency(Math.max(...pts.map((x) => Number(x.price))), product.currency || "USD"), "."] }), specs.length > 0 && _jsxs(_Fragment, { children: [_jsx("h4", { className: "sec-h", style: { margin: "8px 0 0" }, children: "Details from the supplier" }), _jsx("dl", { className: "pl-specs", children: specs.slice(0, 30).map(([k, v]) => _jsxs(Fragment, { children: [_jsx("dt", { children: k }), _jsx("dd", { children: v })] }, k)) })] })] }) }));
}
export function PriceChart({ points, cur }) {
    const W = 600, H = 180, L = 56, R = 12, T = 12, B = 26;
    const xs = points.map((p) => new Date(p.at).getTime());
    const ys = points.map((p) => Number(p.price));
    const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo) * 0.15 || hi * 0.1 || 1;
    const y0 = Math.max(0, lo - pad), y1 = hi + pad;
    const sx = (x) => L + ((x - x0) / (x1 - x0)) * (W - L - R);
    const sy = (y) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
    // a price holds until the next check: draw steps
    let d = "";
    points.forEach((_, i) => { d += i === 0 ? `M${sx(xs[i])},${sy(ys[i])}` : `H${sx(xs[i])}V${sy(ys[i])}`; });
    const ticks = [y0, (y0 + y1) / 2, y1];
    const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return (_jsxs("svg", { className: "pl-chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Price over time", children: [ticks.map((t) => _jsxs("g", { children: [_jsx("line", { className: "grid", x1: L, x2: W - R, y1: sy(t), y2: sy(t) }), _jsx("text", { x: L - 6, y: sy(t) + 4, textAnchor: "end", children: currency(t, cur) })] }, t)), _jsx("path", { className: "ln", d: d }), points.map((p, i) => _jsx("circle", { className: "dot", cx: sx(xs[i]), cy: sy(ys[i]), r: 3, children: _jsx("title", { children: `${dateTime(p.at)}: ${currency(p.price, cur)}` }) }, p.at + i)), _jsx("text", { x: L, y: H - 6, children: fmtDate(x0) }), _jsx("text", { x: W - R, y: H - 6, textAnchor: "end", children: fmtDate(x1) })] }));
}
function CompareDialog({ entityType, entityId, onClose }) {
    const q = useQuery({ queryKey: ["product-compare", entityType, entityId], queryFn: () => api(`/product-links/compare?entity_type=${entityType}&entity_id=${entityId}`) });
    return (_jsx(Modal, { title: "Compare suppliers", onClose: onClose, width: 620, footer: _jsx(Button, { onClick: onClose, children: "Close" }), children: q.isLoading ? _jsx("div", { className: "small faint", children: "Loading\u2026" }) : _jsxs(_Fragment, { children: [_jsxs("table", { className: "pl-cmp", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Supplier" }), _jsx("th", { children: "Price per unit" }), _jsx("th", { children: "Stock" }), _jsx("th", {})] }) }), _jsx("tbody", { children: (q.data?.items ?? []).map((r) => _jsxs("tr", { className: r.best ? "best" : "", children: [_jsxs("td", { children: [r.supplier_name, r.preferred && _jsx("span", { className: "small faint", children: " \u00B7 preferred" })] }), _jsx("td", { children: r.unit_price ? currency(r.unit_price, r.currency || "USD") : "—" }), _jsx("td", { children: r.availability ? AVAILABILITY[r.availability]?.label : _jsx("span", { className: "faint", children: "Unknown" }) }), _jsx("td", { children: r.best && _jsx(Pill, { tone: "success", children: "Best price in stock" }) })] }, r.link_id)) })] }), _jsx("p", { className: "small faint", style: { marginTop: 12 }, children: "Prices are divided by the pack size. Currencies aren't converted." })] }) }));
}
function ReorderDialog({ link, onClose, onDone }) {
    const { session } = useSession();
    const line = useQuery({ queryKey: ["po-line", link.id], queryFn: () => api(`/product-links/${link.id}/po-line`) });
    const [qty, setQty] = useState(null);
    const [error, setError] = useState("");
    const quantity = qty ?? line.data?.quantity ?? "1";
    const go = useMutation({
        mutationFn: () => api(`/product-links/${link.id}/reorder`, { method: "POST", body: { quantity } }),
        onSuccess: (r) => onDone(r.url),
        onError: (e) => setError(e.message),
    });
    const cost = line.data?.unit_cost;
    return (_jsx(Modal, { title: "Reorder", onClose: onClose, width: 460, footer: _jsxs(_Fragment, { children: [_jsx(Button, { onClick: onClose, children: "Cancel" }), _jsxs(Button, { variant: "primary", disabled: go.isPending || !line.data, onClick: () => go.mutate(), children: [_jsx(ShoppingCart, { size: 14 }), "Create purchase order"] })] }), children: _jsxs("div", { className: "stack", children: [_jsxs("div", { children: [_jsx("div", { className: "pl-title", children: link.title }), _jsxs("div", { className: "small muted", children: [link.supplier_name, link.supplier_sku && ` · ${link.supplier_sku}`] })] }), _jsx(Field, { label: "Quantity", hint: "Suggested from the part's minimum and maximum stock.", children: (id) => _jsx(Input, { id: id, inputMode: "decimal", value: quantity, onChange: (e) => setQty(e.target.value) }) }), cost && _jsxs("div", { className: "small muted", children: ["Unit cost ", currency(cost, session.org?.currency), " \u00B7 total ", currency(Number(cost) * Number(quantity || 0), session.org?.currency)] }), _jsx("div", { className: "small faint", children: "You can review the purchase order before it's sent to the supplier." }), error && _jsx("div", { className: "small", style: { color: "var(--c-danger)" }, children: error })] }) }));
}
