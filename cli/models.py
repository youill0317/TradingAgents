from enum import StrEnum


class AnalystType(StrEnum):
    MARKET = "market"
    # Wire value stays "social" for saved-config and string-keyed-caller
    # back-compat; the user-facing label is "Sentiment Analyst".
    SOCIAL = "social"
    NEWS = "news"
    FUNDAMENTALS = "fundamentals"
    # Works from the provider's web search, so it is chosen, never assumed.
    BUSINESS = "business"


# Analysts that run only when named: not part of "every analyst".
OPT_IN_ANALYSTS = frozenset({AnalystType.BUSINESS})


class AssetType(StrEnum):
    STOCK = "stock"
    CRYPTO = "crypto"
