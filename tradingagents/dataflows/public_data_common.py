"""Small HTTP and evidence helpers for official public data feeds."""

from datetime import datetime, timezone
from xml.etree import ElementTree

import requests


def request_json(url, params=None, headers=None):
    response = requests.get(url, params=params, headers=headers, timeout=15)
    response.raise_for_status()
    return response.json()


def request_xml(url, params=None, headers=None):
    response = requests.get(url, params=params, headers=headers, timeout=15)
    response.raise_for_status()
    return ElementTree.fromstring(response.content)


def evidence(source, target, content, url, *, observed_at=None, published_at=None, **extra):
    return {
        "source": source, "target": target, "status": "success",
        "content": content, "url": url,
        "observed_at": observed_at, "published_at": published_at,
        "retrieved_at": datetime.now(timezone.utc).isoformat(), **extra,
    }
