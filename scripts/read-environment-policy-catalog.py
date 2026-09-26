"""Read the policy catalog workbook into stable JSON without changing the workbook."""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

def values_for_sheet(z, target, shared):
    root = ET.fromstring(z.read(target))
    rows = []
    for row in root.findall('.//m:sheetData/m:row', NS):
        values = {}
        for cell in row.findall('m:c', NS):
            value = cell.find('m:v', NS)
            text = '' if value is None else (value.text or '')
            if cell.attrib.get('t') == 's' and text:
                text = shared[int(text)]
            values[cell.attrib.get('r', '')] = text
        rows.append(values)
    return rows

def main(path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            shared = [''.join(t.text or '' for t in item.findall('.//m:t', NS)) for item in root.findall('m:si', NS)]
        workbook = ET.fromstring(z.read('xl/workbook.xml'))
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        relation = {item.attrib['Id']: item.attrib['Target'] for item in rels}
        sheets = workbook.find('m:sheets', NS)
        if sheets is None:
            raise RuntimeError('workbook has no sheets')
        national = next((sheet for sheet in sheets if '国家' in sheet.attrib.get('name', '')), None)
        if national is None:
            national = next(iter(sheets), None)
        if national is None:
            raise RuntimeError('workbook has no usable sheet')
        rid = national.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']
        target = relation[rid]
        if not target.startswith('xl/'):
            target = 'xl/' + target
        rows = values_for_sheet(z, target, shared)
        if not rows:
            print('[]')
            return
        headers = {value: key.rstrip('0123456789') for key, value in rows[0].items() if value}
        mapping = {
            '标题': 'title', '原文件标题': 'originalTitle', '发布部门': 'issuingAuthority',
            '文号': 'documentNumber', '发布日期': 'publishDate', '效力状态': 'legalStatus',
            '主题领域': 'subjectArea', '原始文件路径': 'sourcePath', '官方页面URL': 'officialUrl',
            '版本关系': 'versionRelation', '备注': 'note',
        }
        result = []
        for row_number, row in enumerate(rows[1:], start=2):
            item = {}
            for header, field in mapping.items():
                column = headers.get(header)
                if column is not None:
                    value = row.get(column + str(row_number), '')
                    if value:
                        item[field] = value
            if item:
                result.append(item)
        print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main(sys.argv[1])
