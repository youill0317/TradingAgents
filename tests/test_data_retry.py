"""Shared policy: bounded waits, HTTP/SDK failures and independent provider cooldowns."""
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.request import Request

import pytest
import requests
from curl_cffi.requests.exceptions import Timeout as CurlTimeout
from yfinance.exceptions import YFRateLimitError

from tradingagents.dataflows import retry, stockstats_utils

pytestmark = pytest.mark.usefixtures('data_retry_clock')


def error(status, headers=None):
    response = requests.Response()
    response.status_code = status
    response.headers.update(headers or {})
    return requests.HTTPError(response=response)


@pytest.mark.parametrize('exc', [error(429), error(500), error(502), error(503), error(504),
                                requests.Timeout(), requests.ConnectionError(), CurlTimeout('timeout'),
                                ConnectionResetError(), TimeoutError()])
def test_transient_failure_recovers(exc, data_retry_clock):
    operation = Mock(side_effect=[exc, 'ok'])
    assert retry.retry_call(operation, 'https://data.test/path?key=secret') == 'ok'
    assert operation.call_count == 2 and len(data_retry_clock.sleeps) == 1


@pytest.mark.parametrize('exc', [error(400), error(401), error(403), error(404), error(451),
                                ValueError('bad payload'), requests.exceptions.SSLError('bad certificate')])
def test_permanent_failure_is_not_retried(exc, data_retry_clock):
    operation = Mock(side_effect=exc)
    with pytest.raises(type(exc)):
        retry.retry_call(operation, 'https://data.test')
    assert operation.call_count == 1 and data_retry_clock.sleeps == []


@pytest.mark.parametrize('header', ['12', 'Thu, 17 Sep 2026 00:00:12 GMT'])
def test_cooldown_is_shared_only_by_host(header, data_retry_clock):
    with pytest.raises(requests.HTTPError):
        retry.retry_call(Mock(side_effect=error(429, {'Retry-After': header})),
                         'https://data.test/one', attempts=1)
    assert retry.retry_call(lambda: 'other', 'https://other.test') == 'other'
    assert data_retry_clock.sleeps == []
    assert retry.retry_call(lambda: 'same', 'https://data.test/two') == 'same'
    assert data_retry_clock.sleeps == [12]


def test_long_retry_after_never_retries_early(data_retry_clock):
    operation = Mock(side_effect=error(429, {'Retry-After': '3600'}))
    with pytest.raises(requests.HTTPError):
        retry.retry_call(operation, 'https://data.test')
    with pytest.raises(retry.CooldownExceeded):
        retry.retry_call(operation, 'https://data.test/other')
    assert operation.call_count == 1 and data_retry_clock.sleeps == []


def test_exhaustion_and_total_wait_budget(data_retry_clock):
    operation = Mock(side_effect=requests.Timeout())
    with pytest.raises(requests.Timeout):
        retry.retry_call(operation, 'sdk', attempts=10, max_wait=5)
    assert operation.call_count == 2 and data_retry_clock.sleeps == [2]


def test_urllib_and_yahoo_use_same_policy(monkeypatch, data_retry_clock):
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    opener = Mock(side_effect=[HTTPError('url', 503, 'busy', {'Retry-After': '3'}, None), response])
    assert retry.read_url(Request('https://data.test'), opener=opener, timeout=5, read=lambda r: 'body') == 'body'
    monkeypatch.setattr(stockstats_utils.yf.cache, 'get_tz_cache', Mock())
    monkeypatch.setattr(stockstats_utils.yf.cache, 'get_cookie_cache', Mock())
    monkeypatch.setattr(stockstats_utils.yf.cache, 'get_isin_cache', Mock())
    operation = Mock(side_effect=[YFRateLimitError(), 'sdk result'])
    assert stockstats_utils.yf_retry(operation) == 'sdk result'
    assert data_retry_clock.sleeps == [3, 60]


def test_independent_processes_share_longest_deadline(provider_cooldown_db):
    import os
    import subprocess
    import sys
    import time

    deadline = time.time() + 3600
    retry._cooldown('data.test', deadline)
    env = {**os.environ, 'TRADINGAGENTS_CACHE_DIR': str(provider_cooldown_db.parent)}
    result = subprocess.run([sys.executable, '-c', '''
from tradingagents.dataflows import retry
import time
retry._cooldown('data.test', time.time() + 1)
try:
    retry.retry_call(lambda: print('unexpected request'), 'https://data.test', max_wait=0)
except retry.CooldownExceeded:
    print('blocked')
assert retry.retry_call(lambda: 'ok', 'https://other.test') == 'ok'
'''], env=env, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'blocked'
    assert retry._cooldown('data.test') == deadline
