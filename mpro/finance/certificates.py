"""Tax exemption certificates and cards (MP-090).

The organization's own certificates (and its customers', with customer_id set) are kept with their scans encrypted at
rest. A certificate covers a jurisdiction (country + state/province, or several for multistate SST/MTC forms) and
optionally only some sites. The vendor registry records which vendors have which certificate on file; purchase orders
to such a vendor for a covered jurisdiction are marked tax-exempt (registered into mpro.purchasing.hooks), and
receipts that still charged tax are flagged for reclaiming.
"""

from __future__ import annotations

import base64
import uuid
from datetime import date, timedelta
from typing import Any

from flask import has_request_context, request
from sqlalchemy import or_, select

from mpro.core.events import diff, emit
from mpro.core.files import FileLink, FileObject, attach, file_dict, links_for, read_bytes, save_file
from mpro.core.mail import send_email
from mpro.core.models import iso, utcnow
from mpro.extensions import db
from mpro.finance import vault
from mpro.finance.common import get_in_org, paged, parse_date, s, today, user_label, vendor_label
from mpro.finance.models import CERTIFICATE_TYPES, CertificateAccess, CertificateVendor, TaxCertificate
from mpro.orgs.services import RuleError

TYPE_LABELS = {
    "resale": "Resale",
    "exempt_organization": "Exempt organization (e.g. 501(c)(3))",
    "government": "Government",
    "manufacturing": "Manufacturing / industrial processing",
    "agricultural": "Agricultural",
    "direct_pay": "Direct-pay permit",
    "ca_pst_gst": "Canadian PST/GST exemption",
    "eu_vat": "EU VAT ID (reverse charge)",
    "custom": "Other",
}
MULTISTATE = {"": "", "sst": "Streamlined Sales Tax (SST)", "mtc": "Multistate Tax Commission (MTC)"}

# country names people type in addresses → ISO codes; state/province names → postal codes
_COUNTRIES = {
    "united states": "US",
    "usa": "US",
    "u.s.": "US",
    "u.s.a.": "US",
    "america": "US",
    "canada": "CA",
    "united kingdom": "GB",
    "uk": "GB",
    "germany": "DE",
    "france": "FR",
    "netherlands": "NL",
    "ireland": "IE",
    "spain": "ES",
    "italy": "IT",
    "mexico": "MX",
    "australia": "AU",
}
_REGIONS = {
    "alabama": "AL",
    "alaska": "AK",
    "arizona": "AZ",
    "arkansas": "AR",
    "california": "CA",
    "colorado": "CO",
    "connecticut": "CT",
    "delaware": "DE",
    "district of columbia": "DC",
    "florida": "FL",
    "georgia": "GA",
    "hawaii": "HI",
    "idaho": "ID",
    "illinois": "IL",
    "indiana": "IN",
    "iowa": "IA",
    "kansas": "KS",
    "kentucky": "KY",
    "louisiana": "LA",
    "maine": "ME",
    "maryland": "MD",
    "massachusetts": "MA",
    "michigan": "MI",
    "minnesota": "MN",
    "mississippi": "MS",
    "missouri": "MO",
    "montana": "MT",
    "nebraska": "NE",
    "nevada": "NV",
    "new hampshire": "NH",
    "new jersey": "NJ",
    "new mexico": "NM",
    "new york": "NY",
    "north carolina": "NC",
    "north dakota": "ND",
    "ohio": "OH",
    "oklahoma": "OK",
    "oregon": "OR",
    "pennsylvania": "PA",
    "rhode island": "RI",
    "south carolina": "SC",
    "south dakota": "SD",
    "tennessee": "TN",
    "texas": "TX",
    "utah": "UT",
    "vermont": "VT",
    "virginia": "VA",
    "washington": "WA",
    "west virginia": "WV",
    "wisconsin": "WI",
    "wyoming": "WY",
    "alberta": "AB",
    "british columbia": "BC",
    "manitoba": "MB",
    "new brunswick": "NB",
    "newfoundland and labrador": "NL",
    "nova scotia": "NS",
    "ontario": "ON",
    "prince edward island": "PE",
    "quebec": "QC",
    "québec": "QC",
    "saskatchewan": "SK",
}


def norm_country(v: str | None) -> str:
    t = (v or "").strip()
    if len(t) == 2:
        return t.upper()
    return _COUNTRIES.get(t.lower(), t.upper()[:2] if t else "")


def norm_region(v: str | None) -> str:
    t = (v or "").strip()
    return _REGIONS.get(t.lower(), t.upper())


def jurisdiction_label(c: TaxCertificate) -> str:
    if c.multistate_form:
        form = MULTISTATE.get(c.multistate_form, c.multistate_form)
        return f"{c.country} · {form}: {', '.join(c.covered_regions or [])}"
    return f"{c.country}-{c.region}" if c.region else c.country


def is_valid(c: TaxCertificate, on: date | None = None) -> bool:
    on = on or today()
    return (
        c.status == "active"
        and c.deleted_at is None
        and (c.expires_on is None or c.expires_on >= on)
        and (c.issued_on is None or c.issued_on <= on)
    )


def covers(c: TaxCertificate, country: str, region: str, location_id: uuid.UUID | None = None) -> bool:
    country, region = norm_country(country), norm_region(region)
    if not country or norm_country(c.country) != country:
        return False
    if c.location_ids and location_id is not None and str(location_id) not in {str(x) for x in c.location_ids}:
        return False
    if c.multistate_form:
        return region in {norm_region(r) for r in c.covered_regions or []}
    return not c.region or norm_region(c.region) == region


def covering_certificate(
    org_id: uuid.UUID,
    *,
    vendor_id: uuid.UUID | None,
    country: str,
    region: str,
    location_id: uuid.UUID | None = None,
    on: date | None = None,
    customer_id: uuid.UUID | None = None,
    require_vendor: bool = True,
) -> TaxCertificate | None:
    """A valid certificate covering the jurisdiction; for purchases, one the vendor has on file (or was sent)."""
    q = select(TaxCertificate).where(
        TaxCertificate.org_id == org_id,
        TaxCertificate.deleted_at.is_(None),
        TaxCertificate.status == "active",
        TaxCertificate.customer_id == customer_id if customer_id else TaxCertificate.customer_id.is_(None),
    )
    if require_vendor:
        if vendor_id is None:
            return None
        q = q.join(CertificateVendor, CertificateVendor.certificate_id == TaxCertificate.id).where(
            CertificateVendor.vendor_id == vendor_id, CertificateVendor.status.in_(("on_file", "sent"))
        )
    for c in db.session.scalars(q.order_by(TaxCertificate.expires_on.desc().nulls_first())):
        if is_valid(c, on) and covers(c, country, region, location_id):
            return c
    return None


def exemption_for_po(
    org_id: uuid.UUID, vendor_id: uuid.UUID | None, address: Any, location_id: uuid.UUID | None
) -> Any:
    """mpro.purchasing.hooks.EXEMPTION_LOOKUPS: the certificate that makes a PO tax-exempt, if any.

    The jurisdiction is the shipping address's (or else the receiving location's)."""
    country = region = ""
    if isinstance(address, dict):
        country, region = str(address.get("country") or ""), str(address.get("region") or "")
    elif address is not None:
        country, region = getattr(address, "country", "") or "", getattr(address, "region", "") or ""
    if (not country or not region) and location_id is not None:
        from mpro.assets.models import Location

        loc = db.session.get(Location, location_id)
        if loc is not None and loc.org_id == org_id:
            country, region = country or loc.country, region or loc.region
    if not country:
        return None
    return covering_certificate(
        org_id, vendor_id=vendor_id, country=norm_country(country), region=norm_region(region), location_id=location_id
    )


# ---------------------------------------------------------------- CRUD


def _validate(org_id: uuid.UUID, c: TaxCertificate, data: dict[str, Any]) -> None:
    if "type" in data:
        if data["type"] not in CERTIFICATE_TYPES:
            raise RuleError("Pick a certificate type.", 422)
        c.type = data["type"]
    if "type_label" in data:
        c.type_label = str(data["type_label"] or "").strip()[:120]
    if "country" in data:
        c.country = norm_country(str(data["country"] or ""))
        if len(c.country) != 2:
            raise RuleError("Pick a country.", 422)
    if "region" in data:
        c.region = norm_region(str(data["region"] or ""))[:80]
    if "multistate_form" in data:
        if data["multistate_form"] not in MULTISTATE:
            raise RuleError("Pick SST, MTC or none.", 422)
        c.multistate_form = data["multistate_form"]
    if "covered_regions" in data:
        v = data["covered_regions"]
        if not isinstance(v, list) or len(v) > 60:
            raise RuleError("Covered regions must be a list.", 422)
        c.covered_regions = sorted({norm_region(str(x)) for x in v if str(x).strip()})
    for k, n in (("number", 120), ("legal_entity", 255)):
        if k in data:
            setattr(c, k, str(data[k] or "").strip()[:n])
    if "scope_notes" in data:
        c.scope_notes = str(data["scope_notes"] or "")[:4000]
    if "issued_on" in data:
        c.issued_on = parse_date(data["issued_on"], "issue date")
    if "expires_on" in data:
        c.expires_on = parse_date(data["expires_on"], "expiry date")
    if c.issued_on and c.expires_on and c.expires_on < c.issued_on:
        raise RuleError("The expiry date is before the issue date.", 422)
    if "location_ids" in data:
        from mpro.assets.models import Location

        ids = data["location_ids"] or []
        if not isinstance(ids, list):
            raise RuleError("Sites must be a list.", 422)
        c.location_ids = [str(get_in_org(Location, org_id, x, "location", allow_none=False).id) for x in ids]
    for k in ("reminder_user_ids", "card_user_ids"):
        if k in data:
            c.__setattr__(k, _member_ids(org_id, data[k]))
    if "customer_id" in data:
        from mpro.vendors.models import Customer

        cust = get_in_org(Customer, org_id, data["customer_id"], "customer")
        c.customer_id = cust.id if cust else None
    if c.multistate_form and not c.covered_regions:
        raise RuleError("List the states this multistate form covers.", 422)


def _member_ids(org_id: uuid.UUID, ids: Any) -> list[str]:
    from mpro.orgs.models import Membership

    if not isinstance(ids, list) or len(ids) > 200:
        raise RuleError("People must be a list.", 422)
    out = []
    for x in ids:
        try:
            uid = uuid.UUID(str(x))
        except ValueError as e:
            raise RuleError("That person isn't in this organization.", 404) from e
        ok = db.session.scalar(
            select(Membership.id).where(
                Membership.org_id == org_id, Membership.user_id == uid, Membership.deleted_at.is_(None)
            )
        )
        if not ok:
            raise RuleError("That person isn't in this organization.", 404)
        out.append(str(uid))
    return out


def create(org_id: uuid.UUID, user: Any, data: dict[str, Any]) -> TaxCertificate:
    c = TaxCertificate(org_id=org_id, created_by_id=user.id, type="resale", country="US", status="active")
    _validate(org_id, c, {"type": "resale", "country": "US", **data})
    db.session.add(c)
    db.session.flush()
    _index(c, user.id)
    emit(
        "tax_certificate.created",
        entity_type="tax_certificate",
        entity_id=c.id,
        entity_label=label(c),
        summary=f"Added {label(c)}",
        org_id=org_id,
    )
    return c


def update(org_id: uuid.UUID, c: TaxCertificate, data: dict[str, Any], user: Any) -> TaxCertificate:
    before = cert_dict(c, files=False)
    _validate(org_id, c, data)
    if "expires_on" in data and before["expires_on"] != (c.expires_on.isoformat() if c.expires_on else None):
        c.reminders_sent = []
    _index(c, user.id)
    after = cert_dict(c, files=False)
    emit(
        "tax_certificate.updated",
        entity_type="tax_certificate",
        entity_id=c.id,
        entity_label=label(c),
        summary="Edited",
        changes=diff(before, after),
        org_id=org_id,
    )
    return c


def retire(org_id: uuid.UUID, c: TaxCertificate) -> TaxCertificate:
    c.status = "retired"
    emit(
        "tax_certificate.retired",
        entity_type="tax_certificate",
        entity_id=c.id,
        entity_label=label(c),
        summary="Retired",
        org_id=org_id,
    )
    return c


def delete(org_id: uuid.UUID, c: TaxCertificate) -> None:
    vault.assert_deletable(org_id, "tax_certificate", c.id)
    c.deleted_at = utcnow()
    emit(
        "tax_certificate.deleted",
        entity_type="tax_certificate",
        entity_id=c.id,
        entity_label=label(c),
        summary="Deleted",
        org_id=org_id,
    )


def renew(org_id: uuid.UUID, old: TaxCertificate, data: dict[str, Any], user: Any) -> TaxCertificate:
    """A renewed certificate is a new record (history kept); vendors on file get it automatically when set to."""
    if old.status != "active":
        raise RuleError("Only active certificates can be renewed.", 409)
    new = TaxCertificate(
        org_id=org_id,
        customer_id=old.customer_id,
        type=old.type,
        type_label=old.type_label,
        country=old.country,
        region=old.region,
        multistate_form=old.multistate_form,
        covered_regions=list(old.covered_regions or []),
        number=old.number,
        legal_entity=old.legal_entity,
        location_ids=list(old.location_ids or []),
        scope_notes=old.scope_notes,
        reminder_user_ids=list(old.reminder_user_ids or []),
        card_user_ids=list(old.card_user_ids or []),
        renewed_from_id=old.id,
        status="active",
        created_by_id=user.id,
    )
    _validate(org_id, new, data)
    if new.expires_on is None:
        raise RuleError("Enter the new expiry date.", 422)
    db.session.add(new)
    old.status = "retired"
    db.session.flush()
    for cv in db.session.scalars(select(CertificateVendor).where(CertificateVendor.certificate_id == old.id)):
        db.session.add(
            CertificateVendor(
                org_id=org_id,
                certificate_id=new.id,
                vendor_id=cv.vendor_id,
                status="not_sent",
                vendor_account_id=cv.vendor_account_id,
                auto_resend=cv.auto_resend,
            )
        )
    db.session.flush()
    _index(new, user.id)
    emit(
        "tax_certificate.renewed",
        entity_type="tax_certificate",
        entity_id=new.id,
        entity_label=label(new),
        summary=f"Renewed until {new.expires_on:%b %d, %Y}",
        data={"renewed_from_id": old.id},
        org_id=org_id,
    )
    return new


def resend_after_renewal(org_id: uuid.UUID, c: TaxCertificate, user: Any) -> int:
    """Send the renewed certificate to every vendor that had the old one, where auto-resend is on."""
    n = 0
    for cv in db.session.scalars(
        select(CertificateVendor).where(
            CertificateVendor.certificate_id == c.id, CertificateVendor.auto_resend.is_(True)
        )
    ):
        try:
            send_to_vendor(org_id, c, cv.vendor_id, user)
            n += 1
        except RuleError:
            continue  # no email for this vendor: it stays "not sent" and shows in the registry
    return n


def label(c: TaxCertificate) -> str:
    t = c.type_label if c.type == "custom" and c.type_label else TYPE_LABELS.get(c.type, c.type)
    return f"{t} · {jurisdiction_label(c)}" + (f" #{c.number}" if c.number else "")


def _index(c: TaxCertificate, user_id: uuid.UUID | None) -> None:
    first = _scan_links(c)
    vault.index(
        c.org_id,
        "certificate",
        "tax_certificate",
        c.id,
        title=label(c),
        file_id=first[0].file_id if first else None,
        customer_id=c.customer_id,
        doc_date=c.issued_on,
        search_text=f"{c.number} {c.legal_entity} {c.scope_notes}",
        user_id=user_id,
    )


def _scan_links(c: TaxCertificate) -> list[FileLink]:
    return links_for("tax_certificate", c.id)


def add_scan(org_id: uuid.UUID, c: TaxCertificate, name: str, data: bytes, user: Any, role: str = "file") -> FileObject:
    """Certificate scans and card images are stored encrypted at rest."""
    from mpro.core.files import sniff_type

    ctype = sniff_type(name, data[:512])
    if not (ctype.startswith("image/") or ctype == "application/pdf"):
        raise RuleError("Upload a PDF or a picture of the certificate.", 422)
    f = save_file(org_id, name, data, user.id, content_type=ctype, encrypt=True)
    if role == "card":
        c.card_file_id = f.id
    else:
        attach(f, "tax_certificate", c.id, "file")
    db.session.flush()
    _index(c, user.id)
    emit(
        "tax_certificate.file_added",
        entity_type="tax_certificate",
        entity_id=c.id,
        entity_label=label(c),
        summary=f"Added {'card picture' if role == 'card' else 'scan'} {f.name}",
        org_id=org_id,
    )
    return f


def log_access(org_id: uuid.UUID, c: TaxCertificate, user: Any, action: str) -> None:
    ip = ""
    if has_request_context():
        ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()[:60]
    db.session.add(
        CertificateAccess(
            org_id=org_id, certificate_id=c.id, user_id=getattr(user, "id", None), action=action, ip=ip, at=utcnow()
        )
    )


def access_log(c: TaxCertificate, limit: int = 100) -> list[dict[str, Any]]:
    rows = db.session.scalars(
        select(CertificateAccess)
        .where(CertificateAccess.certificate_id == c.id)
        .order_by(CertificateAccess.at.desc())
        .limit(limit)
    ).all()
    return [{"action": r.action, "user": user_label(r.user_id), "at": iso(r.at), "ip": r.ip} for r in rows]


# ---------------------------------------------------------------- vendor registry


def registry_dict(cv: CertificateVendor) -> dict[str, Any]:
    return {
        "id": str(cv.id),
        "vendor": vendor_label(cv.vendor_id),
        "status": cv.status,
        "sent_at": iso(cv.sent_at),
        "sent_to": cv.sent_to,
        "vendor_account_id": cv.vendor_account_id,
        "auto_resend": cv.auto_resend,
    }


def set_vendor(org_id: uuid.UUID, c: TaxCertificate, data: dict[str, Any]) -> CertificateVendor:
    from mpro.vendors.models import Vendor

    v = get_in_org(Vendor, org_id, data.get("vendor_id"), "vendor", allow_none=False)
    cv = db.session.scalars(
        select(CertificateVendor).where(CertificateVendor.certificate_id == c.id, CertificateVendor.vendor_id == v.id)
    ).first()
    if cv is None:
        cv = CertificateVendor(org_id=org_id, certificate_id=c.id, vendor_id=v.id, status="not_sent")
        db.session.add(cv)
    if "status" in data:
        if data["status"] not in ("not_sent", "sent", "on_file", "rejected"):
            raise RuleError("Pick a status.", 422)
        cv.status = data["status"]
    if "vendor_account_id" in data:
        cv.vendor_account_id = str(data["vendor_account_id"] or "").strip()[:120]
    if "auto_resend" in data:
        cv.auto_resend = bool(data["auto_resend"])
    db.session.flush()
    emit(
        "tax_certificate.vendor_updated",
        entity_type="tax_certificate",
        entity_id=c.id,
        entity_label=label(c),
        summary=f"{v.name}: {cv.status.replace('_', ' ')}",
        data={"vendor_id": v.id},
        org_id=org_id,
    )
    return cv


def remove_vendor(org_id: uuid.UUID, c: TaxCertificate, vendor_id: str) -> None:
    cv = db.session.scalars(
        select(CertificateVendor).where(
            CertificateVendor.certificate_id == c.id, CertificateVendor.vendor_id == uuid.UUID(vendor_id)
        )
    ).first()
    if cv is None or cv.org_id != org_id:
        raise RuleError("That vendor isn't on this certificate.", 404)
    db.session.delete(cv)


def _vendor_email(vendor: Any) -> str:
    from mpro.vendors.models import VendorContact

    contacts = db.session.scalars(
        select(VendorContact).where(VendorContact.vendor_id == vendor.id, VendorContact.deleted_at.is_(None))
    ).all()
    for ct in sorted(contacts, key=lambda x: (not x.is_po_contact,)):
        if ct.email and "@" in ct.email:
            return str(ct.email)
    return vendor.email if vendor.email and "@" in vendor.email else ""


def send_to_vendor(
    org_id: uuid.UUID, c: TaxCertificate, vendor_id: Any, user: Any, to: str = "", message: str = ""
) -> CertificateVendor:
    """Email the certificate (scans attached) to the vendor; the registry records when and to whom."""
    from mpro.orgs.models import Organization
    from mpro.vendors.models import Vendor

    if not is_valid(c):
        raise RuleError("This certificate isn't valid (expired, retired or not yet issued).", 409)
    v = get_in_org(Vendor, org_id, vendor_id, "vendor", allow_none=False)
    to = (to or _vendor_email(v)).strip()
    if "@" not in to:
        raise RuleError(f"{v.name} has no email address. Add a contact with an email first.", 422)
    scans = _scan_links(c)
    if not scans:
        raise RuleError("Add a scan of the certificate before sending it.", 422)
    org = db.session.get(Organization, org_id)
    org_name = org.name if org else "Our organization"
    body = (
        f"Hello {v.name},\n\n{org_name} is sending its tax exemption certificate for your records.\n\n"
        f"Certificate: {label(c)}\nLegal entity: {c.legal_entity or org_name}\n"
        + (f"Valid until: {c.expires_on:%B %d, %Y}\n" if c.expires_on else "")
        + (f"\n{message.strip()}\n" if message.strip() else "")
        + "\nPlease apply it to our account so purchases aren't charged sales tax.\n\nThank you."
    )
    files = [db.session.get(FileObject, ln.file_id) for ln in scans]
    send_email(
        to,
        f"Tax exemption certificate from {org_name}",
        body,
        org_id=org_id,
        attachments=[{"file_id": f.id, "name": f.name} for f in files if f],
    )
    cv = set_vendor(org_id, c, {"vendor_id": str(v.id)})
    if cv.status in ("not_sent", "rejected"):
        cv.status = "sent"
    cv.sent_at = utcnow()
    cv.sent_to = to[:255]
    log_access(org_id, c, user, "send")
    emit(
        "tax_certificate.sent",
        entity_type="tax_certificate",
        entity_id=c.id,
        entity_label=label(c),
        summary=f"Sent to {v.name} ({to})",
        data={"vendor_id": v.id},
        org_id=org_id,
    )
    return cv


# ---------------------------------------------------------------- reminders


def reminders(on: date | None = None) -> int:
    """Daily: remind 60 / 30 / 7 days (settings) before a certificate expires; once per threshold per expiry."""
    from mpro.auth.models import User
    from mpro.finance.settings import finance_settings
    from mpro.orgs.models import Membership, Organization

    on = on or today()
    sent = 0
    rows = db.session.scalars(
        select(TaxCertificate).where(
            TaxCertificate.deleted_at.is_(None),
            TaxCertificate.status == "active",
            TaxCertificate.expires_on.is_not(None),
            TaxCertificate.expires_on >= on,
            TaxCertificate.expires_on <= on + timedelta(days=366),
        )
    ).all()
    for c in rows:
        org = db.session.get(Organization, c.org_id)
        if org is None or org.deleted_at is not None:
            continue
        assert c.expires_on is not None
        left = (c.expires_on - on).days
        thresholds = [int(x) for x in finance_settings(c.org_id).get("certificate_reminder_days") or [60, 30, 7]]
        due = [t for t in thresholds if left <= t and t not in (c.reminders_sent or [])]
        if not due:
            continue
        users = [uuid.UUID(x) for x in c.reminder_user_ids or []]
        if not users:
            users = list(
                db.session.scalars(
                    select(Membership.user_id).where(
                        Membership.org_id == c.org_id,
                        Membership.role.in_(("owner", "admin")),
                        Membership.deleted_at.is_(None),
                    )
                )
            )
        emails = sorted(
            set(
                db.session.scalars(
                    select(User.email)
                    .join(Membership, Membership.user_id == User.id)
                    .where(User.id.in_(users), Membership.org_id == c.org_id, Membership.deleted_at.is_(None))
                )
            )
        )
        body = (
            f"The tax exemption certificate {label(c)} expires on {c.expires_on:%B %d, %Y} "
            f"({left} day{'s' if left != 1 else ''} from now).\n\nRenew it in Finance → Tax certificates; "
            "vendors on file get the renewed certificate automatically."
        )
        for e in emails:
            send_email(e, f"Tax certificate expires in {left} days: {label(c)}", body, org_id=c.org_id)
            sent += 1
        c.reminders_sent = sorted(set((c.reminders_sent or []) + due))
        emit(
            "tax_certificate.reminder",
            entity_type="tax_certificate",
            entity_id=c.id,
            entity_label=label(c),
            summary=f"Expiry reminder ({left} days left)",
            org_id=c.org_id,
        )
    db.session.commit()
    return sent


# ---------------------------------------------------------------- views


def can_show_card(c: TaxCertificate, user_id: uuid.UUID, manage: bool) -> bool:
    return manage or str(user_id) in {str(x) for x in c.card_user_ids or []}


def card(org_id: uuid.UUID, c: TaxCertificate, user: Any) -> dict[str, Any]:
    """The mobile exemption card: details plus the card picture inline, so the phone can keep it for offline use."""
    from mpro.orgs.models import Organization

    if not is_valid(c):
        raise RuleError("This certificate isn't valid any more.", 409)
    f = db.session.get(FileObject, c.card_file_id) if c.card_file_id else None
    if f is None:
        scans = [db.session.get(FileObject, ln.file_id) for ln in _scan_links(c)]
        f = next((x for x in scans if x is not None and x.content_type.startswith("image/")), None)
    image = None
    if f is not None and f.deleted_at is None and f.content_type.startswith("image/") and f.size <= 4 * 1024 * 1024:
        image = f"data:{f.content_type};base64," + base64.b64encode(read_bytes(f)).decode()
    org = db.session.get(Organization, org_id)
    log_access(org_id, c, user, "show_card")
    return {
        "id": str(c.id),
        "org_name": org.name if org else "",
        "watermark": f"For {org.name if org else 'organization'} employees only",
        "type": TYPE_LABELS.get(c.type, c.type) if c.type != "custom" else c.type_label or "Exemption",
        "jurisdiction": jurisdiction_label(c),
        "number": c.number,
        "legal_entity": c.legal_entity,
        "expires_on": c.expires_on.isoformat() if c.expires_on else None,
        "image": image,
        "fetched_at": iso(utcnow()),
    }


def cert_dict(c: TaxCertificate, files: bool = True, *, manage: bool = True) -> dict[str, Any]:
    on = today()
    d: dict[str, Any] = {
        "id": str(c.id),
        "label": label(c),
        "type": c.type,
        "type_label": c.type_label,
        "type_name": TYPE_LABELS.get(c.type, c.type),
        "country": c.country,
        "region": c.region,
        "multistate_form": c.multistate_form,
        "covered_regions": list(c.covered_regions or []),
        "jurisdiction": jurisdiction_label(c),
        "number": c.number,
        "legal_entity": c.legal_entity,
        "location_ids": list(c.location_ids or []),
        "issued_on": c.issued_on.isoformat() if c.issued_on else None,
        "expires_on": c.expires_on.isoformat() if c.expires_on else None,
        "days_left": (c.expires_on - on).days if c.expires_on else None,
        "scope_notes": c.scope_notes,
        "status": c.status,
        "valid": is_valid(c),
        "renewed_from_id": str(c.renewed_from_id) if c.renewed_from_id else None,
        "customer_id": str(c.customer_id) if c.customer_id else None,
        "reminder_user_ids": list(c.reminder_user_ids or []),
        "card_user_ids": list(c.card_user_ids or []),
        "has_card": bool(c.card_file_id),
        "created_at": iso(c.created_at),
    }
    if files and manage:
        d["files"] = [file_dict(ln.file, ln.role, ln.id) for ln in _scan_links(c)]
        d["vendors"] = [
            registry_dict(cv)
            for cv in db.session.scalars(
                select(CertificateVendor)
                .where(CertificateVendor.certificate_id == c.id)
                .order_by(CertificateVendor.created_at)
            )
        ]
        renewed = db.session.scalars(select(TaxCertificate.id).where(TaxCertificate.renewed_from_id == c.id)).first()
        d["renewed_by_id"] = str(renewed) if renewed else None
    return d


def list_certs(org_id: uuid.UUID, args: dict[str, Any], *, manage: bool, user_id: uuid.UUID) -> dict[str, Any]:
    q = select(TaxCertificate).where(TaxCertificate.org_id == org_id, TaxCertificate.deleted_at.is_(None))
    if not manage:  # people allowed to show a card see only those certificates
        q = q.where(TaxCertificate.card_user_ids.is_not(None))
        rows = [
            c for c in db.session.scalars(q) if str(user_id) in {str(x) for x in c.card_user_ids or []} and is_valid(c)
        ]
        return {
            "items": [cert_dict(c, files=False, manage=False) for c in rows],
            "total": len(rows),
            "page": 1,
            "per_page": len(rows) or 1,
        }
    status = args.get("status", "active")
    if status in ("active", "retired"):
        q = q.where(TaxCertificate.status == status)
    if args.get("expiring") == "1":
        q = q.where(TaxCertificate.expires_on.is_not(None), TaxCertificate.expires_on <= today() + timedelta(days=60))
    if args.get("holder") == "customers":
        q = q.where(TaxCertificate.customer_id.is_not(None))
    elif args.get("holder") == "org":
        q = q.where(TaxCertificate.customer_id.is_(None))
    if args.get("customer_id"):
        try:
            q = q.where(TaxCertificate.customer_id == uuid.UUID(str(args["customer_id"])))
        except ValueError:
            return {"items": [], "total": 0, "page": 1, "per_page": 50}
    if args.get("q"):
        like = f"%{str(args['q']).strip()[:80]}%"
        q = q.where(
            or_(
                TaxCertificate.number.ilike(like),
                TaxCertificate.legal_entity.ilike(like),
                TaxCertificate.region.ilike(like),
            )
        )
    q = q.order_by(TaxCertificate.expires_on.asc().nulls_last(), TaxCertificate.created_at)
    return paged(q, args, lambda c: cert_dict(c, files=False))


def exempt_purchases(org_id: uuid.UUID, start: date | None = None, end: date | None = None) -> list[dict[str, Any]]:
    """Exempt purchases by certificate and jurisdiction (tax audits): exempt POs and receipts tied to a certificate."""
    from mpro.finance.models import Receipt
    from mpro.purchasing.models import PurchaseOrder

    certs = {c.id: c for c in db.session.scalars(select(TaxCertificate).where(TaxCertificate.org_id == org_id))}
    rows: list[dict[str, Any]] = []
    q = select(PurchaseOrder).where(
        PurchaseOrder.org_id == org_id,
        PurchaseOrder.deleted_at.is_(None),
        PurchaseOrder.tax_exempt.is_(True),
        PurchaseOrder.status != "canceled",
    )
    for po in db.session.scalars(q):
        d = (po.approved_at or po.created_at).date()
        if (start and d < start) or (end and d > end):
            continue
        c = certs.get(po.tax_certificate_id) if po.tax_certificate_id else None
        rows.append(
            {
                "certificate": label(c) if c else "",
                "certificate_id": str(c.id) if c else None,
                "jurisdiction": jurisdiction_label(c) if c else "",
                "kind": "purchase_order",
                "reference": po.custom_number or f"PO-{po.number}",
                "record_id": str(po.id),
                "vendor": (vendor_label(po.vendor_id) or {}).get("name", ""),
                "date": d.isoformat(),
                "amount": s(po.total),
                "tax_charged": "0",
                "currency": po.currency,
            }
        )
    for r in db.session.scalars(
        select(Receipt).where(
            Receipt.org_id == org_id, Receipt.deleted_at.is_(None), Receipt.tax_certificate_id.is_not(None)
        )
    ):
        if r.purchased_on and ((start and r.purchased_on < start) or (end and r.purchased_on > end)):
            continue
        c = certs.get(r.tax_certificate_id) if r.tax_certificate_id else None
        rows.append(
            {
                "certificate": label(c) if c else "",
                "certificate_id": str(c.id) if c else None,
                "jurisdiction": jurisdiction_label(c) if c else "",
                "kind": "receipt",
                "reference": r.vendor_name,
                "record_id": str(r.id),
                "vendor": r.vendor_name,
                "date": r.purchased_on.isoformat() if r.purchased_on else "",
                "amount": s(r.total),
                "tax_charged": s(r.tax),
                "currency": r.currency,
            }
        )
    rows.sort(key=lambda x: (x["certificate"], x["date"]))
    return rows
