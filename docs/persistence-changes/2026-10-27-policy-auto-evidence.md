---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-27-policy-auto-evidence

English | [中文](2026-10-27-policy-auto-evidence.zh.md)

## Summary

Records automatically retrieved policy evidence as an attributed user message.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-policy-auto-evidence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-20-policy-read-reminders"
    after: "3985283b3fe27f3aaacfd0e7bff686596f3aa99fd218d59824bc1273a52c55c8"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-20-policy-read-reminders"
    after: "9042f148c1b19e206835ed27c2870bf94191ea837cc6e34ef0c0173d513a022c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-20-policy-read-reminders"
    after: "8ea6c6bf30edfe9c3d4ca64a3f58e2fe327110793f8c20919e0a8f208a05d6e3"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-20-policy-read-reminders"
    after: "ecdfcb28b63b6b0a5e6d3c237e62a6f0a541e4680a4192b675ac6614f468d128"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing messages remain valid. The new policy-evidence source kind is an attribution-only addition; evidence text uses the existing durable user/message content.

<a id="verification"></a>
## Verification

Focused environment-policy Loader, retrieval and evidence tests: 34 tests passed; TypeScript and focused lint passed.

<a id="dev-note"></a>
## Dev Note

None.
