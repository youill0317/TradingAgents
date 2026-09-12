"""Bounded official U.S. and euro-area macro data collectors."""

import os
from datetime import date, timedelta

from .public_data_common import evidence, request_json

_EIA_URL = "https://api.eia.gov/v2/petroleum/sum/sndw/data/"
_NYFED_URL = "https://markets.newyorkfed.org/api/rates/secured/sofr/search.json"
_CFTC_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json"
_TREASURY_URL = (
    "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/"
    "v1/accounting/dts/operating_cash_balance"
)
_ECB_URL = "https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV"


def collect_eia(trade_date):
    """Collect two weekly petroleum supply observations, excluding prices."""
    end = date.fromisoformat(trade_date).isoformat()
    payload = request_json(_EIA_URL, params={
        "api_key": os.environ["EIA_API_KEY"],
        "frequency": "weekly",
        "data[0]": "value",
        "facets[series][]": ["WCESTUS1", "WCRFPUS2"],
        "end": end,
        "sort[0][column]": "period",
        "sort[0][direction]": "desc",
        "length": 20,
    })
    rows = payload.get("response", {}).get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError("EIA returned an invalid response")

    labels = {
        "WCESTUS1": "U.S. commercial crude oil stocks excluding SPR",
        "WCRFPUS2": "U.S. crude oil field production",
    }
    units = {"MBBL": "thousand barrels", "MBBL/D": "thousand barrels per day"}
    latest = {}
    for row in rows:
        series, period = row.get("series"), row.get("period")
        if series in labels and isinstance(period, str) and period <= end and row.get("value") is not None:
            latest.setdefault(series, row)
    if not latest:
        raise ValueError("EIA returned no usable observations")

    return [evidence(
        "eia", series,
        f"{labels[series]}: {row['value']} {units.get(row.get('units'), 'unit not supplied')} for week ending "
        f"{row['period']}. Weekly data are released after the observation week and this API may "
        "contain later revisions; this is not a historical vintage.",
        _EIA_URL, observed_at=row["period"], api_unit=row.get("units"),
    ) for series, row in latest.items()]


def collect_nyfed(trade_date):
    """Collect the latest SOFR rate and matching transaction volume."""
    end = date.fromisoformat(trade_date)
    common = {"startDate": (end - timedelta(days=14)).isoformat(), "endDate": end.isoformat()}
    rate_payload = request_json(_NYFED_URL, params={**common, "type": "rate"})
    volume_payload = request_json(_NYFED_URL, params={**common, "type": "volume"})
    rates = rate_payload.get("refRates") if isinstance(rate_payload, dict) else None
    volumes = volume_payload.get("refRates") if isinstance(volume_payload, dict) else None
    if not isinstance(rates, list) or not isinstance(volumes, list):
        raise ValueError("New York Fed returned an invalid response")

    volume_by_date = {row.get("effectiveDate"): row.get("volumeInBillions") for row in volumes}
    usable = [row for row in rates if row.get("effectiveDate", "") <= end.isoformat()
              and row.get("percentRate") is not None and row.get("effectiveDate") in volume_by_date]
    if not usable:
        raise ValueError("New York Fed returned no usable observations")
    row = max(usable, key=lambda item: item["effectiveDate"])
    observed = row["effectiveDate"]
    notice = (
        "The SOFR data are subject to the Terms of Use posted at newyorkfed.org. The New York "
        "Fed is not responsible for publication of SOFR by TradingAgents, does not sanction or "
        "endorse this republication, and has no liability for your use."
    )
    return [evidence(
        "nyfed", "SOFR",
        f"SOFR: {row['percentRate']}%; transaction volume: {volume_by_date[observed]} billion USD "
        f"on {observed}; revision indicator: {row.get('revisionIndicator') or 'none'}. {notice}",
        _NYFED_URL, observed_at=observed,
    )]


def collect_cftc(trade_date):
    """Collect a small latest-report subset of financial futures positioning."""
    cutoff = date.fromisoformat(trade_date) - timedelta(days=3)
    params = {
        "$select": ("market_and_exchange_names,report_date_as_yyyy_mm_dd,open_interest_all,"
                    "asset_mgr_positions_long,asset_mgr_positions_short,lev_money_positions_long,"
                    "lev_money_positions_short,contract_units"),
        "$where": (f"report_date_as_yyyy_mm_dd <= '{cutoff.isoformat()}T00:00:00.000' AND "
                   "commodity_group_name = 'FINANCIAL INSTRUMENTS'"),
        "$order": "report_date_as_yyyy_mm_dd DESC,open_interest_all DESC",
        "$limit": 5,
    }
    rows = request_json(_CFTC_URL, params=params)
    if not isinstance(rows, list):
        raise ValueError("CFTC returned an invalid response")
    rows = [row for row in rows if row.get("report_date_as_yyyy_mm_dd", "")[:10] <= cutoff.isoformat()]
    if not rows:
        raise ValueError("CFTC returned no usable observations")

    observed = max(row["report_date_as_yyyy_mm_dd"][:10] for row in rows)
    rows = [row for row in rows if row["report_date_as_yyyy_mm_dd"][:10] == observed]
    result = []
    for row in rows:
        try:
            asset_net = int(row["asset_mgr_positions_long"]) - int(row["asset_mgr_positions_short"])
            leveraged_net = int(row["lev_money_positions_long"]) - int(row["lev_money_positions_short"])
            open_interest = int(row["open_interest_all"])
        except (KeyError, TypeError, ValueError):
            continue
        market = row.get("market_and_exchange_names")
        if market:
            result.append(evidence(
                "cftc", market,
                f"TFF futures-only positions as of Tuesday {observed}: asset-manager net "
                f"{asset_net:+,}, leveraged-money net {leveraged_net:+,}, open interest "
                f"{open_interest:,} ({row.get('contract_units', 'contract units not supplied')}). "
                "COT is normally released Friday and these positions do not measure current-day flow.",
                _CFTC_URL, observed_at=observed,
            ))
    if not result:
        raise ValueError("CFTC returned no usable observations")
    return result


def collect_treasury(trade_date):
    """Collect the latest Daily Treasury Statement TGA closing balance."""
    end = date.fromisoformat(trade_date).isoformat()
    payload = request_json(_TREASURY_URL, params={
        "filter": (f"record_date:lte:{end},account_type:eq:"
                   "Treasury General Account (TGA) Closing Balance"),
        "sort": "-record_date", "page[size]": 5,
    })
    rows = payload.get("data") if isinstance(payload, dict) else None
    meta = payload.get("meta") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not isinstance(meta, dict):
        raise ValueError("Treasury returned an invalid response")
    fmt = meta.get("dataFormats", {}).get("open_today_bal")
    usable = [row for row in rows if row.get("record_date", "") <= end
              and row.get("account_type") == "Treasury General Account (TGA) Closing Balance"
              and row.get("open_today_bal") not in (None, "null", "")]
    if not usable or fmt != "$1,000,000":
        raise ValueError("Treasury returned no usable observations")
    row = max(usable, key=lambda item: item["record_date"])
    return [evidence(
        "treasury", "TGA closing balance",
        f"Treasury General Account closing balance: {row['open_today_bal']} million USD on "
        f"{row['record_date']}. The DTS publishes this account type's balance in open_today_bal; "
        "close_today_bal is null. DTS is generally available the following business day and the "
        "API does not provide a historical vintage.",
        _TREASURY_URL, observed_at=row["record_date"],
    )]


def collect_ecb(trade_date):
    """Collect the euro-area ECB deposit facility rate from SDMX-JSON."""
    end = date.fromisoformat(trade_date)
    payload = request_json(_ECB_URL, params={
        "startPeriod": (end - timedelta(days=14)).isoformat(),
        "endPeriod": end.isoformat(), "format": "jsondata",
    }, headers={"Accept": "application/json"})
    try:
        times = payload["structure"]["dimensions"]["observation"][0]["values"]
        series = next(iter(payload["dataSets"][0]["series"].values()))
        observations = series["observations"]
    except (KeyError, IndexError, StopIteration, TypeError):
        raise ValueError("ECB returned an invalid response") from None
    usable = [(times[int(index)]["id"], values[0]) for index, values in observations.items()
              if times[int(index)]["id"] <= end.isoformat() and values and values[0] is not None]
    if not usable:
        raise ValueError("ECB returned no usable observations")
    observed, value = max(usable)
    return [evidence(
        "ecb", "ECB deposit facility rate",
        f"ECB deposit facility rate: {value}% on {observed} (daily, euro area changing "
        "composition). The current SDMX response may include later revisions and is not a "
        "complete historical publication-time vintage.",
        _ECB_URL, observed_at=observed,
    )]
