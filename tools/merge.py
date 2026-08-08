"""Load-order and override semantics (spec §7).

Model: an ordered list of :class:`Source` objects (vanilla first, then mods).
Two override mechanisms, both implemented, one expected:

1. **Whole-file replacement** — a later source shipping the same
   ``dir/filename`` replaces the earlier source's entire file. Gigastructures
   deliberately avoids this for technologies, so any collision produces a
   loud warning naming the vanilla techs it would delete (almost certainly an
   accident in this codebase), but the semantics are still honoured because a
   third mod may rely on them.
2. **Same-ID redefinition** — within the merged, ordered stream of files
   (sources in order, files ASCII-sorted within each source directory), a
   later ``some_tech = { … }`` replaces an earlier definition wholesale.
   This is the well-behaved override path (``zz_giga_tech_overwrites.txt``).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .pdx.parser import Block, ParseError, parse_bytes
from .pdx.lexer import LexError


@dataclass
class SourceFile:
    name: str          # bare filename, e.g. "giga_01_physics.txt"
    data: bytes
    source_id: str     # e.g. "vanilla", "gigas"


@dataclass
class Source:
    id: str            # "vanilla" | mod id
    label: str
    files: list[SourceFile] = field(default_factory=list)

    def add(self, name: str, data: bytes) -> None:
        self.files.append(SourceFile(name, data, self.id))


@dataclass
class TechDef:
    id: str
    body: Block
    source_id: str          # winning definition's source
    source_file: str
    line: int
    #: True when this ID was first defined by an *earlier* source
    #: (i.e. a mod redefining a vanilla tech).
    overrides_earlier_source: bool = False


@dataclass
class MergeResult:
    techs: dict[str, TechDef] = field(default_factory=dict)   # insertion-ordered
    warnings: list[dict] = field(default_factory=list)
    parse_errors: list[dict] = field(default_factory=list)


def merge_sources(sources: list[Source]) -> MergeResult:
    res = MergeResult()

    # -- 1. whole-file replacement --------------------------------------
    winners: dict[str, SourceFile] = {}
    for src in sources:
        for f in sorted(src.files, key=lambda f: f.name):
            if f.name in winners and winners[f.name].source_id != f.source_id:
                loser = winners[f.name]
                # Name the techs the replacement silently deletes.
                deleted = _tech_ids_in(loser, res)
                res.warnings.append({
                    "kind": "file-replacement",
                    "file": f.name,
                    "replaces_source": loser.source_id,
                    "by_source": f.source_id,
                    "deleted_techs": deleted,
                    "message": (
                        f"{f.source_id}/{f.name} replaces the entire "
                        f"{loser.source_id} file; techs removed by "
                        f"replacement: {', '.join(deleted) or '(none parse)'}"
                    ),
                })
            winners[f.name] = f

    # -- 2. parse winning files in merged order, same-ID override -------
    # Order: sources in declared order; within a source, ASCII filename
    # order; a replaced file occupies the *replacing* source's slot (matches
    # the game: the file is read when its owning mod loads).
    ordered: list[SourceFile] = []
    for src in sources:
        for f in sorted(src.files, key=lambda f: f.name):
            if winners[f.name] is f:
                ordered.append(f)

    first_seen_source: dict[str, str] = {}
    for f in ordered:
        try:
            ast = parse_bytes(f.data)
        except (ParseError, LexError) as e:
            res.parse_errors.append({
                "file": f.name, "source": f.source_id,
                "line": getattr(e, "line", 0), "col": getattr(e, "col", 0),
                "message": getattr(e, "message", str(e)),
            })
            continue
        for p in ast.pairs():
            if not isinstance(p.value, Block) or p.key.startswith("@"):
                continue
            tid = p.key
            overrides = (tid in first_seen_source
                         and first_seen_source[tid] != f.source_id)
            if tid not in first_seen_source:
                first_seen_source[tid] = f.source_id
            res.techs[tid] = TechDef(
                id=tid, body=p.value, source_id=f.source_id,
                source_file=f.name, line=p.line,
                overrides_earlier_source=overrides,
            )
    return res


def _tech_ids_in(f: SourceFile, res: MergeResult) -> list[str]:
    try:
        ast = parse_bytes(f.data)
    except (ParseError, LexError):
        return []
    return [p.key for p in ast.pairs()
            if isinstance(p.value, Block) and not p.key.startswith("@")]
