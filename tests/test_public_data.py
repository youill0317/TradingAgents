import pytest

from tradingagents.dataflows import public_data


@pytest.mark.parametrize(
    ("ticker", "expected"),
    [("AAPL", {"sec", "macro"}), ("005930.KS", {"dart", "fsc", "macro"}), (None, {"macro"})],
)
def test_routes_filings_by_market_and_skips_them_for_market_runs(monkeypatch, ticker, expected):
    calls = []

    def collector(name):
        def collect(*args):
            calls.append((name, args))
            return [public_data.evidence(name, ticker or "market", name, "https://example.test")]
        return collect

    monkeypatch.setattr(public_data, "PUBLIC_SOURCES", {
        name: (collector(name), ()) for name in ("sec", "dart", "fsc", "macro")
    })

    result = public_data.collect_public_data(
        "2999-01-01", {"public_data_sources": "sec,dart,fsc,macro"}, ticker=ticker
    )

    assert {name for name, _ in calls} == expected
    assert {row["source"] for row in result["evidence"]} == expected
    filing_calls = {name: args for name, args in calls if name in {"sec", "dart", "fsc"}}
    assert all(args == (ticker, "2999-01-01") for args in filing_calls.values())


def test_missing_keys_and_errors_are_sanitized(monkeypatch):
    secret = "secret-key-in-provider-url"

    def fail(_trade_date):
        raise RuntimeError(f"https://provider.test/?api_key={secret}")

    monkeypatch.delenv("TEST_PUBLIC_KEY", raising=False)
    monkeypatch.setattr(public_data, "PUBLIC_SOURCES", {
        "missing": (lambda _: pytest.fail("collector must not run"), ("TEST_PUBLIC_KEY",)),
        "broken": (fail, ()),
    })

    result = public_data.collect_public_data(
        "2999-01-01", {"public_data_sources": "missing,broken"}
    )

    by_source = {row["source"]: row for row in result["evidence"]}
    assert by_source["missing"]["status"] == "not_configured"
    assert by_source["broken"]["status"] == "error"
    assert "RuntimeError" in by_source["broken"]["content"]
    assert secret not in str(result)


@pytest.mark.parametrize(
    ("trade_date", "config", "expected_status"),
    [("2999-01-01", {"public_data_sources": ""}, None),
     ("2000-01-01", {"public_data_sources": "probe"}, "unavailable_as_of")],
)
def test_disabled_and_historical_collection_do_not_call_network(monkeypatch, trade_date, config, expected_status):
    monkeypatch.setattr(public_data, "PUBLIC_SOURCES", {
        "probe": (lambda _: pytest.fail("collector must not run"), ())
    })

    result = public_data.collect_public_data(trade_date, config)

    if expected_status is None:
        assert result == {"report": "", "evidence": [], "warnings": []}
    else:
        assert result["evidence"][0]["status"] == expected_status


def test_historical_filings_remain_available_and_monthly_series_are_not_crowded_out(monkeypatch):
    dated = public_data.evidence("sec", "AAPL", "dated filing", "https://example.test", published_at="2000-01-01")
    monkeypatch.setattr(public_data, "PUBLIC_SOURCES", {"sec": (lambda *_: [dated], ())})
    assert public_data.collect_public_data("2000-01-02", {"public_data_sources": "sec"}, ticker="AAPL")["evidence"] == [dated]

    rows = [public_data.evidence("ecos", "rate", "daily rate", "https://example.test", observed_at=f"202609{day:02}")
            for day in range(1, 25)]
    rows.append(public_data.evidence("ecos", "CPI", "monthly CPI", "https://example.test", observed_at="202608"))
    monkeypatch.setattr(public_data, "PUBLIC_SOURCES", {"ecos": (lambda _: rows, ())})
    result = public_data.collect_public_data("2999-01-01", {"public_data_sources": "ecos"})
    assert "monthly CPI" in result["report"] and result["report"].count("daily rate") == 4
    assert len(result["evidence"]) == 25


@pytest.mark.parametrize(("role", "sources"), [
    ("news", {"sec", "dart", "ecos", "nyfed", "treasury", "ecb"}),
    ("fundamentals", {"sec", "dart", "fsc"}),
    ("macro", {"ecos", "nyfed", "treasury", "ecb", "cftc", "eia"}),
    ("sector", {"eia", "customs", "kosis", "cftc"}),
    ("ticker_review", {"sec", "dart", "fsc", "ecos", "nyfed", "treasury", "ecb"}),
    ("market_review", {"ecos", "nyfed", "treasury", "ecb", "cftc", "eia", "customs", "kosis"}),
])
def test_roles_receive_only_relevant_sources_and_keep_failure_provenance(role, sources):
    rows = [public_data.evidence(source, source, f"{source} observation", "https://example.test",
                                 observed_at="2026-09-01") for source in public_data.PUBLIC_SOURCES]
    next(row for row in rows if row["source"] == "nyfed")["status"] = "error"
    report = public_data.public_data_for_agent({"public_data_evidence": rows}, role)
    assert {source for source in public_data.PUBLIC_SOURCES if f"{source} observation" in report} == sources
    assert "2026-09-01" in report and "https://example.test" in report
    assert ("(error)" in report) == ("nyfed" in sources)


@pytest.mark.parametrize(("identity", "industry_sources"), [
    ({"sector": "Energy", "industry": "Oil & Gas Integrated"}, {"eia"}),
    ({"sector": "Technology", "industry": "Semiconductors"}, {"customs", "kosis"}),
    ({"sector": "Healthcare", "industry": "Drug Manufacturers - General"}, set()),
    ({}, set()),
])
def test_ticker_industry_data_requires_relevant_resolved_classification(identity, industry_sources):
    rows = [public_data.evidence(source, source, f"{source} observation", "https://example.test")
            for source in ("eia", "customs", "kosis")]
    state = {"instrument_identity": identity, "public_data_evidence": rows}
    for role in ("fundamentals", "ticker_review", "news"):
        report = public_data.public_data_for_agent(state, role)
        expected = industry_sources & {"eia"} if role == "news" else industry_sources
        assert {source for source in ("eia", "customs", "kosis") if f"{source} observation" in report} == expected
        if not identity:
            assert "classification is unavailable" in report
