"""Market-scan report tree.

A separate writer from ``tradingagents.reporting.write_report_tree``: the two
workflows share no sections.
"""

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path


def write_market_report_tree(final_state: dict, save_path) -> Path:
    """Save a market scan's reports to ``save_path``; return the complete-report path.

    A separate writer from ``write_report_tree`` rather than a generalisation of
    it: the two workflows share no sections, so one function handling both would
    be a pile of empty-key checks rather than shared logic.
    """
    save_path = Path(save_path)
    save_path.mkdir(parents=True, exist_ok=True)

    trade_date = final_state.get("trade_date", "")
    sections = []

    parts = [
        ("global_snapshot", "global_data.md", "Collected Global Data"),
        ("global_context", "global_context.md", "Global News and Community Context"),
        ("market_diagnostics", "market_diagnostics.md", "Market Participation and Transitions"),
        ("event_calendar", "event_calendar.md", "Economic Catalysts"),
        ("macro_report", "macro.md", "I. Macro Analyst"),
        ("sector_report", "sector.md", "II. Sector Analyst"),
        ("market_bull_case", "bull_case.md", "Market Upside Case"),
        ("market_bear_case", "bear_case.md", "Market Downside Case"),
        ("market_bull_rebuttal", "bull_rebuttal.md", "Upside Rebuttal"),
        ("market_bear_rebuttal", "bear_rebuttal.md", "Downside Rebuttal"),
        ("market_draft_report", "market_draft.md", "Provisional Market Outlook"),
        ("market_risk_review", "risk_review.md", "Independent Risk Review"),
        ("market_scan_report", "strategist.md", "Final Market Strategist"),
    ]
    for key, filename, heading in parts:
        content = final_state.get(key)
        if not content:
            continue
        (save_path / filename).write_text(content, encoding="utf-8")
        sections.append(f"## {heading}\n\n{content}")

    complete = save_path / "complete_report.md"
    retrieved_at = datetime.now(UTC).isoformat()
    manifest = {
        "run_id": final_state.get("run_id"),
        "as_of_utc": final_state.get("as_of_utc"),
        "effective_market_session": final_state.get("effective_market_session"),
        "scan_mode": final_state.get("scan_mode"),
        "retrieved_at": retrieved_at,
        "code_commit": final_state.get("code_commit"),
        "config_hash": final_state.get("config_hash"),
        "models": {
            "quick": final_state.get("quick_model"),
            "deep": final_state.get("deep_model"),
        },
    }
    validation = {
        "status": final_state.get("scan_status") or "INCOMPLETE",
        "warnings": final_state.get("scan_warnings") or [],
        "required_reports": {
            key: bool(final_state.get(key))
            for key in ("macro_report", "sector_report", "market_scan_report")
        },
    }
    (save_path / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8"
    )
    (save_path / "validation.json").write_text(
        json.dumps(validation, indent=2, sort_keys=True), encoding="utf-8"
    )
    evidence_records = []
    for record in final_state.get("global_evidence", []):
        content = record.get("content") or ""
        evidence_records.append({
            **record,
            "sha256": hashlib.sha256(content.encode()).hexdigest(),
        })
    for source, key in (
        ("fred", "macro_evidence"),
        ("yahoo_sectors", "sector_evidence"),
        ("yahoo_screener", "screen_evidence"),
    ):
        content = final_state.get(key) or ""
        if content:
            evidence_records.append({
                "source": source,
                "retrieved_at": retrieved_at,
                "sha256": hashlib.sha256(content.encode()).hexdigest(),
                "content": content,
            })
    (save_path / "evidence.jsonl").write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in evidence_records),
        encoding="utf-8",
    )
    for key, filename in (("market_draft_result", "market_draft.json"),
                          ("market_diagnostics_data", "market_diagnostics.json"),
                          ("event_calendar_data", "event_calendar.json")):
        if key in final_state:
            (save_path / filename).write_text(
                json.dumps(final_state[key], indent=2, ensure_ascii=False, allow_nan=False), encoding="utf-8"
            )
    (save_path / "scan.json").write_text(
        json.dumps(final_state.get("market_scan_result") or {
            "status": validation["status"], "warnings": validation["warnings"],
            "candidates": [],
        }, indent=2, ensure_ascii=False), encoding="utf-8",
    )
    header = (
        f"# Market Scan — {trade_date}\n\n"
        f"_Generated {retrieved_at}._\n\n"
        f"**Validation:** {validation['status']}\n\n"
        "This is a scan, not a recommendation: every candidate below still needs "
        "its own analysis before it means anything.\n"
    )
    complete.write_text(header + "\n" + "\n\n".join(sections), encoding="utf-8")
    return complete
