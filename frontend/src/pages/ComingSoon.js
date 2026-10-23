import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/ui";
export function ComingSoon({ item }) {
    const Icon = item.icon;
    return (_jsxs("div", { className: "page", children: [_jsx("div", { className: "page-head", children: _jsxs("div", { children: [_jsx("h1", { children: item.label }), _jsxs("p", { className: "sub", children: ["Arrives in MPro ", item.phase] })] }) }), _jsx("div", { className: "card", children: _jsxs(EmptyState, { icon: _jsx(Icon, { size: 28 }), title: `${item.label} is on its way`, action: _jsx(Link, { className: "btn", to: "/", children: "Back to Overview" }), children: [item.blurb, " It's planned for version ", item.phase, ", matching how it works in MaintainX so your team doesn't need retraining."] }) })] }));
}
export function NotFound() {
    return _jsx("div", { className: "page", children: _jsx("div", { className: "card", children: _jsx(EmptyState, { title: "Page not found", action: _jsx(Link, { className: "btn", to: "/", children: "Go to Overview" }), children: "That link doesn't lead anywhere in MPro. It may have moved or been typed incorrectly." }) }) });
}
