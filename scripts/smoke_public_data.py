"""Exercise official collectors without paying for an LLM run.

Run from a checkout: python scripts/smoke_public_data.py --sources census,ofr
"""

import argparse
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tradingagents.dataflows.public_data import PUBLIC_SOURCES, collect_public_data  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sources",
        default="nyfed,cftc,treasury,ecb,ofr,census,bls,oecd,eurostat,bis,tic,mof_japan",
    )
    parser.add_argument(
        "--date", default=datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    )
    parser.add_argument("--ticker", help="Use AAPL for SEC or 005930.KS for Korean issuer sources")
    parser.add_argument("--asset-type", default="stock", choices=["stock", "crypto"])
    parser.add_argument("--output", type=Path, help="Optional JSON evidence file")
    parser.add_argument(
        "--list", action="store_true", help="Show source IDs and required credential names"
    )
    args = parser.parse_args()
    load_dotenv()
    if args.list:
        for source, (_, keys) in PUBLIC_SOURCES.items():
            print(f"{source}: {', '.join(keys) if keys else 'no required API key'}")
        return 0
    result = collect_public_data(
        args.date,
        {"public_data_sources": args.sources},
        ticker=args.ticker,
        asset_type=args.asset_type,
    )
    rows = result["evidence"]
    for source in dict.fromkeys(r["source"] for r in rows):
        batch = [r for r in rows if r["source"] == source]
        print(
            json.dumps(
                {
                    "source": source,
                    "statuses": dict(Counter(r["status"] for r in batch)),
                    "series": len({r["target"] for r in batch if r["status"] == "success"}),
                    "gaps": [
                        {"target": r["target"], "status": r["status"], "detail": r["content"]}
                        for r in batch
                        if r["status"] != "success"
                    ],
                },
                ensure_ascii=False,
            )
        )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    # Fail visibly on partial coverage. This is a provider/schema check, not an
    # assertion that missing credentials should stop normal analysis.
    return 0 if rows and all(r["status"] == "success" for r in rows) else 2


if __name__ == "__main__":
    raise SystemExit(main())
