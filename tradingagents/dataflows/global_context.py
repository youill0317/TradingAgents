"""Optional global news and community context using existing providers."""

import json
from datetime import datetime, timezone

from .config import get_config
from .interface import get_category_for_method, get_vendor, route_to_vendor
from .reddit import collect_reddit_topic
from .stocktwits import fetch_stocktwits_messages


def collect_global_context(trade_date: str) -> dict:
    """Collect bounded evidence; optional source failures never stop a market scan."""
    evidence, warnings = [], []
    config = get_config()
    for method, target in (("get_global_news", trade_date),
                           ("get_prediction_markets", "interest rates"),
                           ("get_prediction_markets", "geopolitics")):
        provider = "unknown"
        try:
            provider = get_vendor(get_category_for_method(method), method)
            kwargs = ({"look_back_days": config["global_news_lookback_days"],
                       "limit": config["global_news_article_limit"]}
                      if method == "get_global_news" else {})
            response = route_to_vendor(method, target, **kwargs)
            payload = response
            if isinstance(response, str):
                try:
                    payload = json.loads(response)
                except (ValueError, TypeError):
                    payload = None
            content = json.dumps(response) if isinstance(response, dict) else str(response)
            lines = content.lower().splitlines()
            failed = any(line.startswith(("error fetching", "data_unavailable:",
                                          "polymarket data is currently unavailable"))
                         for line in lines)
            coverage = content.partition("\nQuery coverage:\n")[2]
            partial_failure = any(": failed (" in line for line in coverage.splitlines())
            empty = any(line.startswith(("no global news", "no open prediction markets"))
                        for line in lines)
            if method == "get_global_news" and isinstance(payload, dict):
                failed = failed or any(key in payload for key in ("Error Message", "Information", "Note"))
                empty = empty or payload.get("feed") == []
            has_news = any(": success (" in line for line in coverage.splitlines())
            status = ("failed" if failed or (partial_failure and not has_news) else
                      "partial" if partial_failure else "empty" if empty else "success")
            if failed:
                content = "Provider reported retrieval failure; error details omitted."
        except Exception as exc:
            content, status = type(exc).__name__, "failed"
        evidence.append({"source": method, "configured_provider": provider, "target": target,
                         "status": status, "content": content,
                         "retrieved_at": datetime.now(timezone.utc).isoformat()})

    for subreddit, query in (("Economics", "inflation"), ("geopolitics", "war OR trade")):
        target = f"r/{subreddit}: {query}"
        try:
            result = collect_reddit_topic(query, subreddit)
            lines = []
            for post in result["posts"]:
                stamp = post.get("created_utc")
                published = datetime.fromtimestamp(stamp, timezone.utc).isoformat() if stamp else "unknown"
                lines.append(f"{published}: {post.get('title', '')}\n"
                             f"Excerpt: {post.get('selftext', '')[:240]}\nURL: {post.get('url', '')}")
            content = "\n\n".join(lines) or result.get("error", "No matching posts")
            status = result["status"]
        except Exception as exc:
            content, status = type(exc).__name__, "failed"
        evidence.append({"source": "reddit", "target": target, "status": status, "content": content,
                         "retrieved_at": datetime.now(timezone.utc).isoformat()})

    try:
        content = fetch_stocktwits_messages("SPY", limit=5)
        status = "failed" if content.lower().startswith("<stocktwits unavailable:") else "empty" if content.startswith("<no ") else "success"
    except Exception as exc:
        content, status = type(exc).__name__, "failed"
    evidence.append({"source": "stocktwits", "target": "SPY", "status": status,
                     "content": content + "\nSource: https://stocktwits.com/symbol/SPY",
                     "retrieved_at": datetime.now(timezone.utc).isoformat()})
    for item in evidence:
        if item["status"] != "success":
            warnings.append(f"{item['source']} ({item['target']}): {item['status']}")
    caution = (
        "News may contain only headlines and summaries, not verified full articles. "
        "Separate reported claims from confirmed facts and political impact scenarios. "
        "Community posts are unverified opinions, not representative polling; do not profile authors. "
        "Prediction-market probabilities express participant expectations, not confirmed facts. "
        "Missing coverage is not evidence that no conflict or risk exists."
    )
    report = caution + "\n\n" + "\n\n".join(
        f"## {item['source']}: {item['target']} [{item['status']}]\n{item['content']}"
        for item in evidence
    )
    return {"report": report, "evidence": evidence, "warnings": warnings}
