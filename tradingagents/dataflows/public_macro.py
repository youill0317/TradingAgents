"""Official US demand, labour, credit and financial stress observations.

Provider contracts and default series are documented in docs/public-data.md.
Each table fails independently; data retain units, seasonal basis and dates.
"""

import csv
import io
import os
import zipfile
from datetime import date, datetime, timedelta

from .public_data_common import _request, collect_parts, numeric_rows, request_json, request_text
from .public_evidence import require_series
from .public_industry import census_sectors

# Existing FRED transport supports arbitrary IDs and ALFRED vintages. These are
# additional mandatory evidence when fred is selected, rather than LLM guesses.
FRED_SERIES = {
    "WALCL": "Federal Reserve total assets",
    "WRESBAL": "Reserve balances",
    "RRPONTSYD": "Overnight reverse repo usage",
    "DRTSCILM": "C&I lending standards: large firms",
    "DRTSCIS": "C&I lending standards: small firms",
    "DRSDCILM": "C&I loan demand: large firms",
    "NFCI": "Chicago Fed financial conditions",
    "STLFSI4": "St Louis Fed financial stress",
    "DGS2": "2-year Treasury yield",
    "DGS10": "10-year Treasury yield",
    "DFII10": "10-year real Treasury yield",
    "T10YIE": "10-year breakeven inflation",
    "INDPRO": "Industrial production",
    "TCU": "Capacity utilization",
    "BUSLOANS": "Commercial and industrial loans",
    "DTWEXBGS": "Broad dollar index",
}


def collect_fred(trade_date):
    from .fred import _fred_today, _request

    vintage = min(trade_date, _fred_today())
    realtime = {"realtime_start": vintage, "realtime_end": vintage}
    start = (date.fromisoformat(trade_date) - timedelta(days=800)).isoformat()

    def series(series_id, label):
        meta = _request("series", {"series_id": series_id, **realtime})["seriess"][0]
        data = _request(
            "series/observations",
            {
                "series_id": series_id,
                "observation_start": start,
                "observation_end": trade_date,
                **realtime,
            },
        )["observations"]
        rows = numeric_rows(
            "fred",
            series_id,
            [(r["date"], r["value"]) for r in data],
            f"https://fred.stlouisfed.org/series/{series_id}",
            trade_date=trade_date,
            unit=meta["units"],
            frequency=meta.get("frequency_short", ""),
            kind="rate" if "percent" in meta["units"].casefold() else "level",
            country="US",
            title=meta.get("title", label),
            basis=meta.get("seasonal_adjustment"),
            vintage_date=vintage,
        )
        for row in rows:
            row["point_in_time"] = True
        return rows

    return collect_parts(
        "fred", [(key, lambda k=key, v=label: series(k, v)) for key, label in FRED_SERIES.items()]
    )


def collect_ofr(trade_date):
    """FSI and its regional/risk contributions, plus observed repo funding rates."""
    start = (date.fromisoformat(trade_date) - timedelta(days=400)).isoformat()
    url = "https://www.financialresearch.gov/financial-stress-index/data/fsi.csv"

    def stress():
        data = list(csv.DictReader(io.StringIO(request_text(url))))
        columns = (
            "OFR FSI",
            "Credit",
            "Equity valuation",
            "Safe assets",
            "Funding",
            "Volatility",
            "United States",
            "Other advanced economies",
            "Emerging markets",
        )
        if not data or not set(columns).issubset(data[0]):
            raise ValueError("OFR FSI schema changed")
        rows = [
            row
            for col in columns
            for row in numeric_rows(
                "ofr",
                col,
                [(r["Date"], r[col]) for r in data if r["Date"] >= start],
                url,
                trade_date=trade_date,
                unit="index contribution" if col != "OFR FSI" else "index",
                frequency="D",
                kind="index",
                note="FSI is published with a two-business-day lag; revisions are possible.",
            )
        ]
        return require_series("ofr", rows, columns, url)

    def repo():
        endpoint = "https://data.financialresearch.gov/v1/series/timeseries"
        mnemonic = "REPO-DVP_AR_G30-P"
        data = request_json(
            endpoint, params={"mnemonic": mnemonic, "start_date": start, "end_date": trade_date}
        )
        return numeric_rows(
            "ofr",
            mnemonic,
            data,
            endpoint + "?mnemonic=" + mnemonic,
            trade_date=trade_date,
            unit="percent",
            frequency="D",
            country="US",
            title="DVP repo: volume-weighted rate, term over 30 days, preliminary",
        )

    return collect_parts("ofr", [("financial stress", stress), ("term repo", repo)])


# Official BLS series IDs. Catalog metadata supply descriptions where available.
BLS_SERIES = {
    "CES0500000003": ("Private average hourly earnings", "USD/hour", ()),
    "CES3000000001": ("Manufacturing employment", "thousand persons", ("Industrials",)),
    "CES2000000001": (
        "Construction employment",
        "thousand persons",
        ("Industrials", "Real Estate"),
    ),
    "CES4200000001": ("Retail employment", "thousand persons", ("Consumer Cyclical",)),
    "CES6500000001": (
        "Private education and health employment",
        "thousand persons",
        ("Healthcare",),
    ),
    "JTS000000000000000JOL": ("Total nonfarm job openings", "thousand jobs", ()),
    "JTS000000000000000QUR": ("Total nonfarm quits rate", "percent", ()),
    "WPSFD4": ("PPI final demand", "index", ()),
    "WPSFD4131": (
        "PPI finished goods less foods and energy",
        "index (1982=100)",
        ("Industrials", "Consumer Cyclical"),
    ),
}


def collect_bls(trade_date):
    year = date.fromisoformat(trade_date).year
    url = "https://api.bls.gov/publicAPI/v2/timeseries/data/"
    # The API explicitly supports GET signatures; this avoids a new HTTP client.
    params = {"startyear": str(year - 2), "endyear": str(year), "catalog": "true"}
    if os.getenv("BLS_API_KEY"):
        params["registrationkey"] = os.environ["BLS_API_KEY"]

    def series(key, spec):
        payload = request_json(url + key, params=params)
        if payload.get("status") != "REQUEST_SUCCEEDED":
            raise ValueError("BLS request unsuccessful")
        result = []
        for batch in payload.get("Results", {}).get("series", []):
            if batch.get("seriesID") != key:
                continue
            catalog = batch.get("catalog", {})
            for point in batch.get("data", []):
                period = point.get("period", "")
                if period not in {f"M{n:02}" for n in range(1, 13)}:
                    continue  # M13 is an annual average, not a month.
                result.extend(
                    numeric_rows(
                        "bls",
                        key,
                        [(point["year"] + "-" + period[1:], point.get("value"))],
                        url + key,
                        trade_date=trade_date,
                        unit=spec[1],
                        frequency="M",
                        country="US",
                        sectors=spec[2],
                        title=catalog.get("series_title", spec[0]),
                        basis="seasonally adjusted",
                        footnotes=point.get("footnotes", []),
                    )
                )
        return result

    return collect_parts(
        "bls", [(k, lambda key=k, spec=v: series(key, spec)) for k, v in BLS_SERIES.items()]
    )


# Whole program tables are retained, with named series and units from provider
# dictionaries, rather than assuming all cell values are dollar levels.
CENSUS_PROGRAMS = ("M3ADV", "MRTS", "MWTS", "RESCONST", "VIP")
CENSUS_UNITS = {
    "MLN$": "million USD",
    "BLN$": "billion USD",
    "K$": "thousand USD",
    "PCT": "percent",
    "UNITS": "units",
    "RATIO": "ratio",
    "MO": "months",
    "DOL": "USD",
    "K": "thousand units",
    "CP$": "cents per dollar",
    "%PTS": "percentage points",
    "CENTS": "cents",
}


def census_bulk_rows(text, program, trade_date, url):
    """Read the provider's dictionaries before decoding cells in its bulk CSV."""
    tables = {}
    section = None
    columns = None
    start = date.fromisoformat(trade_date) - timedelta(days=800)
    result = []
    for cells in csv.reader(io.StringIO(text)):
        if not cells:
            continue
        if len(cells) == 1:
            section, columns = cells[0], None
            continue
        if section not in {"CATEGORIES", "DATA TYPES", "GEO LEVELS", "TIME PERIODS", "DATA"}:
            continue
        if columns is None:
            columns = cells
            continue
        row = dict(zip(columns, cells, strict=True))
        if section != "DATA":
            tables.setdefault(section, {})[cells[0]] = row
            continue
        if row.get("et_idx", "0") != "0":
            continue
        category = tables["CATEGORIES"][row["cat_idx"]]
        metric = tables["DATA TYPES"][row["dt_idx"]]
        geo = tables["GEO LEVELS"][row["geo_idx"]]
        # Sampling errors and published percent changes are distinct from levels.
        # Derive comparable changes ourselves from the retained level histories.
        if (
            geo["geo_code"] != "US"
            or metric["dt_unit"] not in CENSUS_UNITS
            or metric["dt_unit"] in {"PCT", "%PTS"}
        ):
            continue
        period = tables["TIME PERIODS"][row["per_idx"]]["per_name"]
        observed = datetime.strptime(period, "%b-%Y").date()
        if observed < start:
            continue
        basis = "seasonally adjusted" if row["is_adj"] == "1" else "not seasonally adjusted"
        title = category["cat_desc"] + ": " + metric["dt_desc"]
        unit = CENSUS_UNITS[metric["dt_unit"]]
        if (program == "VIP" and row["is_adj"] == "1") or "annual rate" in title.casefold():
            basis = "seasonally adjusted annual rate"
            unit += " per year (annualized)"
        target = f"{program}/{category['cat_code']}/{metric['dt_code']}/{row['is_adj']}"
        sectors = census_sectors(program, category["cat_code"])
        result.extend(
            numeric_rows(
                "census",
                target,
                [(observed.strftime("%Y-%m"), row["val"])],
                url,
                trade_date=trade_date,
                unit=unit,
                frequency="M",
                country="US",
                sectors=sectors,
                title=title,
                basis=basis,
                kind="ratio" if metric["dt_unit"] in {"RATIO", "MO"} else "level",
                note="Current revised bulk series. Seasonal adjustment and annual rates follow the program's definitions; aggregate categories overlap.",
            )
        )
    # Prefer the adjusted series when the same category/metric has one. Keep
    # unadjusted-only series, retaining the basis in every target and record.
    adjusted = {r["target"].rsplit("/", 1)[0] for r in result if r["target"].endswith("/1")}
    return [
        r
        for r in result
        if r["target"].endswith("/1") or r["target"].rsplit("/", 1)[0] not in adjusted
    ]


def collect_census(trade_date):
    def program(name):
        url = "https://www.census.gov/econ_getzippedfile/?programCode=" + name
        response = _request(url)
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            member = next(m for m in archive.infolist() if m.filename.lower().endswith("-mf.csv"))
            if member.file_size > 80_000_000:
                raise ValueError("Census expanded table exceeds bound")
            text = archive.read(member).decode("utf-8-sig")
        return census_bulk_rows(text, name, trade_date, url)

    return collect_parts("census", [(k, lambda key=k: program(key)) for k in CENSUS_PROGRAMS])


# Published rows: https://apps.bea.gov/scb/issues/2020/01-january/pdf/0120-selected-nipa-tables.pdf
# Industry codes: https://www.bea.gov/sites/default/files/2023-10/BEA-Industry-and-Commodity-Codes-and-NAICS-Concordance.xlsx
_BEA_NIPA_SECTORS = {
    "4": ("Consumer Cyclical",),
    "5": ("Consumer Cyclical",),
    "6": ("Consumer Cyclical",),
    "9": ("Consumer Defensive",),
    "10": ("Consumer Cyclical",),
    "11": ("Energy",),
    "16": ("Healthcare",),
    "17": ("Industrials",),
    "18": ("Consumer Cyclical",),
    "19": ("Consumer Cyclical",),
    "20": ("Financial Services",),
}
_BEA_INDUSTRY_SECTORS = {
    "211": ("Energy",),
    "22": ("Utilities",),
    "23": ("Industrials",),
    "311FT": ("Consumer Defensive",),
    "315AL": ("Consumer Cyclical",),
    "321": ("Basic Materials",),
    "322": ("Basic Materials",),
    "324": ("Energy",),
    "326": ("Basic Materials",),
    "327": ("Basic Materials",),
    "331": ("Basic Materials",),
    "332": ("Industrials",),
    "333": ("Industrials",),
    "334": ("Technology",),
    "3361MV": ("Consumer Cyclical",),
    "3364OT": ("Industrials",),
    "337": ("Consumer Cyclical",),
    "441": ("Consumer Cyclical",),
    "445": ("Consumer Defensive",),
    "481": ("Industrials",),
    "482": ("Industrials",),
    "483": ("Industrials",),
    "484": ("Industrials",),
    "485": ("Industrials",),
    "486": ("Energy",),
    "487OS": ("Industrials",),
    "493": ("Industrials",),
    "512": ("Communication Services",),
    "513": ("Communication Services",),
    "521CI": ("Financial Services",),
    "523": ("Financial Services",),
    "524": ("Financial Services",),
    "525": ("Financial Services",),
    "5415": ("Technology",),
    "561": ("Industrials",),
    "562": ("Industrials",),
    "621": ("Healthcare",),
    "622": ("Healthcare",),
    "623": ("Healthcare",),
    "624": ("Healthcare",),
    "711AS": ("Consumer Cyclical",),
    "713": ("Consumer Cyclical",),
    "72": ("Consumer Cyclical",),
    "721": ("Consumer Cyclical",),
    "722": ("Consumer Cyclical",),
    "HS": ("Real Estate",),
    "ORE": ("Real Estate",),
}


def bea_sectors(dataset, table, item):
    """Return sector context only for exact published BEA table/item codes."""
    if dataset == "NIPA" and table in {"T20305", "T20306"}:
        return list(_BEA_NIPA_SECTORS.get(str(item), ()))
    if dataset == "GDPbyIndustry" and table == "1":
        return list(_BEA_INDUSTRY_SECTORS.get(str(item), ()))
    return []


def collect_bea(trade_date):
    """Detailed consumption and industry value added; keep SAAR units."""
    year = date.fromisoformat(trade_date).year
    url = "https://apps.bea.gov/api/data/"

    def table(dataset, selector):
        payload = request_json(
            url,
            params={
                "UserID": os.environ["BEA_API_KEY"],
                "method": "GetData",
                "datasetname": dataset,
                "Year": ",".join(str(y) for y in range(year - 2, year + 1)),
                # T20305/T20306 are quarterly/annual tables, not monthly PCE.
                "Frequency": "Q",
                "ResultFormat": "JSON",
                **selector,
            },
        )
        results = payload.get("BEAAPI", {}).get("Results", {})
        if isinstance(results, dict) and "Error" in results:
            raise ValueError("BEA provider error")
        tables = results if isinstance(results, list) else [results]
        rows = []
        for entry in tables:
            for row in entry.get("Data", []):
                period = row.get("TimePeriod")
                if not period:
                    quarter = str(row.get("Quarter", ""))
                    quarter = {
                        "I": "Q1",
                        "II": "Q2",
                        "III": "Q3",
                        "IV": "Q4",
                        "1": "Q1",
                        "2": "Q2",
                        "3": "Q3",
                        "4": "Q4",
                        "Annual": "",
                    }.get(quarter, quarter)
                    period = str(row.get("Year", "")) + quarter
                frequency = "Q" if "Q" in period else "M" if "M" in period else "A"
                title = (
                    row.get("LineDescription")
                    or row.get("IndustrYDescription")
                    or row.get("IndustryDescription")
                    or row.get("Description", "")
                )
                item = row.get("LineNumber") or row.get("Industry") or row.get("industry", "")
                metric_name = row.get("Metric_Name", row.get("METRIC_NAME", ""))
                unit = row.get("CL_UNIT") or row.get("UNIT")
                multiplier = str(row.get("UNIT_MULT", "0"))
                if unit:
                    unit = (
                        f"{metric_name + '; ' if metric_name else ''}{unit}; scale 10^{multiplier}"
                    )
                elif dataset == "GDPbyIndustry" and selector.get("TableID") == "1":
                    unit = "billion current USD; seasonally adjusted annual rate"
                else:
                    raise ValueError("BEA observation units are unavailable")
                rows.extend(
                    numeric_rows(
                        "bea",
                        f"{dataset}/{selector.get('TableName', selector.get('TableID'))}/{item}/{frequency}",
                        [(period, row.get("DataValue"))],
                        "https://apps.bea.gov/iTable/",
                        trade_date=trade_date,
                        unit=unit,
                        frequency=frequency,
                        country="US",
                        title=title,
                        sectors=bea_sectors(
                            dataset,
                            selector.get("TableName", selector.get("TableID")),
                            item,
                        ),
                        kind="level",
                        basis=row.get("Metric_Name", row.get("METRIC_NAME", unit)),
                        dimensions={
                            k: row[k]
                            for k in (
                                "TableName",
                                "LineNumber",
                                "Industry",
                                "SeriesCode",
                                "METRIC_NAME",
                            )
                            if k in row
                        },
                        provider_notes=entry.get("Notes", []),
                        note=("Aggregate accounts, not issuer revenue. Quarterly levels are seasonally adjusted annual rates. "
                              + ("Nominal industry value added is not physical production volume."
                                 if dataset == "GDPbyIndustry" else
                                 "Chain-dollar components are not additive.")),
                    )
                )
        return rows

    return collect_parts(
        "bea",
        [
            ("nominal consumption", lambda: table("NIPA", {"TableName": "T20305"})),
            ("real consumption", lambda: table("NIPA", {"TableName": "T20306"})),
            (
                "industry value added",
                lambda: table("GDPbyIndustry", {"TableID": "1", "Industry": "ALL"}),
            ),
        ],
    )
