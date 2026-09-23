#!/usr/bin/env python3
"""Validate a generated Hugo site as it will be served from a subpath."""

from __future__ import annotations

import argparse
import html
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit


IGNORED_SCHEMES = {"data", "javascript", "mailto", "tel"}


@dataclass
class Page:
    file: Path
    url: str
    title: str = ""
    canonicals: list[str] = field(default_factory=list)
    references: list[tuple[str, str]] = field(default_factory=list)
    ids: set[str] = field(default_factory=set)


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.title_parts: list[str] = []
        self.canonicals: list[str] = []
        self.references: list[tuple[str, str]] = []
        self.ids: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value for key, value in attrs if value is not None}
        tag = tag.lower()
        if tag == "title":
            self.in_title = True
        if "id" in values:
            self.ids.add(values["id"])
        if tag == "a" and "name" in values:
            self.ids.add(values["name"])
        if tag == "link" and "canonical" in values.get("rel", "").lower().split():
            if "href" in values:
                self.canonicals.append(values["href"])

        for attribute in ("href", "src", "poster", "action", "data"):
            if attribute in values:
                self.references.append((f"{tag}[{attribute}]", values[attribute]))
        for attribute in ("srcset",):
            if attribute in values:
                for candidate in values[attribute].split(","):
                    url = candidate.strip().split()[0] if candidate.strip() else ""
                    if url:
                        self.references.append((f"{tag}[{attribute}]", url))

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-dir", type=Path, required=True)
    parser.add_argument("--content-dir", type=Path)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--required-path", action="append", default=[])
    return parser.parse_args()


def normalized_base(raw: str) -> str:
    split = urlsplit(raw)
    if split.scheme not in {"http", "https"} or not split.netloc:
        raise ValueError("--base-url must be an absolute HTTP(S) URL")
    path = split.path.rstrip("/") + "/"
    return f"{split.scheme}://{split.netloc}{path}"


def page_url(base_url: str, relative: Path) -> str:
    value = relative.as_posix()
    if value == "index.html":
        value = ""
    elif value.endswith("/index.html"):
        value = value[: -len("index.html")]
    return urljoin(base_url, value)


def parse_pages(public_dir: Path, base_url: str) -> dict[Path, Page]:
    pages: dict[Path, Page] = {}
    for file in sorted(public_dir.rglob("*.html")):
        parser = PageParser()
        parser.feed(file.read_text(encoding="utf-8"))
        relative = file.relative_to(public_dir)
        pages[file.resolve()] = Page(
            file=file,
            url=page_url(base_url, relative),
            title=" ".join("".join(parser.title_parts).split()),
            canonicals=parser.canonicals,
            references=parser.references,
            ids=parser.ids,
        )
    return pages


def public_target(public_dir: Path, base_url: str, absolute_url: str) -> Path | None:
    base = urlsplit(base_url)
    target = urlsplit(absolute_url)
    if target.scheme in IGNORED_SCHEMES:
        return None
    if target.scheme and (target.scheme, target.netloc) != (base.scheme, base.netloc):
        return None
    if target.netloc and target.netloc != base.netloc:
        return None

    base_path = base.path.rstrip("/")
    target_path = unquote(target.path)
    if target_path == base_path:
        relative = ""
    elif target_path.startswith(base_path + "/"):
        relative = target_path[len(base_path) + 1 :]
    else:
        raise ValueError(f"internal URL escapes the configured site path: {absolute_url}")

    candidate = (public_dir / relative).resolve()
    public_root = public_dir.resolve()
    if candidate != public_root and public_root not in candidate.parents:
        raise ValueError(f"internal URL escapes the output directory: {absolute_url}")
    if candidate.is_dir() or target_path.endswith("/"):
        candidate = candidate / "index.html"
    elif not candidate.exists() and (candidate / "index.html").exists():
        candidate = candidate / "index.html"
    return candidate


def css_urls(text: str):
    """Yield top-level CSS url() values without re-parsing text inside strings."""
    index = 0
    length = len(text)
    while index < length:
        if text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = length if end < 0 else end + 2
            continue

        if text[index] in {"\"", "'"}:
            quote = text[index]
            index += 1
            while index < length:
                if text[index] == "\\":
                    index += 2
                elif text[index] == quote:
                    index += 1
                    break
                else:
                    index += 1
            continue

        if text[index : index + 3].lower() != "url":
            index += 1
            continue
        if index > 0 and (text[index - 1].isalnum() or text[index - 1] in {"_", "-"}):
            index += 1
            continue

        cursor = index + 3
        while cursor < length and text[cursor].isspace():
            cursor += 1
        if cursor >= length or text[cursor] != "(":
            index += 1
            continue
        cursor += 1
        while cursor < length and text[cursor].isspace():
            cursor += 1

        if cursor < length and text[cursor] in {"\"", "'"}:
            quote = text[cursor]
            cursor += 1
            value_start = cursor
            value_parts: list[str] = []
            while cursor < length:
                if text[cursor] == "\\" and cursor + 1 < length:
                    value_parts.append(text[value_start:cursor])
                    value_parts.append(text[cursor + 1])
                    cursor += 2
                    value_start = cursor
                elif text[cursor] == quote:
                    value_parts.append(text[value_start:cursor])
                    cursor += 1
                    break
                else:
                    cursor += 1
            while cursor < length and text[cursor].isspace():
                cursor += 1
            if cursor < length and text[cursor] == ")":
                yield "".join(value_parts).strip()
                index = cursor + 1
                continue
        else:
            value_start = cursor
            while cursor < length and text[cursor] != ")":
                cursor += 1
            if cursor < length:
                yield text[value_start:cursor].strip()
                index = cursor + 1
                continue

        index += 1


def validate_pages(public_dir: Path, base_url: str, pages: dict[Path, Page]) -> list[str]:
    errors: list[str] = []
    if not pages:
        return ["no HTML pages were generated"]

    for page in pages.values():
        label = page.file.relative_to(public_dir)
        if not page.title:
            errors.append(f"{label}: missing or empty <title>")
        if len(page.canonicals) != 1:
            errors.append(f"{label}: expected exactly one canonical URL, found {len(page.canonicals)}")
        else:
            canonical = urljoin(page.url, page.canonicals[0])
            if canonical != page.url:
                errors.append(f"{label}: canonical {canonical!r} does not match page URL {page.url!r}")

        for source, raw_url in page.references:
            raw_url = html.unescape(raw_url.strip())
            if not raw_url or raw_url.startswith("#") and not raw_url[1:]:
                continue
            absolute = urljoin(page.url, raw_url)
            try:
                target = public_target(public_dir, base_url, absolute)
            except ValueError as error:
                errors.append(f"{label}: {source} {error}")
                continue
            if target is None:
                continue
            if not target.exists():
                errors.append(f"{label}: {source} points to missing {raw_url!r}")
                continue
            fragment = unquote(urlsplit(absolute).fragment)
            if fragment and target.suffix.lower() in {".html", ".htm"}:
                target_page = pages.get(target.resolve())
                if target_page and fragment not in target_page.ids:
                    errors.append(f"{label}: {source} points to missing fragment #{fragment} in {target.relative_to(public_dir)}")

    for css_file in sorted(public_dir.rglob("*.css")):
        css_url = urljoin(base_url, css_file.relative_to(public_dir).as_posix())
        for raw_url in css_urls(css_file.read_text(encoding="utf-8")):
            absolute = urljoin(css_url, raw_url)
            try:
                target = public_target(public_dir, base_url, absolute)
            except ValueError as error:
                errors.append(f"{css_file.relative_to(public_dir)}: {error}")
                continue
            if target is not None and not target.exists():
                errors.append(f"{css_file.relative_to(public_dir)}: CSS points to missing {raw_url!r}")
    return errors


def validate_sitemap(public_dir: Path, base_url: str) -> list[str]:
    sitemap = public_dir / "sitemap.xml"
    if not sitemap.exists():
        return ["sitemap.xml was not generated"]
    errors: list[str] = []
    try:
        root = ET.parse(sitemap).getroot()
    except ET.ParseError as error:
        return [f"sitemap.xml is invalid XML: {error}"]
    locations = [node.text.strip() for node in root.iter() if node.tag.endswith("loc") and node.text]
    if not locations:
        errors.append("sitemap.xml contains no URLs")
    for location in locations:
        try:
            target = public_target(public_dir, base_url, location)
        except ValueError as error:
            errors.append(f"sitemap.xml: {error}")
            continue
        if target is None or not target.exists():
            errors.append(f"sitemap.xml points to missing {location!r}")
    return errors


def front_matter(path: Path) -> dict[str, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() not in {"+++", "---"}:
        return {}
    delimiter = lines[0].strip()
    result: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == delimiter:
            break
        match = re.match(r"^\s*([A-Za-z][\w-]*)\s*(?:=|:)\s*(.*?)\s*$", line)
        if match:
            result[match.group(1).lower()] = match.group(2).strip().strip("\"'")
    return result


def draft_url_path(file: Path, content_dir: Path, metadata: dict[str, str]) -> str:
    if metadata.get("url"):
        return "/" + metadata["url"].strip("/") + "/"
    relative = file.relative_to(content_dir)
    if relative.name in {"index.md", "_index.md"}:
        parts = list(relative.parent.parts)
    else:
        parts = list(relative.with_suffix("").parts)
    if metadata.get("slug") and parts:
        parts[-1] = metadata["slug"].strip("/")
    return "/" + "/".join(parts).strip("/") + "/"


def validate_drafts(public_dir: Path, content_dir: Path, base_url: str, pages: dict[Path, Page]) -> list[str]:
    errors: list[str] = []
    page_titles = {page.title for page in pages.values()}
    for source in sorted(content_dir.rglob("*.md")):
        metadata = front_matter(source)
        if metadata.get("draft", "").lower() not in {"true", "yes"}:
            continue
        title = metadata.get("title")
        if title and title in page_titles:
            errors.append(f"draft title was published: {title!r} ({source})")
        path = draft_url_path(source, content_dir, metadata)
        try:
            target = public_target(public_dir, base_url, urljoin(base_url, path.lstrip("/")))
        except ValueError:
            continue
        if target is not None and target.exists():
            errors.append(f"draft page was generated: {source} -> {target.relative_to(public_dir)}")
    return errors


def validate_required(public_dir: Path, base_url: str, paths: list[str]) -> list[str]:
    errors: list[str] = []
    for path in paths:
        location = urljoin(base_url, path.lstrip("/"))
        try:
            target = public_target(public_dir, base_url, location)
        except ValueError as error:
            errors.append(str(error))
            continue
        if target is None or not target.exists():
            errors.append(f"required page is missing: {path}")
    return errors


def main() -> int:
    args = arguments()
    public_dir = args.public_dir.resolve()
    base_url = normalized_base(args.base_url)
    pages = parse_pages(public_dir, base_url)
    errors = validate_pages(public_dir, base_url, pages)
    errors.extend(validate_sitemap(public_dir, base_url))
    errors.extend(validate_required(public_dir, base_url, args.required_path))
    if args.content_dir:
        content_dir = args.content_dir.resolve()
        errors.extend(validate_drafts(public_dir, content_dir, base_url, pages))

    if errors:
        print(f"Site verification failed with {len(errors)} issue(s):", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"Verified {len(pages)} HTML page(s), sitemap, links, assets, titles, canonicals, and draft exclusion.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
