"""Review independence, evidence transfer and failure contracts."""
from unittest.mock import Mock

import pytest
from langchain_core.messages import AIMessage

from tradingagents.agents.market_review import create_market_review
from tradingagents.agents.schemas import MarketRiskReview


def test_initial_cases_are_independent_and_rebuttals_see_both_cases():
    llm = Mock()
    llm.invoke.return_value = AIMessage(content=[{"type": "text", "text": "Reasoned case"}])
    state = {"market_bull_case": "UPSIDE_CLAIM", "market_bear_case": "DOWNSIDE_CLAIM",
             "market_diagnostics": "OBSERVED_RATIO", "market_draft_report": "DRAFT_CLAIM"}
    create_market_review(llm, "market_bear_case")(state)
    prompt = str(llm.invoke.call_args.args[0])
    assert "OBSERVED_RATIO" in prompt and "UPSIDE_CLAIM" not in prompt
    for field in ("market_bull_rebuttal", "market_bear_rebuttal"):
        assert create_market_review(llm, field)(state)[field] == "Reasoned case"
        prompt = str(llm.invoke.call_args.args[0])
        assert "UPSIDE_CLAIM" in prompt and "DOWNSIDE_CLAIM" in prompt
    state["screen_evidence"] = "RAW_SCREEN"
    llm.with_structured_output.return_value.invoke.return_value = MarketRiskReview(summary="Audited", findings=["Check valuation"])
    result = create_market_review(llm, "market_risk_review")(state)
    assert result["market_risk_findings"] == [{"id": "R1", "finding": "Check valuation"}]
    prompt = str(llm.with_structured_output.return_value.invoke.call_args.args[0])
    assert "RAW_SCREEN" in prompt
    assert "OBSERVED_RATIO" in prompt and "DRAFT_CLAIM" in prompt
    assert "UPSIDE_CLAIM" not in prompt


@pytest.mark.parametrize("failure", ["empty", "exception"])
def test_review_failures_are_explicit_and_preserve_previous_warnings(failure):
    llm = Mock()
    if failure == "exception":
        llm.invoke.side_effect = RuntimeError("API error")
    else:
        llm.invoke.return_value = None
    llm.with_structured_output.return_value.invoke = llm.invoke
    result = create_market_review(llm, "market_risk_review")({"data_warnings": ["OLD_GAP"]})
    assert result["market_risk_review"] == ""
    assert result["data_warnings"] == ["OLD_GAP", "MARKET_REVIEW_UNAVAILABLE:market_risk_review"]
