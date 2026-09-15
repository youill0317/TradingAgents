"""Official regional activity, global credit and cross-border securities data."""

import csv
import io
import re
import unicodedata
from collections import defaultdict
from datetime import date, timedelta
from xml.etree import ElementTree as ET

from .public_data_common import collect_parts, numeric_rows, period_date, request_json, request_text

COUNTRIES = {
    "USA",
    "GBR",
    "CHN",
    "JPN",
    "KOR",
    "IND",
    "DEU",
    "FRA",
    "ITA",
    "ESP",
    "CAN",
    "AUS",
    "BRA",
    "MEX",
}


def collect_oecd(trade_date):
    """Amplitude-adjusted CLI; country-level cycles, not return forecasts."""
    url = (
        "https://sdmx.oecd.org/public/rest/v1/data/OECD.SDD.STES,DSD_STES@DF_CLI,/"
        + "+".join(sorted(COUNTRIES))
        + ".M.LI...AA...H"
    )
    start = (date.fromisoformat(trade_date) - timedelta(days=800)).strftime("%Y-%m")
    root = ET.fromstring(
        request_text(
            url,
            params={"startPeriod": start, "endPeriod": trade_date},
            headers={"Accept": "application/vnd.sdmx.genericdata+xml;version=2.1"},
        )
    )
    ns = {"g": "http://www.sdmx.org/resources/sdmxml/schemas/v2_1/data/generic"}
    result = []
    for series in root.findall(".//g:Series", ns):
        dims = {v.get("id"): v.get("value") for v in series.findall("g:SeriesKey/g:Value", ns)}
        if dims.get("REF_AREA") not in COUNTRIES or dims.get("MEASURE") != "LI":
            continue
        points = [
            (obs.find("g:ObsDimension", ns).get("value"), obs.find("g:ObsValue", ns).get("value"))
            for obs in series.findall("g:Obs", ns)
            if obs.find("g:ObsValue", ns) is not None
        ]
        result.extend(
            numeric_rows(
                "oecd",
                f"CLI/{dims['REF_AREA']}",
                points,
                url,
                trade_date=trade_date,
                unit="index (long-term average=100)",
                frequency="M",
                country=dims["REF_AREA"],
                dimensions=dims,
                title="Composite leading indicator, amplitude adjusted",
                kind="index",
                note="Signals growth-cycle turning points; subject to revisions, not a stock-price forecast.",
            )
        )
    return result


def collect_bis(trade_date):
    url = "https://stats.bis.org/api/v1/data/WS_GLI/Q.USD+EUR+JPY.3P.N.A.I.B.USD+EUR+JPY"
    text = request_text(
        url,
        params={
            "startPeriod": str(date.fromisoformat(trade_date).year - 3),
            "endPeriod": trade_date,
            "format": "csv",
        },
    )
    data = list(csv.DictReader(io.StringIO(text)))
    result = []
    for row in data:
        if not {"TIME_PERIOD", "OBS_VALUE", "UNIT_MEASURE", "UNIT_MULT", "TITLE"}.issubset(row):
            raise ValueError("BIS SDMX CSV schema changed")
        if row["UNIT_MEASURE"] != row["CURR_DENOM"]:
            continue  # Keep native currency levels, never pool currency conversions.
        result.extend(
            numeric_rows(
                "bis",
                "GLI/" + row["CURR_DENOM"],
                [(row["TIME_PERIOD"], row["OBS_VALUE"])],
                url,
                trade_date=trade_date,
                unit=f"{row['UNIT_MEASURE']}; scale 10^{row['UNIT_MULT']}",
                frequency="Q",
                title=row["TITLE"],
                dimensions={
                    k: row[k]
                    for k in ("CURR_DENOM", "BORROWERS_CTY", "BORROWERS_SECTOR", "UNIT_MULT")
                },
                note="Quarterly credit stock, not current-day capital flow; publication lag and revisions apply.",
            )
        )
    return result


EUROSTAT_QUERIES = {
    "sts_inpr_m": {"nace_r2": "B-D", "s_adj": "SCA", "unit": "I21"},
    "sts_trtu_m": {"nace_r2": "G47", "s_adj": "SCA", "unit": "I21", "indic_bt": "VOL_SLS"},
    "sts_copr_m": {"s_adj": "SCA", "unit": "I21", "indic_bt": "PRD", "nace_r2": "F"},
    "namq_10_gdp": {"s_adj": "SCA", "unit": "CLV_PCH_PRE", "na_item": "B1GQ"},
    "une_rt_m": {"s_adj": "SA", "unit": "PC_ACT", "sex": "T", "age": "TOTAL"},
}
EUROSTAT_SECTORS = {
    "sts_inpr_m": ("Industrials", "Basic Materials", "Technology"),
    "sts_trtu_m": ("Consumer Cyclical", "Consumer Defensive"),
    "sts_copr_m": ("Real Estate", "Industrials"),
}


def jsonstat_rows(payload):
    """Decode sparse JSON-stat by dimension indexes; never assume time is axis 0."""
    ids, sizes = payload["id"], payload["size"]
    codes = {}
    for axis, size in zip(ids, sizes, strict=True):
        index = payload["dimension"][axis]["category"]["index"]
        codes[axis] = (
            index
            if isinstance(index, list)
            else [k for k, _ in sorted(index.items(), key=lambda kv: kv[1])]
        )
        if len(codes[axis]) != size:
            raise ValueError("Invalid JSON-stat dimension")
    values = payload.get("value", {})
    entries = enumerate(values) if isinstance(values, list) else values.items()
    for offset, value in entries:
        position = int(offset)
        dimensions = {}
        for axis, size in reversed(list(zip(ids, sizes, strict=True))):
            dimensions[axis] = codes[axis][position % size]
            position //= size
        if position:
            raise ValueError("JSON-stat index outside dimensions")
        yield dimensions, value


def collect_eurostat(trade_date):
    start = (date.fromisoformat(trade_date) - timedelta(days=800)).isoformat()[:7]

    def table(name, query):
        url = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/" + name
        payload = request_json(
            url,
            params={
                "lang": "en",
                "geo": ["EA20", "DE", "FR", "IT", "ES"],
                "sinceTimePeriod": start[:4] + "-Q1" if name == "namq_10_gdp" else start,
                **query,
            },
        )
        result = []
        for dims, value in jsonstat_rows(payload):
            period = dims.pop("time")
            unit_code = dims["unit"]
            unit = (
                payload["dimension"]["unit"]["category"].get("label", {}).get(unit_code, unit_code)
            )
            target = name + "/" + "/".join(f"{k}={v}" for k, v in sorted(dims.items()))
            result.extend(
                numeric_rows(
                    "eurostat",
                    target,
                    [(period, value)],
                    url,
                    trade_date=trade_date,
                    unit=unit,
                    frequency=dims.get("freq", "M"),
                    country=dims["geo"],
                    title=payload.get("label"),
                    sectors=EUROSTAT_SECTORS.get(name, ()),
                    basis=dims.get("s_adj"),
                    dimensions=dims,
                    provider_updated_at=payload.get("updated"),
                    kind="rate" if "PC" in unit_code else "level",
                )
            )
        return result

    return collect_parts(
        "eurostat",
        [(name, lambda n=name, q=query: table(n, q)) for name, query in EUROSTAT_QUERIES.items()],
    )


def collect_tic(trade_date):
    """TIC SLT table 1 explicitly separates holdings, transactions and valuation."""
    url = "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table1.txt"
    text = request_text(url)
    lines = list(csv.reader(io.StringIO(text), delimiter="\t"))
    header = next(
        i for i, row in enumerate(lines) if row[:3] == ["Country", "Country Code", "Date"]
    )
    if "Millions of dollars" not in text or lines[header][3:6] != [
        "Holdings",
        "Net U.S. Sales",
        "Valuation Change",
    ]:
        raise ValueError("TIC schema or units changed")
    assets = [label.strip() for label in lines[header - 1]]
    cutoff = date.fromisoformat(trade_date)
    start = cutoff - timedelta(days=800)
    countries = {
        "Grand Total",
        "Total",
        "All Countries",
        "Japan",
        "China, Mainland",
        "China, mainland",
        "United Kingdom",
        "Korea, South",
        "Korea",
        "Germany",
        "France",
        "Canada",
        "India",
        "Taiwan",
    }
    result = []
    for row in lines[header + 1 :]:
        if len(row) < 18 or row[0].strip() not in countries:
            continue
        period = row[2].strip()
        if re.fullmatch(r"\d{4}-\d{2}", period):
            observed = period_date(period)
        else:
            match = re.fullmatch(r"(\d{1,2})/(\d{4})", period)
            observed = date(int(match[2]), int(match[1]), 1) if match else period_date(period)
        if not observed or not start <= observed <= cutoff:
            continue
        for col in range(3, 18):
            metric = lines[header][col]
            result.extend(
                numeric_rows(
                    "tic",
                    f"{row[0].strip()}/{assets[col]}/{metric}",
                    [(observed.strftime("%Y-%m"), row[col])],
                    url,
                    trade_date=trade_date,
                    unit="million USD",
                    frequency="M",
                    country=row[0].strip(),
                    kind="level" if metric == "Holdings" else "flow",
                    metric=metric,
                    note="Net U.S. sales to foreigners >0 means foreign net acquisition. Holdings changes include valuation; country may reflect custody rather than ultimate owner.",
                )
            )
    return result


def collect_mof_japan(trade_date):
    """Japanese weekly and monthly cross-border transactions; positive=net buying."""
    base = "https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/"
    cutoff = date.fromisoformat(trade_date)
    start = cutoff - timedelta(days=800)

    def table(filename, frequency):
        url = base + filename
        text = request_text(url, encoding="cp932")
        if "100 million Yen" not in text and "100 mil Yen" not in text:
            raise ValueError("MOF units changed")
        data = list(csv.reader(io.StringIO(text)))
        net_header = next(
            i for i, row in enumerate(data) if "Acquisition" in row and "Disposition" in row
        )
        expected = (
            (3, 6, 10, 11, 14, 17, 21, 22) if frequency == "W" else (5, 8, 12, 13, 16, 19, 23, 24)
        )
        if any(not data[net_header][i].startswith("Net") for i in expected):
            raise ValueError("MOF column layout changed")
        labels = (
            "outward/equity",
            "outward/long-term debt",
            "outward/short-term debt",
            "outward/total",
            "inward/equity",
            "inward/long-term debt",
            "inward/short-term debt",
            "inward/total",
        )
        points = defaultdict(list)
        current_year = None
        for row in data[net_header + 1 :]:
            if len(row) <= max(expected):
                continue
            if frequency == "W":
                value = unicodedata.normalize("NFKC", row[0]).replace(" ", "")
                match = re.fullmatch(
                    r"(\d{4})\.(\d{1,2})\.(\d{1,2})[~〜～](?:(\d{4})\.)?(\d{1,2})\.(\d{1,2})", value
                )
                if not match:
                    continue
                year = int(match[4] or match[1]) + (
                    1 if not match[4] and int(match[5]) < int(match[2]) else 0
                )
                observed = date(year, int(match[5]), int(match[6]))
                period = observed.isoformat()
            else:
                if re.fullmatch(r"\d{4}", row[0].strip()):
                    current_year = int(row[0])
                month = row[2].strip()
                months = (
                    "Jan",
                    "Feb",
                    "Mar",
                    "Apr",
                    "May",
                    "Jun",
                    "Jul",
                    "Aug",
                    "Sep",
                    "Oct",
                    "Nov",
                    "Dec",
                )
                if current_year is None or month not in months:
                    continue
                observed = date(current_year, months.index(month) + 1, 1)
                period = observed.strftime("%Y-%m")
            if observed.year < 2014 or not start <= observed <= cutoff:
                continue
            for label, col in zip(labels, expected, strict=True):
                points[label].append((period, row[col]))
        return [
            r
            for label, values in points.items()
            for r in numeric_rows(
                "mof_japan",
                frequency + "/" + label,
                values,
                url,
                trade_date=trade_date,
                unit="100 million JPY",
                frequency=frequency,
                country="JP",
                kind="flow",
                note="Designated major reporting investors, not the entire balance of payments; positive=net acquisition. Current file may revise past observations.",
            )
        ]

    return collect_parts(
        "mof_japan",
        [
            ("weekly flows", lambda: table("week.csv", "W")),
            ("monthly flows", lambda: table("montha1.csv", "M")),
        ],
    )
