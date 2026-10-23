// Settings → Purchasing (0.5.0, MP-042–044, r227–r268): PO numbering and defaults, CC list, addresses, approval
// rules, budgets, and custom fields for purchase orders and vendors.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api, ApiError, type CustomFieldDef } from "../../lib/api";
import { useSession } from "../../lib/session";
import { currency } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { LocationPicker } from "../../components/assetPickers";
import { useTeams } from "../assets/shared";
import { useVendorsLite } from "./POForm";
import { addrLines, type Address, type ApprovalRule, type Budget, type Condition, type POSettings } from "./types";
import "./purchasing.css";

export function PurchasingSettingsPage() {
  const { can } = useSession();
  const ro = !can("po.settings");
  return (
    <div className="stack" style={{ gap: 20 }}>
      {ro && <div className="banner info">Only administrators can change purchasing settings. You can see how they're set up.</div>}
      <General ro={ro} />
      <Addresses ro={ro} />
      <Rules ro={ro} />
      <Budgets ro={ro} />
      <EntityFields entity="purchase_order" title="Purchase order fields" ro={ro} />
      <EntityFields entity="vendor" title="Vendor fields" ro={!can("vendors.manage")} />
    </div>
  );
}

function General({ ro }: { ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const s = useQuery({ queryKey: ["po-settings"], queryFn: () => api<POSettings & { next_number: number }>("/purchasing/settings") });
  const [cc, setCc] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (b: Partial<POSettings>) => api<POSettings & { next_number: number }>("/purchasing/settings", { method: "PATCH", body: b }),
    onSuccess: (x) => { qc.setQueryData(["po-settings"], x); qc.invalidateQueries({ queryKey: ["po-options"] }); setCc(null); setNext(null); toast("Saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!s.data) return <ListSkeleton rows={4} />;
  const v = s.data;
  return (
    <section className="card">
      <div className="card-head"><h2>Purchase orders</h2></div>
      <div className="card-body stack">
        <div className="po-form-grid">
          <Field label="Number prefix" hint={`Next: ${v.number_prefix}${v.next_number}`}>{(id) => <Input id={id} defaultValue={v.number_prefix} maxLength={12} disabled={ro}
            onBlur={(e) => { if (e.target.value !== v.number_prefix) save.mutate({ number_prefix: e.target.value }); }} />}</Field>
          <Field label="Next number" hint="Can't go below a number already used">{(id) => <div className="row" style={{ gap: 6 }}>
            <Input id={id} inputMode="numeric" value={next ?? String(v.next_number)} disabled={ro} onChange={(e) => setNext(e.target.value)} />
            {next !== null && <Button size="sm" onClick={() => save.mutate({ next_number: Number(next) })}>Set</Button>}</div>}</Field>
          <Field label="Default title">{(id) => <Input id={id} defaultValue={v.default_title} maxLength={120} disabled={ro}
            onBlur={(e) => { if (e.target.value !== v.default_title) save.mutate({ default_title: e.target.value }); }} />}</Field>
        </div>
        <Field label="Always CC" hint="These addresses get a copy of every purchase order you send. Separate with commas.">{(id) => <div className="row" style={{ gap: 6 }}>
          <Input id={id} className="grow" value={cc ?? v.default_cc.join(", ")} disabled={ro} onChange={(e) => setCc(e.target.value)} placeholder="purchasing@yourcompany.com" />
          {cc !== null && <Button size="sm" onClick={() => save.mutate({ default_cc: cc.split(/[,;\s]+/).filter(Boolean) })}>Save</Button>}</div>}</Field>
        <Toggle label="One address for shipping and billing" hint="Purchase orders use the shipping address for billing too." checked={v.single_address} disabled={ro} onChange={(x) => save.mutate({ single_address: x })} />
        <Toggle label="Requests need review" hint="Purchase orders requested by technicians wait for someone who manages purchase orders." checked={v.requests_need_review} disabled={ro} onChange={(x) => save.mutate({ requests_need_review: x })} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- addresses (r253)
function Addresses({ ro }: { ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useQuery({ queryKey: ["addresses"], queryFn: () => api<{ items: Address[] }>("/addresses") });
  const [edit, setEdit] = useState<Address | "new" | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ["addresses"] }); qc.invalidateQueries({ queryKey: ["po-options"] }); };
  const del = useMutation({ mutationFn: (a: Address) => api(`/addresses/${a.id}`, { method: "DELETE" }), onSuccess: done, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const items = list.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-head"><h2>Shipping and billing addresses</h2>{!ro && <Button size="sm" onClick={() => setEdit("new")}><Plus size={14} />Add address</Button>}</div>
      {items.length === 0 ? <div className="card-body small faint">Add where vendors ship to and send invoices. The default ones fill in on new purchase orders.</div>
        : items.map((a) => <div key={a.id} className="list-row" style={{ borderLeft: 0, alignItems: "flex-start" }}>
          <div className="grow"><div className="t">{a.label || a.line1} {a.is_default && <Pill tone="info">Default</Pill>} <span className="small faint">{{ shipping: "Shipping", billing: "Billing", both: "Shipping and billing" }[a.kind]}</span></div>
            <div className="s prewrap">{addrLines(a).join(", ")}</div></div>
          {!ro && <><Button size="sm" variant="ghost" icon aria-label={`Edit ${a.label}`} onClick={() => setEdit(a)}><Pencil size={14} /></Button>
            <Button size="sm" variant="ghost" icon aria-label={`Delete ${a.label}`} onClick={() => del.mutate(a)}><Trash2 size={14} /></Button></>}
        </div>)}
      {edit && <AddressModal edit={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); done(); }} />}
    </section>
  );
}

function AddressModal({ edit, onClose, onDone }: { edit?: Address; onClose: () => void; onDone: () => void }) {
  const [a, setA] = useState<Partial<Address>>(edit ?? { kind: "both", is_default: false, country: "" });
  const [err, setErr] = useState("");
  const m = useMutation({ mutationFn: () => edit ? api(`/addresses/${edit.id}`, { method: "PATCH", body: a }) : api("/addresses", { method: "POST", body: a }),
    onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  const t = (k: keyof Address, label: string, max = 200) => <Field label={label}>{(id) => <Input id={id} value={(a[k] as string) ?? ""} maxLength={max} onChange={(e) => setA({ ...a, [k]: e.target.value })} />}</Field>;
  return (
    <Modal title={edit ? "Edit address" : "New address"} onClose={onClose} width={620} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="po-form-grid">
        {t("label", "Name", 120)}
        <Field label="Used for">{(id) => <Select id={id} value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as Address["kind"] })}>
          <option value="both">Shipping and billing</option><option value="shipping">Shipping</option><option value="billing">Billing</option></Select>}</Field>
        {t("company", "Company")}{t("attention", "Attention")}{t("line1", "Street")}{t("line2", "Line 2")}{t("city", "City", 120)}{t("region", "State / region", 120)}
        {t("postal_code", "Postal code", 20)}{t("country", "Country (2 letters)", 2)}{t("phone", "Phone", 60)}
        <Field label="Site">{(id) => <LocationPicker id={id} value={a.location_id ?? null} onChange={(v) => setA({ ...a, location_id: v })} placeholder="Any site" />}</Field>
      </div>
      <Checkbox checked={!!a.is_default} onChange={(v) => setA({ ...a, is_default: v })} label="Use by default on new purchase orders" />
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- approval rules (r230)
const COND_FIELDS: [string, string][] = [["total", "Total"], ["vendor", "Vendor"], ["location", "Site"], ["category", "Category"],
  ["has_one_off", "Has items that aren't parts"], ["zero_cost_part", "Has a part with no cost"], ["over_budget", "Goes over its budget"]];

function useUsersLite() {
  return useQuery({ queryKey: ["users-lite"], queryFn: () => api<{ items: { id: string; name: string; email: string }[] }>("/users?per_page=500"), staleTime: 60_000 });
}

function condLabel(c: Condition, names: Record<string, string>, cur?: string): string {
  const f = COND_FIELDS.find(([k]) => k === c.field)?.[1] ?? c.field;
  if (c.field === "total") return c.op === "between" && Array.isArray(c.value) ? `Total between ${currency(c.value[0], cur)} and ${currency(c.value[1], cur)}` : `Total ${c.op} ${currency(c.value, cur)}`;
  if (Array.isArray(c.value)) return `${f}: ${c.value.map((x) => names[String(x)] ?? "…").join(", ")}`;
  if (c.field === "category") return `Category is ${String(c.value)}`;
  return f;
}

function Rules({ ro }: { ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { session } = useSession();
  const list = useQuery({ queryKey: ["approval-rules"], queryFn: () => api<{ items: ApprovalRule[] }>("/approval-rules?applies_to=purchase_order") });
  const users = useUsersLite();
  const teams = useTeams();
  const vendors = useVendorsLite();
  const [edit, setEdit] = useState<ApprovalRule | "new" | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ["approval-rules"] });
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const del = useMutation({ mutationFn: (r: ApprovalRule) => api(`/approval-rules/${r.id}`, { method: "DELETE" }), onSuccess: done, onError: err });
  const toggle = useMutation({ mutationFn: (r: ApprovalRule) => api(`/approval-rules/${r.id}`, { method: "PATCH", body: { active: !r.active } }), onSuccess: done, onError: err });
  const names: Record<string, string> = Object.fromEntries([...(users.data?.items ?? []), ...(teams.data?.items ?? []), ...(vendors.data?.items ?? [])].map((x) => [x.id, x.name]));
  const items = list.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-head"><h2>Approval rules</h2>{!ro && <Button size="sm" onClick={() => setEdit("new")}><Plus size={14} />Add rule</Button>}</div>
      <div className="card-body small muted" style={{ paddingBottom: 0 }}>Every matching rule adds an approval step; each step needs one of its approvers. Without a matching rule, purchase orders from people who manage them are approved right away.</div>
      {items.length === 0 ? <div className="card-body small faint">No rules yet. For example: orders of {currency(5000, session.org?.currency)} or more need the plant manager.</div>
        : items.map((r) => <div key={r.id} className="list-row" style={{ borderLeft: 0 }}>
          <div className="grow"><div className="t">{r.name} {!r.active && <Pill>Off</Pill>}</div>
            <div className="s">{(r.conditions.length ? r.conditions.map((c) => condLabel(c, names, session.org?.currency)).join(" and ") : "Every purchase order") + " → "
              + (r.action === "auto_approve" ? "approve automatically" : [...r.approver_user_ids, ...r.approver_team_ids].map((x) => names[x] ?? "…").join(" or "))}</div></div>
          {!ro && <><Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>{r.active ? "Turn off" : "Turn on"}</Button>
            <Button size="sm" variant="ghost" icon aria-label={`Edit ${r.name}`} onClick={() => setEdit(r)}><Pencil size={14} /></Button>
            <Button size="sm" variant="ghost" icon aria-label={`Delete ${r.name}`} onClick={() => del.mutate(r)}><Trash2 size={14} /></Button></>}
        </div>)}
      {edit && <RuleModal edit={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); done(); }} />}
    </section>
  );
}

function RuleModal({ edit, onClose, onDone }: { edit?: ApprovalRule; onClose: () => void; onDone: () => void }) {
  const users = useUsersLite();
  const teams = useTeams();
  const vendors = useVendorsLite();
  const [name, setName] = useState(edit?.name ?? "");
  const [conds, setConds] = useState<Condition[]>(edit?.conditions ?? [{ field: "total", op: ">=", value: "" }]);
  const [action, setAction] = useState<ApprovalRule["action"]>(edit?.action ?? "approvers");
  const [approvers, setApprovers] = useState<string[]>([...(edit?.approver_user_ids ?? []).map((x) => `u:${x}`), ...(edit?.approver_team_ids ?? []).map((x) => `t:${x}`)]);
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => {
      const body = { name, conditions: conds, action, approver_user_ids: approvers.filter((x) => x.startsWith("u:")).map((x) => x.slice(2)),
        approver_team_ids: approvers.filter((x) => x.startsWith("t:")).map((x) => x.slice(2)), applies_to: "purchase_order" };
      return edit ? api(`/approval-rules/${edit.id}`, { method: "PATCH", body }) : api("/approval-rules", { method: "POST", body });
    },
    onSuccess: onDone, onError: (e) => setErr((e as ApiError).message),
  });
  const setC = (i: number, c: Partial<Condition>) => setConds((cs) => cs.map((x, j) => (j === i ? { ...x, ...c } : x)));
  const reset = (field: string): Condition => field === "total" ? { field, op: ">=", value: "" } : field === "vendor" || field === "location" ? { field, op: "in", value: [] }
    : field === "category" ? { field, op: "=", value: "" } : { field, op: "=", value: true };
  return (
    <Modal title={edit ? "Edit approval rule" : "New approval rule"} width={640} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim() || m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Name">{(id) => <Input id={id} autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="e.g. Big orders" />}</Field>
      <h3 className="sec-h">When</h3>
      {conds.length === 0 && <p className="small muted">Every purchase order.</p>}
      {conds.map((c, i) => <div key={i} className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
        <Select aria-label="Condition" value={c.field} onChange={(e) => setC(i, reset(e.target.value))} style={{ maxWidth: 220 }}>
          {COND_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        {c.field === "total" && <>
          <Select aria-label="Comparison" value={c.op} onChange={(e) => setC(i, { op: e.target.value, value: e.target.value === "between" ? ["", ""] : "" })} style={{ maxWidth: 110 }}>
            {[">=", ">", "<=", "<", "between"].map((o) => <option key={o} value={o}>{o === "between" ? "between" : o}</option>)}</Select>
          {c.op === "between" && Array.isArray(c.value)
            ? <><Input aria-label="From" inputMode="decimal" value={String(c.value[0] ?? "")} style={{ maxWidth: 110 }} onChange={(e) => setC(i, { value: [e.target.value, (c.value as string[])[1]] })} />
              <Input aria-label="To" inputMode="decimal" value={String(c.value[1] ?? "")} style={{ maxWidth: 110 }} onChange={(e) => setC(i, { value: [(c.value as string[])[0], e.target.value] })} /></>
            : <Input aria-label="Amount" inputMode="decimal" value={String(c.value ?? "")} style={{ maxWidth: 140 }} onChange={(e) => setC(i, { value: e.target.value })} />}
        </>}
        {c.field === "vendor" && <div className="grow"><MultiPicker label="Vendors" placeholder="Pick vendors" value={(c.value as string[]) ?? []} onChange={(v) => setC(i, { value: v })}
          options={(vendors.data?.items ?? []).map((v) => ({ key: v.id, label: v.name }))} /></div>}
        {c.field === "location" && <div className="grow"><LocationPicker value={((c.value as string[]) ?? [])[0] ?? null} onChange={(v) => setC(i, { value: v ? [v] : [] })} placeholder="Pick a site" /></div>}
        {c.field === "category" && <Input aria-label="Category" value={String(c.value ?? "")} onChange={(e) => setC(i, { value: e.target.value })} />}
        <Button size="sm" variant="ghost" icon aria-label="Remove condition" onClick={() => setConds((cs) => cs.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>
      </div>)}
      <Button size="sm" variant="ghost" onClick={() => setConds((cs) => [...cs, reset("total")])}><Plus size={14} />Add condition</Button>
      <h3 className="sec-h">Then</h3>
      <Select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value as ApprovalRule["action"])}>
        <option value="approvers">Needs approval from</option><option value="auto_approve">Approve automatically</option></Select>
      {action === "approvers" && <div style={{ marginTop: 8 }}><MultiPicker label="Approvers" placeholder="Pick people or teams" value={approvers} onChange={setApprovers}
        options={[...(users.data?.items ?? []).map((u) => ({ key: `u:${u.id}`, label: u.name, sub: u.email })), ...(teams.data?.items ?? []).map((t) => ({ key: `t:${t.id}`, label: t.name, sub: "Team" }))]} /></div>}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- budgets (r268)
function Budgets({ ro }: { ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useQuery({ queryKey: ["budgets"], queryFn: () => api<{ items: Budget[] }>("/budgets") });
  const [edit, setEdit] = useState<Budget | "new" | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ["budgets"] }); qc.invalidateQueries({ queryKey: ["po-options"] }); };
  const del = useMutation({ mutationFn: (b: Budget) => api(`/budgets/${b.id}`, { method: "DELETE" }), onSuccess: done, onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const items = list.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-head"><h2>Budgets</h2>{!ro && <Button size="sm" onClick={() => setEdit("new")}><Plus size={14} />Add budget</Button>}</div>
      {items.length === 0 ? <div className="card-body small faint">Set a maintenance budget per site or category. Purchase orders show how much is left, and orders above the approval limit need approval.</div>
        : items.map((b) => <div key={b.id} className="list-row" style={{ borderLeft: 0 }}>
          <div className="grow"><div className="t">{b.name} {!b.active && <Pill>Off</Pill>}</div>
            <div className="s">{b.amount !== null ? `${currency(b.spent, b.currency)} of ${currency(b.amount, b.currency)} this ${b.period} (${b.used_pct}%)` : `Per ${b.period}`}
              {b.approval_limit !== null && ` · approval above ${currency(b.approval_limit, b.currency)}`}</div>
            {b.amount !== null && <div className="meter" style={{ height: 6, background: "var(--c-border-soft)", borderRadius: 3, marginTop: 4, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, b.used_pct)}%`, height: "100%", background: b.used_pct >= 100 ? "var(--c-danger)" : b.used_pct >= b.warn_at_pct ? "var(--c-warning)" : "var(--c-primary)" }} /></div>}
          </div>
          {!ro && <><Button size="sm" variant="ghost" icon aria-label={`Edit ${b.name}`} onClick={() => setEdit(b)}><Pencil size={14} /></Button>
            <Button size="sm" variant="ghost" icon aria-label={`Delete ${b.name}`} onClick={() => del.mutate(b)}><Trash2 size={14} /></Button></>}
        </div>)}
      {edit && <BudgetModal edit={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); done(); }} />}
    </section>
  );
}

function BudgetModal({ edit, onClose, onDone }: { edit?: Budget; onClose: () => void; onDone: () => void }) {
  const [b, setB] = useState({ name: edit?.name ?? "", period: edit?.period ?? "month", starts_on: edit?.starts_on ?? new Date().toISOString().slice(0, 8) + "01",
    amount: edit?.amount ?? "", approval_limit: edit?.approval_limit ?? "", warn_at_pct: edit?.warn_at_pct ?? 90, location_id: edit?.location_id ?? null,
    category: edit?.category ?? "", active: edit?.active ?? true });
  const [err, setErr] = useState("");
  const body = { ...b, approval_limit: b.approval_limit === "" ? null : b.approval_limit };
  const m = useMutation({ mutationFn: () => edit ? api(`/budgets/${edit.id}`, { method: "PATCH", body }) : api("/budgets", { method: "POST", body }),
    onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={edit ? "Edit budget" : "New budget"} onClose={onClose} width={600}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!b.name.trim() || m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <div className="po-form-grid">
        <Field label="Name">{(id) => <Input id={id} autoFocus value={b.name} maxLength={200} onChange={(e) => setB({ ...b, name: e.target.value })} />}</Field>
        <Field label="Period">{(id) => <Select id={id} value={b.period} onChange={(e) => setB({ ...b, period: e.target.value as Budget["period"] })}>
          <option value="month">Monthly</option><option value="quarter">Quarterly</option><option value="year">Yearly</option></Select>}</Field>
        <Field label="Starts on">{(id) => <Input id={id} type="date" value={b.starts_on} onChange={(e) => setB({ ...b, starts_on: e.target.value })} />}</Field>
        <Field label="Amount per period">{(id) => <Input id={id} inputMode="decimal" value={b.amount} onChange={(e) => setB({ ...b, amount: e.target.value })} />}</Field>
        <Field label="Approval needed above" hint="Optional: single orders over this amount">{(id) => <Input id={id} inputMode="decimal" value={b.approval_limit} onChange={(e) => setB({ ...b, approval_limit: e.target.value })} />}</Field>
        <Field label="Warn at %">{(id) => <Input id={id} inputMode="numeric" value={String(b.warn_at_pct)} onChange={(e) => setB({ ...b, warn_at_pct: Number(e.target.value) || 0 })} />}</Field>
        <Field label="Site">{(id) => <LocationPicker id={id} value={b.location_id} onChange={(v) => setB({ ...b, location_id: v })} placeholder="All sites" />}</Field>
        <Field label="Category">{(id) => <Input id={id} value={b.category} maxLength={80} onChange={(e) => setB({ ...b, category: e.target.value })} />}</Field>
      </div>
      <Checkbox checked={b.active} onChange={(v) => setB({ ...b, active: v })} label="Active" />
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------- custom fields (r249, r264)
const TYPES: [CustomFieldDef["type"], string][] = [["text", "Single line text"], ["textarea", "Multi-line text"], ["number", "Number"], ["select", "Single select"],
  ["date", "Date"], ["checkbox", "Checkbox"], ["link", "Link"], ["currency", "Currency"]];

function EntityFields({ entity, title, ro }: { entity: "purchase_order" | "vendor"; title: string; ro: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ["custom-fields", entity];
  const list = useQuery({ queryKey: key, queryFn: () => api<{ items: CustomFieldDef[] }>(`/custom-fields?entity=${entity}`) });
  const [edit, setEdit] = useState<CustomFieldDef | "new" | null>(null);
  const del = useMutation({ mutationFn: (f: CustomFieldDef) => api(`/custom-fields/${f.id}?entity=${entity}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }), onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const items = list.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2>{!ro && <Button size="sm" onClick={() => setEdit("new")}><Plus size={14} />Add field</Button>}</div>
      {items.length === 0 ? <div className="card-body small faint">{entity === "vendor" ? "Track more about vendors, like a certification or a rating." : "Add fields like a cost center or a project code to every purchase order."}</div>
        : items.map((f) => <div key={f.id} className="list-row" style={{ borderLeft: 0 }}>
          <div className="grow"><div className="t">{f.name} {f.required && <Pill tone="warning">Required</Pill>}</div><div className="s">{TYPES.find(([k]) => k === f.type)?.[1] ?? f.type}</div></div>
          {!ro && <><Button size="sm" variant="ghost" icon aria-label={`Edit ${f.name}`} onClick={() => setEdit(f)}><Pencil size={14} /></Button>
            <Button size="sm" variant="ghost" icon aria-label={`Delete ${f.name}`} onClick={() => del.mutate(f)}><Trash2 size={14} /></Button></>}
        </div>)}
      {edit && <FieldModal entity={entity} field={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); qc.invalidateQueries({ queryKey: key }); }} />}
    </section>
  );
}

function FieldModal({ entity, field, onClose, onDone }: { entity: string; field?: CustomFieldDef; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: field?.name ?? "", type: field?.type ?? "text", options: (field?.options ?? []).join("\n"), required: field?.required ?? false });
  const [err, setErr] = useState("");
  const body = () => ({ ...f, options: f.options.split("\n").map((x) => x.trim()).filter(Boolean), entity_type: entity });
  const m = useMutation({ mutationFn: () => field ? api(`/custom-fields/${field.id}`, { method: "PATCH", body: body() }) : api("/custom-fields", { method: "POST", body: body() }),
    onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={field ? "Edit field" : "New field"} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <Field label="Name">{(id) => <Input id={id} autoFocus value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
      <Field label="Type">{(id) => <Select id={id} value={f.type} disabled={!!field} onChange={(e) => setF({ ...f, type: e.target.value as CustomFieldDef["type"] })}>
        {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
      {f.type === "select" && <Field label="Options (one per line)">{(id) => <textarea id={id} className="textarea" value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} />}</Field>}
      <Checkbox checked={f.required} onChange={(x) => setF({ ...f, required: x })} label="Required" />
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

