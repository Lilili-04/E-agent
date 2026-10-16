# Environment-policy indexing inputs

English | [中文](README.zh.md)

`policy-national-v1.sqlite` is the generated national policy source database. Deployment arrangements A and B both use DGX databases; this directory prepares build artifacts rather than providing a third Harness deployment. The large database is ignored by Git and excluded from source uploads.

The index builder defaults to:

```text
data/policy-national-v1.sqlite
```

Prepare source Markdown, inventories, metadata, descriptions, and other inputs, then run from the repository root:

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

The script writes SQLite and its manifest here by default. Exclude raw inputs and generated files from Git. Follow the [retrieval deployment guide](../packages/experimental/environment-policy/deploy/README.md) to validate and release the snapshot with matching vector indexes on DGX; update the snapshot selected by the [viewer configuration](../deploy/db-viewers/README.md) when changing databases.
