import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Toast = { id: number; text: string; kind: "info" | "error"; action?: { label: string; run: () => void } };
type Ctx = { toast: (text: string, opts?: { kind?: "info" | "error"; action?: Toast["action"] }) => void };
const ToastCtx = createContext<Ctx>({ toast: () => {} });
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback<Ctx["toast"]>((text, opts) => {
    const id = ++seq;
    setItems((x) => [...x.slice(-3), { id, text, kind: opts?.kind ?? "info", action: opts?.action }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), opts?.action ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={"toast " + t.kind}>
            <span>{t.text}</span>
            {t.action && <button className="act" onClick={() => { t.action!.run(); setItems((x) => x.filter((y) => y.id !== t.id)); }}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);
