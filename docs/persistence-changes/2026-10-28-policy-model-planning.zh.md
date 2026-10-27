---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-28-policy-model-planning

[English](2026-10-28-policy-model-planning.md) | 中文

## 概述

记录法规检索规划与覆盖审核模型调用的精确输入输出。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-policy-model-planning
baseline: false
changes:
  - root: "event:policy/retrieval-model"
    previous: null
    after: "cfdf39d384fb28493bf3d969dc73db19e1af9ec39eaa605327790fca33d474b5"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新增仅用于日志的事件，在派发前记录输入、结束后记录输出，不改变已有事件字段或回答历史。不认识该事件的旧读取器拒绝新日志，不静默丢弃审计记录。

<a id="verification"></a>
## 验证

环境政策Loader、模型规划和检索针对性测试44项通过；TypeScript和针对性lint通过，真实20题回归另行记录。

<a id="dev-note"></a>
## 开发备注

无。
