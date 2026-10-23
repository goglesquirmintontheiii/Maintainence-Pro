import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createContext, useCallback, useContext, useState } from "react";
const ToastCtx = createContext({ toast: () => { } });
let seq = 0;
export function ToastProvider({ children }) {
    const [items, setItems] = useState([]);
    const toast = useCallback((text, opts) => {
        const id = ++seq;
        setItems((x) => [...x.slice(-3), { id, text, kind: opts?.kind ?? "info", action: opts?.action }]);
        setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), opts?.action ? 6000 : 3500);
    }, []);
    return (_jsxs(ToastCtx.Provider, { value: { toast }, children: [children, _jsx("div", { className: "toasts", role: "status", "aria-live": "polite", children: items.map((t) => (_jsxs("div", { className: "toast " + t.kind, children: [_jsx("span", { children: t.text }), t.action && _jsx("button", { className: "act", onClick: () => { t.action.run(); setItems((x) => x.filter((y) => y.id !== t.id)); }, children: t.action.label })] }, t.id))) })] }));
}
export const useToast = () => useContext(ToastCtx);
