// 0.5.0 PunchOut (MP-088): shop in a supplier's own catalog; the cart comes back to MPro as a purchase order.
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShoppingBag } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Dropdown } from "../../components/ui";

type Catalog = { id: string; name: string; supplier_name: string };
type Start = { session_id: string; redirect?: string; form?: { action: string; fields: Record<string, string> } };

function postForm(action: string, fields: Record<string, string>) {
  // OCI: the catalog expects a form post from the browser. Built with DOM APIs, so values are never parsed as HTML.
  if (!/^https:\/\//i.test(action)) throw new ApiError(422, "The catalog address must start with https://.");
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  for (const [k, v] of Object.entries(fields)) {
    const i = document.createElement("input");
    i.type = "hidden"; i.name = k; i.value = v;
    form.appendChild(i);
  }
  document.body.appendChild(form);
  form.submit();
}

export function PunchOutButton() {
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["punchout-catalogs"], queryFn: () => api<{ items: Catalog[] }>("/punchout/catalogs"), staleTime: 60_000 });
  const start = useMutation({
    mutationFn: (id: string) => api<Start>("/punchout/start", { method: "POST", body: { connection_id: id } }),
    onSuccess: (r) => {
      if (r.redirect && /^https?:\/\//i.test(r.redirect)) window.location.assign(r.redirect);
      else if (r.form) postForm(r.form.action, r.form.fields);
    },
    onError: (e) => toast((e as ApiError).message, { kind: "error" }),
  });
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Dropdown width={260} trigger={(_o, t) => <Button size="sm" variant="ghost" onClick={t} disabled={start.isPending}><ShoppingBag size={14} />Shop a catalog</Button>}>
      {(close) => <>
        <div className="small faint" style={{ padding: "6px 12px" }}>Your cart comes back here as a purchase order.</div>
        {items.map((c) => <button key={c.id} className="menu-item" onClick={() => { close(); start.mutate(c.id); }}>{c.supplier_name || c.name}</button>)}
      </>}
    </Dropdown>
  );
}
