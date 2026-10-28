"""Build a read-only retrieval allowlist from reviewed version identities; never write source stores."""
import argparse
import collections
import hashlib
import json
import re
import sqlite3
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def interval(version):
    dates = [version.get(k) for k in ('revision_date', 'publish_date', 'adoption_date')]
    dates = [d for d in dates if d and re.fullmatch(r'\d{4}-\d{2}-\d{2}', d)]
    labels = ' '.join([version.get('version_label', ''), version['title']])
    explicit = re.findall(r'((?:19|20)\d{2}-\d{2}-\d{2})[年]?版', labels)
    if dates or explicit:
        date = max(dates + explicit)
        return date, date
    years = re.findall(r'((?:19|20)\d{2})年?版', labels)
    return (max(years) + '-01-01', max(years) + '-12-31') if years else None


def build(graph, documents):
    owners = {r['to']: r['from'] for r in graph['relations'] if r['type'] == 'HAS_VERSION'}
    groups = collections.defaultdict(list)
    for v in graph['versions']:
        groups[owners[v['id']]].append(v)
    entries = []
    for reg in graph['regulations']:
        versions = groups[reg['id']]
        # Only whole-version revision establishes ordering; an AMENDS issuer can be another law.
        successors = collections.defaultdict(set)
        for edge in graph['relations']:
            if edge['type'] == 'REVISES' and owners.get(edge['from']) == reg['id'] == owners.get(edge['to']):
                successors[edge['from']].add(edge['to'])
        def newer(a, b):
            pending, seen = list(successors[a['id']]), set()
            while pending:
                item = pending.pop()
                if item in seen:
                    continue
                seen.add(item)
                pending.extend(successors[item] - seen)
            left, right = interval(a), interval(b)
            dated = bool(left and right and left[0] > right[1])
            conflict = bool(left and right and left[1] < right[0])
            return dated or b['id'] in seen and not conflict
        by_id = {v['id']: v for v in versions}
        conflict = any(interval(by_id[src]) and interval(by_id[dst]) and
                       interval(by_id[src])[1] < interval(by_id[dst])[0]
                       for src, targets in list(successors.items()) for dst in targets)
        winners = [] if conflict else [v for v in versions if all(v is other or newer(v, other) for other in versions)]
        chosen = winners[0] if len(winners) == 1 else None
        entries.append(dict(regulation_id=reg['id'], title=reg['title'], aliases=reg['aliases'], region=reg['region'],
                            version_id=chosen['id'] if chosen else None,
                            document_ids=chosen['document_ids'] if chosen else [],
                            all_document_ids=sorted({d for v in versions for d in v['document_ids']}),
                            source_text_status=chosen['source_text_status'] if chosen else 'unresolved',
                            status='ready' if chosen and chosen['document_ids'] else 'missing_body' if chosen else 'unresolved',
                            reason='date_relation_conflict' if conflict else 'order_unknown_or_tied' if not chosen else
                                   'latest_body_missing' if not chosen['document_ids'] else 'single_version' if len(versions) == 1 else 'ordered_versions',
                            candidates=[dict(id=v['id'], date_interval=interval(v), document_ids=v['document_ids']) for v in versions]))
    covered = {d for e in entries for d in e['all_document_ids']}
    # Unmapped bodies have no verified identity and cannot bypass latest-version filtering.
    return dict(entries=entries, unmapped_document_ids=sorted(set(documents) - covered))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--graph-config', required=True)
    parser.add_argument('--database', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.graph_config).read_text(encoding='utf-8-sig'))
    if digest(config['snapshot']) != config['snapshotSha256'] or digest(args.database) != config['databaseSha256']:
        raise ValueError('Graph/SQLite snapshot hash mismatch')
    graph = json.loads(Path(config['snapshot']).read_text(encoding='utf-8'))
    with sqlite3.connect(Path(args.database).resolve().as_uri() + '?mode=ro', uri=True) as db:
        documents = [r[0] for r in db.execute('select id from documents')]
    result = dict(format=1, database_sha256=config['databaseSha256'], graph_sha256=config['snapshotSha256'], **build(graph, documents))
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(statuses=dict(collections.Counter(e['status'] for e in result['entries'])),
                         allowed_documents=len({d for e in result['entries'] for d in e['document_ids']}),
                         unmapped_documents=len(result['unmapped_document_ids']))))
