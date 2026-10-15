# Source evidence pipeline evaluation

English | [中文](policy-retrieval-evaluation.zh.md)

Measurements on 2026-10-15 use the local read-only corpus of 494 documents and 61,455 units, Windows, and Node.js 24.14.0. The candidate pipeline and query planner run locally. Hybrid evaluation calls the existing DGX embedding and Chroma services through temporary local SSH relays; it installs no files or containers on DGX. The same SQLite snapshot and existing vector collections serve both implementations.

## Acceptance and results

| Check | Before | After |
| --- | --- | --- |
| Existing 90 expected-title/presence cases | 72/90 | 72/90 |
| Six practical questions, hybrid recall | 5/6 | 6/6 |
| Source text, title, date, document number and line-span integrity across 96 queries | 96/96 | 96/96 |
| Hybrid retrieval P95, observed locally | 2003 ms | 760 ms |

The six practical questions cover Nuclear Safety Law overview and article one, Water and Soil Conservation Law overview, pig-farm waste treatment, excessive wastewater discharge liability, and discharging manure water into rivers. The wastewater-liability case previously exhausted its semantic budget and missed the expected Water Pollution Prevention and Control Law; the optimized run retrieves it. These measurements exclude answer generation. Warm caches, networking and host load affect timings; P95 is an observation, not a DGX latency guarantee.

The original 90-case suite contains expected-title checks and absence checks, including plans or standards asked for an article they do not contain, title aliases, and unsupported or negative premises. The remaining 18 failures are retained. Returning a related document does not establish that it supports the question's premise. This suite is not a measure of answer accuracy or legal correctness.

## Alternating local timing comparison

The following lexical-only measurements use three repetitions, alternating old/new execution order, on the same machine and read-only file after index statistics are warmed. Values are medians. Source identity and citation integrity remain unchanged.

| Query | Before | After |
| --- | --- | --- |
| Nuclear Safety Law article one | 2.8 ms | 3.9 ms |
| Pig-farm waste treatment | 358 ms | 246 ms |
| Excessive wastewater discharge liability | 1669 ms | 469 ms |
| Discharging manure water into rivers | 500 ms | 297 ms |

BM25 now aggregates term matches and limits candidate addresses before loading body columns. Source hydration reads up to 100 distinct units per SQL batch and rejects missing units, source-hash mismatches and invalid Unicode offsets. Fault tests also cover one failed vector collection, forged Chroma text copies, repeated unit votes, incompatible embedding revisions, incomplete collections, and failed atomic release selection.

## Reproduce

Run from the repository root with a separately supplied corpus. The evaluator opens SQLite read-only and writes only the explicitly named report. `--implementation-root` accepts a saved source directory for a baseline comparison. `--hybrid-config` accepts a private JSON file with the existing HybridConfig endpoint and candidate settings; it does not create or update vector collections.

```bash
node --experimental-strip-types packages/experimental/environment-policy/eval/run.ts --database data/policy-national-v1.sqlite --output retrieval-report.json
pnpm exec vitest run packages/experimental/environment-policy/tests
python3 -m unittest discover -s packages/experimental/environment-policy/deploy -p 'test_*.py'
```

New versioned collection construction and atomic release selection are tested with local SQLite fixtures and simulated vector/embedding APIs. Existing production collections are queried read-only in legacy mode. Full-corpus index reconstruction, production release activation and DGX container deployment require a separate post-merge validation; this evaluation does not claim they ran on production. No generation-model answer quality was graded.
