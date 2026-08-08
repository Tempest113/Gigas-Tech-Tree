"""Stellaris localisation parser.

The ``.yml`` files are **not YAML** (spec §5). Real-corpus facts this handles
(docs/observed-grammar.md):

- UTF-8 with BOM (the norm) or without; cp1252 stray files tolerated.
- Indentation is tabs in some files, spaces in others. Accept anything.
- Lines: ``key:<version> "value"`` where ``<version>`` may be absent.
- Values may contain escaped quotes ``\\"``, literal ``\\n``, ``§X…§!``
  colour codes, ``£icon£`` tokens, ``$KEY$`` and ``[Scope.Concept]``
  substitutions. Colour/icon rendering is the viewer's job; the raw value is
  preserved. ``$KEY$`` is resolved here when KEY is itself a loc key
  (``giga_tech_alderson_disk`` is literally named "The $name_alderson$"),
  left visible otherwise.
- Later-loaded files win for duplicate keys (mod loc overrides vanilla).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from .pdx.lexer import decode_bytes

_HEADER_RE = re.compile(r"^\s*l_(\w+)\s*:\s*$")
_ENTRY_RE = re.compile(
    r"""^\s*
        (?P<key>[A-Za-z0-9_.\-']+)
        :(?P<version>\d*)
        \s*"
        (?P<rest>.*)$""",
    re.VERBOSE,
)
_SUBST_RE = re.compile(r"\$([A-Za-z0-9_.\-']+)(?:\|[^$]*)?\$")


@dataclass
class LocEntry:
    value: str
    source_file: str
    line: int


@dataclass
class LocTable:
    entries: dict[str, LocEntry] = field(default_factory=dict)
    warnings: list[dict] = field(default_factory=list)
    #: keys requested via :meth:`name` that were missing (mod-QA feature).
    missing: set[str] = field(default_factory=set)

    # -- loading -------------------------------------------------------

    def load_file(self, data: bytes, source_file: str,
                  language: str = "english") -> None:
        text = decode_bytes(data)
        in_target = False
        saw_header = False
        for lineno, raw in enumerate(text.split("\n"), start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            m = _HEADER_RE.match(line)
            if m:
                saw_header = True
                in_target = (m.group(1) == language)
                continue
            if not in_target:
                # Either pre-header junk or another language's section.
                if saw_header:
                    continue
                # Tolerate files that omit the header (broken but real);
                # treat as target language with a warning, once.
                in_target = True
                self.warnings.append({
                    "file": source_file, "line": lineno,
                    "message": "no l_<language>: header; assuming target",
                })
            m = _ENTRY_RE.match(raw)
            if m is None:
                self.warnings.append({
                    "file": source_file, "line": lineno,
                    "message": f"unparseable loc line: {line[:60]!r}",
                })
                continue
            rest = m.group("rest")
            value = _extract_value(rest)
            # Later definition wins (load order), unconditionally.
            self.entries[m.group("key")] = LocEntry(value, source_file, lineno)

    # -- lookup --------------------------------------------------------

    def get(self, key: str) -> Optional[str]:
        e = self.entries.get(key)
        return e.value if e else None

    def name(self, key: str, resolve_subst: bool = True) -> Optional[str]:
        """Value for ``key`` with in-table ``$refs$`` resolved; records a
        miss (for the missing-loc panel) and returns None if absent."""
        e = self.entries.get(key)
        if e is None:
            self.missing.add(key)
            return None
        return self.resolve_substitutions(e.value) if resolve_subst else e.value

    def resolve_substitutions(self, value: str, depth: int = 6) -> str:
        """Replace ``$key$`` where key exists in this table, recursively,
        depth-limited so cycles terminate. Unknown keys stay verbatim —
        ``$VALUE$``-style runtime params are *supposed* to show."""
        if depth <= 0 or "$" not in value:
            return value

        def repl(m: re.Match) -> str:
            key = m.group(1)
            hit = self.entries.get(key)
            if hit is None:
                # Gigastructures mirrors vanilla-object names it needs under
                # a giga_vanilla_ prefix ($dyson_swarm_3$ ->
                # giga_vanilla_dyson_swarm_3); vanilla loc itself is not
                # available at build time.
                hit = self.entries.get("giga_vanilla_" + key)
            if hit is None:
                return m.group(0)
            return self.resolve_substitutions(hit.value, depth - 1)

        return _SUBST_RE.sub(repl, value)


def _extract_value(rest: str) -> str:
    """``rest`` is everything after the opening quote. Take up to the last
    quote on the line (Paradox's own reader is this forgiving — values with
    unescaped inner quotes exist in the wild), strip a trailing comment if it
    sits *after* that quote, then unescape."""
    # Trailing comment after the closing quote: find last '"', anything after
    # it that isn't whitespace/# is garbage we ignore.
    end = rest.rfind('"')
    body = rest[:end] if end != -1 else rest
    body = body.replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t")
    return body


# -- viewer-prep helpers (used at build time for plain-text contexts) -------

_COLOUR_RE = re.compile(r"§.")
_ICON_RE = re.compile(r"£([A-Za-z0-9_]+)£?")


def strip_markup(value: str) -> str:
    """Plain-text form: colour codes removed, icon tokens dropped.
    Used for search indexing and the Explore table; the map/detail views
    render markup properly client-side."""
    value = _COLOUR_RE.sub(lambda m: "" if m.group(0) != "§!" else "", value)
    value = value.replace("§!", "")
    value = _ICON_RE.sub("", value)
    return re.sub(r"\s{2,}", " ", value).strip()
