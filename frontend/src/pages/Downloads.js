import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Download Center: exports run in the background and stay here for 14 days.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, FileText, Loader2, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { dateTime, timeAgo } from "../lib/format";
import { useToast } from "../components/Toast";
import { Button, EmptyState, ListSkeleton, Pill } from "../components/ui";
export function Downloads() {
    const qc = useQueryClient();
    const { toast } = useToast();
    const data = useQuery({
        queryKey: ["exports"], queryFn: () => api("/exports"),
        refetchInterval: (q) => ((q.state.data?.items ?? []).some((x) => x.status === "queued") ? 1500 : false),
    });
    const del = useMutation({ mutationFn: (id) => api(`/exports/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["exports"] }),
        onError: (e) => toast(e.message, { kind: "error" }) });
    return (_jsxs("div", { className: "page", children: [_jsx("div", { className: "page-head", children: _jsxs("div", { children: [_jsx("h1", { children: "Download Center" }), _jsx("p", { className: "sub", children: "Your exports. Large exports are prepared in the background and kept here for 14 days." })] }) }), _jsx("section", { className: "card", children: !data.data ? _jsx(ListSkeleton, { rows: 3 }) : data.data.items.length === 0 ? _jsx(EmptyState, { icon: _jsx(Download, { size: 26 }), title: "Nothing here yet", children: "Export work orders from Work Orders \u2192 \u22EF \u2192 Export, or from a selection." })
                    : data.data.items.map((x) => (_jsxs("div", { className: "list-row", style: { borderLeft: 0 }, children: [_jsx("span", { className: "empty-icon", style: { width: 36, height: 36, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--c-sunken)" }, children: x.kind.endsWith("csv") ? _jsx(FileSpreadsheet, { size: 18 }) : _jsx(FileText, { size: 18 }) }), _jsxs("div", { className: "grow", children: [_jsx("div", { className: "t", children: x.title }), _jsxs("div", { className: "s", title: dateTime(x.created_at), children: [timeAgo(x.created_at), x.status === "ready" && x.file ? ` · ${(x.file.size / 1024).toFixed(0)} KB · expires ${new Date(x.expires_at).toLocaleDateString()}` : "", x.status === "failed" ? ` · ${x.error}` : ""] })] }), x.status === "queued" && _jsxs(Pill, { tone: "info", children: [_jsx(Loader2, { size: 12, className: "spin" }), "Preparing"] }), x.status === "failed" && _jsx(Pill, { tone: "danger", children: "Failed" }), x.status === "ready" && x.file && _jsxs("a", { className: "btn sm primary", href: x.file.url + "?download=1", children: [_jsx(Download, { size: 14 }), "Download"] }), _jsx(Button, { size: "sm", variant: "ghost", icon: true, "aria-label": "Delete", onClick: () => del.mutate(x.id), children: _jsx(Trash2, { size: 14 }) })] }, x.id))) })] }));
}
