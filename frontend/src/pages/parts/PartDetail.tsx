// One part: header, stock per location, vendors, assets, teams, codes, files, supplier links; transactions,
// work orders and history tabs. Stock actions open the dialogs in StockDialogs.tsx.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRightLeft, Link2, MoreHorizontal, Package, PackagePlus, Pencil, Plus, Printer, QrCode, RotateCcw, ShoppingCart, SlidersHorizontal, Trash2 } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useSession } from "../../lib/session";
import { absoluteUrl, copyText } from "../../lib/wo";
import { currency, dateTime, show } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, Dropdown, EmptyState, ListSkeleton, Modal, Pill } from "../../components/ui";
import { LabelDialog } from "../../components/LabelDialog";
import { FilesSection, HistoryList, TeamChips } from "../assets/shared";
import { ProductLinksPanel } from "../suppliers/ProductLinksPanel";
import { PartForm } from "./PartForm";
import { AdjustDialog, LocationDialog, RestockDialog, TransferDialog } from "./StockDialogs";
import { TxnTable } from "./Transactions";
import { StockBadge } from "./Parts";
import { qty, usePartFields, type PartDetail as PD, type StockRow } from "./types";

export const PART_TABS = [["details", "Details"], ["transactions", "Transactions"], ["work-orders", "Work Orders"], ["history", "History"]] as const;
export type PartTab = (typeof PART_TABS)[number][0];

type Dialog = { kind: "restock" | "adjust" | "transfer" | "location"; stock?: StockRow } | null;

export function usePart(id: string | undefined) {
  return useQuery({ queryKey: ["part", id], queryFn: () => api<PD>(`/parts/${id}`), enabled: !!id });
}

export function PartDetailView({ id, tab, onTab }: { id: string; tab: PartTab; onTab: (t: PartTab) => void }) {
  const q = usePart(id);
  const { can, session } = useSession();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [labels, setLabels] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const err = (e: unknown) => toast((e as ApiError).message, { kind: "error" });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["part", id] }); qc.invalidateQueries({ queryKey: ["parts"] }); qc.invalidateQueries({ queryKey: ["part-txns"] }); };
  const del = useMutation({ mutationFn: () => api(`/parts/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); setConfirmDelete(false); toast("Part deleted"); }, onError: (e) => { setConfirmDelete(false); err(e); } });
  const restore = useMutation({ mutationFn: () => api(`/parts/${id}/restore`, { method: "POST" }), onSuccess: () => { refresh(); toast("Restored"); }, onError: err });
  if (q.isError) return <EmptyState icon={<Package size={28} />} title="Part not found">It may have been deleted, or you don't have access.</EmptyState>;
  const p = q.data;
  if (!p) return <div className="detail"><ListSkeleton rows={5} /></div>;
  const tz = session.org?.timezone;
  const manage = can("parts.manage") && !p.deleted;
  const stockOps = can("parts.stock") && !p.deleted && !p.non_stock;

  return (
    <div className="detail part-detail">
      <Link to="/parts" className="row small mobile-only"><ArrowLeft size={14} />All parts</Link>
      {p.deleted && <div className="banner warning"><Trash2 size={18} /><div className="grow">This part was deleted.</div>
        {can("parts.delete") && <Button size="sm" onClick={() => restore.mutate()}><RotateCcw size={14} />Restore</Button>}</div>}
      <div className="wo-head">
        {p.thumb_url ? <img className="asset-hero" src={p.thumb_url} alt="" /> : <span className="asset-hero ph" aria-hidden="true"><Package size={26} /></span>}
        <div className="grow">
          <div className="small muted"><Link to="/parts">Parts</Link>{p.part_number && <> · <span className="mono">{p.part_number}</span></>}</div>
          <h1 className="wo-title">{p.name}</h1>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <StockBadge p={p} />
            {p.needs_restock && <Pill tone="warning">Needs restock</Pill>}
            {p.negative && <Pill tone="danger">Below zero</Pill>}
            {p.critical && <Pill tone="danger">Critical</Pill>}
            {p.types.map((t) => <span key={t.id} className="chip"><span className="sw lg" style={{ background: t.color }} />{t.name}</span>)}
          </div>
        </div>
        <div className="row">
          {stockOps && <Button onClick={() => setDialog({ kind: "restock" })}><PackagePlus size={15} /><span className="desktop-only">Restock</span></Button>}
          {manage && <Button icon aria-label="Edit part" title="Edit" onClick={() => setEditing(true)}><Pencil size={15} /></Button>}
          <Dropdown trigger={(_, t) => <Button icon aria-label="More actions" onClick={t}><MoreHorizontal size={18} /></Button>} width={240}>
            {(close) => <>
              {stockOps && <>
                <button className="menu-item" onClick={() => { close(); setDialog({ kind: "adjust" }); }}><SlidersHorizontal size={15} />Adjust quantity</button>
                <button className="menu-item" onClick={() => { close(); setDialog({ kind: "transfer" }); }}><ArrowRightLeft size={15} />Move between locations</button>
              </>}
              {!p.deleted && <Link className="menu-item" to={p.order_link} onClick={close}><ShoppingCart size={15} />Order this part</Link>}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => { close(); setLabels(true); }}><Printer size={15} />Print QR label</button>
              <button className="menu-item" onClick={async () => { close(); toast((await copyText(absoluteUrl(`/parts/${p.id}`))) ? "Link copied" : "Couldn't copy the link"); }}><Link2 size={15} />Copy link</button>
              {can("parts.delete") && !p.deleted && <><div className="menu-sep" /><button className="menu-item" style={{ color: "var(--c-danger)" }} onClick={() => { close(); setConfirmDelete(true); }}><Trash2 size={15} />Delete</button></>}
            </>}
          </Dropdown>
        </div>
      </div>

      <div className="tabs asset-tabs" role="tablist" aria-label="Part sections">
        {PART_TABS.map(([k, l]) => <button key={k} type="button" role="tab" className="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{l}</button>)}
      </div>
      {tab === "details" && <DetailsTab p={p} tz={tz} stockOps={stockOps} manage={manage} onDialog={setDialog} />}
      {tab === "transactions" && <TxnTable filters={{ part_id: p.id }} hidePart />}
      {tab === "work-orders" && <WorkOrdersTab p={p} />}
      {tab === "history" && <HistoryList path={`/parts/${p.id}/history`} tz={tz} />}

      {editing && <PartForm edit={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
      {labels && <LabelDialog entityType="part" ids={[p.id]} onClose={() => { setLabels(false); refresh(); }} />}
      {dialog?.kind === "restock" && <RestockDialog p={p} stock={dialog.stock} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "adjust" && <AdjustDialog p={p} stock={dialog.stock} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "transfer" && <TransferDialog p={p} stock={dialog.stock} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === "location" && <LocationDialog p={p} stock={dialog.stock} onClose={() => setDialog(null)} onDone={refresh} />}
      {confirmDelete && <Modal title="Delete part?" onClose={() => setConfirmDelete(false)} footer={<><Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
        <Button variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>Delete</Button></>}>
        <p>{p.name} will be removed from lists. Work orders and the transactions log keep their history, and an administrator can restore it.</p></Modal>}
    </div>
  );
}

function DetailsTab({ p, tz, stockOps, manage, onDialog }: { p: PD; tz?: string; stockOps: boolean; manage: boolean; onDialog: (d: Dialog) => void }) {
  const { can, session } = useSession();
  const cur = session.org?.currency;
  const fields = usePartFields();
  const cf = (fields.data?.items ?? []).filter((f) => p.custom[f.id] !== undefined && p.custom[f.id] !== "");
  return (
    <div className="stack" style={{ gap: 16 }}>
      {!p.non_stock && <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Stock</h3>
          {manage && <Button size="sm" variant="ghost" onClick={() => onDialog({ kind: "location" })}><Plus size={14} />Add location</Button>}</div>
        <div className="part-totals">
          <div><span className="k">In stock</span><span className="v">{qty(p.on_hand, p.unit)}</span></div>
          <div><span className="k">Reserved</span><span className="v">{qty(p.reserved, p.unit)}</span></div>
          <div><span className="k">Available</span><span className="v">{qty(p.available, p.unit)}</span></div>
          <div><span className="k">On order</span><span className="v">{qty(p.ordered, p.unit)}</span></div>
          <div><span className="k">Planned on work orders</span><span className="v">{qty(p.assigned, p.unit)}</span></div>
          {p.value !== null && <div><span className="k">Value</span><span className="v">{currency(p.value, cur)}</span></div>}
        </div>
        {p.stock.length === 0 ? <div className="card-body small faint">Not stocked anywhere yet. Add a location to track how many you have and when to restock.</div>
          : <div className="table-wrap"><table className="table part-stock-table">
            <thead><tr><th>Location</th><th>Area / bin</th><th className="num">In stock</th><th className="num">Available</th><th className="num">Min</th><th className="num">Max</th><th /></tr></thead>
            <tbody>{p.stock.map((s) => (
              <tr key={s.id}>
                <td>{s.location ? <Link to={`/locations/${s.location.id}`}>{s.location.name}</Link> : <span className="faint">No location</span>}
                  {s.needs_restock && <span className="part-flag low">Restock {s.restock_quantity}</span>}</td>
                <td>{s.area || <span className="faint">—</span>}</td>
                <td className={"num" + (s.negative ? " part-neg" : s.needs_restock ? " part-low" : "")}>{s.on_hand}</td>
                <td className="num">{s.available}</td><td className="num">{s.min_qty ?? "—"}</td><td className="num">{s.max_qty ?? "—"}</td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {(stockOps || manage) && <Dropdown trigger={(_, t) => <Button size="sm" variant="ghost" icon aria-label={`Actions for ${s.location?.name ?? "no location"}`} onClick={t}><MoreHorizontal size={15} /></Button>} width={210}>
                    {(close) => <>
                      {stockOps && <button className="menu-item" onClick={() => { close(); onDialog({ kind: "restock", stock: s }); }}><PackagePlus size={15} />Restock</button>}
                      {stockOps && <button className="menu-item" onClick={() => { close(); onDialog({ kind: "adjust", stock: s }); }}><SlidersHorizontal size={15} />Adjust quantity</button>}
                      {stockOps && <button className="menu-item" onClick={() => { close(); onDialog({ kind: "transfer", stock: s }); }}><ArrowRightLeft size={15} />Move from here</button>}
                      {manage && <button className="menu-item" onClick={() => { close(); onDialog({ kind: "location", stock: s }); }}><Pencil size={15} />Area, min and max</button>}
                    </>}
                  </Dropdown>}
                </td>
              </tr>))}</tbody></table></div>}
        {p.needs_restock && <div className="card-body"><Link className="btn btn-sm" to={p.order_link}><ShoppingCart size={14} />Order this part</Link></div>}
      </section>}
      {p.description && <section className="card card-pad prewrap">{p.description}</section>}
      <dl className="meta-grid card card-pad">
        <div><dt>Part number</dt><dd className="mono">{show(p.part_number)}</dd></div>
        <div><dt>Unit</dt><dd>{p.unit}</dd></div>
        {can("costs.view") && <div><dt>Unit cost</dt><dd>{currency(p.unit_cost, cur)}</dd></div>}
        <div><dt>Barcode</dt><dd className="mono">{show(p.barcode)}</dd></div>
        <div><dt>Manufacturer</dt><dd>{show(p.manufacturer)}</dd></div>
        <div><dt>Manufacturer part number</dt><dd className="mono">{show(p.mpn)}</dd></div>
        <div><dt>Lead time</dt><dd>{p.lead_time_days === null ? <span className="faint">—</span> : `${p.lead_time_days} day${p.lead_time_days === 1 ? "" : "s"}`}</dd></div>
        <div><dt>Stocking</dt><dd>{p.non_stock ? "Non-stock (bought when needed)" : "Stocked"}</dd></div>
        <div className="span2"><dt>Teams in charge</dt><dd><TeamChips teams={p.teams} /></dd></div>
        <div className="span2"><dt>Used on assets</dt><dd>{p.assets.length ? <span className="row wrap" style={{ gap: 4 }}>{p.assets.map((a) =>
          <Link key={a.id} className="chip" to={`/assets/${a.id}`} title={a.auto ? "Linked automatically when used on a work order" : undefined}>{a.name}</Link>)}</span> : <span className="faint">None</span>}</dd></div>
        {cf.map((f) => <div key={f.id}><dt>{f.name}</dt><dd><CustomValue def={f} value={p.custom[f.id]} cur={cur} /></dd></div>)}
        <div><dt>Created</dt><dd className="small">{dateTime(p.created_at, tz)}</dd></div>
        <div><dt>Updated</dt><dd className="small">{dateTime(p.updated_at, tz)}</dd></div>
      </dl>
      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Vendors</h3></div>
        {p.vendors.length === 0 ? <div className="card-body small faint">No vendors yet. Add who you buy this part from when you edit it.</div>
          : p.vendors.map((v) => <Link key={v.vendor.id} to={`/vendors/${v.vendor.id}`} className="list-row">
            <span className="sw lg" style={{ background: v.vendor.color }} /><span className="grow"><span className="t">{v.vendor.name}</span>
              <span className="s">{[v.vendor_part_number && `Vendor part # ${v.vendor_part_number}`, v.unit_cost !== null && currency(v.unit_cost, cur), v.lead_time_days !== null && `${v.lead_time_days} days`].filter(Boolean).join(" · ") || " "}</span></span>
            {v.preferred && <Pill tone="info">Preferred</Pill>}</Link>)}
      </section>
      <ProductLinksPanel entityType="part" entityId={p.id} canEdit={manage} />
      <section className="card">
        <div className="card-head"><h3 className="sec-h" style={{ margin: 0 }}>Codes</h3></div>
        {p.codes.length === 0 ? <div className="card-body small faint">No QR code yet. Printing a label gives the part one.{p.barcode && " Scanning its barcode also opens it."}</div>
          : p.codes.map((c) => <div key={c.id} className="list-row"><QrCode size={15} /><span className="grow mono">{c.value}</span><span className="small faint">{c.kind === "mpro" ? "MPro code" : c.symbology}</span></div>)}
      </section>
      <FilesSection files={p.files} entityType="part" entityId={p.id} editable={manage} queryKey={["part", p.id]} role="file" />
    </div>
  );
}

function CustomValue({ def, value, cur }: { def: { type: string }; value: unknown; cur?: string }) {
  if (def.type === "checkbox") return <>{value ? "Yes" : "No"}</>;
  if (def.type === "link") return <a href={String(value)} target="_blank" rel="noopener noreferrer">{String(value)}</a>;
  if (def.type === "currency") return <>{currency(value, cur)}</>;
  return <>{String(value)}</>;
}

function WorkOrdersTab({ p }: { p: PD }) {
  if (!p.open_work_orders.length) return <EmptyState title="Not on any open work orders">Parts added to open work orders show here, with what's planned or reserved.</EmptyState>;
  return (
    <section className="card">
      {p.open_work_orders.map((w) => <Link key={w.id} to={`/work-orders/${w.id}`} className="list-row">
        <span className="mono small faint">#{w.number}</span><span className="grow t">{w.title}</span>
        <span className="small">{qty(w.quantity, p.unit)}</span><Pill tone={w.part_status === "assigned" ? "neutral" : "info"}>{w.part_status_label}</Pill></Link>)}
    </section>
  );
}
