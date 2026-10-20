---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-20-policy-read-reminders

English | [中文](2026-10-20-policy-read-reminders.zh.md)

## Summary

Adds the policy-read-check producer label for logged reminders to finish reading policy source pages.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-20-policy-read-reminders
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "bd1164af033812ef6ad09a8ef14cace1142dce148e7535347b96cc5f58ddb4ea"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "fdb62ebe3045b5f34f66297f56be893993dd4bb0a620f4688d117864eca788d4"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "59c4d950b5fa91664bf545ff3d09ed489198eae3cd1287ef6601b7567aea6e49"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "dd4b3dc419bf29216ab1556bcf0f658536da459199c711ca62aa5dfe3e079d22"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The label carries only attribution. Readers preserve unknown producer labels and reminder content; existing message payloads and the Session writer version remain unchanged. The guard adds no executable replay operation.

<a id="verification"></a>
## Verification

Seven focused environment-policy v2 tests passed. Two real DGX-model Harness runs exercised search and full reading, including the two-page Nuclear Safety Law.

<a id="dev-note"></a>
## Dev Note

None.
