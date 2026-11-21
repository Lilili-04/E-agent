"""Read an EIA PDF and expose source pages and generic arithmetic."""

import argparse
import gzip
import json
from pathlib import Path
import re
import sys

import fitz

# Harness starts the worker in isolated mode, trusting only bundled modules.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from document import CAPTION, compact, extract_grids, quote
from evidence_index import IndexWriter, as_json, fetch
from formula import calculate


LIMITS = json.loads(Path(__file__).with_name("limits.json").read_text(encoding="utf-8"))
MAX_BYTES = LIMITS["mib"] * 1024 * 1024
MAX_PAGES = LIMITS["pages"]
CHAPTER = re.compile(r"^(?:第(?P<chapter>[一二三四五六七八九十\d]+)章\s*|"
                     r"(?P<item>[一二三四五六七八九十]+)[、.．]\s*)[\u4e00-\u9fff].{1,70}$")
SUBHEADING = re.compile(r"^\d{1,2}(?:[.．]\d{1,2}){1,3}[.．\s]*[\u4e00-\u9fff].{1,58}$")
CONTENTS_ENTRY = re.compile(r"[.…·]{2,}\s*[-—]?\s*\d+\s*[-—]?\s*$")
REPORT_TITLE = re.compile(r"^[^《》“”。，；]{0,70}环境影响报告[书表](?:\(.{1,18}\))?$")
CHINESE_DIGITS = dict(zip("一二三四五六七八九", range(1, 10)))


def chapter_number(match):
    number = match["chapter"] or match["item"]
    if number.isdecimal():
        return int(number)
    if "十" in number:
        tens, ones = number.split("十", 1)
        return 10 * CHINESE_DIGITS.get(tens, 1) + CHINESE_DIGITS.get(ones, 0)
    return CHINESE_DIGITS.get(number, 0)


def inspect(document, name, index=None):
    contents_pages = []
    contents_headings = {}
    chapters = {}
    headings = {}
    table_locations = {}
    unreadable = []
    table_errors = []
    title_candidates = []
    chapter = ""
    chapter_order = 0
    for number, page in enumerate(document, 1):
        text = page.get_text(sort=True)
        low_text = len(re.sub(r"[\d\W_]", "", text)) < 12
        if low_text:
            unreadable.append(number)
            if index is not None:
                index.add(number, text, chapter, True)
            continue

        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if number <= 6 and not title_candidates:
            for i, line in enumerate(lines):
                if REPORT_TITLE.fullmatch(compact(line)):
                    subtype = lines[i + 1] if i + 1 < len(lines) else ""
                    if compact(subtype).strip("()") in ("污染影响类", "生态影响类"):
                        line += " " + subtype
                    title_candidates.append({"title": quote(line), "page": number})
        is_contents = any(compact(line) == "目录" for line in lines[:8])
        if is_contents:
            contents_pages.append(number)
            for line in lines:
                title = CONTENTS_ENTRY.sub("", line).strip()
                if title != line and (match := CHAPTER.fullmatch(title)):
                    contents_headings.setdefault(chapter_number(match), compact(title))
        else:
            for line in lines:
                if CONTENTS_ENTRY.search(line) or re.search(r"[。；！？]", line):
                    continue
                if match := CHAPTER.fullmatch(line):
                    order = chapter_number(match)
                    listed_title = contents_headings.get(order)
                    matches_contents = listed_title == compact(line)
                    next_on_new_page = order == chapter_order + 1 and chapters.get(chapter) != number
                    follows_numbering = not listed_title and (match["chapter"] or next_on_new_page)
                    if order > chapter_order and (matches_contents or follows_numbering):
                        chapter = line
                        chapter_order = order
                        chapters.setdefault(line, number)
                    elif line != chapter:
                        headings.setdefault(line, number)
                elif SUBHEADING.fullmatch(line):
                    headings.setdefault(line, number)

        grids = []
        if not is_contents:
            try:
                # Use the PDF table geometry across all sections, including uncaptained continuations.
                grids = extract_grids(page)
            except (RuntimeError, ValueError, IndexError) as error:
                table_errors.append({"page": number, "reason": type(error).__name__})
        captions = {line for line in lines if CAPTION.fullmatch(line)}
        captions.update(grid.label for grid in grids if grid.label != "页面表格")
        for label in sorted(captions):
            table_locations.setdefault(label, []).append(number)
        if index is not None:
            index.add(number, text, chapter, False, grids)

    page_count = len(document)
    status = "indexed"
    if len(unreadable) == page_count:
        status = "needs_ocr"
    elif len(unreadable) * 10 >= page_count * 9:
        status = "partial_needs_ocr"
    return {
        "file": name, "status": status, "page_count": page_count,
        "low_text_page_count": len(unreadable), "low_text_pages": unreadable[:24],
        "table_parse_error_count": len(table_errors), "table_parse_errors": table_errors[:24],
        "indexed_pages": index.pages if index is not None else 0,
        "unindexed_pages": index.omitted_pages if index is not None else 0,
        "navigation": {
            "title_candidates": title_candidates[:6],
            "contents_pages": contents_pages[:16],
            "bookmarks": [{"level": level, "title": quote(title, 90), "page": page}
                          for level, title, page in document.get_toc()[:30] if page >= 1],
            "sections": [{"title": title, "page": page} for title, page in list(chapters.items())[:30]],
            "subheadings": [{"title": title, "page": page} for title, page in list(headings.items())[:35]],
            "tables": [{"caption": quote(label, 90), "pages": pages[:8], "page_count": len(pages)}
                       for label, pages in list(table_locations.items())[:48]],
            "table_title_count": len(table_locations),
        },
    }


def run_pdf(data, name, index=None):
    if len(data) > MAX_BYTES or b"%PDF-" not in data[:1024]:
        raise ValueError(f"请提交不超过 {LIMITS['mib']} MiB 的 PDF。")
    with fitz.open(stream=data, filetype="pdf") as document:
        if document.needs_pass or not 0 < document.page_count <= MAX_PAGES:
            raise ValueError(f"请提交已解密且不超过 {MAX_PAGES} 页的 PDF。")
        return inspect(document, name, index)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", help="PDF path or - for stdin")
    parser.add_argument("--name", help="Display filename for piped PDF")
    parser.add_argument("--index-output", type=Path, help="Local compressed evidence index")
    parser.add_argument("--evidence-query", help="Read a compressed evidence index on stdin")
    parser.add_argument("--calculate", action="store_true", help="Read decimal formulas as JSON on stdin")
    parser.add_argument("--scope", dest="legacy_scope", help=argparse.SUPPRESS)
    args = parser.parse_args()
    fitz.TOOLS.mupdf_display_errors(False)
    try:
        if args.legacy_scope is not None:
            # Let an already-running legacy adapter finish its stdin write.
            if args.pdf == "-":
                sys.stdin.buffer.read(MAX_BYTES + 1)
            raise ValueError("3080 正在使用旧环评工具。请重启网页服务，再使用新版 PDF 取证和复算工具。")
        if args.evidence_query is not None:
            result = fetch(sys.stdin.buffer, json.loads(args.evidence_query))
        elif args.calculate:
            result = calculate(json.loads(sys.stdin.buffer.read(32 * 1024)))
        else:
            if args.pdf == "-":
                data, name = sys.stdin.buffer.read(MAX_BYTES + 1), args.name or "报告.pdf"
            else:
                path = Path(args.pdf)
                with path.open("rb") as stream:
                    data, name = stream.read(MAX_BYTES + 1), path.name
            if args.index_output is None:
                result = run_pdf(data, name)
            else:
                with gzip.open(args.index_output, "wb") as stream:
                    result = run_pdf(data, name, IndexWriter(stream))
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"{error}\n")
    print(as_json(result))


if __name__ == "__main__":
    main()
