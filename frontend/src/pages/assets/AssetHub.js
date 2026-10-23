import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Asset Hub (0.5.0, r115): OEM equipment packages — asset type, fields, spare parts, procedures and work order
// templates for a manufacturer's model range — plus suggestions for existing assets that match. Admins only.
import { useRef, useState } from "react";
import { DropZone } from "../../components/DropZone";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Boxes, Check, PackageCheck, Upload, X } from "lucide-react";
import { api, getCsrf } from "../../lib/api";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, ListSkeleton, Modal, Pill } from "../../components/ui";
import "../../styles/external.css";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function useMatchActions(onDone) {
    const { toast } = useToast();
    const fail = (e) => toast(e.message, { kind: "error" });
    const apply = useMutation({ mutationFn: (m) => api(`/asset-package-matches/${m.id}/apply`, { method: "POST" }),
        onSuccess: (_d, m) => { toast(`Applied ${m.package.name} to ${m.asset.name}`); onDone(); }, onError: fail });
    const dismiss = useMutation({ mutationFn: (m) => api(`/asset-package-matches/${m.id}/dismiss`, { method: "POST" }), onSuccess: onDone, onError: fail });
    return { apply, dismiss };
}
function MatchRow({ m, apply, dismiss, showAsset = true }) {
    return (_jsxs("div", { className: "list-row", style: { alignItems: "center" }, children: [_jsxs("div", { className: "grow small", children: [showAsset ? _jsxs(_Fragment, { children: [_jsx(Link, { to: `/assets/${m.asset.id}`, children: _jsx("b", { children: m.asset.name }) }), " ", _jsxs("span", { className: "muted", children: [m.asset.manufacturer, " ", m.asset.model] })] })
                        : _jsxs(_Fragment, { children: [_jsx("b", { children: m.package.name }), " matches this asset's manufacturer and model."] }), _jsxs("div", { className: "faint", children: ["Adds the ", m.adds.asset_type, " type and links ", plural(m.adds.parts, "spare part"), "."] })] }), _jsxs(Button, { size: "sm", variant: "primary", onClick: () => apply(m), children: [_jsx(Check, { size: 13 }), "Apply"] }), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => dismiss(m), "aria-label": "Dismiss", children: _jsx(X, { size: 14 }) })] }));
}
/** Suggestions on an asset's page (only for people who manage packages, only when something matches). */
export function AssetPackageSuggestions({ assetId }) {
    const { can } = useSession();
    const qc = useQueryClient();
    const q = useQuery({ queryKey: ["asset", assetId, "package-suggestions"], enabled: can("assets.packages"),
        queryFn: () => api(`/assets/${assetId}/package-suggestions`) });
    const { apply, dismiss } = useMatchActions(() => { qc.invalidateQueries({ queryKey: ["asset", assetId] }); qc.invalidateQueries({ queryKey: ["asset-hub"] }); });
    if (!q.data?.items.length)
        return null;
    return _jsxs("div", { className: "banner info stack", style: { alignItems: "stretch", gap: 4 }, children: [_jsxs("div", { className: "row", children: [_jsx(PackageCheck, { size: 18 }), _jsx("b", { className: "grow", children: "Asset Hub suggestion" })] }), q.data.items.map((m) => _jsx(MatchRow, { m: m, showAsset: false, apply: (x) => apply.mutate(x), dismiss: (x) => dismiss.mutate(x) }, m.id))] });
}
function PackageDialog({ id, onClose }) {
    const qc = useQueryClient();
    const { toast } = useToast();
    const d = useQuery({ queryKey: ["asset-hub", id], queryFn: () => api(`/asset-packages/${id}`) });
    const matches = useQuery({ queryKey: ["asset-hub", id, "matches"], enabled: !!d.data?.installed,
        queryFn: () => api(`/asset-packages/${id}/matches`) });
    const refresh = () => qc.invalidateQueries({ queryKey: ["asset-hub"] });
    const { apply, dismiss } = useMatchActions(refresh);
    const install = useMutation({
        mutationFn: () => api(`/asset-packages/${id}/install`, { method: "POST" }),
        onSuccess: (r) => { refresh(); toast(`Installed: ${r.result.created} created, ${r.result.linked} already there${r.result.suggested ? `, ${plural(r.result.suggested, "asset")} to review` : ""}`); },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const del = useMutation({ mutationFn: () => api(`/asset-packages/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); onClose(); } });
    const p = d.data;
    return (_jsx(Modal, { title: p?.name ?? "Package", width: 680, onClose: onClose, footer: _jsxs(_Fragment, { children: [p?.source === "imported" && _jsx(Button, { variant: "ghost", style: { color: "var(--c-danger)", marginRight: "auto" }, onClick: () => del.mutate(), children: "Delete package" }), _jsx(Button, { onClick: onClose, children: "Close" }), _jsx(Button, { variant: "primary", disabled: !p || install.isPending, onClick: () => install.mutate(), children: p?.installed ? "Install again" : "Install" })] }), children: !p ? _jsx(ListSkeleton, { rows: 4 }) : _jsxs("div", { className: "stack", children: [_jsxs("div", { className: "small muted", children: [p.manufacturer, " \u00B7 fits ", p.models.join(", "), " \u00B7 version ", p.version, p.installed_at && ` · installed ${timeAgo(p.installed_at)}`] }), p.description && _jsx("p", { children: p.description }), p.notice && _jsx("div", { className: "banner warning small", children: p.notice }), _jsxs("div", { className: "hub-grid", children: [_jsxs("div", { children: [_jsx("h4", { className: "sec-h", children: "Asset type and fields" }), _jsxs("ul", { className: "small", children: [_jsx("li", { children: p.asset_type }), p.contents.fields.map((f) => _jsx("li", { children: f.name }, f.name))] })] }), _jsxs("div", { children: [_jsx("h4", { className: "sec-h", children: "Spare parts" }), _jsx("ul", { className: "small", children: p.contents.parts.map((x) => _jsx("li", { children: x.name }, x.name)) })] }), _jsxs("div", { children: [_jsx("h4", { className: "sec-h", children: "Procedures" }), _jsx("ul", { className: "small", children: p.contents.procedures.map((x) => _jsxs("li", { children: [x.name, " ", _jsxs("span", { className: "faint", children: ["(", plural(x.fields, "field"), ")"] })] }, x.name)) })] }), _jsxs("div", { children: [_jsx("h4", { className: "sec-h", children: "Work order templates" }), _jsx("ul", { className: "small", children: p.contents.templates.map((x) => _jsx("li", { children: x.name }, x.name)) })] })] }), _jsx("p", { className: "small muted", children: "Installing creates what you don't have yet and links what you do (by name), so it's safe to run again." }), p.installed && _jsxs("div", { className: "stack", style: { gap: 0 }, children: [_jsx("h4", { className: "sec-h", children: "Matching assets" }), matches.data?.items.map((m) => _jsx(MatchRow, { m: m, apply: (x) => apply.mutate(x), dismiss: (x) => dismiss.mutate(x) }, m.id)), matches.data && !matches.data.items.length && _jsxs("p", { className: "small muted", children: ["No assets waiting. Assets with manufacturer ", p.manufacturer, " and a matching model get a suggestion."] })] })] }) }));
}
export function AssetHubPage() {
    const { can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const [open, setOpen] = useState(null);
    const file = useRef(null);
    const list = useQuery({ queryKey: ["asset-hub"], enabled: can("assets.packages"), queryFn: () => api("/asset-packages") });
    const pending = useQuery({ queryKey: ["asset-hub", "suggested"], enabled: can("assets.packages"), queryFn: () => api("/asset-package-matches") });
    const { apply, dismiss } = useMatchActions(() => qc.invalidateQueries({ queryKey: ["asset-hub"] }));
    const importFile = async (f) => {
        const fd = new FormData();
        fd.append("file", f);
        const res = await fetch("/api/v1/asset-packages", { method: "POST", body: fd, credentials: "same-origin", headers: { "X-CSRF-Token": getCsrf() } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            toast(data.message || "Couldn't import that package.", { kind: "error" });
            return;
        }
        qc.invalidateQueries({ queryKey: ["asset-hub"] });
        toast(`Imported ${data.name}`);
        setOpen(data.id);
    };
    if (!can("assets.packages"))
        return _jsx("div", { className: "page", children: _jsx(EmptyState, { title: "Asset Hub", children: "Only administrators can install asset packages." }) });
    return (_jsxs("div", { className: "page stack", children: [_jsxs(Link, { to: "/assets", className: "row small", children: [_jsx(ArrowLeft, { size: 14 }), "Assets"] }), _jsxs("div", { className: "row", style: { justifyContent: "space-between" }, children: [_jsxs("div", { children: [_jsx("h1", { children: "Asset Hub" }), _jsx("p", { className: "muted small", style: { margin: 0 }, children: "Ready-made equipment packages: asset type, fields, spare parts, procedures and work order templates." })] }), _jsx(DropZone, { inline: true, accept: "application/json,.json", multiple: false, label: "Drop a package file", onFiles: (fs) => void importFile(fs[0]), children: _jsxs("div", { className: "row", children: [_jsxs(Button, { onClick: () => file.current?.click(), children: [_jsx(Upload, { size: 14 }), "Import package"] }), _jsx("input", { ref: file, type: "file", accept: "application/json,.json", hidden: true, onChange: (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f)
                                        void importFile(f); } })] }) })] }), (pending.data?.items.length ?? 0) > 0 && _jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Suggested for your assets" }), _jsx("span", { className: "small muted", children: plural(pending.data.items.length, "asset") })] }), pending.data.items.map((m) => _jsx(MatchRow, { m: m, apply: (x) => apply.mutate(x), dismiss: (x) => dismiss.mutate(x) }, m.id))] }), list.isLoading ? _jsx(ListSkeleton, { rows: 4 }) : _jsx("div", { className: "hub-cards", children: (list.data?.items ?? []).map((p) => (_jsxs("button", { type: "button", className: "card card-pad hub-card", onClick: () => setOpen(p.id), children: [_jsxs("div", { className: "row", children: [_jsx(Boxes, { size: 18, className: "faint" }), _jsx("b", { className: "grow", children: p.name }), p.installed ? _jsx(Pill, { tone: "success", children: "Installed" }) : p.source === "imported" ? _jsx(Pill, { children: "Imported" }) : null] }), _jsxs("div", { className: "small muted", children: [p.manufacturer, " \u00B7 ", p.models.slice(0, 4).join(", "), p.models.length > 4 ? "…" : ""] }), _jsxs("div", { className: "small", children: [plural(p.includes.parts, "part"), " \u00B7 ", plural(p.includes.procedures, "procedure"), " \u00B7 ", plural(p.includes.templates, "template")] }), p.matching_assets > 0 && _jsx("div", { className: "small", children: _jsxs(Pill, { tone: "info", children: [plural(p.matching_assets, "of your assets"), " match"] }) })] }, p.id))) }), open && _jsx(PackageDialog, { id: open, onClose: () => setOpen(null) })] }));
}
