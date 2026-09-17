"""Bounded retries for read-only data collection, with shared host cooldowns."""

import http.client
import logging
import math
import random
import sqlite3
import ssl
import time
from contextlib import closing
from pathlib import Path
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

import requests
from curl_cffi.requests.exceptions import ConnectionError as CurlConnectionError
from curl_cffi.requests.exceptions import Timeout as CurlTimeout
from curl_cffi.requests.exceptions import IncompleteRead as CurlIncompleteRead
from curl_cffi.requests.exceptions import SSLError as CurlSSLError
from tradingagents.default_config import DEFAULT_CONFIG

logger = logging.getLogger(__name__)
_TRANSIENT = {429, 500, 502, 503, 504}
# Use the common cache root, not each analysis run's cache override.
_COOLDOWN_DB = Path(DEFAULT_CONFIG['data_cache_dir']) / 'provider-cooldowns.sqlite'


def _cooldown(host, until=None):
    _COOLDOWN_DB.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(_COOLDOWN_DB, timeout=5)) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS cooldowns (host TEXT PRIMARY KEY, deadline REAL NOT NULL)')
        if until is not None:
            db.execute('INSERT INTO cooldowns VALUES (?, ?) ON CONFLICT(host) DO UPDATE '
                       'SET deadline = MAX(deadline, excluded.deadline)', (host, until))
        row = db.execute('SELECT deadline FROM cooldowns WHERE host = ?', (host,)).fetchone()
        return row[0] if row else 0.0


class CooldownExceeded(requests.Timeout, TimeoutError):
    """The provider's cooldown exceeds this call's bounded waiting budget."""


def retry_after(headers):
    value = headers.get('Retry-After') if headers else None
    if value is None:
        return None
    try:
        seconds = float(value)
    except (ValueError, TypeError):
        try:
            seconds = parsedate_to_datetime(value).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            return None
    return max(0.0, seconds) if math.isfinite(seconds) else None


def retry_call(operation, service, *, attempts=2, base_delay=2.0, max_wait=90.0,
               rate_limit_errors=()):
    """Retry transient failures only. Wait budget excludes bounded network timeouts.

    Processes using the same cache share deadlines. No database transaction is
    held during network calls or sleep; other providers keep running.
    """
    host = urlsplit(service).hostname or service
    waited = 0.0
    for attempt in range(attempts):
        while True:
            delay = max(0.0, _cooldown(host) - time.time())
            if not delay:
                break
            if waited + delay > max_wait:
                raise CooldownExceeded(f'{host}: provider cooldown exceeds wait budget')
            delay += min(random.uniform(0, 0.5), max_wait - waited - delay)
            time.sleep(delay)
            waited += delay
        try:
            return operation()
        except Exception as exc:
            response = getattr(exc, 'response', None)
            status = exc.code if isinstance(exc, HTTPError) else getattr(response, 'status_code', None)
            if isinstance(exc, HTTPError):
                exc.close()
            limited = status == 429 or isinstance(exc, rate_limit_errors)
            transient = status in _TRANSIENT if status is not None else isinstance(
                exc, (requests.Timeout, requests.ConnectionError, requests.exceptions.ChunkedEncodingError,
                      CurlTimeout, CurlConnectionError, CurlIncompleteRead, TimeoutError, ConnectionError,
                      URLError, http.client.IncompleteRead, http.client.RemoteDisconnected))
            if isinstance(exc, (requests.exceptions.SSLError, CurlSSLError, ssl.SSLError)) or isinstance(getattr(exc, "reason", None), ssl.SSLError):
                raise
            if getattr(exc, "retryable", True) is False or (not limited and not transient):
                raise
            headers = exc.headers if isinstance(exc, HTTPError) else getattr(response, 'headers', None)
            header_delay = retry_after(headers)
            delay = getattr(exc, "retry_after", header_delay)
            if delay is None:
                delay = (60.0 if limited else base_delay * 2 ** attempt) + random.uniform(0, 0.5)
            if limited or header_delay is not None:
                _cooldown(host, time.time() + delay)
            if attempt + 1 == attempts or waited + delay > max_wait:
                raise
            logger.warning('%s: %s; retry %d/%d after %.1fs', host,
                           status if status is not None else type(exc).__name__, attempt + 1, attempts - 1, delay)
            if not limited and header_delay is None:
                time.sleep(delay)
                waited += delay
    raise RuntimeError('No request attempts')


def request_get(url, *, params=None, headers=None, timeout=(5, 20)):
    def fetch():
        options = {"params": params, "timeout": timeout}
        if headers is not None:
            options["headers"] = headers
        response = requests.get(url, **options)
        try:
            response.raise_for_status()
        except requests.HTTPError:
            response.close()
            raise requests.HTTPError(f"{urlsplit(url).hostname}: HTTP {response.status_code}", response=response) from None
        return response
    return retry_call(fetch, url)


def read_url(request, *, opener, timeout, read):
    """Include response-body reads in retries, so truncated connections can recover."""
    def fetch():
        with opener(request, timeout=timeout) as response:
            return read(response)
    return retry_call(fetch, request.full_url)
