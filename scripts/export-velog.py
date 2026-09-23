#!/usr/bin/env python3
"""Export a Markdown draft for Velog without publishing it."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlsplit


MARKDOWN_LINK = re.compile(
    r"(?P<prefix>!?\[[^\]]*\]\()(?P<open><)?(?P<url>[^\s)>]+)(?P<close>>)?(?P<suffix>(?:\s+[^)]*)?\))"
)
REFERENCE_LINK = re.compile(
    r"^(?P<prefix>\s*\[[^\]]+\]:\s*)(?P<open><)?(?P<url>\S+?)(?P<close>>)?(?P<suffix>\s*(?:[\"'(].*)?)$",
    re.MULTILINE,
)
HTML_ASSET = re.compile(
    r"(?P<prefix>\b(?:src|poster)=[\"'])(?P<url>[^\"']+)(?P<suffix>[\"'])",
    re.IGNORECASE,
)
FENCE_OPEN = re.compile(r"^ {0,3}(?P<fence>`{3,}|~{3,})")
INDENTED_CODE = re.compile(r"^(?: {4}|\t)")
HTML_CODE_OPEN = re.compile(r"<(code|pre)\b", re.IGNORECASE)
ASSET_EXTENSIONS = {
    ".avif", ".gif", ".jpeg", ".jpg", ".pdf", ".png", ".svg", ".webp",
    ".mp3", ".mp4", ".ogg", ".wav", ".webm", ".zip",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Markdown file to export")
    parser.add_argument("--output", type=Path, help="Output file; omit to write to stdout")
    parser.add_argument("--base-url", help="Site base URL; defaults to baseURL in hugo.toml")
    parser.add_argument(
        "--article-url",
        help="Canonical article URL used to resolve page-bundle assets",
    )
    return parser.parse_args()


def split_front_matter(text: str) -> str:
    lines = text.splitlines(keepends=True)
    if not lines:
        return text
    delimiter = lines[0].strip()
    if delimiter not in {"+++", "---"}:
        return text
    for index in range(1, len(lines)):
        if lines[index].strip() == delimiter:
            return "".join(lines[index + 1 :]).lstrip("\r\n")
    raise ValueError("front matter has no closing delimiter")


def read_base_url(project_dir: Path) -> str:
    config = project_dir / "hugo.toml"
    text = config.read_text(encoding="utf-8")
    match = re.search(r'^\s*baseURL\s*=\s*["\']([^"\']+)["\']', text, re.MULTILINE)
    if not match:
        raise ValueError("baseURL was not found in hugo.toml; pass --base-url")
    return match.group(1)


def inferred_article_url(source: Path, project_dir: Path, base_url: str) -> str | None:
    content_dir = project_dir / "content"
    try:
        relative = source.resolve().relative_to(content_dir.resolve())
    except ValueError:
        return None

    if relative.name in {"index.md", "_index.md"}:
        url_path = relative.parent.as_posix().strip("/")
    else:
        url_path = relative.with_suffix("").as_posix().strip("/")
    return urljoin(base_url.rstrip("/") + "/", url_path + "/")


def is_relative_asset(raw_url: str) -> bool:
    split = urlsplit(raw_url)
    if split.scheme or split.netloc or raw_url.startswith(("/", "#")):
        return False
    return Path(split.path).suffix.lower() in ASSET_EXTENSIONS


def markdown_block_segments(body: str):
    """Yield protected code blocks and ordinary Markdown as separate segments."""
    protected: bool | None = None
    parts: list[str] = []
    fence_character = ""
    fence_length = 0

    def flush():
        nonlocal parts
        if parts:
            value = "".join(parts)
            parts = []
            return value
        return None

    for line in body.splitlines(keepends=True):
        line_is_protected = False
        if fence_character:
            line_is_protected = True
            closing = re.match(
                rf"^ {{0,3}}{re.escape(fence_character)}{{{fence_length},}}[ \t]*(?:\r?\n)?$",
                line,
            )
            if closing:
                fence_character = ""
                fence_length = 0
        else:
            opening = FENCE_OPEN.match(line)
            if opening:
                marker = opening.group("fence")
                fence_character = marker[0]
                fence_length = len(marker)
                line_is_protected = True
            elif INDENTED_CODE.match(line):
                line_is_protected = True

        if protected is None:
            protected = line_is_protected
        elif protected != line_is_protected:
            value = flush()
            if value is not None:
                yield protected, value
            protected = line_is_protected
        parts.append(line)

    value = flush()
    if value is not None:
        yield bool(protected), value


def rewrite_inline_safe(text: str, rewrite) -> str:
    """Rewrite prose while preserving inline code and HTML code/pre examples."""
    result: list[str] = []
    position = 0
    length = len(text)

    while position < length:
        tick_start = text.find("`", position)
        html_match = HTML_CODE_OPEN.search(text, position)
        html_start = html_match.start() if html_match else -1
        candidates = [value for value in (tick_start, html_start) if value >= 0]
        if not candidates:
            result.append(rewrite(text[position:]))
            break

        start = min(candidates)
        result.append(rewrite(text[position:start]))

        if start == html_start and html_match is not None:
            tag = html_match.group(1)
            closing = re.compile(rf"</{tag}\s*>", re.IGNORECASE).search(text, html_match.end())
            if closing:
                result.append(text[start : closing.end()])
                position = closing.end()
                continue
            result.append(rewrite(text[start : html_match.end()]))
            position = html_match.end()
            continue

        delimiter_end = start
        while delimiter_end < length and text[delimiter_end] == "`":
            delimiter_end += 1
        delimiter = text[start:delimiter_end]
        search_from = delimiter_end
        closing_start = -1
        while True:
            candidate = text.find(delimiter, search_from)
            if candidate < 0:
                break
            before_is_tick = candidate > 0 and text[candidate - 1] == "`"
            after = candidate + len(delimiter)
            after_is_tick = after < length and text[after] == "`"
            if not before_is_tick and not after_is_tick:
                closing_start = candidate
                break
            search_from = candidate + 1

        if closing_start >= 0:
            closing_end = closing_start + len(delimiter)
            result.append(text[start:closing_end])
            position = closing_end
        else:
            result.append(rewrite(delimiter))
            position = delimiter_end

    return "".join(result)


def rewrite_assets(body: str, article_url: str | None) -> str:
    found_relative = False

    def replace(match: re.Match[str]) -> str:
        nonlocal found_relative
        raw_url = match.group("url")
        if not is_relative_asset(raw_url):
            return match.group(0)
        found_relative = True
        if article_url is None:
            return match.group(0)
        absolute = urljoin(article_url.rstrip("/") + "/", raw_url)
        groups = match.groupdict()
        return f'{groups["prefix"]}{groups.get("open") or ""}{absolute}{groups.get("close") or ""}{groups["suffix"]}'

    def rewrite_prose(text: str) -> str:
        text = MARKDOWN_LINK.sub(replace, text)
        text = REFERENCE_LINK.sub(replace, text)
        return HTML_ASSET.sub(replace, text)

    rewritten: list[str] = []
    for protected, segment in markdown_block_segments(body):
        if protected:
            rewritten.append(segment)
        else:
            rewritten.append(rewrite_inline_safe(segment, rewrite_prose))
    if found_relative and article_url is None:
        raise ValueError(
            "relative assets were found outside content/; pass --article-url so their public URL is unambiguous"
        )
    return "".join(rewritten)


def main() -> int:
    args = parse_args()
    script_dir = Path(__file__).resolve().parent
    project_dir = script_dir.parent
    source = args.source if args.source.is_absolute() else (Path.cwd() / args.source)
    source = source.resolve()

    base_url = args.base_url or read_base_url(project_dir)
    if not urlsplit(base_url).scheme:
        raise ValueError("base URL must be absolute")
    article_url = args.article_url or inferred_article_url(source, project_dir, base_url)

    body = split_front_matter(source.read_text(encoding="utf-8"))
    exported = rewrite_assets(body, article_url)
    if not exported.endswith("\n"):
        exported += "\n"

    if args.output:
        output = args.output if args.output.is_absolute() else (Path.cwd() / args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(exported, encoding="utf-8")
        print(f"Velog draft written to {output}", file=sys.stderr)
    else:
        sys.stdout.write(exported)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
