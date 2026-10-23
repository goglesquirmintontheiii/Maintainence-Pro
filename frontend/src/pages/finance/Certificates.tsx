// Tax exemption certificates (MP-090): scans stored encrypted, reminders 60/30/7 days before expiry, a vendor
// registry with "Send certificate to vendor" (scan attached; re-sent automatically on renewal), an access log, the
// exempt-purchases report, and the mobile exemption card — shown to the people named on it, watermarked
// "For <org> employees only", and kept on the phone so it works offline.
import { useEffect, useState } from "react";
import { DropZone } from "../../components/DropZone";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BadgeCheck, CreditCard, FileUp, Plus, RefreshCw, Send, ShieldCheck, Trash2, WifiOff } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Checkbox, EmptyState, Field, Input, ListSkeleton, Modal, Pill, Select } from "../../components/ui";
import { useVendors } from "./VendorInvoices";
import { CERT_TYPES, day, postForm, type Certificate, type ExemptionCard, type FinanceMe, type Paged, type RegistryRow } from "./types";

type UserLite = { id: string; name: string; email: string };
const useMembers = () => useQuery({ queryKey: ["users", "lite"], staleTime: 60_000, queryFn: () => api<{ items: UserLite[] }>("/users?per_page=500") });
const REG: Record<RegistryRow["status"], [string, "neutral" | "info" | "success" | "warning" | "danger"]> = {
  not_sent: ["Not sent", "neutral"], sent: ["Sent", "info"], on_file: ["On file", "success"], rejected: ["Rejected", "danger"],
};

export function CertificatesTab({ me, id }: { me: FinanceMe; id?: string }) {
  const manage = me.can["finance.tax_certificates"];
  const [status, setStatus] = useState("active");
  const [adding, setAdding] = useState(false);
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const list = useQuery({ queryKey: ["finance", "certificates", status], queryFn: () => api<Paged<Certificate>>(`/finance/tax-certificates?status=${status}&per_page=200`) });
  if (!manage) {
    // people named on a card: just their cards, phone-first
    return <div className="fin-cards-only">{id ? <ExemptionCardView id={id} onBack={() => nav("/finance/certificates")} />
      : <div className="stack" style={{ padding: "var(--s-4)" }}><h1>Exemption cards</h1>
        {list.isLoading ? <ListSkeleton rows={2} /> : !list.data?.items.length ? <EmptyState title="No cards">Nobody has shared an exemption card with you.</EmptyState>
          : list.data.items.map((c) => <Link key={c.id} className="card card-pad row" to={`/finance/certificates/${c.id}`}><CreditCard size={20} />
            <div className="grow"><div className="t">{c.type_name} · {c.jurisdiction}</div><div className="faint fin-small">Expires {day(c.expires_on)}</div></div></Link>)}</div>}</div>;
  }
  return (
    <div className={"split fin-split" + (id ? " has-detail" : "")}>
      <div className="split-list">
        <div className="list-tools">
          <div className="row" style={{ justifyContent: "space-between" }}><h1>Tax certificates</h1>
            <Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} />New</Button></div>
          <div className="seg fin-seg" role="tablist" aria-label="Status">
            {[["active", "Active"], ["retired", "Retired"], ["", "All"]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={status === k}
              className={"seg-btn" + (status === k ? " on" : "")} onClick={() => setStatus(k)}>{l}</button>)}
          </div>
        </div>
        <div className="list" aria-label="Certificates">
          {list.isLoading ? <ListSkeleton /> : !list.data?.items.length ? <EmptyState icon={<ShieldCheck size={28} />} title="No certificates">
            Add your resale or exemption certificates; vendors get them by email, and purchase orders are marked tax-exempt.</EmptyState>
            : list.data.items.map((c) => (
              <Link key={c.id} to={`/finance/certificates/${c.id}`} className={"list-row" + (c.id === id ? " active" : "")}>
                <ShieldCheck size={18} className={c.valid ? "fin-ok" : "faint"} />
                <div className="grow"><div className="t">{c.type_name} · {c.jurisdiction}</div>
                  <div className="s">{c.number || "No number"}{c.customer_id ? " · customer's certificate" : ""}</div>
                  <div className="row wrap fin-pills"><ExpiryPill c={c} /></div></div>
              </Link>))}
        </div>
      </div>
      <div className="split-detail">{!id ? <EmptyState title="Pick a certificate" />
        : sp.get("card") === "1" ? <ExemptionCardView id={id} onBack={() => nav(`/finance/certificates/${id}`)} />
        : <CertificateDetail id={id} onBack={() => nav("/finance/certificates")} />}</div>
      {adding && <CertForm onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); nav(`/finance/certificates/${c.id}`); }} />}
    </div>
  );
}

function ExpiryPill({ c }: { c: Certificate }) {
  if (c.status === "retired") return <Pill>Retired</Pill>;
  if (c.days_left === null) return <Pill tone="success">No expiry</Pill>;
  if (c.days_left < 0) return <Pill tone="danger">Expired</Pill>;
  if (c.days_left <= 60) return <Pill tone="warning">Expires in {c.days_left} day{c.days_left === 1 ? "" : "s"}</Pill>;
  return <Pill tone="success">Valid until {day(c.expires_on)}</Pill>;
}

function CertForm({ edit, renew, onClose, onSaved }: { edit?: Certificate; renew?: Certificate; onClose: () => void; onSaved: (c: Certificate) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const members = useMembers();
  const base = edit ?? renew;
  const [f, setF] = useState({ type: base?.type ?? "resale", type_label: base?.type_label ?? "", country: base?.country ?? "US", region: base?.region ?? "",
    multistate_form: base?.multistate_form ?? "", covered_regions: (base?.covered_regions ?? []).join(", "), number: base?.number ?? "",
    legal_entity: base?.legal_entity ?? "", issued_on: renew ? "" : base?.issued_on ?? "", expires_on: renew ? "" : base?.expires_on ?? "",
    scope_notes: base?.scope_notes ?? "" });
  const [cardUsers, setCardUsers] = useState<string[]>(base?.card_user_ids ?? []);
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { ...f, covered_regions: f.covered_regions.split(/[,\s]+/).filter(Boolean), card_user_ids: cardUsers };
      if (renew) return api<Certificate>(`/finance/tax-certificates/${renew.id}/renew`, { method: "POST", body });
      return edit ? api<Certificate>(`/finance/tax-certificates/${edit.id}`, { method: "PATCH", body }) : api<Certificate>("/finance/tax-certificates", { method: "POST", body });
    },
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ["finance"] }); toast(renew ? "Renewed. Add the new scan; vendors get it automatically." : "Saved"); onSaved(c); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal title={renew ? "Renew certificate" : edit ? "Edit certificate" : "New tax certificate"} onClose={onClose} width={640}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="stack">
        <div className="fin-form-grid">
          {!renew && <Field label="Type">{(fid) => <Select id={fid} value={f.type} onChange={set("type")}>{CERT_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>}
          {f.type === "custom" && !renew && <Field label="Name">{(fid) => <Input id={fid} value={f.type_label} onChange={set("type_label")} />}</Field>}
          {!renew && <Field label="Country">{(fid) => <Input id={fid} value={f.country} onChange={set("country")} maxLength={40} />}</Field>}
          {!renew && <Field label="Multistate form">{(fid) => <Select id={fid} value={f.multistate_form} onChange={set("multistate_form")}>
            <option value="">None (one state / province)</option><option value="sst">Streamlined Sales Tax (SST)</option><option value="mtc">Multistate Tax Commission (MTC)</option></Select>}</Field>}
          {!renew && (f.multistate_form
            ? <Field label="States covered" hint="e.g. IN, KY, OH">{(fid) => <Input id={fid} value={f.covered_regions} onChange={set("covered_regions")} />}</Field>
            : <Field label="State / province">{(fid) => <Input id={fid} value={f.region} onChange={set("region")} />}</Field>)}
          <Field label="Certificate number">{(fid) => <Input id={fid} value={f.number} onChange={set("number")} />}</Field>
          {!renew && <Field label="Legal entity">{(fid) => <Input id={fid} value={f.legal_entity} onChange={set("legal_entity")} />}</Field>}
          <Field label="Issued">{(fid) => <Input id={fid} type="date" value={f.issued_on} onChange={set("issued_on")} />}</Field>
          <Field label="Expires">{(fid) => <Input id={fid} type="date" value={f.expires_on} onChange={set("expires_on")} required={!!renew} />}</Field>
        </div>
        {!renew && <Field label="What it covers (notes)">{(fid) => <textarea id={fid} className="input" rows={2} value={f.scope_notes} onChange={set("scope_notes")} />}</Field>}
        {!renew && <div className="stack fin-tight"><span className="fin-label">Who can show the exemption card on their phone</span>
          <div className="fin-chips">{members.data?.items.map((u) => <button key={u.id} type="button" className={"fin-chip" + (cardUsers.includes(u.id) ? " on" : "")}
            onClick={() => setCardUsers((x) => x.includes(u.id) ? x.filter((y) => y !== u.id) : [...x, u.id])}>{u.name}</button>)}</div></div>}
      </div>
    </Modal>
  );
}

function CertificateDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["finance", "certificate", id], queryFn: () => api<Certificate>(`/finance/tax-certificates/${id}`) });
  const vendors = useVendors();
  const [edit, setEdit] = useState(false);
  const [renew, setRenew] = useState(false);
  const [addVendor, setAddVendor] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["finance", "certificate", id] }); void qc.invalidateQueries({ queryKey: ["finance", "certificates"] }); };
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const upload = useMutation({ mutationFn: ({ file, role }: { file: File; role: string }) => postForm<Certificate & { resent: number }>(`/finance/tax-certificates/${id}/files`, { file, role }),
    onSuccess: (r) => { refresh(); toast(r.resent ? `Saved (encrypted) and sent to ${r.resent} vendor${r.resent > 1 ? "s" : ""}` : "Saved (encrypted)"); }, onError: err });
  const reg = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/finance/tax-certificates/${id}/vendors`, { method: "PUT", body }), onSuccess: refresh, onError: err });
  const unreg = useMutation({ mutationFn: (vid: string) => api(`/finance/tax-certificates/${id}/vendors/${vid}`, { method: "DELETE" }), onSuccess: refresh, onError: err });
  const send = useMutation({ mutationFn: (vid: string) => api(`/finance/tax-certificates/${id}/send`, { method: "POST", body: { vendor_id: vid } }),
    onSuccess: () => { refresh(); toast("Sent"); }, onError: err });
  const act = useMutation({ mutationFn: (path: string) => api(`/finance/tax-certificates/${id}/${path}`, { method: "POST", body: {} }), onSuccess: refresh, onError: err });
  const del = useMutation({ mutationFn: () => api(`/finance/tax-certificates/${id}`, { method: "DELETE" }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["finance"] }); onBack(); }, onError: err });
  const c = q.data;
  if (q.isLoading) return <div className="detail"><ListSkeleton rows={4} /></div>;
  if (!c) return <div className="detail"><EmptyState title="Certificate not found" /></div>;
  const pick = (role: string) => (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (file) upload.mutate({ file, role }); e.target.value = ""; };
  return (
    <div className="detail fin-detail">
      <div className="detail-head">
        <Button icon className="fin-back" aria-label="Back" onClick={onBack}><ArrowLeft size={18} /></Button>
        <div className="grow"><h2>{c.type_name} · {c.jurisdiction}</h2><div className="muted fin-small">{c.number || "No number"}{c.legal_entity ? ` · ${c.legal_entity}` : ""}</div></div>
        <ExpiryPill c={c} />
      </div>
      {c.renewed_by_id && <div className="fin-banner">Renewed — <Link to={`/finance/certificates/${c.renewed_by_id}`}>open the new certificate</Link>.</div>}
      <div className="row wrap fin-actions">
        {c.status === "active" && <><Button onClick={() => setEdit(true)}>Edit</Button><Button variant="primary" onClick={() => setRenew(true)}><RefreshCw size={15} />Renew</Button>
          {c.card_user_ids.length > 0 && <Button onClick={() => nav(`/finance/certificates/${c.id}?card=1`)}><CreditCard size={15} />Show card</Button>}
          <Button variant="ghost" onClick={() => { if (confirm("Retire this certificate? It stops covering purchases.")) act.mutate("retire"); }}>Retire</Button></>}
        <Button icon variant="ghost" aria-label="Delete" onClick={() => { if (confirm("Delete this certificate?")) del.mutate(); }}><Trash2 size={16} /></Button>
      </div>
      <DropZone className="card" accept="application/pdf,image/*" multiple={false} label="Drop a scan to add it" onFiles={(fs) => upload.mutate({ file: fs[0], role: "file" })}>
      <section className="card-pad stack">
        <div className="row"><h3 className="sec-h grow">Scans</h3>
          <label className="btn sm"><FileUp size={14} />Add scan<input type="file" accept="application/pdf,image/*" hidden onChange={pick("file")} /></label>
          <label className="btn sm"><CreditCard size={14} />{c.has_card ? "Replace" : "Add"} card picture<input type="file" accept="image/*" hidden onChange={pick("card")} /></label></div>
        {(c.files ?? []).length ? (c.files ?? []).map((f) => <a key={f.id} className="row fin-small" href={`/api/v1/finance/tax-certificates/${c.id}/files/${f.id}`} target="_blank" rel="noreferrer">
          <FileUp size={14} />{f.name}</a>) : <p className="muted">No scan yet. Scans are encrypted at rest and every view is logged.</p>}
      </section>
      </DropZone>
      <section className="card card-pad stack">
        <h3 className="sec-h">Vendors</h3>
        {(c.vendors ?? []).map((v) => { const [l, t] = REG[v.status]; return (
          <div key={v.id} className="row wrap fin-reg">
            <span className="grow">{v.vendor?.name}{v.sent_at ? <span className="faint fin-small"> · sent {day(v.sent_at)}{v.sent_to ? ` to ${v.sent_to}` : ""}</span> : null}</span>
            <Pill tone={t}>{l}</Pill>
            <Select value={v.status} aria-label="Status" onChange={(e) => reg.mutate({ vendor_id: v.vendor?.id, status: e.target.value })}>
              {Object.entries(REG).map(([k, [lbl]]) => <option key={k} value={k}>{lbl}</option>)}</Select>
            <Checkbox checked={v.auto_resend} onChange={(x) => reg.mutate({ vendor_id: v.vendor?.id, auto_resend: x })} label="Re-send on renewal" />
            <Button size="sm" disabled={c.status !== "active"} onClick={() => v.vendor && send.mutate(v.vendor.id)}><Send size={13} />Send</Button>
            <Button icon size="sm" variant="ghost" aria-label="Remove vendor" onClick={() => v.vendor && unreg.mutate(v.vendor.id)}><Trash2 size={13} /></Button>
          </div>); })}
        <div className="row"><Select value={addVendor} onChange={(e) => setAddVendor(e.target.value)} aria-label="Add vendor"><option value="">Add a vendor…</option>
          {vendors.data?.items.filter((v) => !(c.vendors ?? []).some((r) => r.vendor?.id === v.id)).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>
          <Button disabled={!addVendor} onClick={() => { reg.mutate({ vendor_id: addVendor }); setAddVendor(""); }}>Add</Button></div>
        <p className="faint fin-small">Purchase orders to vendors that have it on file (or were sent it) are marked tax-exempt and print the certificate number.</p>
      </section>
      {c.scope_notes && <section className="card card-pad"><h3 className="sec-h">What it covers</h3><p className="prewrap">{c.scope_notes}</p></section>}
      <section className="card card-pad stack fin-tight"><h3 className="sec-h">Access log</h3>
        {(c.access_log ?? []).map((a, i) => <div key={i} className="row fin-small"><span className="grow">{a.user?.name ?? "Someone"} · {a.action.replace("_", " ")}</span><span className="faint">{day(a.at)}</span></div>)}</section>
      {edit && <CertForm edit={c} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); refresh(); }} />}
      {renew && <CertForm renew={c} onClose={() => setRenew(false)} onSaved={(n) => { setRenew(false); refresh(); nav(`/finance/certificates/${n.id}`); }} />}
    </div>
  );
}

// ---- the mobile exemption card -----------------------------------------------------------------------------------
const cacheKey = (id: string) => `mpro.exemption-card.${id}`;

export function ExemptionCardView({ id, onBack }: { id: string; onBack: () => void }) {
  const [card, setCard] = useState<ExemptionCard | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let gone = false;
    api<ExemptionCard>(`/finance/tax-certificates/${id}/card`).then((c) => {
      if (gone) return;
      setCard(c); setOffline(false);
      try { localStorage.setItem(cacheKey(id), JSON.stringify(c)); } catch { /* storage full or blocked */ }
    }).catch((e: ApiError) => {
      if (gone) return;
      if (e.status === 404 || e.status === 403 || e.status === 409) { // no longer allowed or no longer valid: forget it
        try { localStorage.removeItem(cacheKey(id)); } catch { /* blocked */ }
        setError(e.message || "This card isn't available."); return;
      }
      try {
        const raw = localStorage.getItem(cacheKey(id));
        if (raw) { setCard(JSON.parse(raw) as ExemptionCard); setOffline(true); return; }
      } catch { /* blocked */ }
      setError("You're offline and this card hasn't been opened on this phone before.");
    });
    return () => { gone = true; };
  }, [id]);
  const expired = card?.expires_on ? new Date(card.expires_on + "T23:59:59") < new Date() : false;
  return (
    <div className="fin-card-view">
      <div className="row"><Button icon aria-label="Back" onClick={onBack}><ArrowLeft size={18} /></Button><span className="grow" />
        {offline && <Pill tone="warning"><WifiOff size={12} /> Offline copy</Pill>}</div>
      {error ? <EmptyState title="Card not available">{error}</EmptyState> : !card ? <ListSkeleton rows={3} /> : (
        <div className={"fin-excard" + (expired ? " expired" : "")} aria-label="Tax exemption card">
          <div className="fin-excard-wm" aria-hidden>{Array.from({ length: 8 }, (_, i) => <span key={i}>{card.watermark}</span>)}</div>
          <div className="fin-excard-head"><BadgeCheck size={22} /><div className="grow"><div className="fin-excard-org">{card.org_name}</div>
            <div className="fin-excard-type">{card.type} · {card.jurisdiction}</div></div></div>
          {card.image && <img className="fin-excard-img" src={card.image} alt="Certificate" />}
          <dl className="fin-excard-dl">
            <div><dt>Certificate</dt><dd>{card.number || "—"}</dd></div>
            <div><dt>Purchaser</dt><dd>{card.legal_entity || card.org_name}</dd></div>
            <div><dt>Expires</dt><dd>{expired ? "EXPIRED " : ""}{day(card.expires_on)}</dd></div>
          </dl>
          <div className="fin-excard-foot">{card.watermark}</div>
        </div>
      )}
    </div>
  );
}
