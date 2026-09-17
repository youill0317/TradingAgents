"""Non-LLM failures observed during the four live workflow runs."""
from unittest.mock import Mock

import pandas as pd
import pytest

pytestmark = pytest.mark.usefixtures("data_retry_clock")
import requests

from tradingagents.dataflows import fred, global_context, kalshi, public_data_common, y_finance
from tradingagents.dataflows.public_evidence import assess_evidence, evidence_id


def response(status, payload):
    result = requests.Response()
    result.status_code = status
    result._content = b'{}'
    result._content_consumed = True
    result.json = lambda: payload
    result.url = 'https://example.test/?api_key=do-not-expose'
    return result


def test_fred_recovers_once_and_failure_retains_safe_status(monkeypatch):
    monkeypatch.setenv('FRED_API_KEY', 'do-not-expose')
    bad, good = response(429, {}), response(200, {'observations': []})
    fetch = Mock(side_effect=[bad, good, bad, bad])
    monkeypatch.setattr(requests, 'get', fetch)
    assert fred._request('series/observations', {'series_id': 'TEST'}) == {'observations': []}
    rows = public_data_common.collect_parts('fred', [('TEST', lambda: fred._request('series', {}))])
    assert fetch.call_count == 4
    assert 'HTTP 429' in rows[0]['content']
    assert 'do-not-expose' not in str(rows)
    from tradingagents.dataflows import retry
    retry._COOLDOWN_DB.unlink()
    fetch.side_effect = [response(400, {'error_message': 'Unknown series'})]
    with pytest.raises(ValueError, match='Unknown series'):
        fred._request('series', {})
    assert fetch.call_count == 5  # Permanent bad requests are not retried.


@pytest.mark.parametrize('label,day,age,stale', [
    ('2025', '2026-09-17', 260, False),
    ('2026Q1', '2026-09-17', 170, False),
    ('2026-Q1', '2026-09-17', 170, False),
    ('202606', '2026-09-17', 79, False),
    ('2024M2', '2024-03-01', 1, False),
    ('2026-09', '2026-09-17', 0, False),
    ('2024', '2026-09-17', 625, True),
    ('2026-01-01', '2026-09-17', 259, True),
])
def test_coarse_period_age_keeps_exact_dates_and_ids(label, day, age, stale):
    row = public_data_common.evidence('test', 'metric', 'observation', None, value=1, observed_at=label)
    original_id = evidence_id(row)
    assess_evidence([row], day)
    assert row['observed_at'] == label
    assert row['evidence_id'] == original_id
    assert row['observation_age_days'] == age and row['stale'] is stale
    future = {**row, 'observed_at': '2099Q1', 'status': 'success'}
    assess_evidence([future], day)
    assert future['status'] == 'unavailable_as_of'


def test_native_category_excludes_title_collisions_and_subtitles_are_not_conditions(monkeypatch):
    series = [{'ticker': 'CONFLICT', 'title': 'Ceasefire', 'category': 'World'},
              {'ticker': 'OLD', 'title': 'Old event', 'category': 'World', 'volume_fp': '999999'},
              {'ticker': 'SPORT', 'title': 'World Cup', 'category': 'Sports'}]
    contract = dict(ticker='CONTRACT', title='Ceasefire?', status='active', close_time='2099-01-01T00:00:00Z',
                    yes_bid_dollars='.4', yes_ask_dollars='.5', volume_fp='100', volume_24h_fp='10',
                    open_interest_fp='20', yes_sub_title='Same label', no_sub_title='Same label',
                    rules_primary='The actual settlement rule.')
    fetch = Mock(side_effect=lambda path, params: {'series': series} if path == 'series' else
                 {'events': [{'series_ticker': 'CONFLICT'}], 'cursor': 'more'} if path == 'events' else {'markets': [contract]})
    monkeypatch.setattr(kalshi, '_request', fetch)
    out = kalshi.get_prediction_markets('world')
    assert fetch.call_args_list[2].args[1]['series_ticker'] == 'CONFLICT'
    assert 'other series activity is unverified' in out
    assert 'Provider category World' in out and 'YES subtitle: Same label' in out
    assert 'NO subtitle: Same label' in out and 'NO condition' not in out
    assert 'Settlement rules: The actual settlement rule.' in out


@pytest.mark.parametrize('provider,topics', [('kalshi', ['Economics', 'Politics']),
                                            ('polymarket', ['interest rates', 'geopolitics'])])
def test_initial_discovery_uses_provider_categories(monkeypatch, provider, topics):
    monkeypatch.setattr(global_context, 'get_vendor', lambda *a: provider)
    route = Mock(return_value='No global news')
    monkeypatch.setattr(global_context, 'route_to_vendor', route)
    monkeypatch.setattr(global_context, 'collect_reddit_topic', lambda *a: {'status': 'empty', 'posts': []})
    monkeypatch.setattr(global_context, 'fetch_stocktwits_messages', lambda *a, **kw: '<no messages>')
    monkeypatch.setattr(global_context, 'collect_apewisdom', lambda *a: {'source': 'apewisdom', 'target': 'all', 'status': 'success', 'content': 'RAW_APE'})
    result = global_context.collect_global_context('2026-09-17')
    assert result['evidence'][-1]['source'] == 'apewisdom'
    assert 'RAW_APE' in result['report']
    assert [c.args[1] for c in route.call_args_list[1:]] == topics


def test_insider_snapshot_shows_transaction_range_and_unknown_coverage(monkeypatch):
    ticker = Mock(insider_transactions=pd.DataFrame({'Start Date': ['2022-02-28', '2019-08-05', 'invalid']}))
    monkeypatch.setattr(y_finance.yf, 'Ticker', lambda _: ticker)
    monkeypatch.setattr(y_finance, 'yf_retry', lambda f: f())
    out = y_finance.get_insider_transactions('7203.T')
    assert '2019-08-05 to 2022-02-28' in out and 'latest reported transaction: 2022-02-28' in out
    assert 'Retrieval time does not establish recent trading activity' in out
    ticker.insider_transactions = pd.DataFrame({'Shares': [1]})
    assert 'Transaction dates unavailable' in y_finance.get_insider_transactions('AAPL')
    ticker.insider_transactions = pd.DataFrame()
    assert 'not proof of no trades' in y_finance.get_insider_transactions('005930.KS')
