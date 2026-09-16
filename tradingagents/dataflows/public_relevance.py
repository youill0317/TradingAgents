"""Explicit industry exposure routing; a sector match is not company exposure."""

from collections import defaultdict

from .public_industry import census_sectors, matches_industry
from .public_korea import korean_industry_classification

_MACRO_SOURCES = {
    "ecos",
    "nyfed",
    "treasury",
    "ecb",
    "cftc",
    "eia",
    "fred",
    "ofr",
    "census",
    "bea",
    "bls",
    "oecd",
    "eurostat",
    "bis",
    "tic",
    "mof_japan",
}
_SECTOR_SOURCES = {"eia", "customs", "kosis", "cftc", "census", "bea", "bls", "eurostat"}


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
    "nonresidential": ("nonresidential", "commercial construction"),
    "food": ("food", "grocery", "beverage", "식료", "음료"),
}
_HS = {"8542": "semiconductors", "8703": "vehicles", "8507": "batteries",
       "3004": "pharmaceuticals", "2710": "petroleum", "7208": "metals"}
_INDUSTRY_SOURCES = {"census", "bea", "bls", "eurostat", "customs", "kosis", "eia"}


def exposures(text):
    text = str(text or "").casefold()
    return {group for group, terms in _EXPOSURES.items() if matches_industry(text, terms)}


def resolved_identity(identity, rows):
    """Use FSC classifications only when an existing industry field is absent.

    Multiple business lines do not get coerced to a single inferred sector.
    Only exact official industry labels classify a business; free-form business
    descriptions remain descriptive and never imply product exposure.
    """
    result = dict(identity or {})
    if result.get("industry"):
        return result
    labels = []
    classifications = []
    for row in rows:
        content = row.get("content")
        if row.get("source") != "fsc" or row.get("status") != "success" or not isinstance(content, dict):
            continue
        labels.extend(str(content[key]) for key in ("sicNm", "enpMainBizNm") if content.get(key))
        if content.get("sicNm"):
            classifications.append(korean_industry_classification(content["sicNm"]))
    if labels:
        label = " / ".join(dict.fromkeys(labels))
        result["industry"] = label
        result["classification_source"] = "FSC official business description"
        result["industry_groups"] = sorted({group for _, groups in classifications for group in groups})
        sectors = {sector for sectors, _ in classifications for sector in sectors}
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
    company_groups = set(identity["industry_groups"]) if "industry_groups" in identity else exposures(industry)
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
        # Provider classifiers own industry meaning. A report title (including
        # exclusions such as "less foods") must not override that classification.
        row_groups = set(row.get("industry_groups", []))
        if source == "census":
            # Code tags provide broad sector context, not a title-derived claim
            # of issuer exposure. Recompute for cached rows and derived series too.
            parts = (row.get("base_target") or row["target"]).split("/")
            item["sectors"] = census_sectors(parts[0], parts[1]) if len(parts) > 1 else []
            row_groups = set()
        if str(row.get("hs_code", "")) in _HS:
            row_groups = {_HS[row["hs_code"]]}
        matching = bool(company_groups & row_groups)
        if source == "eia":
            # Fuel costs can transmit to these industries without implying that
            # petroleum inventory describes the company's own balance sheet.
            matching = matching or sector == "energy" or "industry_groups" not in identity and industry.casefold() in {
                "airlines", "marine shipping", "integrated freight & logistics",
                "chemicals", "specialty chemicals",
            }
        if matching:
            item["relevance"] = "industry context; issuer exposure not quantified"
            item["routing_reason"] = f"Industry classification: {industry}"
        elif company_groups and row_groups:
            continue
        elif sector and sector in {s.casefold() for s in item.get("sectors", [])}:
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


_MARKET_SECTORS = (
    "Technology", "Healthcare", "Financial Services", "Consumer Cyclical",
    "Consumer Defensive", "Industrials", "Energy", "Utilities", "Real Estate",
    "Basic Materials", "Communication Services",
)


def selected_public_sectors(state):
    """Use requested sectors or captured raw screens, never model-authored prose."""
    canonical = {s.casefold(): s for s in _MARKET_SECTORS}
    requested = state.get("requested_sectors") or []
    if requested:
        return list(dict.fromkeys(canonical[s.casefold()] for s in requested
                                  if isinstance(s, str) and s.casefold() in canonical))
    found, in_screen = [], False
    for line in str(state.get("screen_evidence") or "").splitlines():
        line = line.strip()
        if line.startswith("## Equity screen"):
            in_screen = True
        elif line.startswith("## "):
            in_screen = False
        elif in_screen and line.startswith("### "):
            name = line[4:].split(" (", 1)[0].strip().casefold()
            if name in canonical and canonical[name] not in found:
                found.append(canonical[name])
    return found


def assigned_public_rows(state, role):
    """One routing contract for prompts and citation/coverage checks."""
    rows = state.get("public_data_evidence", [])
    industry_sources = set()
    identity = resolved_identity(state.get("instrument_identity", {}), rows)
    industry = identity.get("industry", "").casefold() if "industry_groups" not in identity else ""
    sector = identity.get("sector", "").casefold()
    if state.get("asset_type", "stock") == "stock":
        if sector in {"energy", "utilities"} or industry in {
            "airlines",
            "marine shipping",
            "integrated freight & logistics",
            "chemicals",
            "specialty chemicals",
        }:
            industry_sources.add("eia")
        if {"semiconductors", "hardware"}.intersection(identity.get("industry_groups", [])) or "semiconductor" in industry or industry in {
            "electronic components",
            "consumer electronics",
            "computer hardware",
            "electronic equipment & parts",
        }:
            industry_sources.update({"customs", "kosis"})
    news = {"sec", "dart", "ecos", "nyfed", "treasury", "ecb", "fred", "ofr"} | (
        industry_sources & {"eia"}
    )
    # New industry feeds carry row-level sector tags, so only matching series
    # are assigned to a company's fundamental analysis.
    fundamentals = {
        "sec",
        "dart",
        "fsc",
        "customs",
        "kosis",
        "census",
        "bea",
        "bls",
        "eurostat",
    } | industry_sources
    sources = {
        "news": news,
        "fundamentals": fundamentals,
        "macro": _MACRO_SOURCES,
        "sector": _SECTOR_SOURCES,
        "ticker_review": news | fundamentals | {"cftc", "oecd", "bis", "tic", "mof_japan"},
        "market_review": _MACRO_SOURCES | _SECTOR_SOURCES,
    }[role]
    assigned = [row for row in rows if row["source"] in sources]
    if role == "sector":
        # The authoring/audit scope is fixed by the request, not later screen output.
        focus = {s.casefold() for s in state.get("requested_sectors") or []}
        if focus:
            # Keep untagged aggregates and explicit collection failures visible;
            # don't inject successful detailed observations for other sectors.
            assigned = [r for r in assigned if r.get("status") != "success"
                        or not r.get("sectors")
                        or focus.intersection(s.casefold() for s in r["sectors"])]
    if role in {"fundamentals", "ticker_review"}:
        assigned = route_ticker_rows(assigned, identity, legacy_sources=industry_sources)
    if role == "fundamentals":
        assigned = [row for row in assigned if row.get("evidence_type") != "filing_excerpt"]
    if role == "news":
        assigned = [
            row
            for row in assigned
            if row.get("evidence_type") not in {"financial_fact", "derived_financial"}
        ]
    return assigned, identity, industry_sources
