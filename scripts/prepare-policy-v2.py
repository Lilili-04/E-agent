"""Prepare source-backed v2 import JSONL; never mutate corpus, legacy DB, or vectors."""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import sqlite3

import openpyxl


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def clean(value):
    if value is None or str(value).strip() in {"", "26", "nan", "None"}:
        return None
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.date().isoformat() if isinstance(value, datetime.datetime) else value.isoformat()
    return str(value).strip()


def norm(text):
    return re.sub(r"[\s《》()（）“”\"']", "", text or "")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=pathlib.Path, required=True)
    parser.add_argument("--legacy", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--corpus", choices=["national", "all"], default="national")
    args = parser.parse_args()
    root = args.workspace.resolve()
    corpus = root / "policy_md"
    workbook = openpyxl.load_workbook(root / "环保政策法规清单.xlsx", read_only=True, data_only=True)
    catalog = []
    for sheet in workbook:
        rows = iter(sheet.values)
        headers = next(rows)
        for row in rows:
            item = {k: clean(v) for k, v in zip(headers, row) if k}
            item["corpus"] = "national" if "国家" in sheet.title else "provincial"
            if item.get("标题"):
                catalog.append(item)
    workbook.close()
    national = json.loads((root / "artifacts/policy-descriptions-national-v1.json").read_text("utf-8-sig"))
    summaries = {"national/" + row["relativePath"]: (row["sourceHash"], row["description"], None)
                 for row in national["records"]}
    provincial_titles = {}
    for meta_path in (root / "deepseek_results/provincial").glob("*.meta.json"):
        meta = json.loads(meta_path.read_text("utf-8-sig"))
        result = json.loads(meta_path.with_name(meta_path.name.replace(".meta.json", ".json")).read_text("utf-8-sig"))
        summaries[meta["source_path"]] = (meta["source_hash"], result["description"], meta.get("status"))
        provincial_titles[meta["source_path"]] = result["title"]
    legacy = sqlite3.connect(f"file:{args.legacy.resolve().as_posix()}?mode=ro", uri=True)
    legacy.row_factory = sqlite3.Row
    legacy_by_path = {"national/" + r["relative_path"]: dict(r) for r in legacy.execute("SELECT record_key, source_hash, relative_path FROM sources")}
    manifest = dict(legacy.execute("SELECT * FROM build_manifest").fetchone())
    mappings = {}
    documents = []
    audit = {"excluded_empty": [], "summary_hash_mismatch": [], "unmatched_metadata": [], "ambiguous_metadata": []}
    seen = {}
    for path in sorted(corpus.rglob("*.md")):
        relative = path.relative_to(corpus).as_posix()
        if args.corpus == "national" and not relative.startswith("national/"):
            continue
        # read_bytes preserves CRLF; hashes must use the original UTF-8 text.
        text = path.read_bytes().decode("utf-8-sig")
        if not text.strip():
            audit["excluded_empty"].append(relative)
            continue
        source_hash = digest(text)
        parts = path.relative_to(corpus).parts
        category = parts[0]
        if args.corpus == "national" and category != "national":
            continue
        folder = path.parent.parent.name if path.parent.name == "extracted" else path.parent.name
        stem = re.sub(r"^[a-f0-9]{24}_", "", folder)
        path_title = stem.split("__")[0]
        title = provincial_titles.get(relative) or path_title
        # Exact source filename wins; title alone is allowed only for one catalog row.
        matches = [r for r in catalog if r["corpus"] == category and
                   pathlib.PurePosixPath((r.get("正文文件路径") or "").replace("\\", "/")).stem == stem]
        if not matches:
            matches = [r for r in catalog if r["corpus"] == category and norm(r["标题"]) == norm(path_title)]
            path_date = re.search(r"__(\d{4}-\d{2}-\d{2})__", folder)
            if path_date:
                matches = [r for r in matches if r.get("发布日期") == path_date[1]]
        unique = {json.dumps(r, sort_keys=True, ensure_ascii=False): r for r in matches}
        row = next(iter(unique.values())) if len(unique) == 1 else {}
        if len(unique) > 1:
            audit["ambiguous_metadata"].append(relative)
        elif not row:
            audit["unmatched_metadata"].append(relative)
        if row:
            title = row["标题"]
        # No borrowing of a different version's dates or status.
        document_number = row.get("文号")
        if not document_number:
            candidate = re.search(r"__([^/]*?(?:〔\d{4}〕\d+号|令第[零〇一二三四五六七八九十百\d]+号))", stem)
            document_number = candidate[1] if candidate else None
        summary = summaries.get(relative)
        description = ""
        status = "complete"
        if summary:
            if summary[0] == source_hash:
                description = summary[1]
                if summary[2] not in (None, "complete"):
                    status = "partial"
            else:
                audit["summary_hash_mismatch"].append(relative)
        if len(text.strip()) < 150:
            status = "partial"
        # Same title and exact body is one source; versions with different bodies stay distinct.
        key = (norm(title), source_hash)
        document_id = seen.get(key) or "d-" + digest(norm(title) + ":" + source_hash)[:24]
        old = legacy_by_path.get(relative)
        if old and old["source_hash"] == source_hash:
            mappings[old["record_key"]] = {"document_id": document_id, "source_hash": source_hash}
        if key in seen:
            continue
        seen[key] = document_id
        pdfs = sorted(path.parent.parent.glob("*.pdf"))
        if not pdfs:
            pdfs = sorted(path.parent.glob("*.pdf"))
        region = row.get("省级行政区")
        if not region and category == "provincial":
            regions = sorted({r.get("省级行政区") for r in catalog if r.get("省级行政区")}, key=len, reverse=True)
            region = next((name for name in regions if name in title), None)
        date = row.get("发布日期")
        if date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            date = None
        documents.append({
            "id": document_id, "title": title, "document_number": document_number,
            "standard_number": next(iter(re.findall(r"(?:GB|HJ|DB\d+)[ /T]*\d+(?:\.\d+)?[-—]\d{4}", title)), None),
            "document_type": row.get("原文件类型"), "issuing_authority": row.get("发布机关"),
            "region": "全国" if category == "national" else region, "publish_date": date,
            "effective_date": None, "legal_status": row.get("效力状态"),
            "description": description, "full_text": text, "pdf_path": str(pdfs[0]) if pdfs else None,
            "markdown_path": str(path.resolve()), "source_hash": source_hash, "text_status": status,
        })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="\n") as stream:
        for doc in documents:
            stream.write(json.dumps(doc, ensure_ascii=False) + "\n")
    legacy_units = {r["unit_id"]: dict(r) for r in legacy.execute(
        "SELECT unit_id, record_key, line_start, line_end, text FROM content_units")
        if r["record_key"] in mappings}
    compatibility = {"legacy_build_id": manifest["build_id"], "documents": mappings, "units": legacy_units}
    args.output.with_suffix(".compat.json").write_text(json.dumps(compatibility, ensure_ascii=False), "utf-8")
    audit.update(documents=len(documents), national=sum(d["region"] == "全国" for d in documents),
                 descriptions=sum(bool(d["description"]) for d in documents), legacy_mappings=len(mappings))
    args.output.with_suffix(".audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({k: len(v) if isinstance(v, list) else v for k, v in audit.items()}, ensure_ascii=False))
    legacy.close()


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    main()
