import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// /q/:code — what a printed MPro QR label opens. Resolves the code, then goes to the record.
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import "../../styles/scan.css";
import { EmptyState } from "../../components/ui";
import { ScanOutcome, resolveScan } from "./resolve";
export function QrResolve() {
    const { code = "" } = useParams();
    const nav = useNavigate();
    const [result, setResult] = useState(null);
    const [err, setErr] = useState("");
    useEffect(() => {
        let live = true;
        resolveScan(code).then((r) => {
            if (!live)
                return;
            if (r.status === "found")
                nav(r.url, { replace: true });
            else
                setResult(r);
        }).catch((e) => { if (live)
            setErr(e.message); });
        return () => { live = false; };
    }, [code, nav]);
    return (_jsx("div", { className: "page scan-page", children: err ? _jsx(EmptyState, { title: "Couldn't open this code", children: err })
            : result ? _jsxs(_Fragment, { children: [_jsx("div", { className: "page-head", children: _jsxs("h1", { children: ["QR code ", _jsx("span", { className: "mono", children: code })] }) }), _jsx(ScanOutcome, { result: result, onAgain: () => nav("/scan"), againLabel: "Scan another code" })] })
                : _jsxs("div", { className: "scan-resolving", role: "status", children: [_jsx(Loader2, { className: "spin", size: 26 }), _jsxs("span", { children: ["Opening code ", _jsx("span", { className: "mono", children: code }), "\u2026"] })] }) }));
}
