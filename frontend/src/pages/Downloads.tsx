// Download Center: exports run in the background and stay here for 14 days.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, FileText, Loader2, Trash2 } from "lucide-react";
import { api, ApiError, type ExportItem } from "../lib/api";
import { dateTime, timeAgo } from "../lib/format";
import { useToast } from "../components/Toast";
import { Button, EmptyState, ListSkeleton, Pill } from "../components/ui";

export function Downloads() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const data = useQuery({
    queryKey: ["exports"], queryFn: () => api<{ items: ExportItem[] }>("/exports"),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((x) => x.status === "queued") ? 1500 : false),
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/exports/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["exports"] }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  return (
    <div className="page">
      <div className="page-head"><div><h1>Download Center</h1><p className="sub">Your exports. Large exports are prepared in the background and kept here for 14 days.</p></div></div>
      <section className="card">
        {!data.data ? <ListSkeleton rows={3} /> : data.data.items.length === 0 ? <EmptyState icon={<Download size={26} />} title="Nothing here yet">Export work orders from Work Orders → ⋯ → Export, or from a selection.</EmptyState>
          : data.data.items.map((x) => (
            <div key={x.id} className="list-row" style={{ borderLeft: 0 }}>
              <span className="empty-icon" style={{ width: 36, height: 36, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--c-sunken)" }}>
                {x.kind.endsWith("csv") ? <FileSpreadsheet size={18} /> : <FileText size={18} />}</span>
              <div className="grow"><div className="t">{x.title}</div>
                <div className="s" title={dateTime(x.created_at)}>{timeAgo(x.created_at)}{x.status === "ready" && x.file ? ` · ${(x.file.size / 1024).toFixed(0)} KB · expires ${new Date(x.expires_at).toLocaleDateString()}` : ""}{x.status === "failed" ? ` · ${x.error}` : ""}</div></div>
              {x.status === "queued" && <Pill tone="info"><Loader2 size={12} className="spin" />Preparing</Pill>}
              {x.status === "failed" && <Pill tone="danger">Failed</Pill>}
              {x.status === "ready" && x.file && <a className="btn sm primary" href={x.file.url + "?download=1"}><Download size={14} />Download</a>}
              <Button size="sm" variant="ghost" icon aria-label="Delete" onClick={() => del.mutate(x.id)}><Trash2 size={14} /></Button>
            </div>))}
      </section>
    </div>
  );
}
