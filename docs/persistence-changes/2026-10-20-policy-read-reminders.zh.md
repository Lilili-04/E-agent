---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-20-policy-read-reminders

[English](2026-10-20-policy-read-reminders.md) | 中文

## 概述

为要求读完政策原文分页的已记录提醒新增 policy-read-check 来源标签。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

标签仅用于来源标识。读取方保留未知标签及提醒正文；既有消息字段和 Session 写入版本不变。提醒不增加需要回放执行的操作。

<a id="verification"></a>
## 验证

七项新版检索测试通过；两次真实 DGX 模型问答验证查找及全文读取，其中核安全法连续读取两页。

<a id="dev-note"></a>
## 开发备注

无。
