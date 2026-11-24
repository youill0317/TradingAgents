"""The market run's report tree, laid out like the ticker run's (``tradingagents.reporting``).

Per-section markdown under numbered folders, a ``complete_report.md``, the same
one-page HTML report, and ``market_call.json`` with the regime and sector ratings.
"""

import json
from datetime import datetime
from pathlib import Path

_SECTIONS = (
    ("I. Analyst Team Reports", "1_analysts", (
        ("Macro Analyst", "macro.md", ("macro_report",)),
        ("Market Analyst", "market.md", ("market_report",)),
        ("Market News Analyst", "news.md", ("news_report",)),
        ("Market Sentiment Analyst", "sentiment.md", ("sentiment_report",)),
        ("Sector Analyst", "sector.md", ("sector_report",)),
        ("Policy Analyst", "policy.md", ("policy_report",)),
    )),
    ("II. Research Team Outlook", "2_research", (
        ("Market Bull Researcher", "bull.md", ("investment_debate_state", "bull_history")),
        ("Market Bear Researcher", "bear.md", ("investment_debate_state", "bear_history")),
        ("Market Research Manager", "manager.md", ("market_plan",)),
    )),
    ("III. Sector Positioning", "3_strategy", (
        ("Sector Strategist", "strategist.md", ("sector_proposal",)),
    )),
    ("IV. Risk Management Team Debate", "4_risk", (
        ("Aggressive Analyst", "aggressive.md", ("risk_debate_state", "aggressive_history")),
        ("Conservative Analyst", "conservative.md", ("risk_debate_state", "conservative_history")),
        ("Neutral Analyst", "neutral.md", ("risk_debate_state", "neutral_history")),
    )),
    ("V. Chief Market Strategist Call", "5_decision", (
        ("Chief Market Strategist", "decision.md", ("final_market_decision",)),
    )),
)


def report_parts(final_state: dict):
    """The sections with something to say: (heading, folder, [(agent, file, text)])."""
    parts = []
    for heading, folder, agents in _SECTIONS:
        written = []
        for agent, filename, path in agents:
            value = final_state
            for key in path:
                value = (value or {}).get(key)
            if value:
                written.append((agent, filename, value))
        if written:
            parts.append((heading, folder, written))
    return parts


def _header(final_state: dict, settings: dict | None) -> str:
    from tradingagents.market.graph import market_call

    call = market_call(final_state)
    lines = ["# Market Analysis Report", ""]
    if final_state.get("trade_date"):
        lines.append(f"- Analysis date: {final_state['trade_date']}")
    lines.append(f"- Market regime: {call['regime']}")
    lines.append("- Sectors: " + ", ".join(f"{name} {rating}" for name, rating in call["sector_ratings"].items()))
    lines.append(f"- Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    if settings:
        s = settings.get
        lines.append(f"- TradingAgents {s('version', '?')}: deep {s('deep_think_llm', '?')}, "
                     f"quick {s('quick_think_llm', '?')}")
        lines.append(f"- Analysts: {', '.join(s('analysts') or [])}; research debate rounds "
                     f"{s('max_debate_rounds', '?')}, risk debate rounds {s('max_risk_discuss_rounds', '?')}")
    if final_state.get("memory_note"):
        lines.append(f"- Memory log: {final_state['memory_note']}")
    return "\n".join(lines) + "\n\n"


def write_market_report_tree(final_state: dict, save_path, settings: dict | None = None,
                             html: bool = True) -> Path:
    """Save a completed market run's reports to ``save_path``; return the complete-report path."""
    from tradingagents.market.graph import market_call

    save_path = Path(save_path)
    save_path.mkdir(parents=True, exist_ok=True)
    parts = report_parts(final_state)
    sections = []
    for heading, folder, written in parts:
        (save_path / folder).mkdir(exist_ok=True)
        for _agent, filename, text in written:
            (save_path / folder / filename).write_text(text, encoding="utf-8")
        sections.append(f"## {heading}\n\n" + "\n\n".join(f"### {agent}\n{text}" for agent, _f, text in written))

    (save_path / "complete_report.md").write_text(_header(final_state, settings) + "\n\n".join(sections),
                                                  encoding="utf-8")
    (save_path / "market_call.json").write_text(
        json.dumps({"trade_date": final_state.get("trade_date"), **market_call(final_state)},
                   indent=2, ensure_ascii=False), encoding="utf-8")
    if html:
        from tradingagents.report_html import render_report

        (save_path / "complete_report.html").write_text(
            render_report("Market", final_state, settings, parts), encoding="utf-8")
    else:
        (save_path / "complete_report.html").unlink(missing_ok=True)

    current = {(folder, f) for _h, folder, written in parts for _a, f, _t in written}
    for _heading, folder, agents in _SECTIONS:
        for _agent, filename, _path in agents:
            if (folder, filename) not in current:
                (save_path / folder / filename).unlink(missing_ok=True)
    return save_path / "complete_report.md"
