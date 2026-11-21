"""Index original PDF text and extracted table rows for targeted follow-up."""

import gzip
import json
import re
import unicodedata

from document import compact


MAX_INDEX_BYTES = 16 * 1024 * 1024
MAX_PAGE_CHARS = 24000
MAX_OUTPUT_BYTES = 26 * 1024
MAX_PAGE_OUTPUT_BYTES = 80 * 1024
TABLE_NUMBER = re.compile(r"表\s*([a-z]?\d+(?:\s*[-.－—–]\s*\d+)*)", re.I)
POLLUTANTS = (("cod", "化学需氧量"), ("tn", "总氮"), ("tp", "总磷"),
              ("ss", "悬浮物"), ("nh3-n", "氨氮"))


def as_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def search_text(value):
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold().translate(str.maketrans("－—–−", "----"))
    # Keep ASCII cell and line separators so e.g. DW001 and DW0010 remain distinct.
    normalized = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", normalized)
    return " ".join(normalized.split())


def table_number(value):
    match = TABLE_NUMBER.search(unicodedata.normalize("NFKC", value or ""))
    return compact(search_text(match[1])) if match else ""


def cells_of(grid, row):
    cells = []
    inherited = []
    for column, actual in enumerate(grid.rows[row]):
        if actual is None and (row, column) in grid.inherited:
            actual = grid.inherited[row, column]
            inherited.append(column + 1)
        cells.append(actual)
    return {"row": row + 1, "cells": cells, "merged_columns": inherited}


def table_record(grid):
    return {"caption": grid.label, "number": table_number(grid.label),
            "rows": [cells_of(grid, n) for n in range(len(grid.rows))]}


class IndexWriter:
    def __init__(self, stream):
        self.stream = stream
        self.bytes_left = MAX_INDEX_BYTES
        self.pages = 0
        self.omitted_pages = 0

    def add(self, number, text, chapter, low_text, tables=()):
        record = {"page": number, "chapter": chapter, "low_text": low_text,
                  "text": text[:MAX_PAGE_CHARS], "tables": [table_record(table) for table in tables],
                  "text_truncated": len(text) > MAX_PAGE_CHARS}
        encoded = (as_json(record) + "\n").encode("utf-8")
        if len(encoded) > self.bytes_left:
            record.update(tables=[], tables_omitted=True)
            encoded = (as_json(record) + "\n").encode("utf-8")
        if len(encoded) <= self.bytes_left:
            self.stream.write(encoded)
            self.bytes_left -= len(encoded)
            self.pages += 1
        else:
            self.omitted_pages += 1


def contains(source, term):
    if not term:
        return False
    if re.fullmatch(r"[a-z][a-z0-9-]*", term):
        return bool(re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", source))
    return term in source


def text_excerpt(text, selectors, explicit):
    lines = text.splitlines()
    hits = [i for i, line in enumerate(lines) if any(
        contains(search_text(line), term) for group in selectors for term in group
    )]
    if not hits or (explicit and len(text) <= 1600):
        return [{"lines": [1, min(len(lines), 24)], "text": "\n".join(lines[:24])[:1600]}] if lines else []
    snippets = []
    end = -1
    for i in hits:
        if i <= end:
            continue
        start, end = max(0, i - 2), min(len(lines) - 1, i + 3)
        snippets.append({"lines": [start + 1, end + 1], "text": "\n".join(lines[start:end + 1])[:800]})
        if len(snippets) == 5:
            break
    return snippets


def matched_rows(grid, groups):
    rows = []
    for row in grid["rows"]:
        packed = search_text(" | ".join(str(cell or "") for cell in row["cells"]))
        if all(any(contains(packed, term) for term in group) for group in groups):
            rows.append(row)
    return rows


def preview_row(row):
    cells = row["cells"]
    return {**row, "cells": [cell[:180] if cell else cell for cell in cells],
            **({"truncated_cells": [n + 1 for n, cell in enumerate(cells) if cell and len(cell) > 180]}
               if any(cell and len(cell) > 180 for cell in cells) else {})}


def fetch(stream, query):
    pages = query.get("pages") or []
    start, end = query.get("start_page"), query.get("end_page")
    chapter = search_text(query.get("section"))
    full = query.get("detail") == "page"
    row_limit = 16 if full else 6
    row_start = query.get("row_start", 1)
    table_limit = 5 if full else 3
    output_limit = MAX_PAGE_OUTPUT_BYTES if full else MAX_OUTPUT_BYTES
    table = query.get("table") or ""
    table_id = table_number(table) or table_number("表" + table)
    table_phrase = search_text(table) if not table_id else ""
    outlet = search_text(query.get("outlet"))
    name = search_text(query.get("pollutant"))
    pollutants = next((aliases for aliases in POLLUTANTS if name in aliases), (name,)) if name else ()
    keywords = [(search_text(word),) for word in query.get("keywords", []) if search_text(word)]
    groups = ([(outlet,)] if outlet else []) + ([pollutants] if pollutants else []) + keywords
    label_query = [(search_text("表" + table_id),)] if table_id else ([(table_phrase,)] if table_phrase else [])
    if not (pages or start or chapter or table or groups):
        raise ValueError("请至少指定页码、页段、章节、表号、排口、污染物或关键词之一。")
    candidates = []
    known_pages = set()
    with gzip.GzipFile(fileobj=stream, mode="rb") as entries:
        for line in entries:
            record = json.loads(line)
            number = record["page"]
            known_pages.add(number)
            if ((pages and number not in pages) or (start and not start <= number <= end)
                    or (chapter and not contains(search_text(record.get("chapter")), chapter))):
                continue
            matches = []
            for grid in record["tables"]:
                if table_id and grid["number"] != table_id:
                    continue
                if table_phrase and not contains(search_text(grid["caption"]), table_phrase):
                    continue
                rows = [row for row in matched_rows(grid, groups) if row["row"] >= row_start]
                if rows:
                    matches.append({"caption": grid["caption"],
                                    "rows": [preview_row(row) for row in rows[:row_limit]],
                                    "remaining_rows": max(0, len(rows) - row_limit),
                                    **({"next_row_start": rows[row_limit]["row"]} if len(rows) > row_limit else {})})
            packed = search_text(record["text"])
            refers = (table_id in [compact(search_text(m[1])) for m in TABLE_NUMBER.finditer(record["text"])]
                      if table_id else not table_phrase or contains(packed, table_phrase))
            text_match = refers and all(any(contains(packed, term) for term in group) for group in groups)
            if not (matches or text_match):
                continue
            snippets = ([{"lines": [1, record["text"].count("\n") + 1], "text": record["text"]}]
                        if full and record["text"] else text_excerpt(record["text"], groups + label_query, bool(pages)))
            candidates.append((number, len(matches), {
                "page": number, "chapter": record["chapter"],
                "low_text": record["low_text"],
                "text_truncated": record["text_truncated"], "table_grid_omitted": record.get("tables_omitted", False),
                "text": snippets, "tables": matches[:table_limit], "remaining_tables": max(0, len(matches) - table_limit),
            }))
    if pages:
        candidates.sort(key=lambda item: pages.index(item[0]))
    elif not start:
        candidates.sort(key=lambda item: (-item[1], item[0]))
    requested_pages = range(start, end + 1) if start else pages
    result = {"status": "matched" if candidates else "no_match", "matching_pages": len(candidates),
              "unindexed_requested_pages": [page for page in requested_pages if page not in known_pages],
              "pages": [], "remaining_pages": len(candidates)}
    for _, _, page in candidates[:query.get("limit", 4)]:
        result["pages"].append(page)
        result["remaining_pages"] -= 1
        if len(as_json(result).encode("utf-8")) > output_limit:
            if len(result["pages"]) == 1:
                while page["tables"] and len(as_json(result).encode("utf-8")) > output_limit:
                    page["tables"].pop()
                    page["remaining_tables"] += 1
            if len(as_json(result).encode("utf-8")) > output_limit:
                result["pages"].pop()
                result["remaining_pages"] += 1
                break
    if start and result["pages"] and result["remaining_pages"]:
        result["next_start_page"] = candidates[len(result["pages"])][0]
    return result
