"""Scripted-variable resolution and safe inline-maths evaluation.

Two-layer model driven by what the mod actually does
(docs/observed-grammar.md):

- :class:`VarTable` holds ``@name -> number`` with load-order overwrite
  semantics (later definition wins) and an optional *fallback* table for
  vanilla variables the mod references but never defines (``@tier5cost2`` and
  friends — 32 of them in Gigastructures).
- :func:`resolve` turns a parsed scalar into a number where possible.
  Unresolvable references stay symbolic and are reported, never zeroed and
  never fatal.

The arithmetic evaluator handles ``+ - * / ( )``, unary minus, and ``@var``
or bare-name variable references, via recursive descent. No ``eval``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Union

from .parser import Block, MathExpr, Pair, Scalar, VarRef

Number = Union[int, float]


def parse_number(text: str) -> Optional[Number]:
    """Clausewitz numeric literal -> int/float, else None."""
    t = text.strip()
    if not t:
        return None
    try:
        if any(c in t for c in ".eE") and not t.lstrip("+-").isdigit():
            return float(t)
        return int(t)
    except ValueError:
        try:
            return float(t)
        except ValueError:
            return None


@dataclass
class VarDef:
    value: Number
    source_file: str
    line: int


@dataclass
class VarTable:
    """Load-order-aware variable table with optional vanilla fallback."""
    defs: dict[str, VarDef] = field(default_factory=dict)
    fallback: Optional["VarTable"] = None

    def define(self, name: str, value: Number, source_file: str = "?",
               line: int = 0) -> None:
        # Later definition simply overwrites: load-order semantics.
        self.defs[name.lstrip("@")] = VarDef(value, source_file, line)

    def lookup(self, name: str) -> Optional[VarDef]:
        name = name.lstrip("@")
        hit = self.defs.get(name)
        if hit is None and self.fallback is not None:
            return self.fallback.lookup(name)
        return hit

    def load_definitions(self, block: Block, source_file: str = "?") -> None:
        """Collect ``@name = value`` pairs from a parsed file's top level.

        Values may themselves be variable refs or maths (vanilla does this);
        resolve against the table as it stands, which matches the game's
        top-to-bottom evaluation.
        """
        for p in block.pairs():
            if not p.key.startswith("@"):
                continue
            val, err = resolve(p.value, self)
            if err is None and isinstance(val, (int, float)):
                self.define(p.key, val, source_file, p.line)
            # Unresolvable definition: skip; the *use* site will report it.


# ---------------------------------------------------------------------------
# Safe arithmetic evaluator
# ---------------------------------------------------------------------------

class MathError(Exception):
    pass


class _Expr:
    """Recursive-descent evaluator for  + - * / ( )  and variable refs."""

    def __init__(self, text: str, table: VarTable):
        self.text = text
        self.table = table
        self.i = 0

    def _skip_ws(self) -> None:
        while self.i < len(self.text) and self.text[self.i] in " \t":
            self.i += 1

    def _peek(self) -> str:
        self._skip_ws()
        return self.text[self.i] if self.i < len(self.text) else ""

    def parse(self) -> Number:
        v = self._expr()
        self._skip_ws()
        if self.i != len(self.text):
            raise MathError(f"trailing input at {self.i!r} in {self.text!r}")
        return v

    def _expr(self) -> Number:
        v = self._term()
        while True:
            c = self._peek()
            if c == "+":
                self.i += 1
                v = v + self._term()
            elif c == "-":
                self.i += 1
                v = v - self._term()
            else:
                return v

    def _term(self) -> Number:
        v = self._factor()
        while True:
            c = self._peek()
            if c == "*":
                self.i += 1
                v = v * self._factor()
            elif c == "/":
                self.i += 1
                d = self._factor()
                if d == 0:
                    raise MathError(f"division by zero in {self.text!r}")
                v = v / d
            else:
                return v

    def _factor(self) -> Number:
        c = self._peek()
        if c == "-":
            self.i += 1
            return -self._factor()
        if c == "+":
            self.i += 1
            return self._factor()
        if c == "(":
            self.i += 1
            v = self._expr()
            if self._peek() != ")":
                raise MathError(f"missing ')' in {self.text!r}")
            self.i += 1
            return v
        return self._atom()

    def _atom(self) -> Number:
        self._skip_ws()
        start = self.i
        t = self.text
        if self.i < len(t) and (t[self.i].isdigit() or t[self.i] == "."):
            while self.i < len(t) and (t[self.i].isdigit() or t[self.i] in ".eE"):
                self.i += 1
            num = parse_number(t[start:self.i])
            if num is None:
                raise MathError(f"bad number {t[start:self.i]!r}")
            return num
        # variable ref, with or without '@'
        if self.i < len(t) and (t[self.i] == "@" or t[self.i].isalpha()
                                or t[self.i] == "_"):
            if t[self.i] == "@":
                self.i += 1
                start = self.i
            while self.i < len(t) and (t[self.i].isalnum() or t[self.i] == "_"):
                self.i += 1
            name = t[start:self.i]
            hit = self.table.lookup(name)
            if hit is None:
                raise MathError(f"undefined variable @{name}")
            return hit.value
        raise MathError(f"unexpected character at {self.i} in {self.text!r}")


def eval_math(expr: str, table: VarTable) -> Number:
    v = _Expr(expr, table).parse()
    # Paradox rounds maths results the same way it prints them; keep ints int.
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


# ---------------------------------------------------------------------------
# Public resolution entry point
# ---------------------------------------------------------------------------

def resolve(value: Scalar, table: VarTable
            ) -> tuple[Union[Number, str, Scalar], Optional[str]]:
    """Resolve a parsed scalar to a concrete value.

    Returns ``(value, error)``. On success ``error`` is None and ``value``
    is a number (for numerics / refs / maths) or the original string.
    On failure the **original symbolic value** is returned with a message,
    so callers can display ``@tier5cost2`` verbatim and log a warning —
    never silently zero (spec §3 / observed-grammar notes).
    """
    if isinstance(value, VarRef):
        hit = table.lookup(value.name)
        if hit is None:
            return value, f"undefined variable @{value.name}"
        return hit.value, None
    if isinstance(value, MathExpr):
        try:
            return eval_math(value.expr, table), None
        except MathError as e:
            return value, str(e)
    if isinstance(value, str):
        num = parse_number(value)
        return (num, None) if num is not None else (value, None)
    return value, None
