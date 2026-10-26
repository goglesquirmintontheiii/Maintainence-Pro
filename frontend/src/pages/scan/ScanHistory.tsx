// Scan history (0.6.0, MP-097): who scanned what and when — proof of visit on rounds and completed work orders.
// People with "See scan history" see everyone's scans; everyone else sees only their own.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MapPin, ScanLine } from "lucide-react";
import "../../styles/scan.css";
import { api } from "../../lib/api";
import { dateTime } from "../../lib/format";
import { useSession } from "../../lib/session";
import { EmptyState, ListSkeleton, Pill, Select } from "../../components/ui";
import { TYPE_LABEL, type ScanEvent } from "./scanApi";

type Page = { items: ScanEvent[]; total: number; page: number; per_page: number; everyone: boolean };

const mapUrl = (g: NonNullable<ScanEvent["gps"]>) => `https://www.openstreetmap.org/?mlat=${g.latitude}&mlon=${g.longitude}#map=18/${g.latitude}/${g.longitude}`;

function Row({ e, showEntity, tz }: { e: ScanEvent; showEntity: boolean; tz?: string }) {
  const url = { asset: "/assets/", location: "/locations/", part: "/parts/", work_order: "/work-orders/", procedure: "/procedures/", meter: "/meters/" }[e.entity_type];
  return (
    <li className="scan-ev">
      <ScanLine size={15} className="faint" aria-hidden />
      <div className="grow" style={{ minWidth: 0 }}>
        <div><b>{e.user?.name ?? "Someone (not signed in)"}</b> <span className="muted">{e.action_label.toLowerCase()}</span>
          {showEntity && <> {url ? <Link to={url + e.entity_id}>{e.entity_label}</Link> : e.entity_label} <span className="faint small">({TYPE_LABEL[e.entity_type]})</span></>}</div>
        <div className="small muted">{dateTime(e.scanned_at, tz)}{e.source === "offline" && " · synced later"}{e.public && " · public scan"}
          {e.gps && <> · <a href={mapUrl(e.gps)} target="_blank" rel="noopener noreferrer"><MapPin size={12} /> on the map</a>{e.gps.accuracy_m != null && ` (±${e.gps.accuracy_m} m)`}</>}</div>
      </div>
      {e.action === "check_in" && <Pill tone="success">Check-in</Pill>}
    </li>
  );
}

export function ScanHistory({ entityType, entityId, title = "Scans" }: { entityType: string; entityId: string; title?: string }) {
  const { session } = useSession();
  const q = useQuery({ queryKey: ["scan-history", entityType, entityId], queryFn: () => api<Page>(`/scan/history?entity_type=${entityType}&entity_id=${entityId}&per_page=50`) });
  if (q.isLoading || !q.data?.items.length) return null;
  return (
    <section className="card card-pad stack" aria-label={title}>
      <h3 className="sec-h" style={{ margin: 0 }}>{title}</h3>
      {!q.data.everyone && <p className="small muted" style={{ margin: 0 }}>Only your own scans are shown.</p>}
      <ul className="scan-evs">{q.data.items.map((e) => <Row key={e.id} e={e} showEntity={false} tz={session.org?.timezone} />)}</ul>
    </section>
  );
}

/** Proof of visit on a work order: check-ins and scans of its asset(s) and location while it was open. */
export function WorkOrderVisits({ woId, canAdd = false }: { woId: string; canAdd?: boolean }) {
  const { session } = useSession();
  const q = useQuery({ queryKey: ["wo-visits", woId], queryFn: () => api<{ items: ScanEvent[]; everyone: boolean }>(`/work-orders/${woId}/visits`) });
  const add = canAdd && <Link className="btn sm" to={`/scan?for=wo:${woId}`}><ScanLine size={14} />Scan to add</Link>;
  if (!q.data?.items.length) return add ? <div className="row small muted" style={{ gap: 8 }}>{add}<span>Scan an asset's or location's code to add it here.</span></div> : null;
  return (
    <section className="card card-pad stack" aria-label="Visits">
      <div className="row"><h3 className="sec-h grow" style={{ margin: 0 }}>Visits</h3>{add}</div>
      <p className="small muted" style={{ margin: 0 }}>Scans of this work order, its assets and its location while it was open.</p>
      <ul className="scan-evs">{q.data.items.map((e) => <Row key={e.id} e={e} showEntity tz={session.org?.timezone} />)}</ul>
    </section>
  );
}

export function ScanHistoryPage() {
  const { session } = useSession();
  const [type, setType] = useState("");
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const qs = `per_page=50&page=${page}${type ? `&entity_type=${type}` : ""}${action ? `&action=${action}` : ""}`;
  const q = useQuery({ queryKey: ["scan-history", "all", qs], queryFn: () => api<Page>(`/scan/history?${qs}`) });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.per_page)) : 1;
  return (
    <div className="page scan-page">
      <Link to="/scan" className="row small" style={{ gap: 4 }}><ArrowLeft size={14} />Scan</Link>
      <div className="page-head"><div><h1>Scan history</h1>
        <p className="sub">{q.data?.everyone === false ? "Your scans and check-ins." : "Who scanned what, and when. Check-ins and scans prove visits on rounds and work orders."}</p></div></div>
      <div className="row wrap" style={{ gap: 8 }}>
        <Select aria-label="Type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} style={{ width: "auto" }}>
          <option value="">Everything</option>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}s</option>)}</Select>
        <Select aria-label="Action" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} style={{ width: "auto" }}>
          <option value="">Scans and actions</option><option value="scan">Scans</option><option value="check_in">Check-ins</option>
          <option value="start">Inspections started</option><option value="reading">Readings</option></Select>
      </div>
      {q.isLoading ? <ListSkeleton /> : !q.data?.items.length ? <EmptyState icon={<ScanLine size={28} />} title="No scans yet">Scans show here as soon as someone scans a code.</EmptyState>
        : <section className="card card-pad"><ul className="scan-evs">{q.data.items.map((e) => <Row key={e.id} e={e} showEntity tz={session.org?.timezone} />)}</ul></section>}
      {pages > 1 && <div className="row" style={{ justifyContent: "center", gap: 8 }}>
        <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="small muted">Page {page} of {pages}</span>
        <button type="button" className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div>}
    </div>
  );
}
