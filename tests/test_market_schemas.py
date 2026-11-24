"""Reading a market call back from text, as a rating is read: what cannot be read is REVIEW."""
import pytest

from tradingagents.market.schemas import (
    SECTORS,
    MarketCall,
    call_ratings,
    extract_regime,
    extract_sector_ratings,
    normalize_call,
    render_call,
)


@pytest.mark.parametrize("text,expected", [
    ("**Market Regime**: Risk-On\nmore", "Risk-On"),
    ("Market regime - **Range-Bound**", "Range-Bound"),
    ("Regime: Rotation into defensives", "Rotation"),
    ("Regime: Risk-On\nLater: final regime: Risk-Off", None),
    ("Regime Evidence: Rotation is visible", None),
    ("The market looks stressed", None),
])
def test_regime_needs_one_agreeing_label(text, expected):
    assert extract_regime(text) == expected


def test_sector_lines_must_name_one_sector_and_agree():
    text = "\n".join([
        "Energy: Bullish (High conviction)",
        "Technology vs Utilities: Technology Bearish, Utilities Bullish",
        "XLU: Neutral",
        "Healthcare: Bullish",
        "Healthcare: Bearish on second thought",
    ])
    ratings = extract_sector_ratings(text)
    assert ratings["Energy"] == "Bullish"
    assert ratings["Utilities"] == "Neutral", "the ETF symbol names the sector"
    assert ratings["Technology"] == "REVIEW"
    assert ratings["Healthcare"] == "REVIEW", "disagreeing lines are no call"


def _verdict(sector, outlook="Bullish"):
    return {"sector": sector, "outlook": outlook, "conviction": "High", "rationale": "r", "invalidation": "i"}


def test_typed_call_is_canonicalised_and_missing_sectors_are_review():
    call = MarketCall(regime="Stressed", regime_evidence="e", summary="s",
                      sector_verdicts=[_verdict(" energy "), _verdict("XLK", "Bearish"), _verdict("Energy", "Bearish"),
                                       _verdict("Crypto")])
    assert [v.sector for v in normalize_call(call).sector_verdicts] == ["Technology", "Energy"]
    regime, ratings = call_ratings(call)
    assert regime == "Stressed"
    assert ratings["Energy"] == "Bullish", "the first verdict for a sector stands"
    assert ratings["Technology"] == "Bearish"
    assert sum(r == "REVIEW" for r in ratings.values()) == len(SECTORS) - 2


def test_rendered_call_reads_back_to_the_same_ratings():
    call = MarketCall(regime="Risk-Off", regime_evidence="e", summary="s",
                      sector_verdicts=[_verdict(s, "Neutral") for s in SECTORS])
    text = render_call(call, "Executive Summary")
    assert extract_regime(text) == "Risk-Off"
    assert set(extract_sector_ratings(text).values()) == {"Neutral"}
    assert "**Executive Summary**:" in text
