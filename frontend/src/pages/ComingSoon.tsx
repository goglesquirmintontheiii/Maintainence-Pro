import { Link } from "react-router-dom";
import { EmptyState } from "../components/ui";
import type { NavItem } from "../shell/nav";

export function ComingSoon({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <div className="page">
      <div className="page-head"><div><h1>{item.label}</h1><p className="sub">Arrives in MPro {item.phase}</p></div></div>
      <div className="card">
        <EmptyState icon={<Icon size={28} />} title={`${item.label} is on its way`}
          action={<Link className="btn" to="/">Back to Overview</Link>}>
          {item.blurb} It's planned for version {item.phase}, matching how it works in MaintainX so your team doesn't need retraining.
        </EmptyState>
      </div>
    </div>
  );
}

export function NotFound() {
  return <div className="page"><div className="card"><EmptyState title="Page not found" action={<Link className="btn" to="/">Go to Overview</Link>}>
    That link doesn't lead anywhere in MPro. It may have moved or been typed incorrectly.</EmptyState></div></div>;
}
