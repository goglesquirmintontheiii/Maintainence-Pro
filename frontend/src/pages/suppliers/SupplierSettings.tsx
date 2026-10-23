// 0.5.0 Settings › Supplier connections (MP-084/086/088): supplier APIs, PunchOut catalogs and your own supplier sites.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Pencil, Plug, Plus, Trash2, XCircle } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select, Toggle } from "../../components/ui";
import type { Connection, ConnectorSpec, SupplierSite } from "./types";
import "./suppliers.css";

export function SupplierSettingsPage() {
  const { can } = useSession();
  if (!can("suppliers.connections")) return <EmptyState title="Supplier connections">Only administrators can set up supplier connections.</EmptyState>;
  return <div className="stack" style={{ gap: 20 }}><Connections /><Sites /></div>;
}

function Connections() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["supplier-connections"], queryFn: () => api<{ items: Connection[]; connectors: ConnectorSpec[] }>("/supplier-connections") });
  const [editing, setEditing] = useState<{ spec: ConnectorSpec; conn?: Connection } | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ["supplier-connections"] });
  const test = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; message?: string }>(`/supplier-connections/${id}/test`, { method: "POST" }),
    onSuccess: (r) => { done(); toast(r.message || "Connected"); },
    onError: (e) => { done(); toast((e as ApiError).message, { kind: "error" }); },
  });
  const del = useMutation({ mutationFn: (id: string) => api(`/supplier-connections/${id}`, { method: "DELETE" }), onSuccess: () => { done(); toast("Connection removed"); } });
  const specs = q.data?.connectors ?? [];
  const items = q.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-head"><div><h2 style={{ margin: 0 }}>Supplier connections</h2>
        <p className="small muted" style={{ margin: "4px 0 0" }}>Without a connection, MPro reads the public product page. A connection gives more reliable prices and stock, and PunchOut lets you shop a supplier's catalog and bring the cart back as a purchase order.</p></div></div>
      {q.isLoading ? <ListSkeleton rows={3} /> : <>
        {items.map((c) => {
          const spec = specs.find((s) => s.key === c.connector);
          return <div key={c.id} className="sup-conn">
            <Plug size={18} className="muted" style={{ marginTop: 2 }} />
            <div className="grow">
              <div className="row" style={{ flexWrap: "wrap" }}><strong>{c.name}</strong><span className="small faint">{c.connector_name}</span>
                {!c.enabled && <Pill>Off</Pill>}</div>
              <div className="small" style={{ marginTop: 4 }}>
                {c.last_error ? <span style={{ color: "var(--c-danger)" }}><XCircle size={13} style={{ verticalAlign: -2 }} /> {c.last_error} ({timeAgo(c.last_error_at)})</span>
                  : c.last_success_at ? <span style={{ color: "var(--c-success)" }}><CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> Worked {timeAgo(c.last_success_at)}</span>
                    : <span className="faint">Not tried yet</span>}
              </div>
            </div>
            <Button size="sm" disabled={test.isPending} onClick={() => test.mutate(c.id)}>Test connection</Button>
            {spec && <Button size="sm" variant="ghost" icon aria-label="Edit" onClick={() => setEditing({ spec, conn: c })}><Pencil size={15} /></Button>}
            <Button size="sm" variant="ghost" icon aria-label="Remove" onClick={() => del.mutate(c.id)}><Trash2 size={15} /></Button>
          </div>;
        })}
        <div className="card-body stack" style={{ borderTop: items.length ? "1px solid var(--c-border-soft)" : undefined }}>
          <div className="small muted">Add a connection</div>
          {specs.map((s) => <div key={s.key} className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow"><div className="row"><strong>{s.name}</strong>{s.needs_account && <Pill tone="warning">Needs your account to try</Pill>}</div>
              <div className="small faint">{s.docs}</div></div>
            <Button size="sm" onClick={() => setEditing({ spec: s })}><Plus size={14} />Connect</Button>
          </div>)}
          <div className="small faint">These connections follow the suppliers' published documentation but haven't been tried against a live account yet. Use "Test connection" after you add yours.</div>
        </div>
      </>}
      {editing && <ConnectionDialog spec={editing.spec} conn={editing.conn} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); done(); }} />}
    </section>
  );
}

function ConnectionDialog({ spec, conn, onClose, onSaved }: { spec: ConnectorSpec; conn?: Connection; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(conn?.name ?? spec.name);
  const [supplier, setSupplier] = useState(conn?.supplier_key ?? spec.supplier_key);
  const [enabled, setEnabled] = useState(conn?.enabled ?? true);
  const [settings, setSettings] = useState<Record<string, string>>({ ...(conn?.settings ?? {}) });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const sites = useQuery({ queryKey: ["supplier-sites"], queryFn: () => api<{ items: SupplierSite[]; builtin: SupplierSite[] }>("/supplier-sites"), enabled: spec.kind === "punchout" });
  const save = useMutation({
    mutationFn: () => {
      const body = { connector: spec.key, name, supplier_key: supplier, enabled, settings, secrets };
      return conn ? api(`/supplier-connections/${conn.id}`, { method: "PATCH", body }) : api("/supplier-connections", { method: "POST", body });
    },
    onSuccess: onSaved,
    onError: (e) => setError((e as ApiError).message),
  });
  const readFile = (field: string, f: File | undefined) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); setSecrets((x) => ({ ...x, [field]: s.slice(s.indexOf(",") + 1) })); };
    r.readAsDataURL(f);
  };
  return (
    <Modal title={conn ? `Edit ${spec.name}` : `Connect ${spec.name}`} onClose={onClose} width={540}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="stack">
        <div className="small muted">{spec.docs}</div>
        {error && <div className="small" style={{ color: "var(--c-danger)" }}>{error}</div>}
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        {spec.kind === "punchout" && <Field label="Supplier">{(id) => <Select id={id} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
          <option value="">Choose…</option>
          {[...(sites.data?.items ?? []), ...(sites.data?.builtin ?? [])].map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
        </Select>}</Field>}
        {spec.fields.map((f) => f.secret
          ? <Field key={f.name} label={f.label} hint={conn?.secrets_set[f.name] ? `Saved${conn.secrets_masked[f.name] ? ` (${conn.secrets_masked[f.name]})` : ""}. Leave empty to keep it.` : undefined}>
            {(id) => f.type === "file" ? <Input id={id} type="file" accept=".pfx,.p12" onChange={(e) => readFile(f.name, e.target.files?.[0])} />
              : <Input id={id} type="password" autoComplete="new-password" value={secrets[f.name] ?? ""} onChange={(e) => setSecrets({ ...secrets, [f.name]: e.target.value })} />}</Field>
          : <Field key={f.name} label={f.label}>{(id) => f.type === "select"
            ? <Select id={id} value={settings[f.name] ?? ""} onChange={(e) => setSettings({ ...settings, [f.name]: e.target.value })}><option value="">Choose…</option>
              {(f.options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            : <Input id={id} placeholder={f.placeholder} value={settings[f.name] ?? ""} onChange={(e) => setSettings({ ...settings, [f.name]: e.target.value })} />}</Field>)}
        <Toggle label="Use this connection" checked={enabled} onChange={setEnabled} />
        <div className="small faint">Passwords, secrets and certificates are stored encrypted and are never shown again.</div>
      </div>
    </Modal>
  );
}

function Sites() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["supplier-sites"], queryFn: () => api<{ items: SupplierSite[]; builtin: SupplierSite[] }>("/supplier-sites") });
  const [editing, setEditing] = useState<SupplierSite | "new" | null>(null);
  const del = useMutation({ mutationFn: (id: string) => api(`/supplier-sites/${id}`, { method: "DELETE" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["supplier-sites"] }); toast("Removed"); } });
  return (
    <section className="card">
      <div className="card-head"><div><h2 style={{ margin: 0 }}>Supplier sites</h2>
        <p className="small muted" style={{ margin: "4px 0 0" }}>MPro recognizes links from {q.data?.builtin.length ?? "many"} suppliers. Add your local suppliers so their links show the supplier name and item number.</p></div>
        <Button size="sm" onClick={() => setEditing("new")}><Plus size={14} />Add supplier</Button></div>
      {(q.data?.items ?? []).map((s) => <div key={s.id} className="sup-conn">
        <div className="grow"><strong>{s.name}</strong> <span className="small faint">{s.domains.join(", ")}</span>
          {s.id_patterns.length > 0 && <div className="small muted mono">{s.id_patterns.join("  ")}</div>}</div>
        <Button size="sm" variant="ghost" icon aria-label="Edit" onClick={() => setEditing(s)}><Pencil size={15} /></Button>
        <Button size="sm" variant="ghost" icon aria-label="Remove" onClick={() => del.mutate(s.id)}><Trash2 size={15} /></Button>
      </div>)}
      <details className="card-body small">
        <summary className="muted">Suppliers MPro already knows</summary>
        <p className="faint">{(q.data?.builtin ?? []).map((s) => s.name).join(", ")}</p>
      </details>
      {editing && <SiteDialog site={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["supplier-sites"] }); }} />}
    </section>
  );
}

function SiteDialog({ site, onClose, onSaved }: { site?: SupplierSite; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: site?.name ?? "", domains: (site?.domains ?? []).join(", "), id_patterns: (site?.id_patterns ?? []).join("\n"),
    id_label: site?.id_label ?? "", product_url: site?.product_url ?? "" });
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, domains: f.domains.split(/[\s,]+/).filter(Boolean), id_patterns: f.id_patterns.split("\n").map((x) => x.trim()).filter(Boolean),
        id_label: f.id_label, product_url: f.product_url };
      return site ? api(`/supplier-sites/${site.id}`, { method: "PATCH", body }) : api("/supplier-sites", { method: "POST", body });
    },
    onSuccess: onSaved,
    onError: (e) => setError((e as ApiError).message),
  });
  return (
    <Modal title={site ? "Edit supplier" : "Add a supplier"} onClose={onClose} width={540}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="stack">
        {error && <div className="small" style={{ color: "var(--c-danger)" }}>{error}</div>}
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Web addresses" hint="For example acmesupply.com. Subdomains are included.">{(id) => <Input id={id} value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} />}</Field>
        <Field label="Item number patterns (optional)" hint="One per line. A regular expression with a group named id, for example /item/(?P<id>[0-9]+)">
          {(id) => <textarea id={id} className="input mono" rows={3} value={f.id_patterns} onChange={(e) => setF({ ...f, id_patterns: e.target.value })} />}</Field>
        <div className="pl-grid2">
          <Field label="Item number label">{(id) => <Input id={id} placeholder="Item #" value={f.id_label} onChange={(e) => setF({ ...f, id_label: e.target.value })} />}</Field>
          <Field label="Product page (optional)" hint="Use {id} for the item number.">{(id) => <Input id={id} placeholder="https://acmesupply.com/item/{id}" value={f.product_url} onChange={(e) => setF({ ...f, product_url: e.target.value })} />}</Field>
        </div>
      </div>
    </Modal>
  );
}
