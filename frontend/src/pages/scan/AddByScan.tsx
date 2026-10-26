// Scan to add (r292): opened as /scan?for=wo:<id> or /scan?for=request, the scanned asset or location is added to
// the work order (after you confirm) or opens the request form with it filled in.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button } from "../../components/ui";
import { requestUrl } from "./ScanActions";
import { TYPE_LABEL, type ScanFound } from "./scanApi";

export type ScanFor = { kind: "wo"; id: string; title: string } | { kind: "request"; title: string };

export function parseFor(v: string | null): ScanFor | null {
  if (!v) return null;
  if (v === "request") return { kind: "request", title: "Scan to report a problem" };
  const m = /^wo:([0-9a-f-]{36})$/i.exec(v);
  return m ? { kind: "wo", id: m[1], title: "Scan to add to the work order" } : null;
}

type WO = { id: string; number: number; title: string; version: number; assets: { id: string; name: string }[]; location: { id: string; name: string } | null };

export function AddByScan({ target, result: r, onAgain }: { target: ScanFor; result: ScanFound; onAgain: () => void }) {
  const nav = useNavigate();
  const { toast } = useToast();
  const wo = useQuery({ queryKey: ["work-order", target.kind === "wo" ? target.id : ""], enabled: target.kind === "wo",
    queryFn: () => api<WO>(`/work-orders/${target.kind === "wo" ? target.id : ""}`) });
  const fits = r.entity_type === "asset" || r.entity_type === "location";
  const add = useMutation({
    mutationFn: async () => {
      const w = wo.data!;
      const body = r.entity_type === "asset"
        ? { asset_ids: [...new Set([...w.assets.map((a) => a.id), r.entity_id])], version: w.version }
        : { location_id: r.entity_id, version: w.version };
      return api<WO>(`/work-orders/${w.id}`, { method: "PATCH", body });
    },
    onSuccess: (w) => { toast(`Added ${r.label} to #${w.number}`); nav(`/work-orders/${w.id}`); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!fits) return (
    <div className="scan-out card card-pad stack" role="alert">
      <p style={{ margin: 0 }}>That's a {TYPE_LABEL[r.entity_type]?.toLowerCase() ?? "record"} ({r.label}). Scan an asset or a location.</p>
      <div className="row"><Button onClick={onAgain}>Scan again</Button></div>
    </div>);
  if (target.kind === "request") return (
    <div className="scan-out card card-pad stack">
      <p style={{ margin: 0 }}>Report a problem with <b>{r.label}</b>?</p>
      <div className="row wrap"><Button variant="primary" onClick={() => nav(requestUrl(r))}>Yes, continue</Button><Button onClick={onAgain}>Scan another</Button></div>
    </div>);
  const already = r.entity_type === "asset" ? wo.data?.assets.some((a) => a.id === r.entity_id) : wo.data?.location?.id === r.entity_id;
  return (
    <div className="scan-out card card-pad stack">
      <p style={{ margin: 0 }}>{already ? <><b>{r.label}</b> is already on #{wo.data?.number}.</>
        : <>{r.entity_type === "asset" ? "Add" : "Set the location to"} <b>{r.label}</b> on #{wo.data?.number} {wo.data?.title}?</>}</p>
      <div className="row wrap">
        {!already && <Button variant="primary" disabled={!wo.data || add.isPending} onClick={() => add.mutate()}>{r.entity_type === "asset" ? "Add asset" : "Set location"}</Button>}
        <Button onClick={onAgain}>Scan another</Button>
        {wo.data && <Button variant="ghost" onClick={() => nav(`/work-orders/${wo.data!.id}`)}>Back to the work order</Button>}
      </div>
    </div>);
}
