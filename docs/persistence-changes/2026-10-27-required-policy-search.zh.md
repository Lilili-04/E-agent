---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-required-policy-search

[English](2026-10-27-required-policy-search.md) | 中文

## 概述

请求配置新增可选requiredTool，使政策问答能要求首轮检索原文。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

旧日志不含此可选字段，继续自动选择工具。新请求头保存指定工具要求；不支持的适配器拒绝执行。不改写旧会话数据。

<a id="verification"></a>
## 验证

TypeScript检查及政策工具Loader组合测试验证请求选择和版本ID拦截；适配器测试核对OpenAI兼容请求映射。

<a id="dev-note"></a>
## 开发备注

无。
