"""Shared 5-tier rating vocabulary and a deterministic heuristic parser.

The same five-tier scale (Buy, Overweight, Hold, Underweight, Sell) is used by:
- The Research Manager (investment plan recommendation)
- The Portfolio Manager (final position decision)
- The signal processor (rating extracted for downstream consumers)
- The memory log (rating tag stored alongside each decision entry)

Centralising it here avoids drift between those call sites.

``extract_rating`` returns ``None`` when no rating can be found, so the graph can
surface an explicit ``REVIEW`` signal instead of a fabricated ``Hold`` (#1170).
``parse_rating`` accepts a separate analysis status to withhold the signal when
issuer evidence is insufficient; prose formatting does not control that status.
"""

from __future__ import annotations

import re
import unicodedata

# Canonical, ordered 5-tier scale (most bullish to most bearish).
RATINGS_5_TIER: tuple[str, ...] = (
    "Buy", "Overweight", "Hold", "Underweight", "Sell",
)

# Signal emitted when the model's decision has no recognizable rating. It is not
# a tradeable position: it flags output that needs a human/re-run rather than
# silently degrading to Hold. Callers that map the signal onto the 5-tier enum
# (e.g. ``PortfolioRating(signal)``) should guard with ``is_review`` first.
RATING_REVIEW = "REVIEW"

_RATING_SET = {r.lower() for r in RATINGS_5_TIER}

# Matches "Rating: X" / "rating - X" / "Rating: **X**" — tolerates markdown
# bold wrappers and either a colon or hyphen separator.
_RATING_LABEL_RE = re.compile(r"rating.*?[:\-][\s*]*(\w+)", re.IGNORECASE)

# Standalone 5-tier word anywhere (word boundaries so "Buyer"/"Holding" don't match).
_RATING_WORD_RE = re.compile(
    r"\b(" + "|".join(RATINGS_5_TIER) + r")\b", re.IGNORECASE
)


def extract_rating(text: str) -> str | None:
    """Extract a 5-tier rating or explicit REVIEW, or ``None`` when absent.

    Two-pass strategy on the NFKC-normalized text (so fullwidth punctuation like
    ``Rating：Overweight`` is matched the same as ASCII):
    1. An explicit "Rating: X" label (tolerant of markdown bold).
    2. The first standalone 5-tier rating word found anywhere.
    """
    if not text:
        return None
    norm = unicodedata.normalize("NFKC", text)

    for line in norm.splitlines():
        m = _RATING_LABEL_RE.search(line)
        if m and m.group(1).upper() == RATING_REVIEW:
            return RATING_REVIEW
        if m and m.group(1).lower() in _RATING_SET:
            return m.group(1).capitalize()

    m = _RATING_WORD_RE.search(norm)
    if m:
        return m.group(1).capitalize()

    return None


def parse_rating(text: str, default: str = "Hold", *, analysis_status: str | None = None) -> str:
    """Extract a rating, honoring structured review status before the default.

    Legacy convenience wrapper: it always returns a rating string, so an
    unparseable decision silently becomes ``default`` (``Hold``). Callers that
    must distinguish "no rating" from a real Hold should use
    :func:`extract_rating` (or the graph's REVIEW-surfacing signal) instead.
    """
    if analysis_status == "REVIEW_REQUIRED":
        return RATING_REVIEW
    rating = extract_rating(text)
    return rating if rating is not None else default


def is_review(signal: str) -> bool:
    """Whether a signal is the non-tradeable REVIEW sentinel (#1170)."""
    return signal == RATING_REVIEW
