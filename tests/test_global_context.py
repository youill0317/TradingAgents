from types import SimpleNamespace
from unittest.mock import patch

from tradingagents.dataflows import global_context, reddit, yfinance_news


def test_context_keeps_optional_failures_and_urls():
    with patch.object(global_context, "route_to_vendor", return_value="Headline https://news.example/item"), \
         patch.object(global_context, "collect_reddit_topic", side_effect=[
             {"status": "success", "posts": [{"title": "Inflation", "url": "https://reddit.com/post", "created_utc": 1}]},
             {"status": "failed", "posts": [], "error": "HTTP 429"},
         ]), patch.object(global_context, "fetch_stocktwits_messages", return_value="<stocktwits unavailable: HTTPError>"):
        result = global_context.collect_global_context("2026-09-09")
    assert len(result["evidence"]) == 6
    assert len(result["warnings"]) == 2
    assert "https://reddit.com/post" in result["report"]
    assert "1970-01-01" in result["report"]
    assert "unverified opinions" in result["report"]


def test_reddit_empty_and_failure_differ():
    with patch.object(reddit, "_fetch_subreddit_rss", return_value=[]):
        assert reddit.collect_reddit_topic("inflation", "Economics")["status"] == "empty"
    with patch.object(reddit, "_fetch_subreddit_rss", side_effect=OSError("blocked")):
        assert reddit.collect_reddit_topic("inflation", "Economics")["status"] == "failed"


def test_global_news_queries_all_groups_filters_before_cap_and_survives_failure():
    def article(title, date="2026-09-08T12:00:00Z"):
        return {"content": {"title": title, "pubDate": date, "canonicalUrl": {"url": "https://news.example/" + title}}}
    config = {"global_news_queries": ["US", "Asia", "war"], "global_news_article_limit": 2,
              "global_news_lookback_days": 7}
    with patch.object(yfinance_news, "get_config", return_value=config), \
         patch.object(yfinance_news, "yf_retry", side_effect=lambda fn: fn()), \
         patch.object(yfinance_news.yf, "Search", side_effect=[
             SimpleNamespace(news=[article("old", "2020-01-01T00:00:00Z"), article("US1"), article("US2")]),
             SimpleNamespace(news=[article("US1"), article("Asia1")]), RuntimeError("blocked"),
         ]) as search:
        result = yfinance_news.get_global_news_yfinance("2026-09-09")
    assert search.call_count == 3
    assert "### US1" in result and "### Asia1" in result
    assert "### US2" not in result and "### old" not in result
    assert "war: failed" in result


def test_topic_rss_retains_permalink_and_reports_http_failure():
    from urllib.error import HTTPError

    atom = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Policy</title><link rel="alternate" href="https://reddit.com/r/Economics/comments/1"/><published>2026-09-08T12:00:00Z</published></entry></feed>'
    from unittest.mock import MagicMock

    response = MagicMock()
    response.__enter__.return_value.read.return_value = atom
    with patch.object(reddit, "urlopen", return_value=response):
        result = reddit.collect_reddit_topic("inflation", "Economics")
    assert result["posts"][0]["url"] == "https://reddit.com/r/Economics/comments/1"
    assert result["posts"][0]["created_utc"] > 0
    with patch.object(reddit, "urlopen", side_effect=HTTPError("url", 403, "Forbidden", {}, None)):
        result = reddit.collect_reddit_topic("inflation", "Economics")
    assert result["status"] == "failed" and result["posts"] == []
    assert result["error"]


def test_news_failure_words_are_not_retrieval_errors_and_exceptions_are_sanitized():
    with patch.object(global_context, "route_to_vendor", side_effect=[
        "### Failed peace talks\nNews about unavailable energy supplies",
        RuntimeError("https://api.example?apikey=secret"), "No open prediction markets matched topic",
    ]) as route, patch.object(global_context, "get_vendor", return_value="yfinance"), \
         patch.object(global_context, "collect_reddit_topic", return_value={"status": "empty", "posts": []}), \
         patch.object(global_context, "fetch_stocktwits_messages", return_value="<no StockTwits messages>"):
        result = global_context.collect_global_context("2026-09-09")
    assert result["evidence"][0]["status"] == "success"
    assert result["evidence"][0]["configured_provider"] == "yfinance"
    assert result["evidence"][1]["content"] == "RuntimeError"
    assert "secret" not in result["report"]
    assert all(item["retrieved_at"].endswith("+00:00") for item in result["evidence"])
    assert route.call_args_list[1].args == ("get_prediction_markets", "interest rates")
    assert route.call_args_list[2].args == ("get_prediction_markets", "geopolitics")


def test_market_news_cutoff_uses_pinned_utc_after_new_york_day_boundary():
    from tradingagents.dataflows import alpha_vantage_news

    config = {"market_scan_date": "2026-09-09", "market_scan_as_of": "2026-09-10T02:00:00+00:00",
              "global_news_queries": ["world"], "global_news_article_limit": 2, "global_news_lookback_days": 7}
    def article(title, stamp):
        return {"content": {"title": title, "pubDate": stamp}}
    with patch.object(yfinance_news, "get_config", return_value=config), \
         patch.object(yfinance_news, "yf_retry", side_effect=lambda fn: fn()), \
         patch.object(yfinance_news.yf, "Search", return_value=SimpleNamespace(news=[
             article("evening", "2026-09-10T01:00:00Z"), article("future", "2026-09-10T03:00:00Z")])):
        report = yfinance_news.get_global_news_yfinance("2026-09-09")
    assert "### evening" in report and "### future" not in report
    with patch.object(alpha_vantage_news, "get_config", return_value=config), \
         patch.object(alpha_vantage_news, "_make_api_request", return_value={}) as request:
        alpha_vantage_news.get_global_news("2026-09-09", look_back_days=7, limit=2)
    assert request.call_args.args[1]["time_to"] == "20260910T0200"
    assert request.call_args.args[1]["time_from"] == "20260903T0200"


def test_alpha_news_payload_status_and_configured_limits():
    import json

    for payload, expected in [({"feed": []}, "empty"), ({"Information": "apikey=secret"}, "failed"),
                              ({"Note": "quota"}, "failed"), ({"Error Message": "invalid"}, "failed")]:
        for response in (payload, json.dumps(payload)):
            with patch.object(global_context, "get_config", return_value={"global_news_lookback_days": 3, "global_news_article_limit": 4}), \
                 patch.object(global_context, "route_to_vendor", return_value=response) as route, \
                 patch.object(global_context, "collect_reddit_topic", return_value={"status": "empty", "posts": []}), \
                 patch.object(global_context, "fetch_stocktwits_messages", return_value="<no messages>"):
                result = global_context.collect_global_context("2026-09-09")
            assert result["evidence"][0]["status"] == expected
            assert "apikey=secret" not in result["evidence"][0]["content"]
            assert route.call_args_list[0].kwargs == {"look_back_days": 3, "limit": 4}


def test_partial_news_keeps_successful_coverage_usable():
    with patch.object(global_context, "route_to_vendor", return_value=(
        "## Global Market News\n### Policy news\n\nQuery coverage:\n"
        "- US: success (1 in window)\n- Asia: failed (TimeoutError)"
    )), patch.object(global_context, "collect_reddit_topic", return_value={"status": "empty", "posts": []}), \
         patch.object(global_context, "fetch_stocktwits_messages", return_value="<no messages>"):
        result = global_context.collect_global_context("2026-09-11")
    assert result["evidence"][0]["status"] == "partial"
    assert "Policy news" in result["evidence"][0]["content"]
    assert result["warnings"]
