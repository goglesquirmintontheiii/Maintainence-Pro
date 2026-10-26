// "My sites" for Guests (r236): the assets at their locations with each one's work history, and their customer's
// quotes to approve. Work orders at their sites are in Work Orders, like for everyone else.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Check, ChevronLeft, FileText, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { currency, timeAgo } from "../../lib/format";
import { useToast } from "../../components/Toast";
import { Button, EmptyState, ListSkeleton, Pill, StatusPill } from "../../components/ui";

type Home = {
  assets: { id: string; name: string; status: string; location: string }[];
  quotes: { id: string; number: number; title: string; status: string; total: string; currency: string; valid_until: string | null }[];
  access: { locations: { id: string; name: string }[]; customer: { id: string; name: string } | null };
};
type History = { asset: { id: string; name: string; status: string }; work_orders: { id: string; number: number; title: string; status: string; created_at: string }[] };

export function GuestHome() {
  const home = useQuery({ queryKey: ["guest-home"], queryFn: () => api<Home>("/guest/home") });
  const [asset, setAsset] = useState<string | null>(null);
  if (home.isLoading) return <ListSkeleton />;
  const d = home.data;
  if (!d) return <EmptyState title="Nothing to show">Ask the maintenance team to give you access to your sites.</EmptyState>;
  if (asset) return <AssetHistory id={asset} onBack={() => setAsset(null)} />;
  return (
    <div className="list">
      <div className="small faint req-guest-sites">Your sites: {d.access.locations.map((l) => l.name).join(", ") || "none yet"}</div>
      {d.quotes.length > 0 && <><div className="sb-group req-guest-h">Quotes{d.access.customer ? ` for ${d.access.customer.name}` : ""}</div>
        {d.quotes.map((q) => <QuoteRow key={q.id} q={q} />)}</>}
      <div className="sb-group req-guest-h">Assets</div>
      {d.assets.length === 0 ? <EmptyState icon={<Boxes size={26} />} title="No assets at your sites" />
        : d.assets.map((a) => (
          <button key={a.id} type="button" className="list-row req-row" onClick={() => setAsset(a.id)}>
            <span className="grow" style={{ minWidth: 0, textAlign: "left" }}><span className="t">{a.name}</span><span className="s">{a.location}</span></span>
            <Pill tone={a.status === "offline" ? "danger" : "success"}>{a.status === "offline" ? "Offline" : "Online"}</Pill>
          </button>))}
    </div>
  );
}

function AssetHistory({ id, onBack }: { id: string; onBack: () => void }) {
  const h = useQuery({ queryKey: ["guest-asset", id], queryFn: () => api<History>(`/guest/assets/${id}`) });
  return (
    <div className="list">
      <button type="button" className="linkbtn small req-guest-sites" onClick={onBack}><ChevronLeft size={14} />All assets</button>
      {!h.data ? <ListSkeleton /> : <>
        <div className="sb-group req-guest-h">{h.data.asset.name}: work history</div>
        {h.data.work_orders.length === 0 ? <EmptyState title="No work orders yet" />
          : h.data.work_orders.map((w) => (
            <Link key={w.id} to={`/work-orders/${w.id}`} className="list-row req-row">
              <span className="grow" style={{ minWidth: 0 }}><span className="t">{w.title}</span><span className="s">#{w.number} · {timeAgo(w.created_at)}</span></span>
              <StatusPill status={w.status as "open"} />
            </Link>))}
      </>}
    </div>
  );
}

function QuoteRow({ q }: { q: Home["quotes"][number] }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [rejecting, setRejecting] = useState(false);
  const [why, setWhy] = useState("");
  const decide = useMutation({
    mutationFn: (approve: boolean) => api(`/guest/quotes/${q.id}/decide`, { method: "POST", body: { approve, comment: why } }),
    onSuccess: (_d, approve) => { qc.invalidateQueries({ queryKey: ["guest-home"] }); toast(approve ? "Quote approved" : "Quote rejected"); setRejecting(false); },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  return (
    <div className="list-row req-row" style={{ flexWrap: "wrap" }}>
      <FileText size={16} className="faint" />
      <span className="grow" style={{ minWidth: 0 }}><span className="t">{q.title}</span>
        <span className="s">Quote {q.number} · {currency(q.total, q.currency)}{q.valid_until ? ` · valid until ${new Date(q.valid_until + "T00:00").toLocaleDateString()}` : ""}</span></span>
      {q.status === "sent" ? <span className="row" style={{ gap: 6 }}>
        {rejecting ? <>
          <input className="input" style={{ width: 180 }} placeholder="Why?" value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Reason" />
          <Button size="sm" variant="danger" disabled={!why.trim() || decide.isPending} onClick={() => decide.mutate(false)}>Reject</Button>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Back</Button>
        </> : <>
          <Button size="sm" onClick={() => setRejecting(true)}><X size={14} />Reject</Button>
          <Button size="sm" variant="primary" disabled={decide.isPending} onClick={() => decide.mutate(true)}><Check size={14} />Approve</Button>
        </>}
      </span> : <Pill tone={q.status === "approved" ? "success" : q.status === "rejected" ? "danger" : "neutral"}>{q.status[0].toUpperCase() + q.status.slice(1)}</Pill>}
    </div>
  );
}
