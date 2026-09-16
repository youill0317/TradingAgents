"""Conservative text matching shared by source tags and issuer routing."""

import re

# Exact Census program/category codes, not NAICS-prefix guesses. These are
# sector context tags, not issuer exposures. Mixed/unknown categories stay untagged.
_CENSUS_SECTORS = {
    "M3ADV": {
        "Basic Materials": ("31S",),
        "Industrials": ("32S", "33S", "NAP", "DAP", "DEF"),
        "Technology": ("34S", "CRP", "34X"),
        "Consumer Cyclical": ("MVP",),
    },
    "MRTS": {
        "Consumer Cyclical": (
            "441", "441X", "4411", "44111", "44112", "4413", "4423X", "442", "4421",
            "443", "443141", "443142", "444", "4441", "44412", "44413", "448", "4481",
            "44812", "44814", "44819", "4482", "451", "45111", "45112", "451211",
            "4522", "45221", "4532", "45321", "45322", "45330", "4541", "722", "7225", "72251X",
        ),
        "Consumer Defensive": ("445", "4451", "44511", "4453", "452311"),
        "Healthcare": ("44611",),
        "Energy": ("447", "45431"),
    },
    "MWTS": {
        "Consumer Cyclical": ("4231", "4232", "4243"),
        "Basic Materials": ("4233", "4235", "4241", "4246"),
        "Technology": ("42343",),
        "Industrials": ("4237", "4238"),
        "Healthcare": ("4242",),
        "Consumer Defensive": ("4244", "4245", "4248"),
        "Energy": ("4247",),
    },
    "RESCONST": {
        "Real Estate": ("PERMITS", "AUTHNOTSTD", "STARTS", "UNDERCONST", "COMPLETIONS"),
        "Industrials": ("PERMITS", "AUTHNOTSTD", "STARTS", "UNDERCONST", "COMPLETIONS"),
    },
    "VIP": {
        "Real Estate": ("00XX",),
        "Healthcare": ("04XX",),
        "Industrials": ("09XX", "12XX"),
        "Communication Services": ("10XX",),
        "Utilities": ("11XX", "13XX", "14XX"),
    },
}


def census_sectors(program, code):
    """Classify only documented categories; A-prefixed construction codes are annual rates."""
    if program == "VIP" or program == "RESCONST" and code in {"APERMITS", "ASTARTS", "ACOMPLETIONS"}:
        code = code.removeprefix("A")
    return [sector for sector, codes in _CENSUS_SECTORS.get(program, {}).items() if code in codes]


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
