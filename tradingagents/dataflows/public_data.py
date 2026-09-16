"""Optional official evidence shared by ticker and market analysis."""

import hashlib
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from datetime import datetime
from zoneinfo import ZoneInfo

from .public_analysis import baseline_overlap_report, build_diagnostics
from .public_data_common import evidence
from .public_digest import _evidence_priority as _evidence_priority, render_public_data
from .public_evidence import (
    SNAPSHOTS,
    assess_evidence,
    cited_evidence_report,
    coverage_report,
)
from .public_filings import collect_dart, collect_fsc, collect_sec
from .public_international import (
    collect_bis,
    collect_eurostat,
    collect_mof_japan,
    collect_oecd,
    collect_tic,
)
from .public_korea import collect_customs, collect_ecos, collect_kosis
from .public_macro import collect_bea, collect_bls, collect_census, collect_fred, collect_ofr
from .public_quality import core_evidence_report, render_quality
from .public_relevance import assigned_public_rows
from .public_us import collect_cftc, collect_ecb, collect_eia, collect_nyfed, collect_treasury

PUBLIC_SOURCES = {
    "sec": (collect_sec, ("SEC_USER_AGENT",)),
    "eia": (collect_eia, ("EIA_API_KEY",)),
    "nyfed": (collect_nyfed, ()),
    "cftc": (collect_cftc, ()),
    "treasury": (collect_treasury, ()),
    "ecb": (collect_ecb, ()),
    "ecos": (collect_ecos, ("ECOS_API_KEY",)),
    "customs": (collect_customs, ("DATA_GO_KR_API_KEY",)),
    "dart": (collect_dart, ("DART_API_KEY",)),
    "kosis": (collect_kosis, ("KOSIS_API_KEY",)),
    "fsc": (collect_fsc, ("DART_API_KEY", "DATA_GO_KR_API_KEY")),
    "fred": (collect_fred, ("FRED_API_KEY",)),
    "ofr": (collect_ofr, ()),
    "census": (collect_census, ()),
    "bea": (collect_bea, ("BEA_API_KEY",)),
    "bls": (collect_bls, ()),
    "oecd": (collect_oecd, ()),
    "eurostat": (collect_eurostat, ()),
    "bis": (collect_bis, ()),
    "tic": (collect_tic, ()),
    "mof_japan": (collect_mof_japan, ()),
}

_WORKFLOWS = {
    "news": "Separate dated filing events and actual document excerpts from macro context. Explain the catalyst, transmission to the business, and what remains unverified. An excerpt does not establish that a full filing was reviewed.",
    "fundamentals": "Start with SEC/DART issuer facts: revenue, margins, cash generation, balance sheet and financing. Compare matching periods, currencies and consolidated/standalone bases only. Then test demand, orders, shipments and inventories against the company's verified industry exposure. Aggregate industry data are corroboration, not issuer results. Identify conflicts with vendor financials and use filing dates to explain restatements.",
    "macro": "Evaluate (1) central-bank liquidity and money-market funding: FRED/NYFed/Treasury/ECB/ECOS; (2) credit supply, demand and stress: FRED SLOOS/OFR/BIS; (3) activity, labour and regional turning points: Census/BEA/BLS/Eurostat/OECD; (4) measured cross-border securities transactions: TIC/Japan MOF. Compare stocks, net transactions and valuation effects separately. CFTC positions are not flows. Give evidence-backed base/alternative cases, contradictions and invalidation signals.",
    "sector": "Build a supply/demand chain for each selected sector: orders and consumption -> production and shipments -> inventory -> pricing/margin exposure. Use Census/BEA/BLS/Eurostat and Korean customs/KOSIS/EIA where applicable. Distinguish nominal sales from real volumes, seasonally adjusted from unadjusted series, and annualized rates from monthly totals. Compare fundamental activity with observed price leadership before screening candidates; do not infer country/company exposure solely from a ticker.",
    "ticker_review": "Cross-check the investment thesis against dated issuer facts, relevant industry activity and liquidity/credit conditions. State the strongest conflicting official observation, the data gaps, and which observable change would invalidate the trade. Missing or stale evidence lowers confidence; it does not justify a neutral signal or invented position sizing.",
    "market_review": "Reconcile the macro regime and sector thesis with official activity, liquidity, stress and cross-border transactions. Identify contradictory readings and stale/missing sources; carry them into confidence, scenario conditions and risk constraints. Do not equate credit stocks, CFTC positions, securities holdings, valuation changes or ETF price returns with measured current capital flows.",
}


def public_data_for_agent(state, role):
    """Give each role only its evidence; downstream reviewers can verify the same facts."""
    rows = state.get("public_data_evidence", [])
    if not rows:
        return ""
    assigned, identity, industry_sources = assigned_public_rows(state, role)
    industry = identity.get("industry", "").casefold()
    sector = identity.get("sector", "").casefold()
    report = render_public_data(assigned, max_chars=28000)
    if assigned:
        report = core_evidence_report(assigned, role, state) + "\n\n" + coverage_report(assigned) + "\n\n" + report
        report += "\n" + baseline_overlap_report(state, assigned)
    if role in {"ticker_review", "market_review"}:
        report += "\n" + cited_evidence_report(state, rows)
    if role == "ticker_review" and state.get("public_data_quality"):
        report += "\n" + render_quality(state["public_data_quality"])
    if report:
        report += "\nOfficial-evidence analysis workflow: " + _WORKFLOWS[role]
        report += (
            "\nCite exact [ev-...] observation IDs for material official-data claims and retain "
            "those IDs in the analyst report. For a change, cite both endpoint observations or "
            "a derived record with operand lineage; use get_official_evidence to inspect omitted "
            "history. Report conflicting, stale and missing inputs explicitly. Collection or "
            "tool access alone is not evidence that a source supports your conclusion."
            " Address each available core analysis purpose above with cited evidence or an explicit "
            "reason it is not material. For official numerical comparisons cite both endpoints "
            "on the same line or a derived observation. Use start_date/end_date and "
            "observation_offset to inspect older collected history."
            " A provider_reported_change observation may support its own published growth figure with one ID; "
            "state its exact comparison basis (e.g. GDP QoQ), not a new change in that growth rate. "
            "For optional purposes not material to this analysis, write [official-exclude:purpose] followed by "
            "a specific reason (at least 12 characters). For a selected sector use its exact Sector/purpose key. "
            "Preserve these declarations in the report; they are recorded reasons, not validated economic conclusions. "
            "Issuer earnings, cash_flow and balance_sheet cannot be excluded: the final ticker decision must "
            "retain fresh issuer citations for each available core purpose or requires review. "
            "For each sector requested or actually screened, address its demand, production and inventory_costs "
            "with the sector's cited observations or a justified optional exclusion. Missing sector data stay explicit."
        )
    if role in {"news", "fundamentals", "ticker_review"}:
        if industry_sources & {row["source"] for row in assigned}:
            report += (
                "\nIndustry evidence was selected using the resolved business classification: "
                f"{identity.get('sector', 'unknown')} / {identity.get('industry', 'unknown')}. "
                "Explain the company's exposure; aggregate energy, activity or trade statistics "
                "are industry context, not this company's sales, inventory or financial results."
            )
        elif (
            not industry
            and not sector
            and any(row["source"] in {"eia", "customs", "kosis"} for row in rows)
        ):
            report += "\nIndustry-specific public data was not assigned: business classification is unavailable. Do not infer a company exposure from the ticker alone."
    return report


def selected_public_sources(config):
    value = config.get("public_data_sources", "")
    names = value.split(",") if isinstance(value, str) else value
    names = list(dict.fromkeys(name.strip().lower() for name in names if name.strip()))
    if names == ["all"]:
        return list(PUBLIC_SOURCES)
    unknown = set(names) - PUBLIC_SOURCES.keys()
    if unknown:
        raise ValueError("Unknown public data sources: " + ", ".join(sorted(unknown)))
    return names


def collect_public_data(trade_date, config, ticker=None, asset_type="stock"):
    """Collect selected sources; preserve failures and avoid current data in backtests."""
    selected = selected_public_sources(config)
    day = datetime.strptime(str(trade_date), "%Y-%m-%d").date()
    today = datetime.now(ZoneInfo("America/New_York")).date()
    korean = bool(ticker and re.fullmatch(r"\d{6}(?:\.(?:KS|KQ))?", ticker.upper()))
    for source in ("sec", "dart", "fsc"):
        applicable = (
            ticker
            and asset_type == "stock"
            and (
                korean
                if source != "sec"
                else re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*", ticker)
                or re.fullmatch(r"[A-Za-z]+\.[AB]", ticker.upper())
            )
        )
        if not applicable and source in selected:
            selected.remove(source)

    def collect(source):
        collector, keys = PUBLIC_SOURCES[source]
        missing = [key for key in keys if not os.environ.get(key, "").strip()]
        status, message = "", ""
        if day < today and source not in {"sec", "dart", "fred"}:
            status, message = (
                "unavailable_as_of",
                "Historical public-data collection is disabled: these feeds are not archived publication-time vintages.",
            )
        elif missing:
            status, message = "not_configured", "Set " + ", ".join(missing)
        else:
            try:
                if source in {"sec", "dart", "fsc"}:
                    rows = collector(ticker, str(trade_date))
                else:
                    # Reuse the same immutable macro/industry snapshot across
                    # tickers, not issuer facts. Credential changes invalidate it.
                    credential_digest = hashlib.sha256(json.dumps(
                        [(key, os.getenv(key, "")) for key in (*keys, "BLS_API_KEY")]
                    ).encode()).hexdigest()
                    ttl = float(config.get("public_data_cache_ttl_seconds", 300))
                    if not 0 <= ttl <= 3600:
                        raise ValueError("public_data_cache_ttl_seconds must be between 0 and 3600")
                    cache_key = (source, str(trade_date), collector, credential_digest, ttl)
                    rows = SNAPSHOTS.collect(cache_key, ttl, lambda: collector(str(trade_date)))
                if rows:
                    return rows
                status, message = "empty", "No matching observations or filings returned."
            except Exception as exc:
                # Request URLs can contain API keys. Never save exception text.
                status, message = (
                    "error",
                    f"Collection failed ({type(exc).__name__}); check credentials, provider availability and subscription.",
                )
        return [{**evidence(source, ticker or "market", message, None), "status": status}]

    if not selected:
        return {"report": "", "evidence": [], "warnings": []}
    with ThreadPoolExecutor(max_workers=min(4, len(selected))) as pool:
        futures = [pool.submit(copy_context().run, collect, source) for source in selected]
        batches = [future.result() for future in futures]
    rows = [row for batch in batches for row in batch]
    rows.extend(build_diagnostics(rows))
    warnings = assess_evidence(rows, trade_date)
    return {"report": render_public_data(rows), "evidence": rows, "warnings": warnings}
