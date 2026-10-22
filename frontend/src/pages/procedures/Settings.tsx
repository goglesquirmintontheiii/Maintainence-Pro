// Procedure settings card (Settings → Work orders): corrective work orders on Fail / Flag / low score (r044/r179)
// and moving work orders to In Progress on the first answer (r074).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Field, Select, Toggle } from "../../components/ui";
import { POLICY_LABEL, type Policy, type ProcSettings } from "./types";

export function ProcedureSettings() {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const ro = !can("wo.settings");
  const q = useQuery({ queryKey: ["proc-settings"], queryFn: () => api<ProcSettings>("/procedures/settings"), enabled: can("procedures.view") });
  const save = useMutation({ mutationFn: (b: Partial<ProcSettings>) => api<ProcSettings>("/procedures/settings", { method: "PATCH", body: b }),
    onSuccess: (x) => { qc.setQueryData(["proc-settings"], x); qc.invalidateQueries({ queryKey: ["proc-options"] }); toast("Saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  if (!q.data) return null;
  const v = q.data;
  const pol = (k: "on_fail" | "on_flag" | "on_low_score", label: string) => (
    <Field label={label}>{(id) => <Select id={id} value={v[k]} disabled={ro} onChange={(e) => save.mutate({ [k]: e.target.value as Policy })}>
      {(Object.keys(POLICY_LABEL) as Policy[]).map((p) => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}</Select>}</Field>);
  return (
    <section className="card">
      <div className="card-head"><h2>Procedures</h2><span className="small muted">Corrective work orders are linked to the original and copy its asset and location</span></div>
      <div className="card-body stack">
        <div className="form-grid">
          {pol("on_fail", "When a step is marked Fail")}
          {pol("on_flag", "When a step is marked Flag")}
          {pol("on_low_score", "When a scored procedure is below its goal")}
        </div>
        <Toggle label="Start work automatically" hint="Answering a procedure step on an Open work order moves it to In Progress." checked={v.auto_in_progress} disabled={ro}
          onChange={(x) => save.mutate({ auto_in_progress: x })} />
      </div>
    </section>);
}
