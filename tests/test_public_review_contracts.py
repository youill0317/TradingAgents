"""Essential official-data parsing, lineage, routing, and prompt regressions."""

from xml.etree import ElementTree

from tradingagents.dataflows import public_korea
from tradingagents.dataflows.public_analysis import build_diagnostics
from tradingagents.dataflows.public_data_common import evidence
from tradingagents.dataflows.public_digest import render_public_data
from tradingagents.dataflows.public_evidence import evidence_id, source_tables
from tradingagents.dataflows.public_financial_metrics import derive_metrics
from tradingagents.dataflows.public_quality import core_evidence_report
from tradingagents.dataflows.public_relevance import assigned_public_rows, selected_public_sectors


def observation(source, target, value=100, observed="2026-07", **extra):
    return evidence(source, target, target, "https://example.invalid/official",
                    observed_at=observed, value=value, unit=extra.pop("unit", "USD"),
                    frequency=extra.pop("frequency", "M"), **extra)


def fact(metric, value=100, **extra):
    instant = metric in {"assets", "liabilities", "cash"}
    return observation("sec", "TEST/" + metric, value, "2026-06-30",
                       published_at="2026-08-01", period_end="2026-06-30",
                       period_start=None if instant else "2026-04-01",
                       basis="instant" if instant else "quarter", metric=metric,
                       evidence_type="financial_fact", accession="filing", frequency="Q", **extra)


def test_financial_derivation_preserves_currency_and_operand_lineage():
    rows = [
        fact(metric, value, unit="CNY")
        for metric, value in (
            ("revenue", 100),
            ("net_income", 20),
            ("operating_cashflow", 30),
            ("capital_expenditure", 10),
        )
    ]
    derived = {row["metric"]: row for row in derive_metrics(rows, "TEST")}
    assert derived["net_margin"]["value"] == 20
    assert derived["free_cashflow"]["value"] == 20
    assert derived["free_cashflow"]["unit"] == "CNY"
    assert all(op["unit"] == "CNY" for row in derived.values() for op in row["operands"])

    mixed = [fact("revenue", unit="CNY"), fact("net_income", 20, unit="EUR")]
    assert not any(row.get("metric") == "net_margin" for row in derive_metrics(mixed, "TEST"))


def test_unsupported_monetary_units_are_visible_without_mutating_inputs():
    rows = [fact("revenue", unit="USD/shares"), fact("net_income", unit="XYZ"),
            fact("shares", unit="shares"), fact("diluted_eps", unit="USD/shares")]
    original_ids = [evidence_id(row) for row in rows]
    derived = derive_metrics(rows, "TEST")
    assert {row["reason_code"] for row in derived} == {"UNSUPPORTED_MONETARY_UNIT"}
    assert all(row["status"] == "unsupported" and row["operands"] for row in derived)
    assert [evidence_id(row) for row in rows] == original_ids


def test_customs_missing_field_keeps_other_fields_and_older_success(monkeypatch):
    monkeypatch.setenv("DATA_GO_KR_API_KEY", "fixture")
    monkeypatch.setattr(public_korea, "CUSTOMS_PRODUCTS", {"8542": ("Integrated circuits", ["Technology"])})
    xml = """<response><resultCode>00</resultCode><items>
    <item><year>2026.07</year><expDlr>0</expDlr><impDlr>10</impDlr><balPayments>-10</balPayments><expWgt>4</expWgt><impWgt>5</impWgt></item>
    <item><year>2026.08</year><expDlr>0</expDlr><impDlr>10</impDlr><balPayments>-10</balPayments><expWgt/><impWgt>5</impWgt></item>
    </items></response>"""
    monkeypatch.setattr(public_korea, "request_xml", lambda *a, **k: ElementTree.fromstring(xml))
    rows = public_korea.collect_customs("2026-09-16")
    missing = [row for row in rows if row["status"] != "success" and row.get("field_id")]
    assert len(missing) == 4 and all(row["field_id"] == "expWgt" for row in missing)
    assert all(row["value"] == 0 for row in rows if row["status"] == "success" and row["field_id"] == "expDlr")
    assert len([row for row in rows if row["status"] == "success"]) == 4 * 9


def test_derived_table_lineage_survives_summary_budget_and_legacy_snapshots():
    originals = []
    for table, count in (("M3ADV", 30), ("MRTS", 1), ("MWTS", 1), ("RESCONST", 1), ("VIP", 1)):
        for n in range(count):
            for day, value in (("2025-07", 100), ("2026-07", 110)):
                originals.append(observation("census", f"{table}/{n}/sales/1", value, day))
    derived = build_diagnostics(originals)
    assert {tuple(row["source_tables"]) for row in derived} == {
        (table,) for table in ("M3ADV", "MRTS", "MWTS", "RESCONST", "VIP")
    }
    for row in derived:
        legacy = {key: value for key, value in row.items() if key not in {"source_tables", "base_target"}}
        assert source_tables(legacy) == tuple(row["source_tables"])

    digest = render_public_data(derived, max_chars=6500)
    for table in ("M3ADV", "MRTS", "MWTS", "RESCONST", "VIP"):
        assert f"**derived/{table}/" in digest
    assert all(f"[{op['evidence_id']}]" in digest for op in derived[0]["operands"])


def test_sector_focus_routes_requested_sectors_and_reserves_digest_budget():
    rows = [
        observation(
            "census",
            f"M3ADV/{n}/sales",
            title="Computer sales",
            sectors=["Technology"],
        )
        for n in range(60)
    ]
    energy = observation("eia", "oil-stock", title="Petroleum stocks", sectors=["Energy"])
    health = observation("census", "health-sales", title="Healthcare sales", sectors=["Healthcare"])
    rows += [energy, health]
    state = {"requested_sectors": ["Technology", "Energy"], "public_data_evidence": rows}

    assigned, _, _ = assigned_public_rows(state, "sector")
    assert health not in assigned and energy in assigned
    digest = core_evidence_report(assigned, "sector", state)
    assert f"Energy/inventory_costs: [{evidence_id(energy)}]" in digest
    assert "Energy/demand: unavailable" in digest
    assert selected_public_sectors(
        {"screen_evidence": "## Equity screen\n### Energy (4 matches)\n## Other\n### Healthcare"}
    ) == ["Energy"]


def test_partial_failure_details_stay_bounded_without_mutating_evidence():
    rows = [observation("kosis", "T12", observed=f"2025-{month:02d}") for month in range(1, 13)]
    for row in rows:
        row.update(status="empty", value=None, content="Missing requested observation. " * 100)
    digest = render_public_data(rows, max_chars=2500)
    assert len(digest) < 3000
    assert "1 series with gaps" in digest and "omitted by prompt budget" in digest
    assert len(rows) == 12
