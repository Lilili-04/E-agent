"""Merge an immutable national snapshot with uniquely catalog-matched local summaries."""
import argparse
from collections import Counter
from datetime import date, datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sqlite3

import openpyxl


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def normalize(text):
    return re.sub(r'[\s《》()（）“”\"\']', '', str(text or ''))


def clean(value):
    if value is None or str(value).strip() in {'', '26', 'nan', 'None'}:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def match_catalog(source_path, rows):
    """Require a unique row; a dated source never borrows another dated version."""
    path = PurePosixPath(source_path)
    folder = path.parent.parent.name if path.parent.name == 'extracted' else path.parent.name
    stem = re.sub(r'^[a-f0-9]{24}_', '', folder)
    candidates = [r for r in rows if PurePosixPath((r.get('正文文件路径') or '').replace('\\', '/')).stem == stem]
    if not candidates:
        candidates = [r for r in rows if normalize(r.get('标题')) == normalize(stem.split('__')[0])]
        source_date = re.search(r'__(\d{4}-\d{2}-\d{2})__', folder)
        if source_date:
            candidates = [r for r in candidates if r.get('发布日期') == source_date[1]]
    unique = {json.dumps(r, ensure_ascii=False, sort_keys=True): r for r in candidates}
    return list(unique.values())


def prepare(workspace, national_db):
    """Preserve national records and admit only validated, uniquely matched local files."""
    root = workspace.resolve()
    source_root = root / 'policy_md'
    conn = sqlite3.connect(national_db.resolve().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    try:
        if conn.execute('pragma user_version').fetchone()[0] != 2:
            raise ValueError('National base must use schema v2')
        if conn.execute('pragma integrity_check').fetchall()[0][0] != 'ok':
            raise ValueError('National base failed integrity_check')
        documents = [dict(r) for r in conn.execute('select * from documents order by id')]
    finally:
        conn.close()
    if not documents or any(r['region'] != '全国' for r in documents):
        raise ValueError('Base must contain national documents only')
    national_count = len(documents)
    workbook = openpyxl.load_workbook(root / '环保政策法规清单.xlsx', read_only=True, data_only=True)
    try:
        sheet = workbook['省级文件清单']
        it = iter(sheet.values)
        headers = next(it)
        rows = [{str(k): clean(v) for k, v in zip(headers, row) if k} for row in it]
    finally:
        workbook.close()
    records = json.loads((root / 'artifacts/provincial-extraction/descriptions-index.json').read_text('utf-8'))['records']
    decisions = []
    seen = {(normalize(r['title']), r['source_hash'], r['region']) for r in documents}
    ids = {r['id'] for r in documents}
    for item in records:
        relative = item['source_path']
        candidates = match_catalog(relative, rows)
        decision = {'source_path': relative, 'source_id': item['source_id'], 'matches': len(candidates)}
        if len(candidates) != 1:
            decisions.append({**decision, 'status': 'excluded', 'reason': 'unmatched_catalog' if not candidates else 'ambiguous_catalog'})
            continue
        row = candidates[0]
        region = row.get('省级行政区')
        if not region or region == '全国':
            decisions.append({**decision, 'status': 'excluded', 'reason': 'missing_province'})
            continue
        source = (source_root / relative).resolve()
        result_path = (root / item['result_path']).resolve()
        evidence_path = (root / item['evidence_path']).resolve()
        if not source.is_relative_to(source_root.resolve()) or not result_path.is_relative_to(root) or not evidence_path.is_relative_to(root):
            raise ValueError('Source or extraction result escapes workspace')
        text = source.read_bytes().decode('utf-8-sig')
        result_text = result_path.read_text('utf-8')
        evidence_text = evidence_path.read_text('utf-8')
        result = json.loads(result_text)
        meta = json.loads(result_path.with_suffix('.meta.json').read_text('utf-8'))
        evidence = json.loads(evidence_text)
        if (set(result) != {'title', 'description', 'main_text'} or result['main_text'] != text
                or not text.strip() or not result['description'].strip()
                or meta['status'] != 'complete' or meta['source_path'] != relative or evidence['source_path'] != relative
                or not digest(text) == item['source_hash'] == meta['source_hash'] == evidence['source_hash']
                or not evidence['citations']
                or meta['result_hash'] != digest(result_text) or meta['evidence_hash'] != digest(evidence_text)):
            raise ValueError(f'Extraction validation failed: {relative}')
        for citation in evidence['citations']:
            if text[citation['startOffset']:citation['endOffset']] != citation['quote']:
                raise ValueError(f'Citation no longer matches: {relative}')
        if 'critical_directory_content_mismatch' in item.get('quality_flags', []):
            decisions.append({**decision, 'status': 'excluded', 'reason': 'catalog_content_mismatch'})
            continue
        # The reviewed extraction title identifies the actual text; the catalog
        # supplies its matched province, dates, number and issuing authority.
        title = result['title']
        key = (normalize(title), digest(text), region)
        if key in seen:
            decisions.append({**decision, 'status': 'excluded', 'reason': 'duplicate_source'})
            continue
        identifier = 'd-' + digest(region + ':' + normalize(title) + ':' + digest(text))[:24]
        if identifier in ids:
            raise ValueError('Document ID collision')
        ids.add(identifier)
        seen.add(key)
        pdfs = sorted(source.parent.parent.glob('*.pdf')) or sorted(source.parent.glob('*.pdf'))
        documents.append({'id': identifier, 'title': title, 'document_number': row.get('文号'),
                          'standard_number': next(iter(re.findall(r'(?:GB|HJ|DB\d+)[ /T]*\d+(?:\.\d+)?[-—]\d{4}', title)), None),
                          'document_type': row.get('原文件类型'), 'issuing_authority': row.get('发布机关'),
                          'region': region, 'publish_date': row.get('发布日期') if re.fullmatch(r'\d{4}-\d{2}-\d{2}', row.get('发布日期') or '') else None,
                          'effective_date': None, 'legal_status': row.get('效力状态'),
                          'description': result['description'], 'full_text': text,
                          'pdf_path': str(pdfs[0]) if pdfs else None, 'markdown_path': str(source),
                          'source_hash': digest(text), 'text_status': 'partial' if len(text.strip()) < 150
                          or 'images_not_read' in item.get('quality_flags', [])
                          or re.search(r'截断|缺页|缺正文|串页|混入', item.get('review_note', '')) else 'complete'})
        decisions.append({**decision, 'status': 'included', 'document_id': identifier, 'region': region,
                          'quality_flags': item.get('quality_flags', []), 'review_note': item.get('review_note', '')})
    counts = Counter(d['reason'] if d['status'] == 'excluded' else 'included' for d in decisions)
    audit = {'schema_version': 2, 'national_base': str(national_db.resolve()),
             'national_base_sha256': hashlib.sha256(national_db.read_bytes()).hexdigest(),
             'national_documents': national_count, 'provincial_extractions': len(records),
             'provincial_included': counts['included'], 'exclusions': {k: v for k, v in counts.items() if k != 'included'},
             'documents': len(documents), 'regions': dict(Counter(d['region'] for d in documents)),
             'vectors_built': False, 'decisions': decisions}
    return documents, audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--national-db', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    audit_path = args.output.with_suffix('.audit.json')
    if args.output.exists() or audit_path.exists():
        raise ValueError('Choose fresh output paths; existing imports are never overwritten')
    documents, audit = prepare(args.workspace, args.national_db)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(''.join(json.dumps(d, ensure_ascii=False) + '\n' for d in documents), 'utf-8')
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    print(json.dumps({k: v for k, v in audit.items() if k != 'decisions'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
