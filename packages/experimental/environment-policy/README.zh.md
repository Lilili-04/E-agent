---
description: "构建并查询国家级及唯一匹配清单的地方环境政策法规证据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-environment-policy

[English](README.md) | 中文

## 概述

本包检索国家级及唯一匹配清单的地方环境政策法规证据。它盘点和解析 Markdown，校验有原文支持的摘要，构建 SQLite 索引，通过 `policy_search` 和 `policy_read` 返回原文证据。它不独立判断法律效力，也不把清单省份当作全省适用的证明。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Offline generation and review](#offline-generation-and-review)
- [Build and query the index](#build-and-query-the-index)
- [Startup environment](#startup-environment)
- [Evaluation baseline](#evaluation-baseline)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## 本地 v2 试用

同时挂载 `./v2-service` 和 `./v2-tools`。独立 SQLite 快照包含 `documents`、`content_units` 两张业务表和两套 FTS5 索引。正文与问题统一使用 Jieba 分词，由原生 BM25 排序标题/description 或正文命中。`policy_search` 查找文件版本或片段，`policy_read` 连续读取指定版本。DGX 现有服务与本地试用独立。

在仓库根目录执行 `python scripts/prepare-policy-v2.py --workspace .. --legacy data/policy-national-v1.sqlite --output .dsh-build/policy-v2-documents.jsonl --corpus national` 准备国家级语料，再执行 `node --import tsx/esm scripts/build-policy-v2.ts .dsh-build/policy-v2-documents.jsonl data/policy-v2-trial.sqlite` 建库。输出必须使用新文件名，脚本拒绝覆盖旧库。Python 需要 `openpyxl`。Markdown、description 和清单工作簿仍不进入 Git。导入文件旁生成审核报告及旧向量映射 JSON；与原文哈希不符的摘要、占位元数据不入库。

提供者设置包括 `path`、可选的 `semanticConfigPath`，以及二选一的 `compatibilityPath`（旧向量）或 `vectorManifestPath`（合并向量）；数量和输出限制为 `candidateLimit`、`guidedCandidates`、`maxEvidencePerDocument`、`resultLimit`、`pageCharacters`、`evidenceCharacters`。语义 JSON 配置 Embedding/Chroma 地址、模型、集合和超时。旧向量需要匹配构建、来源哈希及原文范围；失败会明确报告，BM25 仍可用。搜索不会写入集合，旧模式覆盖范围取决于已有国家级向量快照。

合并库运行方式见[本地 Harness 指南](../../../deploy/local-vectors/README.zh.md#harness)。启动时校验构建清单与 SQLite 文件哈希、模型、维度、距离度量和集合名称。检索对完整原问题生成一次向量，传输失败允许有限重试；向量召回前按地域及可选文件范围过滤。BM25 与向量通道各自按地域保留候选预算；RRF 合并通过来源校验的结果，平衡地域、限制单文件证据数量，并合并同章节相邻单元。`unit_ids` 保留合并证据的原始成员。精确条款和全文读取仍直接使用 SQLite。部分向量通道失败会返回警告，保留可用的 BM25 证据。

可选 `latestManifestPath` 指向由 `scripts/build-policy-latest.py` 生成、绑定 SQLite 哈希的离线允许清单。本地启动器要求 `deploy/local/policy-latest.json`。普通请求在排序前将精确匹配、BM25、组合向量及文档引导候选限制为各法规的库内最新正文；这不代表现行有效。法规身份来自已审核图谱导出，版本顺序依据日期及同一身份的整版修订关系。日期并列、顺序不明或排序矛盾的身份排除并待核实；最新正文缺失不退回旧版。明确命中的不可用身份返回 `latest_version_unavailable` 和原因。明确年份、文号、历史或效力意图进入图谱路径；仅书名中的相关字样不触发沿革查询。普通读取保留离线资料完整性标记。

可选 `graphConfigPath` 在 `./v2-service` 内支持历史版本、沿革和效力问题，不增加工具或监听端口。图谱按需加载：首次历史请求检查冻结图谱/SQLite 哈希，向已有本地 Neo4j 核对身份、来源定位和事件；后续历史操作复用已验证快照，直到重新加载提供者。图谱不可达或不一致时，历史操作明确报错。普通搜索及不带 `version_id` 的读取不会加载或调用图谱。本地启动器保留全部分区。

历史请求的图谱身份解析先于标题缺失和精确条款分支。检索返回有上限的 `graph` 版本卡片和一跳沿革；普通正文检索继续使用 BM25/Chroma。`selected_version_ids` 区分本次匹配版本和相关端点；`truncated` 表示清单不完整。事件区分发出版本和保存证据的来源；未确定目标版本时保留 `target_version_id=null`。没有废止事件不代表现行有效，未知日期和审核标记保持原值。沿革结论须先读取 `events.sources`；未收入 SQLite 的补充来源不提供读取定位。

使用图谱 `read_sources` 时，向 `policy_read` 同时传入实际正文 `document_id` 和 `version_id`，分页时保持两者不变。`text_role=body` 读取该版本已有正文；`attachment` 限制在核验过的附件范围；`history_evidence` 只返回留存的沿革依据，并拒绝对缺失历史正文请求条款或章节。后两者标记 `source_complete=false`。游标绑定来源哈希、图谱版本和范围，不会以新版正文替代缺失旧版。图谱输出单独限制字符预算，增加上下文 token，但不增加模型或 Embedding 轮次。

离线合库先执行 `python scripts/prepare-policy-combined.py --workspace .. --national-db data/policy-v2-national-presentation-r2.sqlite --output .dsh-build/policy-combined.jsonl`，再按上面的建库命令将该 JSONL 和新 SQLite 路径传入 `scripts/build-policy-v2.ts`。需要 Python 3.10+ 和 `openpyxl`。需在指定路径准备国家级修复版快照，记录逐字段继承，包括 ID 和已修正元数据。地方抽取结果只有唯一匹配清单行才准入，未匹配、歧义和已知正文错配直接排除。导入审计记录排除项、正文质量备注、省份数量及基线哈希。不构建向量；离线仅用 BM25 时省略两项语义配置，诊断明确返回 `semantic_not_configured`。原国家级向量不代表地方资料已有语义覆盖。

`region` 是清单中的省份归属，不是法律适用范围认定。未指定地区的问题只检索全国依据，显式传入或在问题中点明省份时联合检索全国及该省资料；`region_mode=only` 只检索所选省份，“江苏”等简称归一化到库中名称。不从命中文件推断省份；明确文件超出地域范围时拒绝请求。比较地区时分别检索，市县、流域、试点等限制仍须核对正文。读取及全文分页继续绑定确定的文件 ID。

`policy_read` 接收 `document_id`、`scope`（`full`、`section`、`article`）、章节/条款的精确 `selector` 和可选 `cursor`。须用 `next_cursor` 继续读到 `has_more=false`。超长单元跨页时标记 `unit_fragments=true`；条款不存在时返回 `found=false`。`source_complete` 描述导入的原文完整性，不代表法律效力。搜索片段标记 `excerpted` 时须继续读取。每个 Agent 的每轮对话独立跟踪所有待完成的全文读取，包括同时指定的多部法规和候选版本，提醒达到配置上限后以错误停止；该检查不能验证模型的理解，超过上下文窗口的长文件仍依赖压缩。

工具插件要求作答前先调用 `policy_search`；只有元数据或全文尚未读完时，继续要求 `policy_read`。受约束的模型响应先缓冲，确认完成指定工具调用后才放行工具内容，不展示其中的正文或推理块；忽略工具要求的响应在答案展示前报错。搜索为空且无可读来源时，返回明确的证据缺口说明。普通读取只接受本轮搜索返回的文档 ID；图谱读取还须匹配返回的文档与版本配对。同时指定多部法规时，不因名称长度不同而丢弃较短名称。这些检查确认依据是否可用，不验证模型对依据的理解是否正确。

本地 Harness、政策数据全部留在 DGX 时，挂载 `./v2-remote-service`，配置 `endpoint`、`tokenFile` 和可选 `timeoutMs`/`maxResponseBytes`，继续使用同一套 `./v2-tools`。客户端不打开 SQLite，也不回退本地库。DGX 的 `./v2-http` 注入本地 v2 服务，提供鉴权的 `GET /v2/policy/status`、`POST /v2/policy/search` 和 `POST /v2/policy/read`；search/read 请求体使用工具参数字段。两端均需私有 token 文件，至少 32 字符。监听默认 loopback 18081、请求上限 32 KiB、期限 15 秒。无效请求返回 400，缺少凭据 401，正文过大 413；客户端支持取消与响应大小限制。部署与本地启动配置见 [DGX 指南](../../../docs/user/guide/dgx-deployment.zh.md)。

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

可选参数 `--source-root` 默认记录仓库相对路径 `data/policy_md/national`；从其他语料位置重建时，可以显式传入一个可移植的资料根目录标识。

默认情况下，数据库和构建清单分别写入相对于仓库根目录的 `data/policy-national-v1.sqlite` 和 `data/policy-national-v1-manifest.json`。`data/` 下的 SQLite 文件属于本地生成的语料产物，已加入 Git 忽略；仓库保留 `data/README.md`，用于说明如何准备索引。全量重建使用单个事务。每次成功提交的清单都会记录 schema 版本、构建 ID、语料哈希、来源数量、内容单元数量和 description 数量。

使用数据库路径挂载 `SqliteEnvironmentPolicyKnowledge`，再在仓库的工具服务和系统提示词服务之后挂载 `./tools` 导出。查询服务会保留索引身份和原文位置，供内部核查使用。`policy_search` 接收自然语言问题和可选的 ISO `current_date`；面向模型的输出只包含有限原文和引用元数据，不包含内部路径或标识符。description 可以帮助发现文档，但最终证据始终来自解析后的原文单元。

[`presets/environment-policy.cordis.yml`](presets/environment-policy.cordis.yml) 是可插入 Agent preset 的可选组合，默认使用仓库相对路径 `./data/policy-national-v1.sqlite`。请从仓库根目录启动 DSH；如果从其他目录启动，请显式传入数据库路径。该组合隔离知识服务，不会修改标准 preset。

远程模式挂载 `./remote-service`，通过 HTTP 调用同一套检索实现。服务启动时读取远程数据库的真实构建清单，支持请求取消和超时；远程不可用时直接返回错误，不自动切换本地库。参见 [DGX Docker 部署说明](deploy/README.zh.md)。

<a id="startup-environment"></a>
### Startup environment

启动 DSH 时，建议在同一个交互式终端中完成依赖安装、构建和启动。Codex 的命令执行使用独立的非交互 shell、托管 Node 运行时和 fallback pnpm；如果 `node_modules/.modules.yaml` 不存在，pnpm 会重新检查整个 workspace 并尝试安装依赖，启动时间可能明显增加。首次使用或依赖目录不完整时，先运行 `pnpm install --frozen-lockfile`，确认依赖链接完成，再按需使用 `pnpm run dev:web --skip-build --poll` 或 `pnpm run start:desktop -- --skip-build`。

<a id="evaluation-baseline"></a>
## Evaluation baseline

[`eval/cases.ts`](eval/cases.ts) 包含 90 个确定性检索问题，覆盖条款定位、主题发现、发布日期、目录效力状态、版本历史、无答案、否定词和 OCR 敏感场景。每个案例记录便于人工检查的期望文档标题，以及是否应返回权威证据。包测试固定案例数量、唯一标识和分类覆盖。DGX 已提供可选向量召回；这套基线仍需由人工核对期望内容单元 ID，标题命中不能代替条款准确性评测。

<a id="offline-generation-and-review"></a>
## Offline generation and review

description 的格式、引用、哈希和审核状态校验保持确定性，生成由调用方提供的适配器完成。调用方可以使用本地规则、人工填写的样本，或子 agent 作为适配器。在所有情况下，权威 Markdown 都保留在构建环境中，生成的 description 只用于检索辅助，不能替代原文、目录元数据或法律效力审核。

<a id="understand-the-implementation"></a>
## Understand the implementation

该库递归发现名为 `full.md` 的文件，计算字节哈希，提取候选标题，检查同目录 PDF，并记录质量标记。确定性的行规则保留标题、法规章节、条款、段落、列表、表格、附件、图片和代码块的原文位置。SQLite 保存来源、元数据、内容单元、description、引用、检索词和一份已提交的构建清单。查询层用库内标题确认文件名称；名称、文号和条款定位走精确查询，概述从完整文档均匀选取正文。普通问题使用正文 BM25；DGX 的混合适配器并行执行文档与正文分段向量召回，按名次融合后限长、去重和评估时间状态。向量候选必须回读 SQLite 原文，并校验构建标识及源文件哈希。

不发布运行时不变量伴随模块；SQLite 清单标识已提交的构建，混合检索在返回证据前会对照 SQLite 检查向量集合的构建标识和源文件哈希。

<a id="further-exploration"></a>
## Further Exploration

- [环境政策法规知识问答方案](../../../.agents/notes/proposed/feature/2026-09-25-environment-policy-qa.zh.md) — 分阶段能力设计。
- [Packages](../../README.zh.md) — 包边界和 workspace 约定。

<a id="model-experience"></a>
## Model Experience

### 政策检索工具

#### 模型看到什么

可选的 `./tools` 插件会注册 `policy_search` 和对应提示词段。对于法规清单问题，模型可以从原问题中提取 `topic`；工具据此召回标题，同时保留原问题用于条件判断和正文 BM25。混合模式还使用文档与正文分段向量召回；独立 SQLite 模式使用 description 词法辅助召回。原问题中没有的主题会被忽略；模型未提供主题时仍使用原有检索。除非问题明确询问历史或版本比较，工具会按规范化文档标题只保留发布日期最新的版本。同一法规可保留多条正文证据，并共用一个引用编号。面向模型的结果从一开始重新编号引用，移除路径和工作流字段，并要求模型在回答末尾生成纯文本编号来源。提示词要求条款问题先用通俗中文解释，询问效力时直接采用目录效力状态，区分发布日期和生效日期，并且不生成来源超链接。

#### Token 影响

可选组合的每次请求都包含固定提示词段和工具 schema。可选的 `topic` 由现有的工具选择模型请求生成，不增加一次模型调用。每次工具调用最多增加 `maxEvidenceCharacters` 个字符的有限证据，以及 `maxResults` 条记录。

#### KV Cache 影响

同一插件配置下的提示词段和工具 schema 保持稳定，因此可以留在可复用请求前缀中。检索结果和最终回答追加在此前缀之后；调整任一输出上限只改变配置，不改变固定的模型可见文本。

### Policy V2 自动整理证据

#### 模型看到什么

本地合并组合通过 `planningProvider` 和 `planningModel` 启用模型规划。回答前，辅助模型调用理解已接收的问题、拆分子问题，并选择具体知识、文件发现、整份文件概括、沿革或效力检索。后端校验JSON、保留原问题的地域限制、在已有库中确认候选名称；模型提示的名称没有适用原文时，按子问题发现实际来源，用户明确指定的文件仍是硬限制。另一次模型调用逐项审核实际原文，后端拒绝不存在的来源编号、过滤作为当前依据的失效文件和草案、核对任务覆盖并执行有上限的补检。同一原文页可供多个子问题复用。历史废止日期未核实的任务只能保留部分覆盖，沿革记载不能标成当年完整正文。辅助调用的精确输入和结束输出分别在派发前后记录为 `policy/retrieval-model`，最终核对后的资料仍以正常持久化的 `policy-evidence` 消息交给回答模型。回答直接给结果，保留缺口和冲突，隐藏内部工作术语并列出实际来源。未配置规划路由的组合保留此前自动检索读取路径。

#### Token 影响

规划增加一次辅助模型调用，随后进行覆盖审核，并可在上限内补检或修正输出。本地组合最多6个子问题、10次搜索、2轮覆盖审核；辅助调用输出上限2048 token、单次期限45秒，原文读取预算24页、8份文件。达到预算时保留未覆盖状态。`evidenceCharacters` 限制包含元数据和图谱上下文的完整序列化证据包；`evidencePages`、`evidenceDocuments` 和 `retrievalTimeoutMs` 限制整理过程。截断不能证明源文件完整。已有 SQLite、关键词索引、Chroma 集合和 Neo4j 数据均保持只读。

#### KV Cache 影响

简短的固定指导保留在稳定提示词前缀中。每批新接收的用户输入追加本次证据，模型看到的证据可以从会话日志重建，不隐藏在请求回调内。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- 元数据抽取只是第一版候选生成器，不确定法律效力、现行状态、废止关系或版本身份。清单中的效力状态会被保留，不会被 Markdown 中的猜测静默替换。
- description 只是可审核的检索辅助信息，不能替代权威 Markdown、元数据字段或后续检索工具返回的证据。源文件哈希变化后，已有 description 会标记为 `stale`。
- PDF 匹配目前只检查包含 `full.md` 的 `extracted` 目录；没有同目录 PDF 的来源会被标记。
- 查询服务为内部调用者保留保守的时效评估字段；面向模型的工具不返回这些工作流字段，并在用户询问时使用目录中的效力状态。
- SQLite 检索和 description 校验不要求外部 API。description 生成由调用方提供的适配器完成，包括通过子 agent 生成；所有结果都必须经过引用、哈希、格式和状态校验。
- SQLite 保存政策原文和元数据，关键词索引与 Chroma 向量辅助召回。各通道返回标识，服务批量读取并校验正文单元后再形成引用。可选的 DGX 混合检索在向量失败时保留词法证据；原文/索引版本校验、诊断及回滚见[部署指南](deploy/README.zh.md)。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers</summary>

None.

</details>
