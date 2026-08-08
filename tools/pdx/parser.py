"""Recursive-descent parser for Clausewitz script.

AST design (docs/observed-grammar.md is the why):

- :class:`Block` is a **list of items in source order**. Items are either
  :class:`Pair` (``key op value``) or bare values (implicit-list members).
  Duplicate keys are legal and preserved — ``modifier = { … }`` appears 58
  times in one real file. Dict-style convenience accessors are provided but
  the underlying storage is always the ordered list.
- :class:`Pair` records the exact operator (``=``, ``>`` …) and the source
  line, so triggers keep their meaning and warnings can point at real lines.
- Scalar values are plain ``str`` (quoted-ness does not survive; nothing in
  the data model needs it), except variable references (:class:`VarRef`) and
  inline maths (:class:`MathExpr`), which stay symbolic until
  ``values.resolve`` runs.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Iterator, Optional, Union

from .lexer import LexError, TokKind, Token, tokenize


class ParseError(Exception):
    def __init__(self, message: str, line: int, col: int):
        super().__init__(f"{message} at line {line}, col {col}")
        self.message = message
        self.line = line
        self.col = col


@dataclass(frozen=True)
class VarRef:
    """A ``@variable`` reference, unresolved."""
    name: str  # without the leading '@'

    def __str__(self) -> str:
        return f"@{self.name}"


@dataclass(frozen=True)
class MathExpr:
    """An ``@[ … ]`` inline-maths expression, unresolved."""
    expr: str

    def __str__(self) -> str:
        return f"@[{self.expr}]"


Scalar = Union[str, VarRef, MathExpr]
Value = Union[Scalar, "Block"]


@dataclass
class Pair:
    key: str
    op: str
    value: Value
    line: int


@dataclass
class Block:
    """Ordered container of Pair and bare-scalar items."""
    items: list[Union[Pair, Scalar]] = field(default_factory=list)
    line: int = 0

    # -- dict-like conveniences (never destructive) --------------------

    def pairs(self) -> Iterator[Pair]:
        for it in self.items:
            if isinstance(it, Pair):
                yield it

    def bare_values(self) -> list[Scalar]:
        return [it for it in self.items if not isinstance(it, Pair)]

    def get_all(self, key: str) -> list[Value]:
        return [p.value for p in self.pairs() if p.key == key]

    def get(self, key: str, default: Optional[Value] = None) -> Optional[Value]:
        """First value for ``key`` (Paradox semantics for scalar fields:
        last usually wins, but callers that care use :meth:`get_last`)."""
        for p in self.pairs():
            if p.key == key:
                return p.value
        return default

    def get_last(self, key: str, default: Optional[Value] = None) -> Optional[Value]:
        out = default
        for p in self.pairs():
            if p.key == key:
                out = p.value
        return out

    def __contains__(self, key: str) -> bool:
        return any(p.key == key for p in self.pairs())

    def keys(self) -> list[str]:
        return [p.key for p in self.pairs()]

    def __iter__(self) -> Iterator[Union[Pair, Scalar]]:
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)


def _scalar_from_token(tok: Token) -> Scalar:
    if tok.kind == TokKind.STRING:
        return tok.value
    if tok.kind == TokKind.MATH:
        return MathExpr(tok.value)
    v = tok.value
    if v.startswith("@") and len(v) > 1:
        return VarRef(v[1:])
    return v


class _Parser:
    def __init__(self, text: str):
        self.toks = list(tokenize(text))
        self.pos = 0

    def peek(self, ahead: int = 0) -> Token:
        i = min(self.pos + ahead, len(self.toks) - 1)
        return self.toks[i]

    def take(self) -> Token:
        tok = self.toks[self.pos]
        if tok.kind != TokKind.EOF:
            self.pos += 1
        return tok

    def parse_top(self) -> Block:
        blk = self.parse_block_body(top=True)
        tok = self.peek()
        if tok.kind != TokKind.EOF:
            raise ParseError(f"unexpected {tok.kind.name} {tok.value!r}",
                             tok.line, tok.col)
        return blk

    def parse_block_body(self, top: bool = False) -> Block:
        """Parse items until '}' (or EOF at top level)."""
        blk = Block(line=self.peek().line)
        while True:
            tok = self.peek()
            if tok.kind == TokKind.EOF:
                if top:
                    return blk
                raise ParseError("unexpected end of file inside block",
                                 tok.line, tok.col)
            if tok.kind == TokKind.RBRACE:
                if top:
                    raise ParseError("unmatched '}'", tok.line, tok.col)
                return blk

            if tok.kind in (TokKind.VALUE, TokKind.STRING, TokKind.MATH):
                nxt = self.peek(1)
                if tok.kind != TokKind.MATH and nxt.kind == TokKind.OPERATOR:
                    blk.items.append(self.parse_pair())
                else:
                    # Bare value in an implicit list / mixed block.
                    self.take()
                    blk.items.append(_scalar_from_token(tok))
                continue

            if tok.kind == TokKind.LBRACE:
                # Anonymous nested block: rare but legal (e.g. lists of
                # coordinate blocks). Store as a Pair with empty key so
                # source order survives.
                self.take()
                inner = self.parse_block_body()
                close = self.take()  # RBRACE, guaranteed by parse_block_body
                assert close.kind == TokKind.RBRACE
                blk.items.append(Pair(key="", op="=", value=inner, line=tok.line))
                continue

            raise ParseError(f"unexpected {tok.kind.name} {tok.value!r}",
                             tok.line, tok.col)

    def parse_pair(self) -> Pair:
        key_tok = self.take()
        op_tok = self.take()
        assert op_tok.kind == TokKind.OPERATOR
        val_tok = self.peek()

        if val_tok.kind == TokKind.LBRACE:
            self.take()
            inner = self.parse_block_body()
            close = self.take()
            assert close.kind == TokKind.RBRACE
            return Pair(key_tok.value, op_tok.value, inner, key_tok.line)

        if val_tok.kind in (TokKind.VALUE, TokKind.STRING, TokKind.MATH):
            self.take()
            return Pair(key_tok.value, op_tok.value,
                        _scalar_from_token(val_tok), key_tok.line)

        raise ParseError(
            f"expected value after '{key_tok.value} {op_tok.value}', "
            f"got {val_tok.kind.name}",
            val_tok.line, val_tok.col)


def parse(text: str) -> Block:
    """Parse decoded Clausewitz text into a top-level :class:`Block`.

    Raises :class:`ParseError` / :class:`LexError` with positions; the build
    driver catches these per-file and continues (spec §3 error tolerance).
    """
    return _Parser(text).parse_top()


def parse_bytes(data: bytes) -> Block:
    from .lexer import decode_bytes
    return parse(decode_bytes(data))
