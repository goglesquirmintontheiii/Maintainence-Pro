// Share a work order outside the organization (0.5.0: r058–r060, r088) and email its PDF to vendors (r094).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Mail, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiError, type WorkOrder } from "../../lib/api";
import { absoluteUrl, copyText } from "../../lib/wo";
import { dateTime, timeAgo } from "../../lib/format";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Button, Field, Input, Modal, Pill, Select } from "../../components/ui";

type Access = "hidden" | "view" | "interact";
type FieldInfo = { id: string; label: string; default: Access; interactive: boolean };
export type Share = {
  id: string; status: "active" | "disabled"; fields: Record<string, Access>; vendor_id: string | null; recipients: string[]; message: string;
  last_viewed_at: string | null; finished_at: string | null; finished_by_name: string; created_at: string; created_by: { id: string; name: string } | null;
  token?: string; path?: string;
};
type VendorLite = { id: string; name: string; color: string };
type Contact = { id: string; name: string; email: string; is_po_contact?: boolean };

const ACCESS_LABEL: Record<Access, string> = { hidden: "Hidden", view: "Can view", interact: "Can view and interact" };

function useVendorContacts(vendorId: string) {
  return useQuery({
    queryKey: ["vendor", vendorId, "contacts"], enabled: !!vendorId,
    queryFn: async () => (await api<{ contacts: Contact[] }>(`/vendors/${vendorId}`)).contacts.filter((c) => c.email),
  });
}

/** Vendor + contacts + free email addresses: who receives the email. */
function Recipients({ vendors, vendorId, setVendorId, contactIds, setContactIds, emails, setEmails }: {
  vendors: VendorLite[]; vendorId: string; setVendorId: (v: string) => void; contactIds: string[]; setContactIds: (v: string[]) => void; emails: string; setEmails: (v: string) => void;
}) {
  const contacts = useVendorContacts(vendorId);
  return <>
    {vendors.length > 0 && <Field label="Vendor">{(id) => (
      <Select id={id} value={vendorId} onChange={(e) => { setVendorId(e.target.value); setContactIds([]); }}>
        <option value="">None</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </Select>)}</Field>}
    {vendorId && <Field label="Send to contacts" hint={contacts.data && !contacts.data.length ? "This vendor has no contacts with an email address." : undefined}>{() => (
      <div className="stack" style={{ gap: 4 }}>
        {(contacts.data ?? []).map((c) => <label key={c.id} className="check small"><input type="checkbox" checked={contactIds.includes(c.id)}
          onChange={(e) => setContactIds(e.target.checked ? [...contactIds, c.id] : contactIds.filter((x) => x !== c.id))} /><span>{c.name} <span className="muted">{c.email}</span></span></label>)}
      </div>)}</Field>}
    <Field label="Other email addresses" hint="Separate addresses with commas.">{(id) => <Input id={id} type="text" inputMode="email" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="name@example.com" />}</Field>
  </>;
}

const splitEmails = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

function FieldAccess({ fields, value, onChange }: { fields: FieldInfo[]; value: Record<string, Access>; onChange: (v: Record<string, Access>) => void }) {
  return (
    <table className="table small ext-access">
      <thead><tr><th>Field</th><th>Access</th></tr></thead>
      <tbody>{fields.map((f) => (
        <tr key={f.id}><td>{f.label}</td><td>
          <Select aria-label={`${f.label} access`} value={value[f.id] ?? f.default} style={{ height: 30 }} onChange={(e) => onChange({ ...value, [f.id]: e.target.value as Access })}>
            {(["hidden", "view", ...(f.interactive ? ["interact"] : [])] as Access[]).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
          </Select></td></tr>))}
      </tbody>
    </table>
  );
}

/** "Share outside" dialog: list links, make a new one (shown once), disable/enable, reset, remove. */
export function ExternalShareDialog({ wo, vendors, onClose }: { wo: WorkOrder; vendors: VendorLite[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { session } = useSession();
  const tz = session.org?.timezone;
  const fieldsQ = useQuery({ queryKey: ["external-fields"], queryFn: () => api<{ fields: FieldInfo[] }>("/external-shares/fields"), staleTime: Infinity });
  const sharesQ = useQuery({ queryKey: ["work-order", wo.id, "external-shares"], queryFn: () => api<{ items: Share[] }>(`/work-orders/${wo.id}/external-shares`) });
  const [creating, setCreating] = useState(false);
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [vendorId, setVendorId] = useState(wo.vendors?.[0]?.id ?? "");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [emails, setEmails] = useState("");
  const [message, setMessage] = useState("");
  const [fresh, setFresh] = useState<Share | null>(null); // the link, shown once
  const [editing, setEditing] = useState<Share | null>(null);
  const done = wo.status === "done" || wo.status === "canceled";
  const refresh = () => { qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["work-orders"] }); };
  const fail = (e: unknown) => toast((e as ApiError).message, { kind: "error" });

  const create = useMutation({
    mutationFn: () => api<Share>(`/work-orders/${wo.id}/external-shares`, { method: "POST", body: { fields: access, vendor_id: vendorId || null, contact_ids: contactIds, emails: splitEmails(emails), message } }),
    onSuccess: (s) => { setFresh(s); setCreating(false); refresh(); toast(s.recipients.length ? `Link emailed to ${s.recipients.join(", ")}` : "Link created"); },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ s, body }: { s: Share; body: Record<string, unknown> }) => api<Share>(`/work-orders/${wo.id}/external-shares/${s.id}`, { method: "PATCH", body }),
    onSuccess: () => { refresh(); setEditing(null); }, onError: fail,
  });
  const reset = useMutation({
    mutationFn: (s: Share) => api<Share>(`/work-orders/${wo.id}/external-shares/${s.id}/reset`, { method: "POST" }),
    onSuccess: (s) => { setFresh(s); refresh(); toast("The old link no longer works. Here's the new one."); }, onError: fail,
  });
  const remove = useMutation({
    mutationFn: (s: Share) => api(`/work-orders/${wo.id}/external-shares/${s.id}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); toast("Link removed"); }, onError: fail,
  });
  const fields = fieldsQ.data?.fields ?? [];
  const items = sharesQ.data?.items ?? [];

  return (
    <Modal title={`Share #${wo.number} outside your organization`} width={640} onClose={onClose}
      footer={creating
        ? <><Button onClick={() => setCreating(false)}>Back</Button><Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>{splitEmails(emails).length || contactIds.length ? "Create and email link" : "Create link"}</Button></>
        : <Button onClick={onClose}>Close</Button>}>
      {fresh?.path && <div className="banner info stack" style={{ alignItems: "stretch" }}>
        <div><b>Copy this link now.</b> For security it's shown only once; if you lose it, reset the link to get a new one.</div>
        <div className="row"><Input readOnly value={absoluteUrl(fresh.path)} onFocus={(e) => e.currentTarget.select()} aria-label="Link" />
          <Button onClick={async () => toast((await copyText(absoluteUrl(fresh.path!))) ? "Link copied" : "Couldn't copy the link")}><Copy size={14} />Copy</Button></div>
      </div>}
      {creating ? <div className="stack">
        <p className="small muted">Anyone with the link can see what you allow below, without an account. It turns off by itself when the work order is Done.</p>
        <FieldAccess fields={fields} value={access} onChange={setAccess} />
        <Recipients vendors={vendors} vendorId={vendorId} setVendorId={setVendorId} contactIds={contactIds} setContactIds={setContactIds} emails={emails} setEmails={setEmails} />
        <Field label="Message (optional)">{(id) => <textarea id={id} className="textarea" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
      </div> : <div className="stack">
        {done && <div className="banner warning">This work order is {wo.status === "done" ? "Done" : "canceled"}, so its links are off. Reopen it to share again.</div>}
        {!items.length && !sharesQ.isLoading && <p className="muted">No links yet. Make one to let a vendor or contractor see the work, fill in procedures, comment and add photos without an account.</p>}
        {items.map((s) => (
          <div key={s.id} className="card card-pad stack" style={{ gap: 6 }}>
            <div className="row wrap">
              <Pill tone={s.status === "active" ? "success" : "neutral"}>{s.status === "active" ? "Active" : "Off"}</Pill>
              {s.finished_at && <Pill tone="info">Finished by {s.finished_by_name}</Pill>}
              <span className="small muted grow">Made {timeAgo(s.created_at)}{s.created_by && ` by ${s.created_by.name}`}{s.recipients.length > 0 && ` · sent to ${s.recipients.join(", ")}`}</span>
            </div>
            <div className="small muted">{s.last_viewed_at ? `Last opened ${dateTime(s.last_viewed_at, tz)}` : "Not opened yet"}</div>
            <div className="row wrap">
              <Button size="sm" onClick={() => setEditing(s)}>Field access</Button>
              <Button size="sm" disabled={patch.isPending || (done && s.status !== "active")} onClick={() => patch.mutate({ s, body: { status: s.status === "active" ? "disabled" : "active" } })}>{s.status === "active" ? "Turn off" : "Turn on"}</Button>
              <Button size="sm" disabled={reset.isPending || done} onClick={() => reset.mutate(s)} title="The old link stops working and you get a new one"><RefreshCw size={13} />Reset link</Button>
              <Button size="sm" variant="ghost" style={{ color: "var(--c-danger)" }} disabled={remove.isPending} onClick={() => remove.mutate(s)}><Trash2 size={13} />Remove</Button>
            </div>
          </div>))}
        {!done && <div><Button variant="primary" onClick={() => { setFresh(null); setAccess({}); setCreating(true); }}><Plus size={14} />New link</Button></div>}
      </div>}
      {editing && <Modal title="Field access" onClose={() => setEditing(null)}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" disabled={patch.isPending} onClick={() => patch.mutate({ s: editing, body: { fields: editing.fields } })}>Save</Button></>}>
        <FieldAccess fields={fields} value={editing.fields} onChange={(v) => setEditing({ ...editing, fields: v })} />
      </Modal>}
    </Modal>
  );
}

/** r094: email the work order PDF to vendors with a message. */
export function EmailPdfDialog({ wo, vendors, onClose }: { wo: WorkOrder; vendors: VendorLite[]; onClose: () => void }) {
  const { toast } = useToast();
  const [vendorId, setVendorId] = useState(wo.vendors?.[0]?.id ?? "");
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [emails, setEmails] = useState("");
  const [message, setMessage] = useState("");
  const send = useMutation({
    mutationFn: () => api<{ sent_to: string[] }>(`/work-orders/${wo.id}/email-pdf`, { method: "POST", body: {
      vendor_ids: vendorId && !contactIds.length ? [vendorId] : [], contact_ids: contactIds, emails: splitEmails(emails), message } }),
    onSuccess: (r) => { toast(`PDF sent to ${r.sent_to.join(", ")}`); onClose(); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <Modal title={`Email #${wo.number} as a PDF`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={send.isPending} onClick={() => send.mutate()}><Mail size={14} />Send</Button></>}>
      <div className="stack">
        <Recipients vendors={vendors} vendorId={vendorId} setVendorId={setVendorId} contactIds={contactIds} setContactIds={setContactIds} emails={emails} setEmails={setEmails} />
        {vendorId && !contactIds.length && <p className="small muted">With no contacts picked, it goes to the vendor's purchase order contacts (or all its contacts).</p>}
        <Field label="Message">{(id) => <textarea id={id} className="textarea" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Please quote for this job…" />}</Field>
      </div>
    </Modal>
  );
}
