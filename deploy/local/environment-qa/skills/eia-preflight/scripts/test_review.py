"""Regression tests for source retrieval and model-supplied expressions."""

import gzip
import io
from pathlib import Path
import subprocess
import sys
import unittest

import fitz

from document import Grid
from evidence_index import IndexWriter, fetch
from formula import calculate
from review import run_pdf


def index_bytes(pages):
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode="wb") as compressed:
        index = IndexWriter(compressed)
        for record in pages:
            index.add(*record)
    stream.seek(0)
    return stream


class ReportTests(unittest.TestCase):
    def test_legacy_adapter_gets_upgrade_error_after_stdin_is_read(self):
        worker = Path(__file__).with_name("review.py")
        result = subprocess.run(
            [sys.executable, "-I", "-X", "utf8", "-B", str(worker), "-", "--scope", "water"],
            input=b"%PDF-" + b" " * (2 * 1024 * 1024), capture_output=True, timeout=15,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("3080 正在使用旧环评工具", result.stderr.decode("utf-8"))

    def test_empty_text_layer_is_reported(self):
        with fitz.open() as document:
            document.new_page()
            data = document.tobytes()
        with gzip.GzipFile(fileobj=io.BytesIO(), mode="wb") as stream:
            result = run_pdf(data, "扫描件.pdf", IndexWriter(stream))
        self.assertEqual(result["status"], "needs_ocr")
        self.assertEqual(result["low_text_pages"], [1])
        self.assertNotIn("checks", result)

    def test_navigation_returns_locations_without_findings(self):
        with fitz.open() as document:
            page = document.new_page()
            page.insert_text((45, 60), "建设项目环境影响报告表\n一、建设项目基本情况\n表1-1 原辅料",
                             fontname="china-s")
            data = document.tobytes()
        result = run_pdf(data, "报告.pdf")
        self.assertEqual(result["status"], "indexed")
        self.assertEqual(result["navigation"]["title_candidates"][0]["page"], 1)
        self.assertEqual(result["navigation"]["sections"][0]["title"], "一、建设项目基本情况")
        self.assertEqual(result["navigation"]["tables"][0]["pages"], [1])
        self.assertNotIn("checks", result)

    def test_evidence_returns_complete_pages_with_continuation(self):
        source = "起始段落。\n" + "\n".join([f"正文第{i}行" for i in range(75)]) + "\n末尾脚注"
        pages = [(i, source, "四、环境影响", False) for i in range(1, 4)]
        result = fetch(index_bytes(pages), {"start_page": 1, "end_page": 3, "detail": "page", "limit": 2,
                                            "section": "环境影响"})
        self.assertEqual([page["page"] for page in result["pages"]], [1, 2])
        self.assertEqual(result["next_start_page"], 3)
        self.assertEqual(result["pages"][0]["text"][0]["text"], source)

    def test_subheadings_do_not_replace_main_chapter(self):
        with fitz.open() as document:
            for text in ("一、工程分析\n工程设计参数来源说明",
                         "二、环境影响\n一、废水治理措施\n二、固废处理措施\n三、噪声治理措施",
                         "运行期废水排放源强和核算过程详见下表"):
                page = document.new_page()
                page.insert_text((45, 60), text, fontname="china-s")
            data = document.tobytes()
        stream = io.BytesIO()
        with gzip.GzipFile(fileobj=stream, mode="wb") as compressed:
            navigation = run_pdf(data, "报告.pdf", IndexWriter(compressed))["navigation"]
        stream.seek(0)
        matched = fetch(stream, {"section": "环境影响"})
        self.assertEqual([item["title"] for item in navigation["sections"]], ["一、工程分析", "二、环境影响"])
        self.assertEqual([page["page"] for page in matched["pages"]], [2, 3])

    def test_evidence_preserves_original_header_and_merged_cells(self):
        grid = Grid("表1-2 监测", [["点位", "指标"], ["DW001", "总氮"], [None, "悬浮物"]], {(2, 0): "DW001"})
        result = fetch(index_bytes([(1, "表1-2 监测\nDW001 总氮\n悬浮物", "", False, [grid])]),
                       {"pages": [1], "table": "表1－2", "detail": "page"})
        rows = result["pages"][0]["tables"][0]["rows"]
        self.assertEqual(rows[0]["cells"], ["点位", "指标"])
        self.assertEqual(rows[-1], {"row": 3, "cells": ["DW001", "悬浮物"], "merged_columns": [1]})

    def test_search_respects_boundaries_and_pollutant_aliases(self):
        pages = [(1, "DW0010 总氮", "", False), (2, "DW001 总氮", "", False)]
        result = fetch(index_bytes(pages), {"outlet": "DW001", "pollutant": "TN"})
        self.assertEqual([page["page"] for page in result["pages"]], [2])

    def test_table_rows_can_continue(self):
        grid = Grid("表1-1 核对", [[str(i), "记录"] for i in range(1, 22)])
        pages = [(1, "表1-1 核对", "", False, [grid])]
        first = fetch(index_bytes(pages), {"pages": [1], "detail": "page"})
        following = fetch(index_bytes(pages), {"pages": [1], "detail": "page", "row_start": 17})
        self.assertEqual(first["pages"][0]["tables"][0]["next_row_start"], 17)
        self.assertEqual(following["pages"][0]["tables"][0]["rows"][0]["row"], 17)


class FormulaTests(unittest.TestCase):
    def test_formula_preserves_decimal_and_inputs(self):
        variables = [{"name": "material", "value": "2.35", "unit": "t/a", "page": 8, "source": "材料表"},
                     {"name": "ratio", "value": "0.36", "page": 10}]
        result = calculate({"variables": variables, "formulas": [
            {"label": "方案甲", "expression": "material * ratio", "unit": "t/a"},
            {"label": "方案乙", "expression": "material * (1 - ratio)", "unit": "t/a"},
        ]})
        self.assertEqual([item["value"] for item in result["calculations"]], ["0.846", "1.504"])
        self.assertEqual(result["calculations"][0]["inputs"], ["material", "ratio"])
        self.assertEqual(result["variables"][0]["page"], 8)

    def test_bad_expression_does_not_affect_next_formula(self):
        expressions = ["(1).__class__", "1/0", "unknown(4)", "2**13", "log10(100) + sqrt(9)"]
        result = calculate({"formulas": [{"label": str(i), "expression": value}
                                         for i, value in enumerate(expressions)]})["calculations"]
        self.assertTrue(all("error" in item for item in result[:-1]))
        self.assertEqual(result[-1]["value"], "5")


if __name__ == "__main__":
    unittest.main()
