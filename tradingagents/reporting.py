"""Reusable report-tree writer shared by the CLI and the programmatic API.

Writes a run's per-section markdown (analysts, research, trading, risk,
portfolio) plus a consolidated ``complete_report.md`` under ``save_path``. The
CLI and ``TradingAgentsGraph.save_reports`` both call this, so a headless / API
run produces the same on-disk report tree a CLI run does.
"""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def write_report_tree(final_state: dict, ticker: str, save_path) -> Path:
    """Save a completed run's reports to ``save_path``; return the complete-report path."""
    save_path = Path(save_path)
    save_path.mkdir(parents=True, exist_ok=True)
    sections = []
    if final_state.get("public_data_quality"):
        from tradingagents.dataflows.public_quality import render_quality

        quality = final_state["public_data_quality"]
        (save_path / "analysis_quality.json").write_text(
            json.dumps(quality, ensure_ascii=False, indent=2), encoding="utf-8",
        )
        sections.append("## Analysis Quality\n\n" + render_quality(quality))
    if final_state.get("public_data_report"):
        (save_path / "public_data.md").write_text(final_state["public_data_report"], encoding="utf-8")
        sections.append(f"## Official Public Data\n\n{final_state['public_data_report']}")

    # 1. Analysts
    analysts_dir = save_path / "1_analysts"
    analyst_parts = []
    if final_state.get("market_report"):
        analysts_dir.mkdir(exist_ok=True)
        (analysts_dir / "market.md").write_text(final_state["market_report"], encoding="utf-8")
        analyst_parts.append(("Market Analyst", final_state["market_report"]))
    if final_state.get("sentiment_report"):
        analysts_dir.mkdir(exist_ok=True)
        (analysts_dir / "sentiment.md").write_text(final_state["sentiment_report"], encoding="utf-8")
        analyst_parts.append(("Sentiment Analyst", final_state["sentiment_report"]))
    if final_state.get("news_report"):
        analysts_dir.mkdir(exist_ok=True)
        (analysts_dir / "news.md").write_text(final_state["news_report"], encoding="utf-8")
        analyst_parts.append(("News Analyst", final_state["news_report"]))
    if final_state.get("fundamentals_report"):
        analysts_dir.mkdir(exist_ok=True)
        (analysts_dir / "fundamentals.md").write_text(final_state["fundamentals_report"], encoding="utf-8")
        analyst_parts.append(("Fundamentals Analyst", final_state["fundamentals_report"]))
    if analyst_parts:
        content = "\n\n".join(f"### {name}\n{text}" for name, text in analyst_parts)
        sections.append(f"## I. Analyst Team Reports\n\n{content}")

    # 2. Research
    if final_state.get("investment_debate_state"):
        research_dir = save_path / "2_research"
        debate = final_state["investment_debate_state"]
        research_parts = []
        if debate.get("bull_history"):
            research_dir.mkdir(exist_ok=True)
            (research_dir / "bull.md").write_text(debate["bull_history"], encoding="utf-8")
            research_parts.append(("Bull Researcher", debate["bull_history"]))
        if debate.get("bear_history"):
            research_dir.mkdir(exist_ok=True)
            (research_dir / "bear.md").write_text(debate["bear_history"], encoding="utf-8")
            research_parts.append(("Bear Researcher", debate["bear_history"]))
        if debate.get("judge_decision"):
            research_dir.mkdir(exist_ok=True)
            (research_dir / "manager.md").write_text(debate["judge_decision"], encoding="utf-8")
            research_parts.append(("Research Manager", debate["judge_decision"]))
        if research_parts:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in research_parts)
            sections.append(f"## II. Research Team Decision\n\n{content}")

    # 3. Trading
    if final_state.get("trader_investment_plan"):
        trading_dir = save_path / "3_trading"
        trading_dir.mkdir(exist_ok=True)
        (trading_dir / "trader.md").write_text(final_state["trader_investment_plan"], encoding="utf-8")
        sections.append(f"## III. Trading Team Plan\n\n### Trader\n{final_state['trader_investment_plan']}")

    # 4. Risk Management
    if final_state.get("risk_debate_state"):
        risk_dir = save_path / "4_risk"
        risk = final_state["risk_debate_state"]
        risk_parts = []
        if risk.get("aggressive_history"):
            risk_dir.mkdir(exist_ok=True)
            (risk_dir / "aggressive.md").write_text(risk["aggressive_history"], encoding="utf-8")
            risk_parts.append(("Aggressive Analyst", risk["aggressive_history"]))
        if risk.get("conservative_history"):
            risk_dir.mkdir(exist_ok=True)
            (risk_dir / "conservative.md").write_text(risk["conservative_history"], encoding="utf-8")
            risk_parts.append(("Conservative Analyst", risk["conservative_history"]))
        if risk.get("neutral_history"):
            risk_dir.mkdir(exist_ok=True)
            (risk_dir / "neutral.md").write_text(risk["neutral_history"], encoding="utf-8")
            risk_parts.append(("Neutral Analyst", risk["neutral_history"]))
        if risk_parts:
            content = "\n\n".join(f"### {name}\n{text}" for name, text in risk_parts)
            sections.append(f"## IV. Risk Management Team Decision\n\n{content}")

        # 5. Portfolio Manager
        if risk.get("judge_decision"):
            portfolio_dir = save_path / "5_portfolio"
            portfolio_dir.mkdir(exist_ok=True)
            (portfolio_dir / "decision.md").write_text(risk["judge_decision"], encoding="utf-8")
            sections.append(f"## V. Portfolio Manager Decision\n\n### Portfolio Manager\n{risk['judge_decision']}")

    if final_state.get("public_data_evidence"):
        (save_path / "public_evidence.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n"
                    for row in final_state["public_data_evidence"]), encoding="utf-8",
        )

    # Write consolidated report
    header = f"# Trading Analysis Report: {ticker}\n\nGenerated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    (save_path / "complete_report.md").write_text(header + "\n\n".join(sections), encoding="utf-8")
    return save_path / "complete_report.md"


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
        ("public_data_report", "public_data.md", "Official Public Data"),
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
    retrieved_at = datetime.now(timezone.utc).isoformat()
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
        "official_data_audit": final_state.get("public_data_quality", {}),
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
        hashed_content = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, sort_keys=True)
        evidence_records.append({
            **record,
            "sha256": hashlib.sha256(hashed_content.encode()).hexdigest(),
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
