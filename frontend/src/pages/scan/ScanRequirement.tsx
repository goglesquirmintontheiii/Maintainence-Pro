// Procedure settings › Scan to start or complete (0.6.0, MP-097): like MaintainX's location check-in, work orders
// using this procedure need a scan of their asset, location or own code by the person starting or completing them.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Toggle } from "../../components/ui";

type Req = { on_start: boolean; on_complete: boolean };

export function ScanRequirementPanel({ procedureId, editable }: { procedureId: string; editable: boolean }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["scan-req", procedureId], queryFn: () => api<Req>(`/procedures/${procedureId}/scan-requirement`), enabled: can("procedures.view") });
  const m = useMutation({ mutationFn: (b: Partial<Req>) => api<Req>(`/procedures/${procedureId}/scan-requirement`, { method: "PUT", body: b }),
    onSuccess: (r) => qc.setQueryData(["scan-req", procedureId], r), onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  if (!q.data) return null;
  return (
    <section className="card card-pad stack" aria-label="Scan to start or complete">
      <div><h3 className="sec-h" style={{ margin: 0 }}>Scan to start or complete</h3>
        <p className="small muted" style={{ margin: 0 }}>Proof that someone was there: they scan the QR code on the work order's asset or location (or the work order's own code) first.</p></div>
      <Toggle checked={q.data.on_start} disabled={!editable || m.isPending} onChange={(v) => m.mutate({ on_start: v })} label="Needs a scan to start" />
      <Toggle checked={q.data.on_complete} disabled={!editable || m.isPending} onChange={(v) => m.mutate({ on_complete: v })} label="Needs a scan to complete" />
    </section>
  );
}
