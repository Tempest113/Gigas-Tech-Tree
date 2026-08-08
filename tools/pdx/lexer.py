"""Lexer for Clausewitz (Paradox) script.

Produces a flat token stream with line/column positions. Design points that
come straight from real Stellaris/Gigastructures files (see
docs/observed-grammar.md):

- ``#`` comments run to end of line, including trailing comments after values.
- Quoted strings may contain spaces, ``=``, ``{``/``}``, and ``\\"`` escapes.
- Bare values may contain ``@ . : ' | - /`` etc.; anything up to whitespace,
  a brace, an operator character, or ``#``.
- Operators: ``= == != < > <= >=``. The lexer emits the exact operator text.
- Inline maths ``@[ expr ]`` and ``@\\[ expr ]`` become a single MATH token
  whose value is the inner expression text.
- Input text should already be decoded; use :func:`decode_bytes` for the
  BOM/UTF-8/cp1252 dance.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Iterator


class TokKind(Enum):
    LBRACE = "{"
    RBRACE = "}"
    OPERATOR = "op"       # = == != < > <= >=
    STRING = "str"        # quoted; value has quotes stripped, escapes resolved
    VALUE = "val"         # bare identifier / number / @varref
    MATH = "math"         # @[ ... ] inline arithmetic, value = inner text
    EOF = "eof"


@dataclass(frozen=True)
class Token:
    kind: TokKind
    value: str
    line: int      # 1-based
    col: int       # 1-based

    def __repr__(self) -> str:  # compact for test failures
        return f"{self.kind.name}({self.value!r}@{self.line}:{self.col})"


class LexError(Exception):
    def __init__(self, message: str, line: int, col: int):
        super().__init__(f"{message} at line {line}, col {col}")
        self.message = message
        self.line = line
        self.col = col


def decode_bytes(data: bytes) -> str:
    """Decode file bytes: UTF-8 (BOM optional) with Windows-1252 fallback.

    Normalises CRLF/CR to LF so the lexer only ever sees ``\\n``.
    """
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        # cp1252 maps every byte, so this cannot fail; it is the documented
        # fallback for stray Windows-authored files.
        text = data.decode("cp1252")
    return text.replace("\r\n", "\n").replace("\r", "\n")


_OP_CHARS = set("=<>!")
# Characters that terminate a bare value.
_BARE_END = set(" \t\n{}#\"") | _OP_CHARS


def tokenize(text: str) -> Iterator[Token]:
    """Yield tokens; always ends with a single EOF token."""
    i = 0
    n = len(text)
    line = 1
    col = 1

    def bump(k: int = 1) -> None:
        nonlocal i, line, col
        for _ in range(k):
            if i < n and text[i] == "\n":
                line += 1
                col = 1
            else:
                col += 1
            i += 1

    while i < n:
        c = text[i]

        if c in " \t\n":
            bump()
            continue

        if c == "#":
            while i < n and text[i] != "\n":
                bump()
            continue

        if c == "{":
            yield Token(TokKind.LBRACE, "{", line, col)
            bump()
            continue

        if c == "}":
            yield Token(TokKind.RBRACE, "}", line, col)
            bump()
            continue

        if c in _OP_CHARS:
            start_line, start_col = line, col
            op = c
            if i + 1 < n and text[i + 1] == "=":
                op += "="
            if op in ("=", "==", "!=", "<", ">", "<=", ">="):
                yield Token(TokKind.OPERATOR, op, start_line, start_col)
                bump(len(op))
                continue
            raise LexError(f"unexpected character {c!r}", line, col)

        if c == '"':
            start_line, start_col = line, col
            bump()  # opening quote
            buf = []
            while True:
                if i >= n:
                    raise LexError("unterminated string", start_line, start_col)
                ch = text[i]
                if ch == "\\" and i + 1 < n and text[i + 1] in ('"', "\\"):
                    buf.append(text[i + 1])
                    bump(2)
                    continue
                if ch == '"':
                    bump()
                    break
                if ch == "\n":
                    # Real files never contain raw newlines in strings; treat
                    # as unterminated so the error points at the open quote.
                    raise LexError("unterminated string", start_line, start_col)
                buf.append(ch)
                bump()
            yield Token(TokKind.STRING, "".join(buf), start_line, start_col)
            continue

        if c == "@" and i + 1 < n and (
            text[i + 1] == "[" or text[i + 1 : i + 3] == "\\["
        ):
            start_line, start_col = line, col
            skip = 2 if text[i + 1] == "[" else 3  # '@[' or '@\['
            bump(skip)
            buf = []
            while True:
                if i >= n:
                    raise LexError("unterminated @[ maths ]", start_line, start_col)
                ch = text[i]
                if ch == "\\" and i + 1 < n and text[i + 1] == "]":
                    bump(2)
                    break
                if ch == "]":
                    bump()
                    break
                buf.append(ch)
                bump()
            yield Token(TokKind.MATH, "".join(buf).strip(), start_line, start_col)
            continue

        # Bare value.
        start_line, start_col = line, col
        buf = []
        while i < n and text[i] not in _BARE_END:
            buf.append(text[i])
            bump()
        if not buf:
            raise LexError(f"unexpected character {c!r}", line, col)
        yield Token(TokKind.VALUE, "".join(buf), start_line, start_col)

    yield Token(TokKind.EOF, "", line, col)
