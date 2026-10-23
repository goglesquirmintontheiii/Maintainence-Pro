import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useId } from "react";
/** The MPro mark: a hex nut with "MP". Colours come from the --logo-* tokens. */
export function LogoMark({ size = 32 }) {
    const gid = useId().replace(/:/g, "");
    return (_jsxs("svg", { width: size, height: size, viewBox: "0 0 44 44", "aria-hidden": "true", style: { flex: "none", overflow: "visible" }, children: [_jsx("defs", { children: _jsxs("linearGradient", { id: gid, x1: "0", y1: "0", x2: "1", y2: "1", children: [_jsx("stop", { offset: "0", style: { stopColor: "var(--logo-1)" } }), _jsx("stop", { offset: "1", style: { stopColor: "var(--logo-2)" } })] }) }), _jsx("path", { d: "M22 4 L37.6 13 V31 L22 40 L6.4 31 V13 Z", fill: `url(#${gid})`, stroke: `url(#${gid})`, strokeWidth: "4", strokeLinejoin: "round" }), _jsx("path", { d: "M22 22 L6.4 13 L22 4 L37.6 13 Z", fill: "#fff", fillOpacity: ".14" }), _jsx("path", { d: "M22 7.6 L34.5 14.8 V29.2 L22 36.4 L9.5 29.2 V14.8 Z", fill: "none", stroke: "#fff", strokeOpacity: ".3", strokeWidth: ".9", strokeLinejoin: "round" }), _jsx("text", { x: "22", y: "23.4", textAnchor: "middle", dominantBaseline: "middle", fill: "#fff", style: { font: "800 14px var(--font)", letterSpacing: "-0.6px" }, children: "MP" })] }));
}
