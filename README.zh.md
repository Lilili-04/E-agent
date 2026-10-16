# E-agent：环境政策法规问答系统

[English](README.en.md) | 中文

E-agent 基于 DeepSeek Harness（DSH），面向国家级中文环境法律、法规、标准、规划和政策文件提供 RAG（检索增强生成）问答。系统先检索政策原文，再由模型组织回答并列出来源。

普通使用者可以直接访问 DGX 网页；开发者也可以在本地运行 Harness，连接 DGX 的检索和模型服务。应用、检索服务、向量数据库和模型分别维护，Harness 镜像不包含语料、数据库或模型权重。

## 阅读导航

- [项目能力与范围](#scope)
- [架构与问答链路](#architecture)
- [多路召回：三类、四路](#retrieval)
- [选择使用与部署方式](#deployment)
- [启动、重启与更新](#startup)
- [协作开发与数据准备](#collaboration)
- [验证与常见问题](#verification)
- [代码与文档入口](#documentation)
- [许可证](#license)

<a id="scope"></a>

## 项目能力与范围

系统支持按法规名称、文号和条号定位正文，按主题寻找相关政策，以及根据库内资料回答条款、概述、发布日期、效力状态和版本问题。

当前 SQLite 索引包含 **494 份国家级文件、61,455 个正文内容单元**，数据库约 **835 MiB**。内容单元可以是一条条款、一段正文、列表或标题，不等于一整份文件。语料尚未覆盖省级文件。

回答受语料覆盖、解析质量、元数据和模型归纳能力限制。效力状态来自目录记录，系统不独立认定法律效力；部分文号、日期元数据仍有异常。返回证据、标题命中或功能测试通过，均不能直接视为回答准确率保证。

<a id="architecture"></a>

## 架构与问答链路

架构按“原文数据层＋多种检索索引＋统一检索服务”组织。SQLite 是政策内容主库，Chroma 是可重建的语义索引；检索 API 是数据库上面的服务。逻辑职责与容器数量分别理解。

这里的“检索 API”通常指 DGX 上运行的政策检索后端程序；严格来说，API 是该程序对外提供的 HTTP 接口。`policy_search` 将问题发送到 `POST /v1/policy/search`，后端执行规则解析和数据库检索，返回原文证据及检索信息，不直接生成最终回答。

| 组件 | 职责 | 部署与数据 |
| --- | --- | --- |
| Harness | 提供网页、会话、agent（智能体）和工具执行 | 可在本地或 DGX 容器运行，独立保存状态和工作区 |
| `policy_search` | 模型调用的政策查询工具 | 在 Harness 中执行，通过 HTTP 请求检索 API |
| 检索 API | 解析问题、协调召回、读取原文、合并证据 | 独立 CPU 容器，只读挂载 SQLite |
| SQLite | 保存正文、标题、日期、元数据、description 和关键词索引 | 独立持久化的文件，由检索 API 打开，无需 SQL 服务容器 |
| Chroma | 保存向量、原文关联标识和可选文本副本 | 独立容器与持久化目录，文本副本不作为引用依据 |
| Qwen3-Embedding-4B | 将问题和索引文本转换成向量 | 独立 GPU 服务，用于语义检索 |
| Qwen3.8-27B | 决定工具调用，根据证据生成回答 | 独立 GPU 服务，通过 OpenAI 兼容 API 调用 |

**离线建库**：政策文件经 MinerU 解析为 Markdown，结合源文件清单、元数据和 description 构建 SQLite；再将文档与正文片段向量化，写入 Chroma。普通查询和服务重启不重新解析语料或重建向量。

**在线问答**：Harness 将问题交给回答模型；模型发起 `policy_search` 调用，工具请求检索 API；API 返回有限原文证据后，模型继续生成带来源的回答。问题规划器使用代码规则，不额外调用规划模型。

```text
Question -> Harness -> Answer model requests policy_search
                              |
                         policy_search
                              | HTTP
                         Retrieval API
                              |
                    Plan and recall candidates
                              |
                    Merge and deduplicate IDs
                              |
                    SQLite batch source reads
                              |
                 Validate, filter, fuse ranks, limit
                              |
                        Tool evidence
                              |
                  Answer model -> Harness -> User
```

上图描述当前仓库代码。**更新 Harness 不会同步更新独立检索 API**；服务器是否采用这套实现，需要核对各自的镜像与代码版本。API 的批量取证、索引校验和发布操作见[检索服务部署指南](packages/experimental/environment-policy/deploy/README.zh.md)。

工具默认最多返回 8 条证据、原文合计最多 12,000 字符，并非整部法规全文。同一法规的多段证据可以共用一个来源编号，例如 `[1]`。工具在返回候选中优先保留同名法规发布日期最新的版本，历史或版本比较问题允许保留多个版本；这不保证语料已经收录最新法律版本。

<a id="retrieval"></a>

## 多路召回：三类、四路

按功能分为精确、关键词和语义三类；将语义召回拆开，混合模式有下面四路检索支路。API 根据问题选择通道，并非每次全部执行。

| 支路 | 适合的问题 | 候选从哪里来 |
| --- | --- | --- |
| 精确召回 | “核安全法第一条是什么” | SQLite 法规名称、文号、条号定位 |
| 关键词召回 | “哪些政策涉及畜禽养殖污染” | SQLite 标题检索、正文 BM25 检索 |
| 文档语义召回 | 用自然语言寻找相关政策文件 | 问题向量匹配 Chroma 文档向量，再在候选文件中找正文 |
| 片段语义召回 | 用自然语言寻找相关条款、段落 | 问题向量匹配 Chroma 正文片段向量，返回原文位置 |

两路语义查询复用一次问题向量化。各通道返回原文关联标识，统一回到 SQLite 读取、校验并形成证据；当前排名融合不依赖额外的 Reranker 模型。

description 用于帮助发现文件，参与文档向量输入，不能替代法规正文。它在混合模式下不单独算第五路；纯 SQLite 模式另有 description 词法辅助召回。向量输入随构建版本变化，具体规则见[检索服务部署指南](packages/experimental/environment-policy/deploy/README.zh.md)。

### 谁决定调用工具与召回通道

模型选择工具，检索 API 中的代码规则选择具体召回通道，两者是不同层面的决策。

| 决策 | 负责方 |
| --- | --- |
| 是否调用政策库、提交什么问题 | 回答模型，受政策问答提示词约束 |
| 使用哪些召回通道、设置哪些检索条件 | 检索 API 的问题规划器，通过代码规则判断 |
| 如何读取、过滤、排序和合并候选 | 检索 API 的检索与取证代码 |
| 如何解释证据并列出来源 | 回答模型 |

`policy_search` 的模型可用参数是 `question`、可选的 `topic` 和 `current_date`，没有“选择召回通道”的参数。提示词要求政策问题先调用工具；实际工具调用仍由模型提出，Harness 负责执行。

### 规则如何判断问题

规划器通过字符串匹配、正则表达式和条件判断解析问题：用库内标题及去掉“中华人民共和国”前缀的名称匹配法规，识别书名号、文号和“第二十六条”等表达；结合“讲了什么”、日期及效力相关表达确定查询意图和过滤条件。它不使用额外的大模型自由推理检索路线。

- “水土保持法第二十六条是什么？”：模型调用工具后，规划器识别法规名称和条号，定位指定条款，跳过语义召回。
- “养殖场的废水能直接排到河里吗？”：没有明确法规目标，在配置了向量服务的混合模式下，并行执行关键词召回与语义召回；语义检索内部查询文档和片段两个集合。

Embedding 模型与 Chroma 负责语义通道内的相似性计算，“是否启用语义通道”由规划器的规则决定。规则便于测试和复现，但名称或意图误判仍可能导致选错通道、漏掉证据；相似度也不代表证据支持问题前提。具体解析与通道条件见[查询规划代码](packages/experimental/environment-policy/src/query.ts)。

<a id="deployment"></a>

<a id="run"></a>

## 选择使用与部署方式

按 Harness 运行位置和数据来源，可以选择以下三种方式。只使用网页的人无需部署代码。

| 方式 | 适用场景 | 需要准备 |
| --- | --- | --- |
| A．DGX 网页应用 | 日常问答、演示、集中运行 | 浏览器、内网连接、负责人私密提供的认证地址 |
| B．本地 Harness＋DGX 检索 | 修改前端、工具或 agent 配置 | 代码、Node/pnpm、启动配置、检索及模型凭据 |
| C．本地 Harness＋本地 SQLite | 离线检索开发、建库、主动切换本地库 | B 的本地运行环境、SQLite 文件或构建输入、可用回答模型 |

A、B 都不要求使用者下载政策语料和模型权重。C 的本地 SQLite 检索本身不依赖 DGX，但回答模型仍需单独配置；本地向量检索也不随 SQLite 自动提供。

DGX 应用入口为 `http://172.27.153.44:3080/`，首次访问需要当前进程的认证链接。该实例共享会话、设置和工作区，不提供多租户隔离。检索 API 为 `http://172.27.153.44:18080`，用于工具查询，不是聊天页面；Docker 内部地址与宿主机端口见[DGX 应用部署指南](docs/user/guide/dgx-deployment.zh.md)。

<a id="startup"></a>

## 启动、重启与更新

### A．DGX 网页应用

首次部署按[DGX 应用部署指南](docs/user/guide/dgx-deployment.zh.md)准备状态目录、凭据、网络并构建。`deploy/dgx` 的 Compose 项目只管理 Harness，依赖已经运行的检索、Chroma 和模型服务。

已有部署仅重启 Harness 时，在 DGX 的仓库目录执行：

```bash
cd deploy/dgx
docker compose restart harness
```

重启后从日志获取当前认证地址。源码更新后需要重新构建镜像，单纯 `restart` 不加载新代码。检索 API、SQLite、向量索引和模型分别更新，操作见各自部署指南；停止或重建 Harness 不会替它们重建数据。

<a id="run-from-source"></a>

### B．本地 Harness 连接 DGX

新协作者先准备仓库声明的运行环境：Node.js `^22.19.0 || >=24.0.0`，pnpm 版本按 `package.json` 的 `packageManager` 固定。首次在仓库根目录安装和构建：

```powershell
pnpm install --frozen-lockfile
pnpm run build
```

再按[部署指南](docs/user/guide/dgx-deployment.zh.md)末尾的本地用法准备私有 `DSH_HOME`、检索地址、令牌文件和模型凭据，使用仓库内可复用的预设生成启动配置。新克隆的仓库没有 `.dsh-build/`；不要直接使用下一段的本机配置。

**当前已有 Windows 工作区**已准备远程启动配置。停止旧进程后，在仓库根目录启动或重启：

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-web.patch.yml --no-open
```

打开终端打印的认证地址，通常为 `http://127.0.0.1:3080`。该私有配置使用 DGX 检索 API，令牌保存在 `.dsh-build/dgx-policy.token`；其中可能含本机绝对路径，不能原样复制到其他电脑。

依赖和构建产物齐全时，重启只需启动命令。尽量在同一个交互式终端完成安装、构建和启动；Codex 执行环境与用户终端的 Node、pnpm、代理和依赖链接状态可能不同。缺少 `node_modules/.modules.yaml` 时，pnpm 可能重新检查并链接整个 workspace，导致启动变慢。只有依赖变化或构建产物需要更新时才重新安装、构建。

### C．使用本地 SQLite

准备 `data/policy-national-v1.sqlite`，按[数据说明](data/README.zh.md)建库，并参考[插件说明](packages/experimental/environment-policy/README.zh.md)组合本地知识服务和查询工具。只有需要重建数据库时才运行建库脚本。

当前 Windows 工作区还保留本地库配置；停止远程模式的 Harness 后，可主动切换：

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-local-web.patch.yml --no-open
```

远程服务不可用时直接报错，不自动切换到本地旧库。切换检索服务不需要改变模型调用的 `policy_search` 工具接口。

<a id="collaboration"></a>

## 协作开发与数据准备

Git 保存源代码、锁文件、部署模板和文档。SQLite、政策语料、向量索引、模型权重、会话状态、凭据和本机私有配置需要分别准备，不随仓库提交。

| 工作内容 | 除代码外需要什么 |
| --- | --- |
| 使用 DGX 网页 | 内网及认证地址 |
| 本地开发并调用 DGX | 检索接口与令牌、可用模型与凭据、本机启动配置 |
| 开发本地 SQLite 检索 | SQLite 快照；查询时不需要 MinerU 原始结果 |
| 重建 SQLite | Markdown 原文、源文件清单、元数据、description 等构建输入 |
| 重建向量索引 | 对应 SQLite 快照、固定版本的 Embedding 模型、输入及切分规则、Chroma |

数据准备见[数据说明](data/README.zh.md)，SQLite 与向量索引的成套校验、发布和回滚见[检索服务部署指南](packages/experimental/environment-policy/deploy/README.zh.md)。认证链接、API 令牌和模型凭据通过私密渠道分发，不写入 README 或提交到 Git。

<a id="verification"></a>

## 验证与常见问题

从仓库根目录运行检索插件的相关检查：

```powershell
node_modules/.bin/vitest.cmd run packages/experimental/environment-policy/tests
node_modules/.bin/tsc.cmd -p packages/experimental/environment-policy/tsconfig.json --noEmit
```

以上为 Windows 命令。评测口径和复现方法见[检索效果评测](docs/user/guide/policy-retrieval-evaluation.zh.md)，部署验证见[DGX 应用部署指南](docs/user/guide/dgx-deployment.zh.md)。

| 现象 | 检查与处理 |
| --- | --- |
| 网页打不开或返回 401 | 区分网页与检索端口，检查内网、访问地址和当前进程认证链接 |
| 检索或模型返回 401 | 分别核对检索令牌和模型凭据，两者不是同一个凭据 |
| 找不到启动 patch | 新克隆不含 `.dsh-build/`，先生成本机配置 |
| 启动慢 | 检查是否重复安装、构建，以及 Node/pnpm 和依赖链接是否一致 |
| 回答慢但检索快 | 完整问答还包含工具调用前后的模型推理和输出生成 |
| 返回的内容不支持问题 | 核对实际正文证据、文件标题和语料覆盖，不能仅看相似度 |
| 向量失败或超时 | 混合检索保留词法证据；API 整体不可用则报错 |
| 合并代码后链路没有变化 | 分别核对 Harness 与检索 API 的镜像和版本 |

<a id="documentation"></a>

## 代码与文档入口

| 入口 | 内容 |
| --- | --- |
| [检索插件](packages/experimental/environment-policy/README.zh.md) | 问题规划、数据服务、工具和检索语义 |
| [检索服务部署](packages/experimental/environment-policy/deploy/README.zh.md) | API、Docker、混合检索、索引发布与回滚 |
| [DGX 应用部署](docs/user/guide/dgx-deployment.zh.md) | Harness 容器、访问认证、持久化、更新与排查 |
| [Agent 预设](apps/cli/config/examples/environment-policy-dgx.patch.yml) | 问答名称、描述、提示词、工具和模型配置 |
| [数据准备](data/README.zh.md) | 本地 SQLite 与建库输入 |
| [检索效果评测](docs/user/guide/policy-retrieval-evaluation.zh.md) | 评测结果、局限与复现方法 |
| [开发指南](docs/development.zh.md) | DSH 仓库开发与检查流程 |

环境政策检索代码位于 `packages/experimental/environment-policy/src/`，SQLite 建库入口为 `scripts/environment-policy-build-index.ts`。本项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 开发，保留上游框架及其贡献历史。

<a id="license"></a>

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
