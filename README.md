# National Environmental Policy Q&A System Built on DSH

English | [中文](README.zh.md)

This project is an environmental policy and regulation question-answering system built on the DeepSeek Harness (DSH) plugin architecture. It is designed for questions about national-level Chinese environmental laws, regulations, standards, plans, and policy documents.

The system retrieves evidence from a local SQLite index and uses the DSH agent to explain the answer in natural language. Retrieval and generation are separated: the model receives bounded source passages and citation metadata, while the index remains under local deployment control.

## What the system does

- Answers article-level questions such as “What does Article 1 of the Marine Environmental Protection Law provide?”
- Finds documents by topic, including national regulations related to marine protection, water pollution, waste, and urban drainage.
- Reports publication dates and the legal-status field recorded in the policy metadata.
- Uses the latest version when history is not requested, and returns revision history when the user asks for it.
- Uses exact title matching, metadata search, BM25 full-text retrieval, and bounded evidence selection.
- Returns the document name, publication information, article or section location, and quoted source evidence.

The current local index contains 494 national documents and 61,455 parsed content units. The index is a generated local artifact and is intentionally not uploaded to GitHub.

## Project layout

```text
packages/experimental/environment-policy/   Environment policy service, query planner, tools, and preset
data/README.md                              Local index preparation instructions
scripts/environment-policy-build-index.ts   SQLite index builder
data/policy-national-v1.sqlite              Local database, ignored by Git
.dsh-build/environment-policy-web.patch.yml Local launch overlay, ignored by Git
```

## Requirements

- Windows, macOS, or Linux
- Node.js 22.19 or newer
- pnpm 11 or newer
- A local `data/policy-national-v1.sqlite` index

The database is not part of the repository because it is a large generated artifact. Put an existing index at `data/policy-national-v1.sqlite`, or rebuild it from the local corpus described in [data/README.md](data/README.md).

## Run locally

From the repository root:

```powershell
pnpm install
pnpm run build
pnpm dsh web --patch .dsh-build/environment-policy-web.patch.yml --no-open
```

Open the URL printed by DSH, normally `http://127.0.0.1:3080`. The launch overlay mounts the environment-policy SQLite service and the `policy_search` tool into an environment-policy agent preset.

The preset uses the repository-relative database path `./data/policy-national-v1.sqlite`. Start DSH from the repository root so the path resolves correctly.

## Build or replace the local index

The default build command writes the database and manifest to `data/`:

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

Use `--inventory`, `--metadata`, `--descriptions`, `--output`, `--manifest`, and `--source-root` when the local corpus is stored elsewhere. The default recorded source-root label is `data/policy_md/national`, which keeps the generated manifest portable across machines.

## Verify the implementation

```powershell
node_modules/.bin/vitest.cmd run packages/experimental/environment-policy/tests/query.spec.ts packages/experimental/environment-policy/tests/database.spec.ts packages/experimental/environment-policy/tests/service.spec.ts
node_modules/.bin/tsc.cmd -p packages/experimental/environment-policy/tsconfig.json --noEmit
node_modules/.bin/tsc.cmd -p tsconfig.host.json --noEmit
```

## Current scope and limitations

- The initial corpus covers national-level documents. Provincial documents are not included yet.
- Legal-status answers use the status recorded in policy metadata. The system does not independently issue a legal opinion.
- The SQLite index must be supplied separately on a fresh clone.
- Use the original document to verify information before making a compliance or legal decision.

## Further documentation

- [Environment policy package guide](packages/experimental/environment-policy/README.md)
- [Environment policy Q&A implementation plan](.agents/notes/proposed/feature/2026-09-25-environment-policy-qa.md)

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
