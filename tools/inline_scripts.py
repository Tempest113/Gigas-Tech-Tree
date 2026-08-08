"""Inline-script expansion (Paradox textual macros).

``inline_script`` inserts another file's text in place, with parameter
substitution. Gigastructures leans on this heavily — the entire
``giga_07_repeatables_megastructures.txt`` file defines its 50 techs' area,
category, cost, and prerequisites *as parameters*, so skipping expansion
loses most of their data model.

Semantics implemented (matching observed game behaviour):
- value form: ``inline_script = path/to/script`` — no parameters.
- block form: ``inline_script = { script = path  KEY = value … }``.
- In the template text, ``$KEY$`` is replaced by the parameter's value;
  a repeated parameter key substitutes as space-joined values.
- ``[[KEY] …]`` includes the bracketed text iff KEY was provided;
  ``[[!KEY] …]`` iff it was not. Nesting is honoured.
- Expansion is recursive (templates may use inline_script themselves),
  depth-limited against cycles.
- Scripts not present in the library (e.g. vanilla's
  ``technology/tech_weight_boni/…``) are left as-is and reported, so the
  weight-modifier display can still say "via inline script X" honestly.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union

from .pdx.lexer import decode_bytes
from .pdx.parser import Block, Pair, ParseError, Scalar, parse
from .pdx.lexer import LexError

_MAX_DEPTH = 8


@dataclass
class InlineScriptLibrary:
    scripts: dict[str, str] = field(default_factory=dict)
    #: script ids referenced but not present (vanilla / other mods)
    unexpanded: list[dict] = field(default_factory=list)

    @classmethod
    def from_dir(cls, root: Path) -> "InlineScriptLibrary":
        lib = cls()
        base = root / "common" / "inline_scripts"
        if base.is_dir():
            for f in sorted(base.rglob("*.txt")):
                sid = f.relative_to(base).with_suffix("").as_posix()
                lib.scripts[sid] = decode_bytes(f.read_bytes())
        return lib

    # -- template text processing ---------------------------------------

    def _substitute(self, text: str, params: dict[str, list[str]]) -> str:
        text = _apply_optionals(text, params)
        def repl(m: re.Match) -> str:
            key = m.group(1)
            if key in params:
                return " ".join(params[key])
            return m.group(0)  # unknown $token$: leave for loc etc.
        return re.sub(r"\$([A-Za-z0-9_]+)\$", repl, text)

    def expand_block(self, block: Block, depth: int = 0,
                     context: str = "?") -> Block:
        """Return a new Block with all resolvable inline_script items
        replaced by their expanded content, recursively."""
        out = Block(items=[], line=block.line)
        for item in block.items:
            if not isinstance(item, Pair):
                out.items.append(item)
                continue
            if item.key != "inline_script":
                val = item.value
                if isinstance(val, Block):
                    val = self.expand_block(val, depth, context)
                out.items.append(Pair(item.key, item.op, val, item.line))
                continue

            sid, params = _script_call(item)
            if sid is None or sid not in self.scripts or depth >= _MAX_DEPTH:
                if sid is not None and sid not in self.scripts:
                    self.unexpanded.append(
                        {"script": sid, "context": context, "line": item.line})
                out.items.append(item)
                continue

            text = self._substitute(self.scripts[sid], params)
            try:
                sub = parse(text)
            except (ParseError, LexError) as e:
                self.unexpanded.append(
                    {"script": sid, "context": context, "line": item.line,
                     "error": str(e)})
                out.items.append(item)
                continue
            sub = self.expand_block(sub, depth + 1, context)
            out.items.extend(sub.items)
        return out


def _script_call(pair: Pair) -> tuple[Optional[str], dict[str, list[str]]]:
    v = pair.value
    if isinstance(v, Block):
        sid = None
        params: dict[str, list[str]] = {}
        for p in v.pairs():
            sval = _param_text(p.value)
            if p.key == "script":
                sid = sval
            else:
                params.setdefault(p.key, []).append(sval)
        return sid, params
    return _param_text(v), {}


def _param_text(v: Union[Scalar, Block]) -> str:
    if isinstance(v, Block):
        # Block-valued parameter: re-serialise (rare; used for trigger params)
        parts = []
        for item in v.items:
            if isinstance(item, Pair):
                inner = _param_text(item.value)
                if isinstance(item.value, Block):
                    inner = "{ " + inner + " }"
                parts.append(f"{item.key} {item.op} {inner}")
            else:
                parts.append(str(item))
        return " ".join(parts)
    return str(v)


def _apply_optionals(text: str, params: dict[str, list[str]]) -> str:
    """Process ``[[KEY] …]`` / ``[[!KEY] …]`` optional segments, nested."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        if text.startswith("[[", i):
            m = re.match(r"\[\[(!?)([A-Za-z0-9_]+)\]", text[i:])
            if m:
                neg, key = m.group(1) == "!", m.group(2)
                start = i + m.end()
                # find matching closing bracket, honouring nesting
                depth = 1
                j = start
                while j < n and depth:
                    if text.startswith("[[", j):
                        depth += 1
                        j += 2
                    elif text[j] == "]":
                        depth -= 1
                        j += 1
                    else:
                        j += 1
                inner = text[start:j - 1]
                include = (key not in params) if neg else (key in params)
                if include:
                    out.append(_apply_optionals(inner, params))
                i = j
                continue
        out.append(text[i])
        i += 1
    return "".join(out)
