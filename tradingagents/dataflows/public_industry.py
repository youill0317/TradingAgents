"""Conservative text matching shared by source tags and issuer routing."""

import re


def matches_industry(text, terms):
    """Match English word starts and Korean stems, without negated housing matches.

    English prefixes intentionally allow plurals (semiconductor/semiconductors).
    Normalize non-residential spellings before matching: the standalone word in
    a hyphenated negative must not turn commercial construction into housing.
    """
    text = re.sub(r"\bnon[\s-]*residential\b", "nonresidential", str(text or "").casefold())
    for term in terms:
        term = term.casefold()
        if re.search(r"[a-z]", term):
            if re.search(r"(?<![a-z])" + re.escape(term), text):
                return True
        elif term in text:
            return True
    return False
