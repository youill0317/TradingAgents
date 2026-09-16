"""Bounded official U.S. and euro-area macro data collectors."""

import os
from datetime import date, timedelta

from .public_data_common import collect_parts, numeric_rows, request_json, request_text
from .public_evidence import require_series

_EIA_URL = "https://api.eia.gov/v2/petroleum/sum/sndw/data/"
_NYFED_URL = "https://markets.newyorkfed.org/api/rates/secured/sofr/search.json"
_CFTC_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json"
_TREASURY_URL = (
    "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/"
    "v1/accounting/dts/operating_cash_balance"
)
_ECB_URL = "https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV"


def collect_eia(trade_date):
    """Four weekly petroleum supply series with two years of history."""
    end = date.fromisoformat(trade_date).isoformat()
    payload = request_json(
        _EIA_URL,
        params={
            "api_key": os.environ["EIA_API_KEY"],
            "frequency": "weekly",
            "data[0]": "value",
            "facets[series][]": ["WCESTUS1", "WCRFPUS2", "WGTSTUS1", "WDISTUS1"],
            "end": end,
            "sort[0][column]": "period",
            "sort[0][direction]": "desc",
            "length": 1500,
            "start": (date.fromisoformat(trade_date) - timedelta(days=800)).isoformat(),
        },
    )
    rows = payload.get("response", {}).get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("EIA returned an invalid response")

    labels = {
        "WCESTUS1": "U.S. commercial crude oil stocks excluding SPR",
        "WCRFPUS2": "U.S. crude oil field production",
        "WGTSTUS1": "U.S. total motor gasoline stocks",
        "WDISTUS1": "U.S. distillate fuel oil stocks",
    }
    units = {"MBBL": "thousand barrels", "MBBL/D": "thousand barrels per day"}
    result = [
        record
        for series, label in labels.items()
        for record in numeric_rows(
            "eia",
            series,
            [
                (row["period"], row["value"])
                for row in rows
                if row.get("series") == series and row.get("value") is not None
            ],
            _EIA_URL,
            trade_date=trade_date,
            unit=next(
                (
                    units.get(row.get("units"), row.get("units", "provider units"))
                    for row in rows
                    if row.get("series") == series
                ),
                "provider units",
            ),
            frequency="W",
            country="US",
            sectors=("Energy", "Utilities"),
            title=label,
            api_unit=next((row.get("units") for row in rows if row.get("series") == series), None),
            note="Weekly petroleum observations, released after the observation week; current data may include revisions.",
        )
    ]

    return require_series("eia", result, labels, _EIA_URL)


def collect_nyfed(trade_date):
    """Secured and unsecured money-market rates and matching transaction volumes."""

    def rate(name, market):
        # The last/N endpoint includes both rate and volume in the same response.
        url = f"https://markets.newyorkfed.org/api/rates/{market}/{name}/last/300.json"
        payload = request_json(url)
        rows = payload.get("refRates")
        if not isinstance(rows, list):
            raise ValueError("NYFed schema changed")
        result = []
        for suffix, field, unit in (
            ("", "percentRate", "percent"),
            (" volume", "volumeInBillions", "billion USD"),
        ):
            result.extend(
                numeric_rows(
                    "nyfed",
                    name.upper() + suffix,
                    [(r.get("effectiveDate"), r.get(field)) for r in rows],
                    url,
                    trade_date=trade_date,
                    unit=unit,
                    frequency="D",
                    country="US",
                    note="Subject to New York Fed Terms of Use. NYFed does not sanction or endorse republication and has no liability for its use. Observations may be revised.",
                )
            )
        return require_series(
            "nyfed", result, (name.upper(), name.upper() + " volume"), url
        )

    return collect_parts(
        "nyfed",
        [
            (name, lambda n=name, m=market: rate(n, m))
            for name, market in (("sofr", "secured"), ("effr", "unsecured"), ("obfr", "unsecured"))
        ],
    )


def collect_cftc(trade_date):
    """Collect a small latest-report subset of financial futures positioning."""
    cutoff = date.fromisoformat(trade_date) - timedelta(days=3)
    params = {
        "$select": (
            "market_and_exchange_names,report_date_as_yyyy_mm_dd,open_interest_all,"
            "asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,"
            "lev_money_positions_short,contract_units"
        ),
        "$where": (
            f"report_date_as_yyyy_mm_dd <= '{cutoff.isoformat()}T00:00:00.000' AND "
            f"report_date_as_yyyy_mm_dd >= '{(cutoff - timedelta(days=100)).isoformat()}T00:00:00.000' AND "
            "commodity_group_name = 'FINANCIAL INSTRUMENTS'"
        ),
        "$order": "report_date_as_yyyy_mm_dd DESC,open_interest_all DESC",
        "$limit": 3000,
    }
    rows = request_json(_CFTC_URL, params=params)
    if not isinstance(rows, list):
        raise ValueError("CFTC returned an invalid response")
    rows = [
        row for row in rows if row.get("report_date_as_yyyy_mm_dd", "")[:10] <= cutoff.isoformat()
    ]
    if not rows:
        raise ValueError("CFTC returned no usable observations")

    observed = max(row["report_date_as_yyyy_mm_dd"][:10] for row in rows)
    leaders = sorted(
        [row for row in rows if row["report_date_as_yyyy_mm_dd"][:10] == observed],
        key=lambda row: int(row.get("open_interest_all") or 0),
        reverse=True,
    )[:12]
    markets = {row["market_and_exchange_names"] for row in leaders}
    rows = [row for row in rows if row.get("market_and_exchange_names") in markets]
    result = []
    for row in rows:
        try:
            asset_net = int(row["asset_mgr_positions_long"]) - int(row["asset_mgr_positions_short"])
            leveraged_net = int(row["lev_money_positions_long"]) - int(
                row["lev_money_positions_short"]
            )
            open_interest = int(row["open_interest_all"])
        except (KeyError, TypeError, ValueError):
            continue
        market = row.get("market_and_exchange_names")
        if market:
            for metric, value in (
                ("asset manager net", asset_net),
                ("leveraged money net", leveraged_net),
                ("open interest", open_interest),
            ):
                result.extend(
                    numeric_rows(
                        "cftc",
                        market + "/" + metric,
                        [(row["report_date_as_yyyy_mm_dd"][:10], value)],
                        _CFTC_URL,
                        trade_date=trade_date,
                        unit="contracts",
                        frequency="W",
                        kind="position",
                        contract_units=row.get("contract_units"),
                        note="TFF futures-only positions as of Tuesday; normally released Friday. Positions do not measure current-day flows.",
                    )
                )
    if not result:
        raise ValueError("CFTC returned no usable observations")
    return result


def collect_treasury(trade_date):
    """Collect the latest Daily Treasury Statement TGA closing balance."""
    end = date.fromisoformat(trade_date).isoformat()
    payload = request_json(
        _TREASURY_URL,
        params={
            "filter": (
                f"record_date:lte:{end},account_type:eq:"
                "Treasury General Account (TGA) Closing Balance"
            ),
            "sort": "-record_date",
            "page[size]": 400,
        },
    )
    rows = payload.get("data") if isinstance(payload, dict) else None
    meta = payload.get("meta") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not isinstance(meta, dict):
        raise ValueError("Treasury returned an invalid response")
    fmt = meta.get("dataFormats", {}).get("open_today_bal")
    usable = [
        row
        for row in rows
        if row.get("record_date", "") <= end
        and row.get("account_type") == "Treasury General Account (TGA) Closing Balance"
        and row.get("open_today_bal") not in (None, "null", "")
    ]
    if not usable or fmt != "$1,000,000":
        raise ValueError("Treasury returned no usable observations")
    return numeric_rows(
        "treasury",
        "TGA closing balance",
        [(r["record_date"], r["open_today_bal"]) for r in usable],
        _TREASURY_URL,
        trade_date=trade_date,
        unit="million USD",
        frequency="D",
        country="US",
        note="DTS TGA Closing Balance is stored in open_today_bal; publication is generally the next business day. Not a historical vintage.",
    )


def collect_ecb(trade_date):
    """All three ECB policy rates with a history, using provider CSV metadata."""
    import csv
    import io

    url = "https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR+MRR_FR+MLFR.LEV"
    text = request_text(
        url,
        params={
            "startPeriod": (date.fromisoformat(trade_date) - timedelta(days=800)).isoformat(),
            "endPeriod": trade_date,
            "format": "csvdata",
        },
    )
    data = list(csv.DictReader(io.StringIO(text)))
    result = []
    for row in data:
        result.extend(
            numeric_rows(
                "ecb",
                row["PROVIDER_FM_ID"],
                [(row["TIME_PERIOD"], row["OBS_VALUE"])],
                url,
                trade_date=trade_date,
                unit="percent",
                frequency="D",
                country="EA",
                title=row.get("TITLE"),
                unit_multiplier=row.get("UNIT_MULT"),
                note="ECB policy rates; observation dates are not policy announcement times.",
            )
        )
    return require_series("ecb", result, ("DFR", "MRR_FR", "MLFR"), url)
