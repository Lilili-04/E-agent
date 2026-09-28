# Local environment-policy index

`policy-national-v1.sqlite` is the generated national environment-policy index used by the local DSH preset. The database is intentionally ignored by Git because it is a large derived artifact and is not part of the source upload.

Place the database at:

```text
data/policy-national-v1.sqlite
```

Run DSH from the repository root so the preset's relative path resolves correctly. To rebuild it, provide the inventory, metadata, and description inputs to:

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

The build script writes the SQLite index and its manifest to this directory by default. The raw policy corpus and source files are also local inputs and are not required to be committed with the code.
