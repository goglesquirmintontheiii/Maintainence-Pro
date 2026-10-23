import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
// 0.5.0 PunchOut (MP-088): shop in a supplier's own catalog; the cart comes back to MPro as a purchase order.
import { useMutation, useQuery } from "@tanstack/react-query";
import { ShoppingBag } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useToast } from "../../components/Toast";
import { Button, Dropdown } from "../../components/ui";
function postForm(action, fields) {
    // OCI: the catalog expects a form post from the browser. Built with DOM APIs, so values are never parsed as HTML.
    if (!/^https:\/\//i.test(action))
        throw new ApiError(422, "The catalog address must start with https://.");
    const form = document.createElement("form");
    form.method = "POST";
    form.action = action;
    for (const [k, v] of Object.entries(fields)) {
        const i = document.createElement("input");
        i.type = "hidden";
        i.name = k;
        i.value = v;
        form.appendChild(i);
    }
    document.body.appendChild(form);
    form.submit();
}
export function PunchOutButton() {
    const { toast } = useToast();
    const q = useQuery({ queryKey: ["punchout-catalogs"], queryFn: () => api("/punchout/catalogs"), staleTime: 60_000 });
    const start = useMutation({
        mutationFn: (id) => api("/punchout/start", { method: "POST", body: { connection_id: id } }),
        onSuccess: (r) => {
            if (r.redirect && /^https?:\/\//i.test(r.redirect))
                window.location.assign(r.redirect);
            else if (r.form)
                postForm(r.form.action, r.form.fields);
        },
        onError: (e) => toast(e.message, { kind: "error" }),
    });
    const items = q.data?.items ?? [];
    if (items.length === 0)
        return null;
    return (_jsx(Dropdown, { width: 260, trigger: (_o, t) => _jsxs(Button, { size: "sm", variant: "ghost", onClick: t, disabled: start.isPending, children: [_jsx(ShoppingBag, { size: 14 }), "Shop a catalog"] }), children: (close) => _jsxs(_Fragment, { children: [_jsx("div", { className: "small faint", style: { padding: "6px 12px" }, children: "Your cart comes back here as a purchase order." }), items.map((c) => _jsx("button", { className: "menu-item", onClick: () => { close(); start.mutate(c.id); }, children: c.supplier_name || c.name }, c.id))] }) }));
}
