"""Explicit industry exposure routing; a sector match is not company exposure."""

from collections import defaultdict

# Deliberately small and inspectable. Unknown classifications remain unknown.
_EXPOSURES = {
    "semiconductors": ("semiconductor", "integrated circuit", "반도체"),
    "hardware": ("computer hardware", "consumer electronics", "electronic components",
                 "electronic equipment", "컴퓨터", "전자부품"),
    "software": ("software", "소프트웨어"),
    "vehicles": ("motor vehicle", "automobile", "auto manufacturer", "자동차"),
    "batteries": ("electric accumulator", "battery", "batteries", "축전지", "이차전지"),
    "pharmaceuticals": ("pharma", "medicament", "drug manufacturer", "의약"),
    "petroleum": ("oil & gas", "petroleum", "crude oil", "gasoline", "석유", "정유"),
    "metals": ("steel", "metal", "철강", "금속"),
    "chemicals": ("chemical", "화학"),
    "machinery": ("machinery", "industrial machinery", "기계"),
    "housing": ("residential", "homebuild", "housing", "주택"),
    "food": ("food", "grocery", "beverage", "식료", "음료"),
}
_SECTORS = {
    "semiconductors": "Technology", "hardware": "Technology", "software": "Technology",
    "vehicles": "Consumer Cyclical", "pharmaceuticals": "Healthcare",
    "petroleum": "Energy", "metals": "Basic Materials", "chemicals": "Basic Materials",
    "machinery": "Industrials", "food": "Consumer Defensive",
}
_HS = {"8542": "semiconductors", "8703": "vehicles", "8507": "batteries",
       "3004": "pharmaceuticals", "2710": "petroleum", "7208": "metals"}
_INDUSTRY_SOURCES = {"census", "bea", "bls", "eurostat", "customs", "kosis", "eia"}


def exposures(text):
    text = str(text or "").casefold()
    return {group for group, terms in _EXPOSURES.items() if any(term in text for term in terms)}


def resolved_identity(identity, rows):
    """Use FSC classifications only when an existing industry field is absent.

    Multiple business lines do not get coerced to a single inferred sector.
    An official label is used for routing; it is not a revenue-exposure estimate.
    """
    result = dict(identity or {})
    if result.get("industry"):
        return result
    labels = []
    for row in rows:
        content = row.get("content")
        if row.get("source") != "fsc" or row.get("status") != "success" or not isinstance(content, dict):
            continue
        labels.extend(str(content[key]) for key in ("sicNm", "enpMainBizNm") if content.get(key))
    if labels:
        label = " / ".join(dict.fromkeys(labels))
        result["industry"] = label
        result["classification_source"] = "FSC official business description"
        sectors = {_SECTORS[group] for group in exposures(label) if group in _SECTORS}
        if not result.get("sector") and len(sectors) == 1:
            result["sector"] = sectors.pop()
    return result


def route_ticker_rows(rows, identity, *, legacy_sources=()):
    """Keep issuer/market context and route industry rows conservatively.

    Detailed mismatches (e.g. software versus semiconductor exports) are not
    auto-injected. Broad same-sector observations are explicitly labelled and
    capped per source. All raw observations remain available via the read tool.
    """
    sector = str(identity.get("sector") or "").casefold()
    industry = str(identity.get("industry") or "")
    company_groups = exposures(industry)
    broad = defaultdict(set)
    result = []
    for row in rows:
        source = row["source"]
        item = dict(row)
        if row.get("status") != "success":
            result.append(item)
            continue
        if source not in _INDUSTRY_SOURCES:
            item["relevance"] = "issuer evidence" if source in {"sec", "dart", "fsc"} else "macro context"
            result.append(item)
            continue
        title = str(row.get("title") or row.get("target") or "")
        row_groups = exposures(title)
        if str(row.get("hs_code", "")) in _HS:
            row_groups = {_HS[row["hs_code"]]}
        matching = bool(company_groups & row_groups)
        if source == "eia":
            # Fuel costs can transmit to these industries without implying that
            # petroleum inventory describes the company's own balance sheet.
            matching = matching or sector == "energy" or industry.casefold() in {
                "airlines", "marine shipping", "integrated freight & logistics",
                "chemicals", "specialty chemicals",
            }
        if matching:
            item["relevance"] = "industry context; issuer exposure not quantified"
            item["routing_reason"] = f"Industry classification: {industry}"
        elif company_groups and row_groups:
            continue
        elif sector and sector in {s.casefold() for s in row.get("sectors", [])}:
            # Limit SERIES, not the number of historical observations.
            if row["target"] not in broad[source]:
                if len(broad[source]) >= 2:
                    continue
                broad[source].add(row["target"])
            item["relevance"] = "broad sector context only; industry linkage unverified"
            item["routing_reason"] = "Sector classification only; do not infer company/product/geographic exposure."
        elif source in legacy_sources and "sectors" not in row:
            item["relevance"] = "industry context; legacy untagged record"
        else:
            continue
        result.append(item)
    return result
