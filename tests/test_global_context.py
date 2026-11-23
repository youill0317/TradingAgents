from unittest.mock import patch

from tradingagents.dataflows import global_context
from tradingagents.dataflows.vendors import reddit


def test_reddit_empty_and_failure_differ():
    with patch.object(reddit, "_fetch_subreddit_rss", return_value=[]):
        assert global_context.collect_reddit_topic("inflation", "Economics")["status"] == "empty"
    with patch.object(reddit, "_fetch_subreddit_rss", side_effect=OSError("blocked")):
        assert global_context.collect_reddit_topic("inflation", "Economics")["status"] == "failed"


def test_topic_rss_parses_posts_and_reports_http_failure():
    from urllib.error import HTTPError

    atom = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Policy</title><link rel="alternate" href="https://reddit.com/r/Economics/comments/1"/><published>2026-09-08T12:00:00Z</published></entry></feed>'
    from unittest.mock import MagicMock

    response = MagicMock()
    response.__enter__.return_value.read.return_value = atom
    with patch.object(reddit, "urlopen", return_value=response):
        result = global_context.collect_reddit_topic("inflation", "Economics")
    assert result["posts"][0]["title"] == "Policy"
    assert result["posts"][0]["created_utc"] > 0
    with patch.object(reddit, "urlopen", side_effect=HTTPError("url", 403, "Forbidden", {}, None)):
        result = global_context.collect_reddit_topic("inflation", "Economics")
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
    assert len(result["warnings"]) == 1, "empty optional results are not degraded coverage"
    assert "secret" not in result["report"]
    assert all(item["retrieved_at"].endswith("+00:00") for item in result["evidence"])
    assert route.call_args_list[1].args == ("get_prediction_markets", "interest rates")
    assert route.call_args_list[2].args == ("get_prediction_markets", "geopolitics")


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
