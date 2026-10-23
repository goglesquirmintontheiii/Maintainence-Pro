// Vendors on a work order (0.5.0, r075) with the outside-sharing actions next to them (r058–r060, r094).
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe2, Mail, Pencil, Truck } from "lucide-react";
import { api, ApiError, type WorkOrder } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useWOOptions } from "../../lib/wo";
import { useToast } from "../../components/Toast";
import { Button, Modal, Pill } from "../../components/ui";
import { EmailPdfDialog, ExternalShareDialog } from "./ExternalShare";
import "../../styles/external.css";

type VendorLite = { id: string; name: string; color: string };

function VendorChecklist({ vendors, value, onChange }: { vendors: VendorLite[]; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const shown = vendors.filter((v) => !q || v.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {vendors.length > 8 && <input className="input" placeholder="Search vendors" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search vendors" />}
      <div className="stack" style={{ gap: 4, maxHeight: 220, overflow: "auto" }}>
        {shown.map((v) => <label key={v.id} className="check small"><input type="checkbox" checked={value.includes(v.id)}
          onChange={(e) => onChange(e.target.checked ? [...value, v.id] : value.filter((x) => x !== v.id))} />
          <span className="row" style={{ gap: 6 }}><span className="vdot" style={{ background: v.color }} />{v.name}</span></label>)}
        {!vendors.length && <span className="small muted">No vendors yet. Add them under Vendors.</span>}
      </div>
    </div>
  );
}

/** Field for the create / edit form. `value` undefined = untouched (edits keep the current vendors). */
export function WOVendorsField({ edit, value, onChange }: { edit?: WorkOrder; value: string[] | undefined; onChange: (ids: string[]) => void }) {
  const opts = useWOOptions();
  const vendors = opts.data?.vendors ?? [];
  if (!vendors.length) return null;
  return <div className="field"><span className="label">Vendors</span>
    <VendorChecklist vendors={vendors} value={value ?? (edit?.vendors ?? []).map((v) => v.id)} onChange={onChange} /></div>;
}

/** Detail card: vendors, plus "Share outside" and "Email PDF". */
export function WorkOrderOutside({ wo, editable }: { wo: WorkOrder; editable: boolean }) {
  const { can } = useSession();
  const opts = useWOOptions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pick, setPick] = useState<string[] | null>(null);
  const [sharing, setSharing] = useState(false);
  const [mailing, setMailing] = useState(false);
  const vendors = opts.data?.vendors ?? [];
  const mine = wo.vendors ?? [];
  const canShare = can("wo.share_external");
  const save = useMutation({
    mutationFn: (ids: string[]) => api(`/work-orders/${wo.id}/vendors`, { method: "PUT", body: { vendor_ids: ids } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["work-order", wo.id] }); qc.invalidateQueries({ queryKey: ["work-orders"] }); setPick(null); toast("Vendors saved"); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  if (!mine.length && !canShare && !(editable && vendors.length)) return null;
  return (
    <section className="card">
      <div className="card-head"><h2><Truck size={16} /> Vendors</h2>
        <div className="row">
          {wo.shared_externally && <Pill tone="info"><Globe2 size={12} /> Shared externally</Pill>}
          {editable && vendors.length > 0 && <Button size="sm" onClick={() => setPick(mine.map((v) => v.id))}><Pencil size={13} />Edit</Button>}
          {canShare && <Button size="sm" onClick={() => setMailing(true)}><Mail size={14} />Email PDF</Button>}
          {canShare && <Button size="sm" onClick={() => setSharing(true)}><Globe2 size={14} />Share outside</Button>}
        </div></div>
      <div className="card-pad row wrap">
        {mine.length ? mine.map((v) => <Link key={v.id} to={`/vendors/${v.id}`} className="chip"><span className="vdot" style={{ background: v.color }} />{v.name}</Link>)
          : <span className="small muted">No vendors on this work order.</span>}
      </div>
      {pick && <Modal title="Vendors" onClose={() => setPick(null)}
        footer={<><Button onClick={() => setPick(null)}>Cancel</Button><Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(pick)}>Save</Button></>}>
        <VendorChecklist vendors={vendors} value={pick} onChange={setPick} />
      </Modal>}
      {sharing && <ExternalShareDialog wo={wo} vendors={vendors} onClose={() => setSharing(false)} />}
      {mailing && <EmailPdfDialog wo={wo} vendors={vendors} onClose={() => setMailing(false)} />}
    </section>
  );
}
