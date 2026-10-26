// Delete my account (0.6.0, r321), on the Profile page. The only Owner of an organization hands it over first.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { forgetSavedWork } from "../lib/offline";
import { Button, Field, Input, Modal } from "../components/ui";

type Status = { can_delete: boolean; only_owner_of: { org_id: string; org: string }[]; needs_password: boolean };

export function DeleteAccount() {
  const st = useQuery({ queryKey: ["account-status"], queryFn: () => api<Status>("/me/account") });
  const [open, setOpen] = useState(false);
  const s = st.data;
  return (
    <section className="card"><div className="card-head"><h2>Delete my account</h2></div>
      <div className="card-body stack" style={{ gap: 10 }}>
        <p className="small muted" style={{ margin: 0 }}>You're removed from every organization and can't sign in again with this account. Work you did stays
          in each organization's history under "Deleted user". This can't be undone.</p>
        {s && !s.can_delete && <div className="banner warning" role="note">You're the only Owner of {s.only_owner_of.map((o) => o.org).join(", ")}. Make someone
          else the Owner in Teams &amp; Users (or delete the organization) first.</div>}
        <div><Button variant="danger" disabled={!s?.can_delete} onClick={() => setOpen(true)}>Delete my account…</Button></div>
      </div>
      {open && s && <ConfirmDelete needsPassword={s.needs_password} onClose={() => setOpen(false)} />}
    </section>);
}

function ConfirmDelete({ needsPassword, onClose }: { needsPassword: boolean; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const go = async () => {
    setBusy(true); setErr("");
    try {
      await api("/me/account", { method: "DELETE", body: { password, confirm } });
      await forgetSavedWork();
      qc.clear();
      nav("/login");
      window.location.reload();
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="Delete your account?" onClose={onClose}
      footer={<><Button onClick={onClose}>Keep my account</Button>
        <Button variant="danger" className="solid" disabled={busy || confirm.trim().toUpperCase() !== "DELETE" || (needsPassword && !password)} onClick={() => void go()}>Delete my account</Button></>}>
      <div className="stack" style={{ gap: 12 }}>
        {needsPassword && <Field label="Your password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}</Field>}
        <Field label='Type DELETE to confirm'>{(id) => <Input id={id} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoCapitalize="characters" />}</Field>
        {err && <div className="banner warning" role="alert">{err}</div>}
      </div>
    </Modal>);
}
