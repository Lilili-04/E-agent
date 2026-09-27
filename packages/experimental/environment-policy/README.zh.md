---
description: "构建并查询本地国家级环境政策法规证据索引。"
kind: "package-plugin"
---

# @deepseek-ai/dsh-experimental-environment-policy

[English](README.md) | 中文

## Summary

本包提供实验性的国家级环境政策法规知识能力。它盘点和解析 Markdown 来源，抽取可审核元数据，校验模型辅助生成的 description，构建带版本标识的 SQLite 索引，规划法规查询，并通过 Cordis 服务和 `policy_search` 工具返回有大小限制的原文证据。它暂不处理省级文档，也不独立判断法律效力。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Offline generation and review](#offline-generation-and-review)
- [Build and query the index](#build-and-query-the-index)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

第一阶段将本包作为内部库使用。调用方提供资料目录；本包不内置项目政策语料，也不假设相对于仓库的固定路径。

```ts
import { buildSourceInventory } from '@deepseek-ai/dsh-experimental-environment-policy'

const inventory = await buildSourceInventory({ sourceRoot: process.env.POLICY_SOURCE_ROOT! })
```

输入文件不变时，返回的清单具有确定性。每条记录包含基于内容的稳定 ID、规范化路径、SHA-256 哈希、Markdown 候选标题和质量标记。重复内容单独报告，后续版本和来源审核可以据此区分重复来源。

完成清单后可以解析单个来源：

```ts
import { parsePolicyMarkdown } from '@deepseek-ai/dsh-experimental-environment-policy'

const parsed = parsePolicyMarkdown(sourceId, markdown)
```

每个内容单元都保留原文、从 1 开始的行号范围、章节路径、内容哈希和确定性的单元 ID。解析质量标记用于记录缺少标题、没有条款标记、只有附件、内容为空和结构不明确的来源。

使用带证据的第一版元数据抽取：

```ts
import { extractPolicyMetadata } from '@deepseek-ai/dsh-experimental-environment-policy'

const metadata = extractPolicyMetadata(sourceId, markdown, parsed)
```

返回值是待审核的候选值。每个日期和标识符都带有原文行号；当规则发现歧义或缺少信息时，`metadataStatus` 会是 `"pending-review"`。`环保政策法规清单.xlsx` 作为目录元数据来源，为 `publishDate`、`legalStatus`、主题领域、原始路径、官方 URL 和版本关系提供值；Markdown 仍负责提供正文中明确的生效或废止表述证据。

准备并校验 description 请求，不选择具体模型供应商：

```ts
import { generatePolicyDescription, prepareDescriptionRequest } from '@deepseek-ai/dsh-experimental-environment-policy'

const request = prepareDescriptionRequest(sourceId, markdown, metadata)
const saved = await generatePolicyDescription(model, request, markdown, new Date().toISOString())
```

模型适配器接收有大小上限且带行号的证据，并且只能返回 description 和来源引用。持久化前会校验引用范围、引文原文、description 长度、源文件哈希、提示词版本、模型标识和审核状态。本包不会自行调用模型或读取凭据。

模型适配器是可选的。Step5 可以完全离线地准备请求，并校验人工填写的 description。如果需要生成样本 description，可以让子 agent 作为注入的适配器，返回相同的 JSON 格式；不要求外部模型 API、密钥或具体供应商接入。子 agent 返回的内容在通过本地校验前仍视为不可信输入。

可审核的样本格式如下：

```json
{
  "description": "本文件规定污染防治工作的适用范围和主要管理要求。",
  "citations": [
    { "lineStart": 12, "lineEnd": 14, "quote": "本办法适用于……" }
  ]
}
```

`generatePolicyDescription` 会检查每条引用是否确实存在于原文对应行，并且属于传给适配器的有限证据范围。同时保存源文件 SHA-256、提示词版本、适配器模型标识和生成时间。审核者可以将结果从 `generated` 改为 `reviewed` 或 `rejected`；源文件哈希变化后，结果会变成 `stale`，在重新生成前不能审核。

<a id="build-and-query-the-index"></a>
## Build and query the index

Step6 构建脚本会把清单、元数据、description 和解析后的原文单元合并为一个派生 SQLite 索引：

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

数据库和构建清单是生成在 Git 仓库外的语料产物。全量重建使用单个事务。每次成功提交的清单都会记录 schema 版本、构建 ID、语料哈希、来源数量、内容单元数量和 description 数量。

使用数据库路径挂载 `SqliteEnvironmentPolicyKnowledge`，再在仓库的工具服务和系统提示词服务之后挂载 `./tools` 导出。`policy_search` 接收自然语言问题和可选的 ISO `current_date`，返回本次查询使用的索引身份，以及带来源相对路径和行号的有限原文证据。description 可以帮助发现文档，但最终证据始终来自解析后的原文单元。

[`presets/environment-policy.cordis.yml`](presets/environment-policy.cordis.yml) 是可插入 Agent preset 的可选组合。使用时把数据库路径改为生成的索引位置。该组合隔离知识服务，不会修改标准 preset。

<a id="offline-generation-and-review"></a>
## Offline generation and review

本包本身保持确定性，并且不绑定模型。调用方可以使用本地规则、人工填写的样本，或子 agent 作为适配器。在所有情况下，权威 Markdown 都保留在本地，生成的 description 只用于检索辅助，不能替代原文、目录元数据或法律效力审核。

<a id="understand-the-implementation"></a>
## Understand the implementation

该库递归发现名为 `full.md` 的文件，计算字节哈希，提取候选标题，检查同目录 PDF，并记录质量标记。确定性的行规则保留标题、法规章节、条款、段落、列表、表格、附件、图片和代码块的原文位置。SQLite 保存来源、元数据、内容单元、description、引用、检索词和一份已提交的构建清单。查询层先应用精确元数据条件，再执行可移植的词法召回和 description 辅助召回，最后做确定性排序、证据限长和保守的时间状态判断。

<a id="further-exploration"></a>
## Further Exploration

- [环境政策法规知识问答方案](../../../.agents/notes/proposed/feature/2026-09-25-environment-policy-qa.zh.md) — 分阶段能力设计。
- [Packages](../../README.zh.md) — 包边界和 workspace 约定。

<a id="model-experience"></a>
## Model Experience

可选的 `./tools` 插件会注册 `policy_search` 和对应提示词段。检索在现有内容词项索引上使用 BM25 排序，同时保留元数据精确检索和 description 辅助发现。提示词要求模型使用文档标题、可选文号及条款、章节或行号作为可见引用标签，来源路径只作为链接目标或定位信息；对于“有哪些文件”的问题按不同文档标题归并，并说明清单仅限本地语料。提示词还要求模型直接回答问题且不暴露检索字段，区分发布日期与生效日期，只在时效不确定性影响问题时说明，并报告语料缺口或证据截断。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- 元数据抽取只是第一版候选生成器，不确定法律效力、现行状态、废止关系或版本身份。清单中的效力状态会被保留，不会被 Markdown 中的猜测静默替换。
- description 只是可审核的检索辅助信息，不能替代权威 Markdown、元数据字段或后续检索工具返回的证据。源文件哈希变化后，已有 description 会标记为 `stale`。
- PDF 匹配目前只检查包含 `full.md` 的 `extracted` 目录；没有同目录 PDF 的来源会被标记。
- 它不确定法律状态、生效日期或跨版本条款身份。即使目录标注文件有效，未经审核的时间元数据仍返回 `unconfirmed`。
- 它不选择模型供应商，也不要求外部 API。调用方注入的适配器可以生成 description，包括通过子 agent 生成，但所有结果都必须经过本地引用、哈希、格式和状态校验。
- 当前检索使用精确元数据条件、中文双字词、拉丁文字词项和 description 辅助召回，不要求向量数据库。后续只有在评测证明存在召回缺口时，才需要在查询存储接口后增加语义向量能力。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
