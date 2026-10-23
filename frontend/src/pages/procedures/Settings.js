import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Procedure settings card (Settings → Work orders): corrective work orders on Fail / Flag / low score (r044/r179)
// and moving work orders to In Progress on the first answer (r074).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { useToast } from "../../components/Toast";
import { Field, Select, Toggle } from "../../components/ui";
import { POLICY_LABEL } from "./types";
export function ProcedureSettings() {
    const { can } = useSession();
    const qc = useQueryClient();
    const { toast } = useToast();
    const ro = !can("wo.settings");
    const q = useQuery({ queryKey: ["proc-settings"], queryFn: () => api("/procedures/settings"), enabled: can("procedures.view") });
    const save = useMutation({ mutationFn: (b) => api("/procedures/settings", { method: "PATCH", body: b }),
        onSuccess: (x) => { qc.setQueryData(["proc-settings"], x); qc.invalidateQueries({ queryKey: ["proc-options"] }); toast("Saved"); },
        onError: (e) => toast(e.message, { kind: "error" }) });
    if (!q.data)
        return null;
    const v = q.data;
    const pol = (k, label) => (_jsx(Field, { label: label, children: (id) => _jsx(Select, { id: id, value: v[k], disabled: ro, onChange: (e) => save.mutate({ [k]: e.target.value }), children: Object.keys(POLICY_LABEL).map((p) => _jsx("option", { value: p, children: POLICY_LABEL[p] }, p)) }) }));
    return (_jsxs("section", { className: "card", children: [_jsxs("div", { className: "card-head", children: [_jsx("h2", { children: "Procedures" }), _jsx("span", { className: "small muted", children: "Corrective work orders are linked to the original and copy its asset and location" })] }), _jsxs("div", { className: "card-body stack", children: [_jsxs("div", { className: "form-grid", children: [pol("on_fail", "When a step is marked Fail"), pol("on_flag", "When a step is marked Flag"), pol("on_low_score", "When a scored procedure is below its goal")] }), _jsx(Toggle, { label: "Start work automatically", hint: "Answering a procedure step on an Open work order moves it to In Progress.", checked: v.auto_in_progress, disabled: ro, onChange: (x) => save.mutate({ auto_in_progress: x }) })] })] }));
}
