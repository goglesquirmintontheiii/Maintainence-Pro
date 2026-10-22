// Settings → Roles and permissions (MP-106): built-in and custom roles, a permission editor grouped by area,
// and a "view as" preview that shows what a role can see and do (a summary, not impersonation).
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Plus, RotateCcw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError, type Role } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import "../../styles/roles.css";

type Catalogue = {
  areas: { id: string; label: string }[];
  actions: { id: string; area: string; label: string; owner_only: boolean }[];
  builtin: Record<string, string[]>;
  bases: string[];
};
type ViewAs = { role: string; label: string; permissions: string[]; work_orders: string; person?: string;
  areas: { id: string; label: string; can: string[]; cannot: string[] }[] };
type Draft = { name: string; description: string; permissions: string[]; wo_visibility: "all" | "limited" };

const err = (e: unknown) => (e as ApiError).message;

export function RolesPage() {
  const { can } = useSession();
  const manage = can("roles.manage");
  const [showDeleted, setShowDeleted] = useState(false);
  const roles = useQuery({ queryKey: ["roles", showDeleted], queryFn: () => api<Role[]>(`/roles${showDeleted ? "?include_deleted=1" : ""}`) });
  const cat = useQuery({ queryKey: ["roles", "catalogue"], queryFn: () => api<Catalogue>("/roles/catalogue"), staleTime: 300_000 });
  const [selected, setSelected] = useState<string>("");
  const [creating, setCreating] = useState<string | null>(null); // base role to start from
  const list = roles.data ?? [];
  const current = list.find((r) => r.key === selected) ?? list[0];

  if (!roles.data || !cat.data) return <ListSkeleton rows={8} />;
  const builtin = list.filter((r) => !r.custom);
  const custom = list.filter((r) => r.custom);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row roles-intro">
        <p className="muted" style={{ margin: 0 }}>Roles decide what people can see and do. Start a custom role from a built-in one and add or take away permissions.</p>
        {manage && <Button variant="primary" onClick={() => setCreating("technician")}><Plus size={16} />New role</Button>}
      </div>
      {!manage && <div className="banner info">Only Owners can create and change roles. You can see how they're set up.</div>}
      <div className="roles-layout">
        <nav className="card roles-list" aria-label="Roles">
          <div className="roles-group">Built-in roles</div>
          {builtin.map((r) => <RoleRow key={r.key} r={r} active={current?.key === r.key} onClick={() => setSelected(r.key)} />)}
          <div className="roles-group">Custom roles</div>
          {custom.length === 0 && <p className="small faint" style={{ padding: "0 16px 12px", margin: 0 }}>No custom roles yet.</p>}
          {custom.map((r) => <RoleRow key={r.key} r={r} active={current?.key === r.key} onClick={() => setSelected(r.key)} />)}
          {manage && <div style={{ padding: "8px 16px 14px" }}><Toggle label="Show deleted roles" checked={showDeleted} onChange={setShowDeleted} /></div>}
        </nav>
        {current && <RoleEditor key={current.key + (current.deleted ? ":d" : "")} role={current} cat={cat.data} manage={manage}
          onSelect={setSelected} onStartFrom={(base) => setCreating(base)} />}
      </div>
      {creating !== null && <CreateRole base={creating} cat={cat.data} roles={builtin} onClose={() => setCreating(null)}
        onCreated={(r) => { setCreating(null); setSelected(r.key); }} />}
    </div>
  );
}

function RoleRow({ r, active, onClick }: { r: Role; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={"roles-row" + (active ? " active" : "")} aria-current={active ? "true" : undefined} onClick={onClick}>
      <span className="grow">
        <span className="roles-row-name">{r.label}{r.key === "owner" && <Pill tone="info">Owner</Pill>}{r.deleted && <Pill tone="warning">Deleted</Pill>}</span>
        {r.custom && r.base_label && <span className="small faint">Based on {r.base_label}</span>}
      </span>
      <span className="small muted" title={`${r.members} ${r.members === 1 ? "person" : "people"}`}>{r.members}</span>
    </button>
  );
}

function CreateRole({ base, cat, roles, onClose, onCreated }: { base: string; cat: Catalogue; roles: Role[]; onClose: () => void; onCreated: (r: Role) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [f, setF] = useState({ name: "", description: "", base: cat.bases.includes(base) ? base : "technician", wo: base === "operator" ? "limited" : "all" });
  const create = useMutation({
    mutationFn: () => api<Role>("/roles", { method: "POST", body: { name: f.name, description: f.description, base: f.base, settings: { wo_visibility: f.wo } } }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["roles"] }); toast(`Created ${r.name}`); onCreated(r); },
    onError: (e) => toast(err(e), { kind: "error" }),
  });
  const label = (k: string) => roles.find((r) => r.key === k)?.label ?? k;
  return (
    <Modal title="New role" onClose={onClose} width={480}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || create.isPending} onClick={() => create.mutate()}>Create role</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (f.name.trim()) create.mutate(); }}>
        <Field label="Name">{(id) => <Input id={id} autoFocus maxLength={60} value={f.name} placeholder="e.g. Shift lead" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Start from" hint="The new role gets this role's permissions. You can change them afterwards.">{(id) => (
          <Select id={id} value={f.base} onChange={(e) => setF({ ...f, base: e.target.value, wo: e.target.value === "operator" ? "limited" : f.wo })}>
            {cat.bases.map((b) => <option key={b} value={b}>{label(b)}</option>)}</Select>)}</Field>
        <Field label="Work orders they see">{(id) => (
          <Select id={id} value={f.wo} onChange={(e) => setF({ ...f, wo: e.target.value })}>
            <option value="all">All work orders</option><option value="limited">Only work assigned to them or their teams</option></Select>)}</Field>
        <Field label="Description (optional)">{(id) => <textarea id={id} className="textarea" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function RoleEditor({ role, cat, manage, onSelect, onStartFrom }: { role: Role; cat: Catalogue; manage: boolean; onSelect: (k: string) => void; onStartFrom: (base: string) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { session } = useSession();
  const mine = useMemo(() => new Set(session.permissions ?? []), [session.permissions]);
  const editable = manage && role.custom && !role.deleted;
  const initial = (): Draft => ({ name: role.name, description: role.description ?? "", permissions: [...role.permissions],
    wo_visibility: role.settings?.wo_visibility === "limited" ? "limited" : "all" });
  const [d, setD] = useState<Draft>(initial);
  useEffect(() => setD(initial()), [role]); // reset when the saved role changes
  const [q, setQ] = useState("");
  const [area, setArea] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [sort, setSort] = useState<"area" | "name">("area");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState(false);

  const basePerms = useMemo(() => new Set(cat.builtin[role.custom ? role.base ?? "technician" : role.key] ?? []), [cat, role]);
  const have = useMemo(() => new Set(d.permissions), [d.permissions]);
  const dirty = editable && (d.name !== role.name || d.description !== (role.description ?? "") || d.wo_visibility !== (role.settings?.wo_visibility === "limited" ? "limited" : "all")
    || d.permissions.length !== role.permissions.length || d.permissions.some((p) => !role.permissions.includes(p)));

  const invalidate = () => qc.invalidateQueries({ queryKey: ["roles"] });
  const save = useMutation({
    mutationFn: () => api<Role>(`/roles/${role.id}`, { method: "PATCH", body: { name: d.name, description: d.description, permissions: d.permissions, settings: { wo_visibility: d.wo_visibility } } }),
    onSuccess: () => { invalidate(); toast("Role saved"); }, onError: (e) => toast(err(e), { kind: "error" }),
  });
  const duplicate = useMutation({
    mutationFn: () => api<Role>(`/roles/${role.id}/duplicate`, { method: "POST" }),
    onSuccess: (r) => { invalidate(); onSelect(r.key); toast(`Created ${r.name}`); }, onError: (e) => toast(err(e), { kind: "error" }),
  });
  const remove = useMutation({
    mutationFn: () => api<{ moved: number }>(`/roles/${role.id}`, { method: "DELETE" }),
    onSuccess: (x) => { setConfirmDelete(false); invalidate(); onSelect(""); qc.invalidateQueries({ queryKey: ["users"] });
      toast(x.moved ? `Role deleted. ${x.moved} ${x.moved === 1 ? "person moved" : "people moved"} to ${role.base_label}.` : "Role deleted"); },
    onError: (e) => toast(err(e), { kind: "error" }),
  });
  const restore = useMutation({
    mutationFn: () => api<Role>(`/roles/${role.id}/restore`, { method: "POST" }),
    onSuccess: () => { invalidate(); toast("Role restored"); }, onError: (e) => toast(err(e), { kind: "error" }),
  });

  const changed = (id: string) => have.has(id) !== basePerms.has(id);
  const needle = q.trim().toLowerCase();
  const visible = cat.actions.filter((a) => (!area || a.area === area) && (!needle || a.label.toLowerCase().includes(needle) || a.id.includes(needle))
    && (!onlyChanged || changed(a.id)));
  const groups = cat.areas.map((ar) => ({ ...ar, actions: visible.filter((a) => a.area === ar.id) })).filter((g) => g.actions.length);
  if (sort === "name") groups.forEach((g) => g.actions.sort((a, b) => a.label.localeCompare(b.label)));
  const lockedReason = (a: Catalogue["actions"][number]) =>
    a.owner_only ? "Only Owners have this" : a.id === "org.view" ? "Everyone has this" : !mine.has(a.id) ? "You don't have this permission yourself" : "";
  const toggle = (id: string, on: boolean) => setD((x) => ({ ...x, permissions: on ? [...new Set([...x.permissions, id])] : x.permissions.filter((p) => p !== id) }));
  const changedCount = cat.actions.filter((a) => changed(a.id)).length;

  return (
    <section className="card roles-editor" aria-labelledby="role-title">
      <div className="card-head roles-editor-head">
        <div>
          <h2 id="role-title" className="row" style={{ gap: 8 }}>{role.label}{role.custom ? <Pill>Custom</Pill> : <Pill tone="info">Built-in</Pill>}</h2>
          <span className="small muted">{role.members} {role.members === 1 ? "person has" : "people have"} this role{role.custom && role.base_label ? ` · based on ${role.base_label}` : ""}</span>
        </div>
        <div className="row roles-actions">
          <Button size="sm" onClick={() => setPreview(true)}><Eye size={14} />View as</Button>
          {manage && !role.custom && role.key !== "owner" && <Button size="sm" onClick={() => onStartFrom(role.key)}><Copy size={14} />Start a role from this</Button>}
          {manage && role.custom && !role.deleted && <Button size="sm" disabled={duplicate.isPending} onClick={() => duplicate.mutate()}><Copy size={14} />Duplicate</Button>}
          {manage && role.custom && !role.deleted && <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 size={14} />Delete</Button>}
          {manage && role.deleted && <Button size="sm" disabled={restore.isPending} onClick={() => restore.mutate()}><RotateCcw size={14} />Restore</Button>}
        </div>
      </div>
      <div className="card-body stack">
        {!role.custom && <p className="small muted" style={{ margin: 0 }}>{role.description} Built-in roles can't be changed; start a custom role from one instead.</p>}
        {role.deleted && <div className="banner warning">This role is deleted. Restore it to use it again.</div>}
        {role.custom && (
          <div className="form-grid">
            <Field label="Name">{(id) => <Input id={id} maxLength={60} value={d.name} disabled={!editable} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
            <Field label="Work orders they see">{(id) => (
              <Select id={id} value={d.wo_visibility} disabled={!editable} onChange={(e) => setD({ ...d, wo_visibility: e.target.value as Draft["wo_visibility"] })}>
                <option value="all">All work orders</option><option value="limited">Only work assigned to them or their teams</option></Select>)}</Field>
            <Field label="Description" className="full">{(id) => <textarea id={id} className="textarea" rows={2} value={d.description} disabled={!editable} onChange={(e) => setD({ ...d, description: e.target.value })} />}</Field>
          </div>)}
        <div className="roles-filters">
          <label className="roles-search"><Search size={14} aria-hidden="true" className="faint" />
            <input className="input" type="search" placeholder="Search permissions" aria-label="Search permissions" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <Select aria-label="Area" value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">All areas</option>{cat.areas.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select>
          <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as "area" | "name")}>
            <option value="area">Default order</option><option value="name">A to Z</option></Select>
          {role.custom && <Checkbox checked={onlyChanged} onChange={setOnlyChanged} label={`Only changed from ${role.base_label ?? "base role"} (${changedCount})`} />}
        </div>
        {groups.length === 0 ? <EmptyState icon={<ShieldCheck size={28} />} title="No permissions match">Try a different search or area.</EmptyState> : groups.map((g) => {
          const settable = g.actions.filter((a) => !lockedReason(a));
          const on = settable.filter((a) => have.has(a.id)).length;
          return (
            <fieldset key={g.id} className="roles-area">
              <legend className="row" style={{ gap: 10 }}>
                <span className="roles-area-title">{g.label}</span>
                <span className="small faint">{g.actions.filter((a) => have.has(a.id)).length} of {g.actions.length}</span>
                {editable && settable.length > 0 && <Checkbox label="Select all" checked={on === settable.length} indeterminate={on > 0 && on < settable.length}
                  onChange={(v) => setD((x) => { const ids = new Set(settable.map((a) => a.id)); const rest = x.permissions.filter((p) => !ids.has(p)); return { ...x, permissions: v ? [...rest, ...ids] : rest }; })} />}
              </legend>
              <ul className="roles-perms">
                {g.actions.map((a) => {
                  const reason = lockedReason(a);
                  return (
                    <li key={a.id} className={changed(a.id) && role.custom ? "changed" : ""}>
                      <Checkbox checked={have.has(a.id)} disabled={!editable || !!reason} onChange={(v) => toggle(a.id, v)} label={a.label} />
                      {role.custom && changed(a.id) && <span className="small roles-diff">{have.has(a.id) ? "Added" : "Removed"}</span>}
                      {editable && reason && <span className="small faint">{reason}</span>}
                    </li>);
                })}
              </ul>
            </fieldset>);
        })}
      </div>
      {editable && (
        <div className="roles-savebar">
          <span className="small muted">{dirty ? "You have unsaved changes." : "All changes saved."}</span>
          <div className="row"><Button disabled={!dirty} onClick={() => setD(initial())}>Discard</Button>
            <Button variant="primary" disabled={!dirty || !d.name.trim() || save.isPending} onClick={() => save.mutate()}>Save role</Button></div>
        </div>)}
      {confirmDelete && (
        <Modal title={`Delete ${role.name}?`} onClose={() => setConfirmDelete(false)} width={440}
          footer={<><Button onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete role</Button></>}>
          <p style={{ marginTop: 0 }}>{role.members > 0
            ? `${role.members} ${role.members === 1 ? "person has" : "people have"} this role. They'll move to ${role.base_label}.`
            : "Nobody has this role."} You can restore it later from “Show deleted roles”.</p>
        </Modal>)}
      {preview && <ViewAsPanel roleKey={role.key} onClose={() => setPreview(false)} />}
    </section>
  );
}

function ViewAsPanel({ roleKey, onClose }: { roleKey: string; onClose: () => void }) {
  const v = useQuery({ queryKey: ["roles", "view-as", roleKey], queryFn: () => api<ViewAs>(`/roles/view-as?role=${encodeURIComponent(roleKey)}`) });
  return (
    <Modal title={v.data ? `Viewing as ${v.data.label}` : "View as"} onClose={onClose} width={640} footer={<Button onClick={onClose}>Close</Button>}>
      {!v.data ? <ListSkeleton rows={4} /> : (
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>A summary of what someone with this role can see and do. You stay signed in as yourself.</p>
          <div className="banner info"><strong>Work orders:</strong>&nbsp;{v.data.work_orders}</div>
          <div className="roles-viewas">
            {v.data.areas.filter((a) => a.can.length + a.cannot.length > 0).map((a) => (
              <div key={a.id} className="roles-viewas-area">
                <h3>{a.label}</h3>
                {a.can.length > 0 && <ul className="roles-can">{a.can.map((x) => <li key={x}>{x}</li>)}</ul>}
                {a.cannot.length > 0 && <ul className="roles-cannot">{a.cannot.map((x) => <li key={x}>{x}</li>)}</ul>}
              </div>))}
          </div>
        </div>)}
    </Modal>
  );
}
