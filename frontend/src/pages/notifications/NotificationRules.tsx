// Settings → Notifications (MP-052, r083, r311, r312): due-soon window, overdue teams, escalation rules, the weekly
// report email and email branding. Needs notifications.rules (owners and administrators).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, TriangleAlert, Upload } from "lucide-react";
import { api, ApiError, upload, type Category } from "../../lib/api";
import { useSession } from "../../lib/session";
import type { EscalationRule, OrgNotifSettings } from "../../lib/notifications";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { ColorPicker } from "../../components/ColorPicker";
import { MultiPicker } from "../../components/pickers";
import { TeamsPicker, useTeams } from "../assets/shared";
import "./notifications.css";

const PRIOS: [string, string][] = [["high", "High"], ["medium", "Medium"], ["low", "Low"], ["none", "None"]];

function usePeople() {
  return useQuery({ queryKey: ["people-lite"], staleTime: 60_000,
    queryFn: () => api<{ items: { id: string; name: string; email: string; role_label?: string }[] }>("/users") });
}

function PeoplePicker({ value, onChange, id, label = "People" }: { value: string[]; onChange: (v: string[]) => void; id?: string; label?: string }) {
  const people = usePeople();
  const opts = useMemo(() => (people.data?.items ?? []).map((p) => ({ key: p.id, label: p.name, sub: p.email })), [people.data]);
  return <MultiPicker id={id} label={label} placeholder="Add people" options={opts} value={value} onChange={onChange} searchPlaceholder="Search people" />;
}

export function NotificationRulesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const s = useQuery({ queryKey: ["notif-org"], queryFn: () => api<OrgNotifSettings>("/notifications/org-settings"), enabled: can("notifications.rules") });
  const save = useMutation({
    mutationFn: (patch: Partial<OrgNotifSettings>) => api<OrgNotifSettings>("/notifications/org-settings", { method: "PATCH", body: patch }),
    onSuccess: (v) => { qc.setQueryData(["notif-org"], v); toast("Saved"); }, onError: err,
  });
  if (!can("notifications.rules")) return <div className="banner info">Only owners and administrators can change organization notification settings. Your own settings are under Notifications → Settings.</div>;
  if (!s.data) return <ListSkeleton rows={6} />;
  const v = s.data;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card">
        <div className="card-head"><h2>Due dates</h2></div>
        <div className="card-body stack">
          <Field label="Tell people a work order is due soon this many hours before" hint="0 turns due-soon notices off.">{(id) =>
            <HoursInput id={id} value={v.due_soon_hours} max={336} onSave={(n) => save.mutate({ due_soon_hours: n })} />}</Field>
          <Field label="Overdue escalation teams" hint="These teams hear about every work order that becomes overdue, as well as the people on it.">{(id) =>
            <TeamsPicker id={id} value={v.overdue_team_ids} onChange={(x) => save.mutate({ overdue_team_ids: x })} />}</Field>
        </div>
      </section>
      <EscalationRules />
      <section className="card">
        <div className="card-head"><h2>Weekly report</h2></div>
        <div className="card-body stack">
          <Toggle label="Email a work order report every Monday morning" hint="Created, completed, open and overdue work for the last 7 days."
            checked={v.weekly_report} onChange={(x) => save.mutate({ weekly_report: x })} />
          {v.weekly_report && <Field label="Send it to" hint="Leave empty to send it to owners and administrators.">{(id) =>
            <PeoplePicker id={id} label="Recipients" value={v.weekly_report_user_ids} onChange={(x) => save.mutate({ weekly_report_user_ids: x })} />}</Field>}
        </div>
      </section>
      <EmailBranding v={v} onSave={(p) => save.mutate(p)} />
    </div>
  );
}

function HoursInput({ id, value, max, onSave }: { id: string; value: number; max: number; onSave: (n: number) => void }) {
  const [t, setT] = useState(String(value));
  const commit = () => { const n = Math.max(0, Math.min(max, Math.round(Number(t) || 0))); setT(String(n)); if (n !== value) onSave(n); };
  return <Input id={id} type="number" inputMode="numeric" min={0} max={max} value={t} style={{ maxWidth: 140 }} onChange={(e) => setT(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />;
}

function EmailBranding({ v, onSave }: { v: OrgNotifSettings; onSave: (p: Partial<OrgNotifSettings>) => void }) {
  const { session } = useSession();
  const { toast } = useToast();
  const [info, setInfo] = useState(v.brand_info);
  const [busy, setBusy] = useState(false);
  const color = v.brand_color || "#1b5bd4";
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) { toast("Choose a picture (PNG, JPG or SVG).", { kind: "error" }); return; }
    setBusy(true);
    try { const up = await upload(f); onSave({ brand_logo_file_id: up.id }); } catch (e) { toast((e as ApiError).message, { kind: "error" }); } finally { setBusy(false); }
  };
  const logoUrl = v.brand_logo_file_id ? `/api/v1/files/${v.brand_logo_file_id}` : "";
  return (
    <section className="card">
      <div className="card-head"><h2>Email branding</h2></div>
      <div className="card-body notif-brand">
        <div className="stack">
          <ColorPicker label="Header colour" value={color} onChange={(c) => onSave({ brand_color: c })} />
          <Field label="Logo" hint="Shown at the top of notification emails. Keep it small and wide.">{() => (
            <div className="row wrap" style={{ gap: 8 }}>
              <label className="btn"><Upload size={15} />{busy ? "Uploading…" : v.brand_logo_file_id ? "Replace logo" : "Upload logo"}
                <input type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} /></label>
              {v.brand_logo_file_id && <Button variant="ghost" onClick={() => onSave({ brand_logo_file_id: "" })}>Remove</Button>}
            </div>)}</Field>
          <Field label="Line under the logo" hint="For example your address, phone number or website.">{(id) =>
            <Input id={id} value={info} maxLength={300} onChange={(e) => setInfo(e.target.value)} onBlur={() => info !== v.brand_info && onSave({ brand_info: info })} />}</Field>
        </div>
        <div className="notif-email-preview" aria-label="Email preview">
          <div className="nep-head" style={{ background: color }}>
            {logoUrl ? <img src={logoUrl} alt="" /> : <span>{session.org?.name}</span>}
          </div>
          <div className="nep-body">
            <div className="nep-h">Jordan Reyes assigned you #42 Replace conveyor belt</div>
            <div className="nep-row">Belt is slipping under load on Line 3.</div>
            {info && <div className="nep-info">{info}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- escalation rules ------------------------------------------------------------------------------
function EscalationRules() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<EscalationRule | "new" | null>(null);
  const rules = useQuery({ queryKey: ["escalation-rules"], queryFn: () => api<{ items: EscalationRule[] }>("/escalation-rules") });
  const teams = useTeams();
  const people = usePeople();
  const toggle = useMutation({
    mutationFn: (r: EscalationRule) => api(`/escalation-rules/${r.id}`, { method: "PATCH", body: { active: !r.active } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["escalation-rules"] }), onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const del = useMutation({
    mutationFn: (r: EscalationRule) => api(`/escalation-rules/${r.id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["escalation-rules"] }); toast("Rule deleted"); },
  });
  const who = (r: EscalationRule) => {
    const parts = [
      ...(r.notify_admins ? ["administrators"] : []), ...(r.notify_assignees ? ["the people assigned"] : []),
      ...r.notify_user_ids.map((id) => people.data?.items.find((p) => p.id === id)?.name ?? "someone"),
      ...r.notify_team_ids.map((id) => teams.data?.items.find((t) => t.id === id)?.name ?? "a team"),
    ];
    return parts.join(", ");
  };
  return (
    <section className="card">
      <div className="card-head"><h2>Escalation rules</h2><span className="grow" />
        <Button variant="primary" size="sm" onClick={() => setEditing("new")}><Plus size={15} />New rule</Button></div>
      <div className="card-body">
        {!rules.data ? <ListSkeleton rows={2} /> : rules.data.items.length === 0
          ? <EmptyState icon={<TriangleAlert size={26} />} title="No escalation rules">Tell a manager when high-priority work is overdue or hasn't been started.</EmptyState>
          : <div className="stack" style={{ gap: 0 }}>{rules.data.items.map((r) => (
            <div key={r.id} className="notif-rule">
              <div className="grow">
                <div className="row" style={{ gap: 8 }}><strong>{r.name}</strong>{!r.active && <Pill>Off</Pill>}</div>
                <div className="small muted">
                  {r.trigger === "overdue" ? `Overdue for ${r.after_hours} h` : `Not started ${r.after_hours} h after it was created`}
                  {r.priorities.length ? ` · ${r.priorities.map((p) => PRIOS.find((x) => x[0] === p)?.[1]).join(", ")} priority` : " · any priority"}
                  {` → ${who(r) || "nobody"}`}{r.raise_priority ? " · raises to High" : ""}
                </div>
              </div>
              <Toggle label={<span className="sr-only">Rule on</span>} checked={r.active} onChange={() => toggle.mutate(r)} />
              <Button size="sm" variant="ghost" icon aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Pencil size={15} /></Button>
              <Button size="sm" variant="ghost" icon aria-label={`Delete ${r.name}`} onClick={() => del.mutate(r)}><Trash2 size={15} /></Button>
            </div>))}</div>}
      </div>
      {editing && <RuleModal rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function RuleModal({ rule, onClose }: { rule: EscalationRule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cats = useQuery({ queryKey: ["categories-lite"], queryFn: () => api<{ items: Category[] }>("/categories"), staleTime: 60_000 });
  const [f, setF] = useState(() => ({
    name: rule?.name ?? "", trigger: rule?.trigger ?? "overdue", after_hours: String(rule?.after_hours ?? 4), priorities: rule?.priorities ?? ["high"],
    category_ids: rule?.category_ids ?? [], notify_user_ids: rule?.notify_user_ids ?? [], notify_team_ids: rule?.notify_team_ids ?? [],
    notify_admins: rule?.notify_admins ?? true, notify_assignees: rule?.notify_assignees ?? false, raise_priority: rule?.raise_priority ?? false,
  }));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, after_hours: Number(f.after_hours) || 0 };
      return rule ? api(`/escalation-rules/${rule.id}`, { method: "PATCH", body }) : api("/escalation-rules", { method: "POST", body });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["escalation-rules"] }); toast("Rule saved"); onClose(); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const catOpts = (cats.data?.items ?? []).map((c) => ({ key: c.id, label: c.name }));
  return (
    <Modal title={rule ? "Edit escalation rule" : "New escalation rule"} onClose={onClose} width={560}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save rule</Button></>}>
      <div className="stack">
        <Field label="Name">{(id) => <Input id={id} value={f.name} maxLength={120} placeholder="High priority overdue" onChange={(e) => set("name", e.target.value)} autoFocus />}</Field>
        <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
          <Field label="Escalate when a work order is">{(id) => (
            <Select id={id} value={f.trigger} onChange={(e) => set("trigger", e.target.value as "overdue" | "not_started")}>
              <option value="overdue">Overdue for</option><option value="not_started">Still open (not started)</option></Select>)}</Field>
          <Field label={f.trigger === "overdue" ? "Hours past its due date" : "Hours after it was created"}>{(id) =>
            <Input id={id} type="number" min={0} max={720} value={f.after_hours} style={{ maxWidth: 120 }} onChange={(e) => set("after_hours", e.target.value)} />}</Field>
        </div>
        <Field label="Priority" hint="None ticked means any priority.">{() => (
          <div className="row wrap" style={{ gap: 12 }}>{PRIOS.map(([k, l]) => (
            <Checkbox key={k} label={l} checked={f.priorities.includes(k)}
              onChange={(v) => set("priorities", v ? [...f.priorities, k] : f.priorities.filter((p) => p !== k))} />))}</div>)}</Field>
        {catOpts.length > 0 && <Field label="Categories" hint="Leave empty for every category.">{(id) =>
          <MultiPicker id={id} label="Categories" placeholder="Any category" options={catOpts} value={f.category_ids} onChange={(v) => set("category_ids", v)} />}</Field>}
        <div className="stack" style={{ gap: 6 }}>
          <div className="label">Tell</div>
          <Checkbox label="Owners and administrators" checked={f.notify_admins} onChange={(v) => set("notify_admins", v)} />
          <Checkbox label="The people and teams assigned" checked={f.notify_assignees} onChange={(v) => set("notify_assignees", v)} />
        </div>
        <Field label="And these people">{(id) => <PeoplePicker id={id} value={f.notify_user_ids} onChange={(v) => set("notify_user_ids", v)} />}</Field>
        <Field label="And these teams">{(id) => <TeamsPicker id={id} value={f.notify_team_ids} onChange={(v) => set("notify_team_ids", v)} />}</Field>
        <Toggle label="Also raise the work order to High priority" checked={f.raise_priority} onChange={(v) => set("raise_priority", v)} />
      </div>
    </Modal>
  );
}
