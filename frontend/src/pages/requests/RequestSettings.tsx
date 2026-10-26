// Settings → Requests (r275, r277–r279, r295, r300, r265, r236): which fields the request form asks for, "Assign to"
// routing, the template used when approving, public request portals with their QR codes, and Guests' site access.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Globe, Pencil, Plus, QrCode, Trash2, UserRound } from "lucide-react";
import { api, ApiError, type CustomFieldDef, type Template } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { FIELD_LABELS, type FieldKey, type FieldState, type Portal } from "./types";
import "./requests.css";

type Settings = { fields: Record<FieldKey, FieldState>; assign_to: FieldState; allow_other: boolean; default_template_id: string };
const KEYS: FieldKey[] = ["description", "priority", "location", "asset", "attachments"];
const STATES: [FieldState, string][] = [["optional", "Optional"], ["required", "Required"], ["hidden", "Hidden"]];

function FieldStates({ value, onChange, keys = KEYS }: { value: Record<FieldKey, FieldState>; onChange: (k: FieldKey, v: FieldState) => void; keys?: FieldKey[] }) {
  return (
    <div className="req-fields">{keys.map((k) => (
      <div key={k} className="req-field-row"><span className="grow">{FIELD_LABELS[k]}</span>
        <div className="seg" role="radiogroup" aria-label={FIELD_LABELS[k]}>{STATES.map(([s, l]) => (
          <button key={s} type="button" role="radio" aria-checked={value[k] === s} className={"seg-btn" + (value[k] === s ? " on" : "")} onClick={() => onChange(k, s)}>{l}</button>))}</div>
      </div>))}</div>
  );
}

export function RequestSettingsPage() {
  const { can } = useSession();
  return (
    <div className="stack page-narrow" style={{ gap: "var(--s-5)" }}>
      {can("requests.settings") && <FormSettings />}
      {can("requests.portals") && <Portals />}
      {can("users.manage") && <Guests />}
    </div>
  );
}

function FormSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const s = useQuery({ queryKey: ["request-settings"], queryFn: () => api<Settings>("/request-settings") });
  const templates = useQuery({ queryKey: ["wo-templates"], queryFn: () => api<{ items: Template[] }>("/work-order-templates") });
  const save = useMutation({ mutationFn: (body: Partial<Settings>) => api<Settings>("/request-settings", { method: "PATCH", body }),
    onSuccess: (d) => { qc.setQueryData(["request-settings"], d); qc.invalidateQueries({ queryKey: ["request-form"] }); toast("Saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  const d = s.data;
  return (
    <section className="card">
      <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Request form</h3></div>
      <div className="card-body stack">
        {!d ? <ListSkeleton rows={4} /> : <>
          <p className="small muted" style={{ margin: 0 }}>The title is always required. Custom fields marked “Show on request forms” in <Link to="/settings/work-orders">Work orders</Link> appear too.</p>
          <FieldStates value={d.fields} onChange={(k, v) => save.mutate({ fields: { ...d.fields, [k]: v } })} />
          <div className="req-field-row"><span className="grow">Assign to (team routing)</span>
            <div className="seg" role="radiogroup" aria-label="Assign to">{STATES.map(([st, l]) => (
              <button key={st} type="button" role="radio" aria-checked={d.assign_to === st} className={"seg-btn" + (d.assign_to === st ? " on" : "")} onClick={() => save.mutate({ assign_to: st })}>{l}</button>))}</div></div>
          {d.assign_to !== "hidden" && <Toggle checked={d.allow_other} onChange={(v) => save.mutate({ allow_other: v })} label="Offer “Other”" hint="Requests sent to Other go to every administrator." />}
          <Field label="Template when approving" hint="Pre-selected when a request becomes a work order. You can still change it.">{(id) => (
            <Select id={id} value={d.default_template_id} onChange={(e) => save.mutate({ default_template_id: e.target.value })} style={{ maxWidth: 360 }}>
              <option value="">No template</option>{templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>)}</Field>
        </>}
      </div>
    </section>
  );
}

function Portals() {
  const list = useQuery({ queryKey: ["request-portals"], queryFn: () => api<{ items: Portal[] }>("/request-portals") });
  const [edit, setEdit] = useState<Portal | "new" | null>(null);
  const [qr, setQr] = useState<Portal | null>(null);
  const { toast } = useToast();
  const copy = (p: Portal) => { void navigator.clipboard?.writeText(location.origin + p.path); toast("Link copied"); };
  return (
    <section className="card">
      <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Request portals</h3>
        <Button size="sm" variant="ghost" onClick={() => setEdit("new")}><Plus size={14} />New portal</Button></div>
      <div className="card-body small muted" style={{ paddingBottom: 0 }}>Public forms anyone can use to report a problem, without an account. Share the link or print the QR code.</div>
      {list.isLoading ? <div className="card-body"><ListSkeleton rows={2} /></div> : !list.data?.items.length
        ? <EmptyState icon={<Globe size={26} />} title="No portals yet">Create one for visitors, tenants or a customer's staff.</EmptyState>
        : list.data.items.map((p) => (
          <div key={p.id} className="list-row req-portal">
            <Globe size={18} className="faint" />
            <span className="grow" style={{ minWidth: 0 }}><span className="t">{p.name} {!p.active && <Pill>Off</Pill>}</span>
              <span className="s">{[p.customer && `For ${p.customer.name}`, p.location && p.location.name, p.asset && p.asset.name, `${p.request_count ?? 0} request${p.request_count === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span></span>
            <Button size="sm" icon aria-label={`Copy link to ${p.name}`} title="Copy link" onClick={() => copy(p)}><Copy size={14} /></Button>
            <a className="btn btn-sm icon" href={p.path} target="_blank" rel="noopener noreferrer" aria-label={`Open ${p.name}`} title="Open"><ExternalLink size={14} /></a>
            <Button size="sm" icon aria-label={`QR code for ${p.name}`} title="QR code" onClick={() => setQr(p)}><QrCode size={14} /></Button>
            <Button size="sm" icon aria-label={`Edit ${p.name}`} title="Edit" onClick={() => setEdit(p)}><Pencil size={14} /></Button>
          </div>))}
      {edit && <PortalEditor portal={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      {qr && <QrDialog portal={qr} onClose={() => setQr(null)} />}
    </section>
  );
}

type Ref = { id: string; name: string };

function PortalEditor({ portal, onClose }: { portal: Portal | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = useSession();
  const [f, setF] = useState(() => ({
    name: portal?.name ?? "", intro: portal?.intro ?? "", active: portal?.active ?? true, require_email: portal?.require_email ?? false,
    fields: portal?.fields ?? { description: "optional", priority: "optional", location: "optional", asset: "optional", attachments: "optional" } as Record<FieldKey, FieldState>,
    custom_field_ids: portal?.custom_field_ids ?? [], location_id: portal?.location?.id ?? null as string | null, asset_id: portal?.asset?.id ?? null as string | null,
    team_id: portal?.team?.id ?? null as string | null, customer_id: portal?.customer?.id ?? null as string | null,
  }));
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState(false);
  const locs = useQuery({ queryKey: ["request-form", "locations"], queryFn: () => api<{ items: Ref[] }>("/requests/form/locations") });
  const assets = useQuery({ queryKey: ["request-form", "assets"], queryFn: () => api<{ items: (Ref & { location: string })[] }>("/requests/form/assets") });
  const teams = useQuery({ queryKey: ["teams", "lite"], queryFn: () => api<{ items: Ref[] }>("/teams") });
  const customers = useQuery({ queryKey: ["customers", "lite"], queryFn: () => api<{ items: Ref[] }>("/customers?per_page=500"), enabled: can("customers.view") });
  const cfs = useQuery({ queryKey: ["custom-fields", "work_order"], queryFn: () => api<{ items: CustomFieldDef[] }>("/custom-fields") });
  const save = useMutation({
    mutationFn: () => api<Portal>(portal ? `/request-portals/${portal.id}` : "/request-portals", { method: portal ? "PATCH" : "POST", body: f }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["request-portals"] }); toast(portal ? "Portal saved" : "Portal created"); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const del = useMutation({ mutationFn: () => api(`/request-portals/${portal!.id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["request-portals"] }); toast("Portal deleted"); onClose(); }, onError: (e) => setErr((e as ApiError).message) });
  const pick = (items: Ref[] | undefined) => (items ?? []).map((x) => ({ key: x.id, label: x.name }));
  return (
    <Modal title={portal ? `Edit ${portal.name}` : "New request portal"} onClose={onClose} width={620}
      footer={<>{portal && <Button variant="ghost" style={{ color: "var(--c-danger)", marginRight: "auto" }} onClick={() => setConfirm(true)}><Trash2 size={15} />Delete</Button>}
        <Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || save.isPending} onClick={() => save.mutate()}>{portal ? "Save" : "Create"}</Button></>}>
      <Field label="Name *">{(id) => <Input id={id} value={f.name} maxLength={200} autoFocus placeholder="e.g. Report a problem" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
      <Field label="Message at the top" hint="Tell people what to expect, e.g. when someone will reply.">{(id) => (
        <textarea id={id} className="textarea" rows={2} maxLength={4000} value={f.intro} onChange={(e) => setF({ ...f, intro: e.target.value })} />)}</Field>
      <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Accept requests" hint="When off, the link and QR code show that the form isn't available." />
      <Toggle checked={f.require_email} onChange={(v) => setF({ ...f, require_email: v })} label="Ask for an email address" hint="People can always leave one to hear about approval, decline and completion." />
      <div className="label">Fields</div>
      <FieldStates value={f.fields} onChange={(k, v) => setF({ ...f, fields: { ...f.fields, [k]: v } })} />
      <div className="form-grid">
        <Field label="Only for this location" hint="Requests can be for it and anything inside it.">{(id) => <MultiPicker id={id} single label="Location" placeholder="Any location"
          options={pick(locs.data?.items)} value={f.location_id ? [f.location_id] : []} onChange={(v) => setF({ ...f, location_id: v[0] ?? null })} />}</Field>
        <Field label="Only for this asset">{(id) => <MultiPicker id={id} single label="Asset" placeholder="Any asset"
          options={(assets.data?.items ?? []).map((a) => ({ key: a.id, label: a.name, sub: a.location }))} value={f.asset_id ? [f.asset_id] : []} onChange={(v) => setF({ ...f, asset_id: v[0] ?? null })} />}</Field>
        <Field label="Send requests to team">{(id) => <MultiPicker id={id} single label="Team" placeholder="No team"
          options={pick(teams.data?.items)} value={f.team_id ? [f.team_id] : []} onChange={(v) => setF({ ...f, team_id: v[0] ?? null })} />}</Field>
        {can("customers.view") && <Field label="Customer" hint="A customer's own portal: their requests are tagged with them.">{(id) => <MultiPicker id={id} single label="Customer" placeholder="No customer"
          options={pick(customers.data?.items)} value={f.customer_id ? [f.customer_id] : []} onChange={(v) => setF({ ...f, customer_id: v[0] ?? null })} />}</Field>}
        <Field label="Custom fields" className="full">{(id) => <MultiPicker id={id} label="Custom fields" placeholder="None"
          options={(cfs.data?.items ?? []).filter((c) => c.type !== "currency").map((c) => ({ key: c.id, label: c.name }))} value={f.custom_field_ids} onChange={(v) => setF({ ...f, custom_field_ids: v })} />}</Field>
      </div>
      {err && <div className="banner warning" role="alert">{err}</div>}
      {confirm && <Modal title="Delete this portal?" onClose={() => setConfirm(false)} width={420}
        footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" onClick={() => del.mutate()}>Delete</Button></>}>
        <p>The link and printed QR codes stop working. Requests already sent stay.</p></Modal>}
    </Modal>
  );
}

function QrDialog({ portal, onClose }: { portal: Portal; onClose: () => void }) {
  const assets = useQuery({ queryKey: ["request-form", "assets"], queryFn: () => api<{ items: (Ref & { location: string })[] }>("/requests/form/assets") });
  const locs = useQuery({ queryKey: ["request-form", "locations"], queryFn: () => api<{ items: Ref[] }>("/requests/form/locations") });
  const [target, setTarget] = useState("");
  const [kind, id] = target.split(":");
  const qs = kind === "asset" ? `asset_id=${id}` : kind === "location" ? `location_id=${id}` : "";
  const link = location.origin + portal.path + (kind === "asset" ? `?asset=${id}` : kind === "location" ? `?location=${id}` : "");
  const src = `/api/v1/request-portals/${portal.id}/qr.svg${qs ? "?" + qs : ""}`;
  return (
    <Modal title={`QR code: ${portal.name}`} onClose={onClose} width={460}
      footer={<><a className="btn" href={src} download={`${portal.slug}${id ? "-" + id.slice(0, 8) : ""}.svg`}>Download</a><Button variant="primary" onClick={() => { const w = window.open(src); w?.addEventListener("load", () => w.print()); }}>Print</Button></>}>
      <Field label="Sticker for" hint="A sticker for one asset or location opens the form already filled in with it.">{(fid) => (
        <Select id={fid} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">The whole portal</option>
          <optgroup label="Locations">{locs.data?.items.map((l) => <option key={l.id} value={`location:${l.id}`}>{l.name}</option>)}</optgroup>
          <optgroup label="Assets">{assets.data?.items.map((a) => <option key={a.id} value={`asset:${a.id}`}>{a.name}</option>)}</optgroup>
        </Select>)}</Field>
      <div className="req-qr"><img src={src} alt={`QR code for ${portal.name}`} /></div>
      <div className="small mono req-link">{link}</div>
    </Modal>
  );
}

type Guest = { user_id: string; name: string; email: string; locations: Ref[]; customer: Ref | null };

function Guests() {
  const list = useQuery({ queryKey: ["guests"], queryFn: () => api<{ items: Guest[] }>("/guests") });
  const [edit, setEdit] = useState<Guest | null>(null);
  return (
    <section className="card">
      <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Guests</h3></div>
      <div className="card-body small muted" style={{ paddingBottom: 0 }}>A customer's contacts with the Guest role sign in to submit requests, see and complete work at their sites, follow their assets' history and approve quotes. Invite them in <Link to="/people/users">Teams &amp; Users</Link>, then choose their sites here.</div>
      {list.isLoading ? <div className="card-body"><ListSkeleton rows={2} /></div> : !list.data?.items.length
        ? <EmptyState icon={<UserRound size={26} />} title="No guests yet" />
        : list.data.items.map((g) => (
          <div key={g.user_id} className="list-row">
            <UserRound size={18} className="faint" />
            <span className="grow" style={{ minWidth: 0 }}><span className="t">{g.name}</span>
              <span className="s">{[g.email, g.customer?.name, g.locations.map((l) => l.name).join(", ") || "No sites yet"].filter(Boolean).join(" · ")}</span></span>
            <Button size="sm" onClick={() => setEdit(g)}><Pencil size={14} />Sites</Button>
          </div>))}
      {edit && <GuestEditor guest={edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function GuestEditor({ guest, onClose }: { guest: Guest; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const { toast } = useToast();
  const [locs, setLocs] = useState(guest.locations.map((l) => l.id));
  const [cust, setCust] = useState(guest.customer?.id ?? null);
  const [err, setErr] = useState("");
  const allLocs = useQuery({ queryKey: ["request-form", "locations"], queryFn: () => api<{ items: Ref[] }>("/requests/form/locations") });
  const customers = useQuery({ queryKey: ["customers", "lite"], queryFn: () => api<{ items: Ref[] }>("/customers?per_page=500"), enabled: can("customers.view") });
  const save = useMutation({ mutationFn: () => api(`/guests/${guest.user_id}`, { method: "PUT", body: { location_ids: locs, customer_id: cust } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["guests"] }); toast("Saved"); onClose(); }, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={`${guest.name}'s sites`} onClose={onClose} width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <Field label="Locations" hint="They see work at these locations and everything inside them.">{(id) => <MultiPicker id={id} label="Locations" placeholder="Pick locations"
        options={(allLocs.data?.items ?? []).map((l) => ({ key: l.id, label: l.name }))} value={locs} onChange={setLocs} />}</Field>
      {can("customers.view") && <Field label="Customer" hint="They approve this customer's quotes.">{(id) => <MultiPicker id={id} single label="Customer" placeholder="No customer"
        options={(customers.data?.items ?? []).map((c) => ({ key: c.id, label: c.name }))} value={cust ? [cust] : []} onChange={(v) => setCust(v[0] ?? null)} />}</Field>}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}
