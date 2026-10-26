// Settings › QR codes › What scanning does (0.6.0, MP-097): the default action per record type, per-role overrides,
// public scans (request form only), GPS, and how recent a scan must be to start or complete a work order.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type Role } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Field, Input, Select, Toggle } from "../../components/ui";
import { resetScanConfig, TYPE_LABEL, type ScanSettings } from "./scanApi";

const TYPES = ["asset", "location", "part", "work_order", "procedure", "meter"] as const;

export function ScanSettingsCard() {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["scan-settings"], queryFn: () => api<ScanSettings>("/scan/settings"), enabled: can("scan.settings") });
  const roles = useQuery({ queryKey: ["roles", false], queryFn: () => api<Role[]>("/roles"), enabled: can("scan.settings") });
  const [f, setF] = useState<ScanSettings | null>(null);
  const [role, setRole] = useState("");
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const save = useMutation({
    mutationFn: (s: ScanSettings) => api<ScanSettings>("/scan/settings", { method: "PATCH", body: {
      default_actions: s.default_actions, role_actions: s.role_actions, public_scans: s.public_scans, public_types: s.public_types,
      record_gps: s.record_gps, require_window_minutes: s.require_window_minutes } }),
    onSuccess: (s) => { qc.setQueryData(["scan-settings"], { ...q.data, ...s }); resetScanConfig(); toast("Saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!can("scan.settings") || !f) return null;
  const roleKey = (r: Role) => (r.custom ? `custom:${r.id}` : r.key);
  const choice = (id: string, et: string, value: string, onChange: (v: string) => void, inherit?: string) => (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {inherit !== undefined && <option value="">Same as everyone ({inherit === "menu" ? "show the choices" : f.actions[et]?.find((a) => a.key === inherit)?.label ?? inherit})</option>}
      <option value="menu">Show the choices</option>
      {f.actions[et]?.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
    </Select>);
  const per = role ? f.role_actions[role] ?? {} : {};
  const setPer = (et: string, v: string) => {
    const next = { ...per };
    if (v) next[et] = v; else delete next[et];
    const ra = { ...f.role_actions };
    if (Object.keys(next).length) ra[role] = next; else delete ra[role];
    setF({ ...f, role_actions: ra });
  };
  return (
    <section className="card card-pad stack" aria-label="What scanning does">
      <div><h2 className="sec-h" style={{ margin: 0 }}>What scanning does</h2>
        <p className="small muted" style={{ margin: 0 }}>Pick what opens straight away when someone scans a code. "Show the choices" lists everything they're allowed to do.</p></div>
      <div className="scan-set-grid">
        {TYPES.map((et) => <Field key={et} label={TYPE_LABEL[et]}>{(id) => choice(id, et, f.default_actions[et] ?? "menu", (v) => setF({ ...f, default_actions: { ...f.default_actions, [et]: v } }))}</Field>)}
      </div>
      <Field label="Different for one role">{(id) => (
        <Select id={id} value={role} onChange={(e) => setRole(e.target.value)} style={{ maxWidth: 320 }}>
          <option value="">Pick a role</option>
          {(roles.data ?? []).filter((r) => !r.deleted).map((r) => <option key={roleKey(r)} value={roleKey(r)}>{r.label}{f.role_actions[roleKey(r)] ? " (changed)" : ""}</option>)}
        </Select>)}</Field>
      {role && <div className="scan-set-grid">{TYPES.map((et) => <Field key={et} label={TYPE_LABEL[et]}>{(id) => choice(id, et, per[et] ?? "", (v) => setPer(et, v), f.default_actions[et])}</Field>)}</div>}

      <Toggle checked={f.public_scans} onChange={(v) => setF({ ...f, public_scans: v })} label="Let people who aren't signed in report problems by scanning"
        hint="They only ever see the request form for the asset or location. Retire a code to stop it working." />
      {f.public_scans && <div className="row wrap" style={{ gap: 16, paddingLeft: 4 }}>
        {(["asset", "location"] as const).map((t) => <Checkbox key={t} label={`${TYPE_LABEL[t]} codes`} checked={f.public_types.includes(t)}
          onChange={(v) => setF({ ...f, public_types: v ? [...f.public_types, t] : f.public_types.filter((x) => x !== t) })} />)}</div>}
      <Toggle checked={f.record_gps} onChange={(v) => setF({ ...f, record_gps: v })} label="Keep the phone's position with each scan"
        hint="Phones ask each person first. Positions show in the scan history as proof of visit." />
      <Field label="A scan to start or complete a work order counts for (minutes)" hint="Turn on per procedure, in the procedure's settings.">
        {(id) => <Input id={id} type="number" min={5} max={1440} value={f.require_window_minutes} style={{ maxWidth: 140 }}
          onChange={(e) => setF({ ...f, require_window_minutes: Number(e.target.value) || 0 })} />}</Field>
      <div className="row"><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(f)}>Save</Button></div>
    </section>
  );
}
