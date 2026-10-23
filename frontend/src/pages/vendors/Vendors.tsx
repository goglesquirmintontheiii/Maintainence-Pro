// Vendors (0.5.0, MP-045, r262–r264): MaintainX list + detail. Vendor types, contacts (who gets purchase orders,
// who is CC'd), linked assets and locations, parts they sell, purchase orders, files and custom vendor fields.
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Building2, Download, FileSpreadsheet, Globe, Mail, MoreHorizontal, Pencil, Phone, Plus, Search, ShoppingCart, Tags, Trash2 } from "lucide-react";
import { api, ApiError, type CustomFieldDef, type ExportItem, type FileItem } from "../../lib/api";
import { useSession } from "../../lib/session";
import { avatarColor, currency, dateTime, show, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, Drawer, Dropdown, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { MultiPicker } from "../../components/pickers";
import { AssetPicker } from "../../components/assetPickers";
import { ColorPicker } from "../../components/ColorPicker";
import { FilesSection } from "../assets/shared";
import { CustomInput } from "../workorders/Form";
import { useLocationList } from "../../lib/assets";
import { PO_TONE, type POStatus } from "../purchasing/types";
import "../purchasing/purchasing.css";

export type AddressValue = { line1?: string; line2?: string; city?: string; region?: string; postal_code?: string; country?: string };
export type Contact = { id: string; name: string; role: string; email: string; phone: string; extension?: string; is_po_contact?: boolean; cc_on_po?: boolean; is_billing?: boolean };
type VType = { id: string; name: string; color: string; vendors?: number };
type VendorRow = {
  id: string; name: string; color: string; description: string; picture_url: string | null; picture_file_id: string | null; website: string; email: string; phone: string;
  address: AddressValue; account_number: string; payment_terms: string; currency: string; custom: Record<string, unknown>; types: VType[]; contacts: Contact[];
  created_at: string; updated_at: string; open_purchase_orders?: number;
};
type VendorDetail = VendorRow & {
  assets: { id: string; name: string }[]; locations: { id: string; name: string }[];
  parts: { id: string; name: string; part_number: string; vendor_part_number: string; unit_cost: string | null; preferred: boolean }[];
  purchase_orders: { id: string; number: string; title: string; status: POStatus; total: string | null; created_at: string }[];
  files: FileItem[]; can: { manage: boolean; delete: boolean };
};

export function useVendorFields() {
  return useQuery({ queryKey: ["custom-fields", "vendor"], queryFn: () => api<{ items: CustomFieldDef[] }>("/custom-fields?entity=vendor"), staleTime: 60_000 });
}
function useVendorTypes() {
  return useQuery({ queryKey: ["vendor-types"], queryFn: () => api<{ items: VType[] }>("/vendor-types"), staleTime: 30_000 });
}

export function OrgAvatar({ name, color, src, lg }: { name: string; color?: string; src?: string | null; lg?: boolean }) {
  if (src) return <img className={"vd-avatar" + (lg ? " lg" : "")} src={src} alt="" />;
  return <span className={"vd-avatar" + (lg ? " lg" : "")} style={{ background: color && color !== "#5d6880" ? color : avatarColor(name) }} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
}

export function addressText(a: AddressValue | undefined): string {
  if (!a) return "";
  return [a.line1, a.line2, [a.city, a.region, a.postal_code].filter(Boolean).join(" "), a.country].filter(Boolean).join("\n");
}

export function VendorsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useSession();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [typeId, setTypeId] = useState("");
  const [creating, setCreating] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const types = useVendorTypes();
  const exportCsv = useMutation({
    mutationFn: () => api<ExportItem>("/vendors/export", { method: "POST", body: {} }),
    onSuccess: () => toast("Export started. It'll be in the Download Center in a moment.", { action: { label: "Open", run: () => nav("/downloads") } }),
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <div className="wo-page">
      <div className={"split wo-split" + (id ? " has-detail" : "")}>
        <div className="split-list">
          <div className="list-tools wo-list-tools">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h1>Vendors</h1>
              <div className="row">
                <Dropdown trigger={(_, t) => <Button icon aria-label="More" onClick={t}><MoreHorizontal size={18} /></Button>} width={240}>
                  {(close) => <>
                    {can("vendors.manage") && <button className="menu-item" onClick={() => { close(); setTypesOpen(true); }}><Tags size={15} />Vendor types</button>}
                    {can("exports.use") && <><button className="menu-item" onClick={() => { close(); exportCsv.mutate(); }}><Download size={15} />Export to CSV</button>
                      <Link className="menu-item" to="/downloads" onClick={close}><FileSpreadsheet size={15} />Download Center</Link></>}
                  </>}
                </Dropdown>
                {can("vendors.manage") && <Button variant="primary" onClick={() => setCreating(true)} aria-label="New Vendor"><Plus size={16} />New</Button>}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <div className="search-in grow"><Search size={15} className="faint" />
                <Input placeholder="Search name, email, contact or account #" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search vendors" /></div>
              {(types.data?.items ?? []).length > 0 && <Select aria-label="Vendor type" value={typeId} onChange={(e) => setTypeId(e.target.value)} style={{ maxWidth: 150 }}>
                <option value="">All types</option>{(types.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}
            </div>
          </div>
          <div className="list" aria-label="Vendors"><VendorList q={search} typeId={typeId} activeId={id} /></div>
        </div>
        <div className="split-detail">
          {id ? <VendorDetailView key={id} id={id} />
            : <EmptyState icon={<Building2 size={28} />} title="Select a vendor">Pick one from the list to see contacts, parts they sell and purchase orders.</EmptyState>}
        </div>
      </div>
      {creating && <VendorForm onClose={() => setCreating(false)} onSaved={(v) => { setCreating(false); nav(`/vendors/${v.id}`); }} />}
      {typesOpen && <TypesDialog onClose={() => setTypesOpen(false)} />}
    </div>
  );
}

function VendorList({ q, typeId, activeId }: { q: string; typeId: string; activeId?: string }) {
  const { can } = useSession();
  const qs = new URLSearchParams(Object.entries({ q, type_id: typeId, per_page: "200" }).filter(([, v]) => v)).toString();
  const list = useQuery({ queryKey: ["vendors", "list", qs], queryFn: () => api<{ items: VendorRow[]; total: number }>(`/vendors?${qs}`), placeholderData: (p) => p });
  if (list.isLoading) return <ListSkeleton />;
  const items = list.data?.items ?? [];
  if (!items.length) return q || typeId ? <EmptyState title="No vendors match">Try another search.</EmptyState>
    : <EmptyState icon={<Building2 size={26} />} title="No vendors yet">{can("vendors.manage") ? "Add the companies you buy parts and services from." : "Vendors your team adds show here."}</EmptyState>;
  return <>
    <div className="small muted" style={{ padding: "6px 16px" }}>{list.data?.total} vendor{list.data?.total === 1 ? "" : "s"}</div>
    {items.map((v) => <Link key={v.id} to={`/vendors/${v.id}`} className={"list-row" + (v.id === activeId ? " active" : "")}>
      <OrgAvatar name={v.name} color={v.color} src={v.picture_url} />
      <span className="grow" style={{ minWidth: 0 }}><span className="t" style={{ display: "block" }}>{v.name}</span>
        <span className="s" style={{ display: "block" }}>{[v.types.map((t) => t.name).join(", "), v.contacts[0]?.name, v.open_purchase_orders ? `${v.open_purchase_orders} open PO${v.open_purchase_orders === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || v.email || " "}</span></span>
    </Link>)}
  </>;
}

function VendorDetailView({ id }: { id: string }) {
  const v = useQuery({ queryKey: ["vendor", id], queryFn: () => api<VendorDetail>(`/vendors/${id}`) });
  const qc = useQueryClient();
  const nav = useNavigate();
  const { session, can } = useSession();
  const { toast } = useToast();
  const fields = useVendorFields();
  const [editing, setEditing] = useState(false);
  const [contact, setContact] = useState<Contact | "new" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["vendor", id] }); qc.invalidateQueries({ queryKey: ["vendors"] }); };
  const del = useMutation({ mutationFn: () => api(`/vendors/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); toast("Vendor deleted"); nav("/vendors"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }) });
  if (v.isError) return <EmptyState icon={<Building2 size={28} />} title="Vendor not found">It may have been deleted, or you don't have access.</EmptyState>;
  const d = v.data;
  if (!d) return <div className="detail"><ListSkeleton rows={5} /></div>;
  const cur = d.currency || session.org?.currency;
  const cf = (fields.data?.items ?? []).filter((f) => d.custom[f.id] !== undefined && d.custom[f.id] !== "");
  return (
    <div className="detail">
      <Link to="/vendors" className="row small mobile-only"><ArrowLeft size={14} />All vendors</Link>
      <div className="wo-head">
        <OrgAvatar name={d.name} color={d.color} src={d.picture_url} lg />
        <div className="grow">
          <div className="small muted"><Link to="/vendors">Vendors</Link></div>
          <h1 className="wo-title">{d.name}</h1>
          <div className="vd-chips" style={{ marginTop: 6 }}>{d.types.map((t) => <span key={t.id} className="chip"><span className="sw lg" style={{ background: t.color }} />{t.name}</span>)}</div>
        </div>
        <div className="row">
          {can("po.request") && <Link className="btn" to={`/purchase-orders?new=1&vendor_id=${d.id}`}><ShoppingCart size={15} /><span className="desktop-only">New PO</span></Link>}
          {d.can.manage && <Button icon aria-label="Edit vendor" title="Edit" onClick={() => setEditing(true)}><Pencil size={15} /></Button>}
          {d.can.delete && <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={200}>
            {(close) => <button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirm(true); }}><Trash2 size={15} />Delete</button>}
          </Dropdown>}
        </div>
      </div>
      {d.description && <section className="card card-pad prewrap">{d.description}</section>}
      <dl className="meta-grid card card-pad">
        <div><dt>Email</dt><dd>{d.email ? <a href={`mailto:${d.email}`}>{d.email}</a> : "—"}</dd></div>
        <div><dt>Phone</dt><dd>{d.phone ? <a href={`tel:${d.phone}`}>{d.phone}</a> : "—"}</dd></div>
        <div><dt>Website</dt><dd>{d.website ? <a href={/^https?:/i.test(d.website) ? d.website : `https://${d.website}`} target="_blank" rel="noopener noreferrer">{d.website}</a> : "—"}</dd></div>
        <div><dt>Our account #</dt><dd className="mono">{show(d.account_number)}</dd></div>
        <div><dt>Payment terms</dt><dd>{show(d.payment_terms)}</dd></div>
        <div><dt>Currency</dt><dd>{d.currency || session.org?.currency}</dd></div>
        <div><dt>Address</dt><dd className="prewrap small">{addressText(d.address) || "—"}</dd></div>
        {cf.map((f) => <div key={f.id}><dt>{f.name}</dt><dd>{f.type === "checkbox" ? (d.custom[f.id] ? "Yes" : "No") : f.type === "currency" ? currency(d.custom[f.id], cur) : String(d.custom[f.id])}</dd></div>)}
        <div><dt>Updated</dt><dd className="small">{dateTime(d.updated_at, session.org?.timezone)}</dd></div>
      </dl>

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Contacts</h3>
          {d.can.manage && <Button size="sm" variant="ghost" onClick={() => setContact("new")}><Plus size={14} />Add contact</Button>}</div>
        {d.contacts.length === 0 ? <div className="card-body small faint">No contacts yet. Add who you order from: they get purchase orders when you send them.</div>
          : <div className="contact-grid">{d.contacts.map((c) => <ContactCard key={c.id} c={c} onEdit={d.can.manage ? () => setContact(c) : undefined} />)}</div>}
      </section>

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Purchase orders</h3>
          <Link className="small" to={`/purchase-orders`}>All purchase orders</Link></div>
        {d.purchase_orders.length === 0 ? <div className="card-body small faint">No purchase orders with this vendor yet.</div>
          : d.purchase_orders.map((p) => <Link key={p.id} to={`/purchase-orders/${p.id}`} className="list-row">
            <span className="mono small faint">{p.number}</span><span className="grow t">{p.title}</span>
            {p.total !== null && <span className="small">{currency(p.total, cur)}</span>}
            <Pill tone={PO_TONE[p.status]}>{p.status.replace("_", " ")}</Pill><span className="small faint desktop-only">{timeAgo(p.created_at)}</span></Link>)}
      </section>

      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Parts</h3></div>
        {d.parts.length === 0 ? <div className="card-body small faint">No parts list this vendor yet. Add it as a vendor on a part.</div>
          : d.parts.map((p) => <Link key={p.id} to={`/parts/${p.id}`} className="list-row">
            <span className="grow"><span className="t">{p.name}</span><span className="s">{[p.vendor_part_number && `Vendor # ${p.vendor_part_number}`, p.part_number].filter(Boolean).join(" · ") || " "}</span></span>
            {p.unit_cost !== null && <span className="small">{currency(p.unit_cost, cur)}</span>}
            {p.preferred && <Pill tone="info">Preferred</Pill>}</Link>)}
      </section>

      <dl className="meta-grid card card-pad">
        <div className="span2"><dt>Assets</dt><dd>{d.assets.length ? <span className="vd-chips">{d.assets.map((a) => <Link key={a.id} className="chip" to={`/assets/${a.id}`}>{a.name}</Link>)}</span> : <span className="faint">None</span>}</dd></div>
        <div className="span2"><dt>Locations</dt><dd>{d.locations.length ? <span className="vd-chips">{d.locations.map((l) => <Link key={l.id} className="chip" to={`/locations/${l.id}`}>{l.name}</Link>)}</span> : <span className="faint">None</span>}</dd></div>
      </dl>
      <FilesSection files={d.files} entityType="vendor" entityId={d.id} editable={d.can.manage} queryKey={["vendor", d.id]} role="file" />

      {editing && <VendorForm edit={d} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {contact && <ContactDialog kind="vendor" parentId={d.id} edit={contact === "new" ? undefined : contact} onClose={() => setContact(null)} onDone={() => { setContact(null); refresh(); }} />}
      {confirm && <Modal title="Delete vendor?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button>
        <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>Delete</Button></>}>
        <p>{d.name} will be removed from lists. Purchase orders keep the vendor's name.</p></Modal>}
    </div>
  );
}

export function ContactCard({ c, onEdit }: { c: Contact; onEdit?: () => void }) {
  return (
    <div className="contact-card">
      <div className="row" style={{ gap: 6 }}><b className="grow">{c.name}</b>{onEdit && <Button size="sm" variant="ghost" icon aria-label={`Edit ${c.name}`} onClick={onEdit}><Pencil size={13} /></Button>}</div>
      {c.role && <span className="small muted">{c.role}</span>}
      {c.email && <a className="small row" style={{ gap: 4 }} href={`mailto:${c.email}`}><Mail size={12} />{c.email}</a>}
      {c.phone && <a className="small row" style={{ gap: 4 }} href={`tel:${c.phone}`}><Phone size={12} />{c.phone}{c.extension ? ` ext. ${c.extension}` : ""}</a>}
      <div className="vd-chips">{c.is_po_contact && <Pill tone="info">Gets POs</Pill>}{c.cc_on_po && <Pill>CC on POs</Pill>}{c.is_billing && <Pill tone="info">Billing</Pill>}</div>
    </div>
  );
}

export function ContactDialog({ kind, parentId, edit, onClose, onDone }: { kind: "vendor" | "customer"; parentId: string; edit?: Contact; onClose: () => void; onDone: () => void }) {
  const [c, setC] = useState<Contact>(edit ?? { id: "", name: "", role: "", email: "", phone: "", extension: "", is_po_contact: false, cc_on_po: false, is_billing: false });
  const [err, setErr] = useState("");
  const base = kind === "vendor" ? "vendor-contacts" : "customer-contacts";
  const body = kind === "vendor" ? { name: c.name, role: c.role, email: c.email, phone: c.phone, extension: c.extension, is_po_contact: c.is_po_contact, cc_on_po: c.cc_on_po }
    : { name: c.name, role: c.role, email: c.email, phone: c.phone, is_billing: c.is_billing };
  const save = useMutation({ mutationFn: () => edit ? api(`/${base}/${edit.id}`, { method: "PATCH", body }) : api(`/${kind}s/${parentId}/contacts`, { method: "POST", body }),
    onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  const del = useMutation({ mutationFn: () => api(`/${base}/${edit?.id}`, { method: "DELETE" }), onSuccess: onDone, onError: (e) => setErr((e as ApiError).message) });
  return (
    <Modal title={edit ? "Edit contact" : "Add contact"} onClose={onClose} footer={<>
      {edit && <Button variant="ghost" style={{ marginRight: "auto", color: "var(--c-danger)" }} onClick={() => del.mutate()}><Trash2 size={14} />Remove</Button>}
      <Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!c.name.trim() || save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <Field label="Name">{(id) => <Input id={id} autoFocus value={c.name} maxLength={200} onChange={(e) => setC({ ...c, name: e.target.value })} />}</Field>
      <Field label="Role">{(id) => <Input id={id} value={c.role} maxLength={120} placeholder="e.g. Account manager" onChange={(e) => setC({ ...c, role: e.target.value })} />}</Field>
      <Field label="Email">{(id) => <Input id={id} type="email" value={c.email} maxLength={255} onChange={(e) => setC({ ...c, email: e.target.value })} />}</Field>
      <div className="po-form-grid">
        <Field label="Phone">{(id) => <Input id={id} type="tel" value={c.phone} maxLength={60} onChange={(e) => setC({ ...c, phone: e.target.value })} />}</Field>
        {kind === "vendor" && <Field label="Extension">{(id) => <Input id={id} value={c.extension ?? ""} maxLength={20} onChange={(e) => setC({ ...c, extension: e.target.value })} />}</Field>}
      </div>
      {kind === "vendor" ? <>
        <Checkbox checked={!!c.is_po_contact} onChange={(v) => setC({ ...c, is_po_contact: v })} label="Send purchase orders to this contact" />
        <Checkbox checked={!!c.cc_on_po} onChange={(v) => setC({ ...c, cc_on_po: v })} label="CC this contact on purchase orders" />
      </> : <Checkbox checked={!!c.is_billing} onChange={(v) => setC({ ...c, is_billing: v })} label="Billing contact" />}
      {err && <div className="banner warning" role="alert">{err}</div>}
    </Modal>
  );
}

export function AddressFields({ value, onChange }: { value: AddressValue; onChange: (v: AddressValue) => void }) {
  const set = (k: keyof AddressValue) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="po-form-grid">
      <Field label="Street">{(id) => <Input id={id} value={value.line1 ?? ""} maxLength={200} onChange={set("line1")} />}</Field>
      <Field label="Line 2">{(id) => <Input id={id} value={value.line2 ?? ""} maxLength={200} onChange={set("line2")} />}</Field>
      <Field label="City">{(id) => <Input id={id} value={value.city ?? ""} maxLength={120} onChange={set("city")} />}</Field>
      <Field label="State / region">{(id) => <Input id={id} value={value.region ?? ""} maxLength={120} onChange={set("region")} />}</Field>
      <Field label="Postal code">{(id) => <Input id={id} value={value.postal_code ?? ""} maxLength={20} onChange={set("postal_code")} />}</Field>
      <Field label="Country">{(id) => <Input id={id} value={value.country ?? ""} maxLength={2} placeholder="US" onChange={set("country")} />}</Field>
    </div>
  );
}

function VendorForm({ edit, onClose, onSaved }: { edit?: VendorDetail; onClose: () => void; onSaved: (v: VendorDetail) => void }) {
  const types = useVendorTypes();
  const fields = useVendorFields();
  const locs = useLocationList();
  const [f, setF] = useState(() => ({
    name: edit?.name ?? "", color: edit?.color ?? "#5d6880", description: edit?.description ?? "", email: edit?.email ?? "", phone: edit?.phone ?? "",
    website: edit?.website ?? "", account_number: edit?.account_number ?? "", payment_terms: edit?.payment_terms ?? "", currency: edit?.currency ?? "",
    address: edit?.address ?? {}, type_ids: edit?.types.map((t) => t.id) ?? [], asset_ids: edit?.assets.map((a) => a.id) ?? [],
    location_ids: edit?.locations.map((l) => l.id) ?? [], custom: { ...(edit?.custom ?? {}) } as Record<string, unknown>,
  }));
  const [err, setErr] = useState("");
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const locOpts = useMemo(() => (locs.data?.items ?? []).map((l) => ({ key: l.id, label: l.name })), [locs.data]);
  const save = useMutation({
    mutationFn: () => edit ? api<VendorDetail>(`/vendors/${edit.id}`, { method: "PATCH", body: f }) : api<VendorDetail>("/vendors", { method: "POST", body: f }),
    onSuccess: onSaved, onError: (e) => setErr((e as ApiError).message),
  });
  return (
    <Drawer title={edit ? `Edit ${edit.name}` : "New Vendor"} onClose={onClose} width={620}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || save.isPending} onClick={() => save.mutate()}>{edit ? "Save" : "Create"}</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10, alignItems: "flex-end" }}>
          <Field label="Name" className="grow">{(id) => <Input id={id} autoFocus value={f.name} maxLength={255} onChange={(e) => set({ name: e.target.value })} />}</Field>
          <ColorPicker value={f.color} onChange={(c) => set({ color: c })} />
        </div>
        <Field label="Vendor types">{(id) => <MultiPicker id={id} label="Vendor types" placeholder="Add types" value={f.type_ids} onChange={(v) => set({ type_ids: v })}
          options={(types.data?.items ?? []).map((t) => ({ key: t.id, label: t.name, icon: <span className="sw lg" style={{ background: t.color }} /> }))} />}</Field>
        <Field label="Description">{(id) => <textarea id={id} className="input" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
        <div className="po-form-grid">
          <Field label="Email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} />}</Field>
          <Field label="Phone">{(id) => <Input id={id} type="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />}</Field>
          <Field label="Website">{(id) => <div className="search-in"><Globe size={14} className="faint" /><Input id={id} value={f.website} onChange={(e) => set({ website: e.target.value })} /></div>}</Field>
          <Field label="Our account #" hint="Your customer number with them">{(id) => <Input id={id} value={f.account_number} onChange={(e) => set({ account_number: e.target.value })} />}</Field>
          <Field label="Payment terms">{(id) => <Input id={id} value={f.payment_terms} placeholder="Net 30" onChange={(e) => set({ payment_terms: e.target.value })} />}</Field>
          <Field label="Currency" hint="Empty: your organization's">{(id) => <Input id={id} value={f.currency} maxLength={3} placeholder="USD" onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />}</Field>
        </div>
        <h3 className="sec-h">Address</h3>
        <AddressFields value={f.address} onChange={(a) => set({ address: a })} />
        <Field label="Assets they service or supply">{(id) => <AssetPicker id={id} multi value={f.asset_ids} onChange={(v) => set({ asset_ids: v })} placeholder="Add assets" />}</Field>
        <Field label="Locations">{(id) => <MultiPicker id={id} label="Locations" placeholder="Add locations" value={f.location_ids} onChange={(v) => set({ location_ids: v })} options={locOpts} />}</Field>
        {(fields.data?.items ?? []).map((d) => <Field key={d.id} label={d.name + (d.required ? " *" : "")}>{() => <CustomInput def={d} value={f.custom[d.id]} onChange={(v) => set({ custom: { ...f.custom, [d.id]: v } })} />}</Field>)}
        {err && <div className="banner warning" role="alert">{err}</div>}
      </div>
    </Drawer>
  );
}

function TypesDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const types = useVendorTypes();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const done = () => { qc.invalidateQueries({ queryKey: ["vendor-types"] }); qc.invalidateQueries({ queryKey: ["vendors"] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const add = useMutation({ mutationFn: () => api("/vendor-types", { method: "POST", body: { name, color } }), onSuccess: () => { setName(""); done(); }, onError: err });
  const patch = useMutation({ mutationFn: (t: VType) => api(`/vendor-types/${t.id}`, { method: "PATCH", body: { name: t.name, color: t.color } }), onSuccess: done, onError: err });
  const del = useMutation({ mutationFn: (t: VType) => api(`/vendor-types/${t.id}`, { method: "DELETE" }), onSuccess: done, onError: err });
  return (
    <Modal title="Vendor types" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="small muted">Group vendors (parts supplier, contractor, service provider…) to filter the list.</p>
      {(types.data?.items ?? []).map((t) => <div key={t.id} className="row" style={{ gap: 8, marginBottom: 6 }}>
        <ColorPicker value={t.color} onChange={(c) => patch.mutate({ ...t, color: c })} size="sm" />
        <Input aria-label="Type name" defaultValue={t.name} className="grow" onBlur={(e) => { if (e.target.value.trim() && e.target.value !== t.name) patch.mutate({ ...t, name: e.target.value }); }} />
        <span className="small faint">{t.vendors ?? 0}</span>
        <Button size="sm" variant="ghost" icon aria-label={`Delete ${t.name}`} onClick={() => del.mutate(t)}><Trash2 size={14} /></Button>
      </div>)}
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <ColorPicker value={color} onChange={setColor} size="sm" />
        <Input aria-label="New type" placeholder="New type" value={name} maxLength={80} className="grow" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) add.mutate(); }} />
        <Button size="sm" disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}><Plus size={14} />Add</Button>
      </div>
    </Modal>
  );
}
