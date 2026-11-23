"""Extract original PDF table cells, with geometrically inherited cells marked."""

from dataclasses import dataclass, field
import re
import unicodedata

import fitz


def compact(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value or ""))


def quote(value, cap=125):
    return " ".join((value or "").split())[:cap]


CAPTION = re.compile(r"^(?:表\s*\d+(?:\s*[.．\-－—]\s*\d+)*(?:\s*[^\d\W_][^\n]{1,85})?|"
                     r"(?:附表\s*)?建设项目污染物排放量汇总表(?:.{0,24})?)$")
EDGE_HEADERS = {"污染物", "污染因子", "污染物种类", "污染物名称", "排放口名称/面源",
                "排放口名称", "排放口编号", "排污口编号", "产排污环节", "工序", "排放量",
                "年排放量", "排放量(t/a)", "年排放量(t/a)"}


@dataclass
class Grid:
    label: str
    rows: list
    inherited: dict = field(default_factory=dict)


def page_lines(page):
    lines = []
    for block in page.get_text("dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]:
        for line in block.get("lines", ()):
            value = "".join(span["text"] for span in line["spans"]).strip()
            lines.append((line["bbox"], value))
    return lines


def edge_column(page, table, lines, side):
    """Recover an edge only when its clipped header names a supported field."""
    x0, y0, x1, _ = table.bbox
    left, right = (max(page.rect.x0, x0 - 74), x0) if side == "left" else (x1, min(page.rect.x1, x1 + 74))
    if right - left < 8:
        return None
    edge = [(box, value) for box, value in lines if left <= (box[0] + box[2]) / 2 < right]
    for n in (1, 2):
        if n >= len(table.rows):
            continue
        bottom = table.rows[n - 1].bbox[3]
        header = compact("".join(value for box, value in edge if y0 <= (box[1] + box[3]) / 2 < bottom))
        if header not in EDGE_HEADERS:
            continue
        result = [header] + [None] * (n - 1)
        for source_row in table.rows[n:]:
            _, y, _, end = source_row.bbox
            value = compact("".join(value for box, value in edge if y <= (box[1] + box[3]) / 2 < end))
            result.append(value if 0 < len(value) <= 40 else "")
        return result
    return None


def extract_grids(page):
    tables = page.find_tables().tables
    if not tables:
        return []
    lines = page_lines(page)
    captions = [(box, value) for box, value in lines if CAPTION.fullmatch(value)]
    grids = []
    for table in tables:
        if table.row_count < 2 or table.col_count < 2 or table.col_count > 35:
            continue
        rows = table.extract()
        if any(len(cell or "") > 300 for cell in rows[0]):
            continue
        _, top, _, _ = table.bbox
        candidates = [(box[3], value) for box, value in captions if -2 <= top - box[3] <= 50]
        label = max(candidates, default=(0, ""), key=lambda item: item[0])[1]
        if re.fullmatch(r"表\s*\d+(?:\s*[.．\-－—]\s*\d+)*", label):
            caption_box = next(box for box, value in captions if value == label and -2 <= top - box[3] <= 50)
            companion = [(box[0], value) for box, value in lines
                         if 0 <= box[0] - caption_box[2] <= 24 and abs(box[1] - caption_box[1]) <= 2
                         and 2 <= len(value) <= 65]
            if companion:
                label += " " + min(companion)[1]
        if label:
            unit_lines = [value for box, value in lines if -1 <= top - box[3] <= 24
                          and re.fullmatch(r"\(?(?:单位[:：]?)t/a\)?", compact(value), re.I)]
            if unit_lines:
                label += " " + unit_lines[0]
        # PyMuPDF leaves merged cells empty. Mark their geometric source.
        widths = [min((row.cells[col][0] for row in table.rows if row.cells[col]), default=table.bbox[0])
                  for col in range(table.col_count)]
        boxes = [(fitz.Rect(rect), value)
                 for grid_row, row in zip(table.rows, rows)
                 for rect, value in zip(grid_row.cells, row) if rect and value]
        inherited = {}
        for n, (grid_row, row) in enumerate(zip(table.rows, rows)):
            for col, value in enumerate(row):
                if value is not None:
                    continue
                point = fitz.Point(widths[col] + 0.7, grid_row.bbox[1] + 0.7)
                for rect, owner in boxes:
                    if point in rect:
                        inherited[n, col] = owner
                        break
        if table.col_count >= 4:
            left = edge_column(page, table, lines, "left")
            right = edge_column(page, table, lines, "right")
            if left:
                inherited = {(n, col + 1): value for (n, col), value in inherited.items()}
            rows = [([left[n]] if left else []) + row + ([right[n]] if right else [])
                    for n, row in enumerate(rows)]
        grids.append(Grid(label or "页面表格", rows, inherited))
    return grids
