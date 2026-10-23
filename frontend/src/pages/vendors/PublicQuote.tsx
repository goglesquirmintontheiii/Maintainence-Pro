// The customer's quote page (r235): opened from the emailed link, no sign-in. The customer reads the quote,
// downloads the PDF, asks a question, and approves or rejects it with their name.
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileDown, X } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { currency, timeAgo } from "../../lib/format";
import { LogoMark } from "../../components/Logo";
import { Button, EmptyState, Field, Input, ListSkeleton, Pill } from "../../components/ui";
import { QUOTE_TONE, type QuoteStatus } from "./Customers";
import "../purchasing/purchasing.css";

type PublicQuote = {
  number: number; title: string; scope: string; status: QuoteStatus; currency: string; valid_until: string | null; subtotal: string; tax: string; total: string;
  decided_at: string | null; decided_by_name: string; decision_comment: string; organization: string; customer: string; expired: boolean;
  lines: { kind: string; description: string; quantity: string; unit_price: string; amount: string; taxable: boolean }[];
  comments: { body: string; author: string; external: boolean; created_at: string }[];
};

export function PublicQuotePage() {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const key = ["public-quote", token];
  const q = useQuery({ queryKey: key, queryFn: () => api<PublicQuote>(`/public/quotes/${encodeURIComponent(token)}`), retry: false });
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [err, setErr] = useState("");
  const decide = useMutation({
    mutationFn: (approve: boolean) => api<PublicQuote>(`/public/quotes/${encodeURIComponent(token)}/decision`, { method: "POST", body: { approve, name, comment } }),
    onSuccess: (d) => { qc.setQueryData(key, d); setErr(""); setComment(""); }, onError: (e) => setErr((e as ApiError).message),
  });
  const ask = useMutation({
    mutationFn: () => api<PublicQuote>(`/public/quotes/${encodeURIComponent(token)}/comments`, { method: "POST", body: { name, body: comment } }),
    onSuccess: (d) => { qc.setQueryData(key, d); setComment(""); setErr(""); }, onError: (e) => setErr((e as ApiError).message),
  });
  if (q.isLoading) return <div className="pq-page"><div className="pq-card"><ListSkeleton rows={5} /></div></div>;
  if (q.isError || !q.data) return <div className="pq-page"><div className="pq-card"><EmptyState title="This link isn't valid">It may have expired or been replaced by a newer quote. Ask the sender for a new link.</EmptyState></div></div>;
  const d = q.data;
  const open = d.status === "sent" && !d.expired;
  const status = d.expired && d.status === "sent" ? "expired" : d.status;
  return (
    <div className="pq-page">
      <div className="pq-card">
        <div className="row" style={{ gap: 10 }}><LogoMark size={28} /><b className="grow">{d.organization}</b>
          <a className="btn btn-sm" href={`/api/v1/public/quotes/${encodeURIComponent(token)}/pdf`} target="_blank" rel="noopener noreferrer"><FileDown size={14} />PDF</a></div>
        <div>
          <div className="small muted">Quote {d.number} for {d.customer}</div>
          <h1 className="wo-title" style={{ margin: "4px 0" }}>{d.title}</h1>
          <div className="row wrap" style={{ gap: 6 }}><Pill tone={QUOTE_TONE[status]}>{status === "sent" ? "Waiting for your decision" : status[0].toUpperCase() + status.slice(1)}</Pill>
            {d.valid_until && <span className="small muted">Valid until {new Date(d.valid_until + "T00:00").toLocaleDateString()}</span>}</div>
        </div>
        {d.scope && <p className="prewrap" style={{ margin: 0 }}>{d.scope}</p>}
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
          <tbody>{d.lines.map((l, i) => <tr key={i}><td>{l.description}<span className="small faint" style={{ display: "block" }}>{l.kind[0].toUpperCase() + l.kind.slice(1)}</span></td>
            <td className="num">{+Number(l.quantity).toFixed(4)}</td><td className="num">{currency(l.unit_price, d.currency)}</td><td className="num">{currency(l.amount, d.currency)}</td></tr>)}</tbody>
        </table></div>
        <div className="po-totals">
          <div><span>Subtotal</span><span>{currency(d.subtotal, d.currency)}</span></div>
          <div><span>Tax</span><span>{currency(d.tax, d.currency)}</span></div>
          <div className="tot"><span>Total</span><span>{currency(d.total, d.currency)}</span></div>
        </div>
        {d.decided_by_name && <div className={"banner " + (d.status === "approved" ? "info" : "warning")}>
          {d.status === "approved" ? "Approved" : "Rejected"} by {d.decided_by_name}{d.decided_at ? `, ${timeAgo(d.decided_at)}` : ""}{d.decision_comment ? `: “${d.decision_comment}”` : ""}</div>}
        {d.comments.length > 0 && <section>
          <h3 className="sec-h">Questions and answers</h3>
          {d.comments.map((c, i) => <div key={i} className="list-row" style={{ alignItems: "flex-start", paddingInline: 0 }}><span className="grow">
            <span className="small"><b>{c.author}</b> <span className="faint">{timeAgo(c.created_at)}</span></span><span className="prewrap" style={{ display: "block" }}>{c.body}</span></span></div>)}
        </section>}
        {(open || d.status === "sent") && <section className="stack" style={{ gap: 10 }}>
          <Field label="Your name">{(id) => <Input id={id} value={name} maxLength={200} autoComplete="name" onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={rejecting ? "Why are you rejecting it?" : "Comment or question (optional)"}>{(id) => <textarea id={id} className="input" rows={3} value={comment} maxLength={4000} onChange={(e) => setComment(e.target.value)} />}</Field>
          {err && <div className="banner warning" role="alert">{err}</div>}
          <div className="row wrap" style={{ gap: 8 }}>
            {open && !rejecting && <Button variant="primary" disabled={!name.trim() || decide.isPending} onClick={() => decide.mutate(true)}><Check size={15} />Approve quote</Button>}
            {open && (rejecting
              ? <><Button variant="danger" disabled={!name.trim() || !comment.trim() || decide.isPending} onClick={() => decide.mutate(false)}><X size={15} />Reject quote</Button>
                <Button variant="ghost" onClick={() => setRejecting(false)}>Back</Button></>
              : <Button onClick={() => setRejecting(true)}><X size={15} />Reject</Button>)}
            {!rejecting && <Button variant="ghost" disabled={!name.trim() || !comment.trim() || ask.isPending} onClick={() => ask.mutate()}>Send question</Button>}
          </div>
        </section>}
      </div>
    </div>
  );
}
