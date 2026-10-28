---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-required-policy-search

English | [中文](2026-10-27-required-policy-search.zh.md)

## Summary

Add optional requiredTool to request configuration so a policy turn can require its first source search.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-required-policy-search
baseline: false
changes:
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "879fb662836055781a1c182f05b2bc74ce1c16cb4b4df13e7e3842d86ce7ece4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Older logs omit the optional field and keep automatic tool selection. New request headers retain the named tool requirement; unsupported adapters reject it. No prior session generation is rewritten.

<a id="verification"></a>
## Verification

TypeScript checks and the policy Loader composition tests validate request selection and version-ID rejection. The adapter test checks the OpenAI-compatible payload mapping.

<a id="dev-note"></a>
## Dev Note

None.
