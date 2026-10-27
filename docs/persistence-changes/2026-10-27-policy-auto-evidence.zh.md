---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-policy-auto-evidence

[English](2026-10-27-policy-auto-evidence.md) | 中文

## 概述

将后端自动检索的法规证据作为带来源归属的用户消息记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有消息仍然有效。新增 policy-evidence 仅扩展来源归属；证据文本沿用现有 user/message 内容持久化。

<a id="verification"></a>
## 验证

环境政策 Loader、检索和证据针对性测试共34项通过；TypeScript与针对性代码检查通过。

<a id="dev-note"></a>
## 开发备注

无。
