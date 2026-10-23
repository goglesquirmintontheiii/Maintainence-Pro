import { jsx as _jsx } from "react/jsx-runtime";
// A number box you can empty while typing (0.5.0, MP-122). While focused it keeps exactly what you typed (including
// nothing), reports `empty` for a blank box, and shows the real value again when you leave it — so clearing "2" and
// typing "5" works without first typing next to it. Values are clamped to min/max when reported.
import { useState } from "react";
export function NumberInput({ value, onValue, empty = null, min, max, integer, onFocus, onBlur, className = "", ...rest }) {
    const [text, setText] = useState(null);
    const clamp = (n) => {
        let v = integer ? Math.trunc(n) : n;
        if (min !== undefined)
            v = Math.max(min, v);
        if (max !== undefined)
            v = Math.min(max, v);
        return v;
    };
    const shown = text ?? (value === null || value === undefined ? "" : String(value));
    return (_jsx("input", { ...rest, type: "number", inputMode: integer ? "numeric" : "decimal", min: min, max: max, className: "input " + className, value: shown, onFocus: (e) => { setText(shown); onFocus?.(e); }, onBlur: (e) => { setText(null); onBlur?.(e); }, onChange: (e) => {
            const t = e.target.value;
            setText(t);
            if (t.trim() === "") {
                onValue(empty);
                return;
            }
            const n = Number(t);
            if (Number.isFinite(n))
                onValue(clamp(n));
        } }));
}
