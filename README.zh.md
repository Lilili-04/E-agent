# E-agent：环境政策法规问答系统

[English](README.en.md) | 中文

E-agent 基于 DeepSeek Harness，先查环境政策原文，再由模型生成带来源的回答。本次新版仅处理国家级语料。

## 阅读导航

- [项目能力与范围](#scope)
- [架构与问答链路](#architecture)
- [多路召回](#retrieval)
- [部署方式](#deployment)
- [启动与更新](#startup)
- [数据库可视化](#db-viewers)
- [协作与数据](#collaboration)
- [验证与局限](#verification)
- [文档入口](#documentation)
- [许可证](#license)

<a id="scope"></a>

## 项目能力与范围

支持法规名称、文号、条号、主题查询和整部文件概括。新版样本库包含 495 份去重国家级文件、63,175 个原文内容单元，约 84.4 MiB；数据库和语料不提交 Git。省级未纳入。效力标注来自目录，系统不独立判断法律效力。

<a id="architecture"></a>

## 架构与问答链路

新版部署把检索代码放在 Harness 容器里。SQLite 原文文件放在宿主机，以只读目录挂载给 Harness；Chroma、Embedding 模型、问答模型分别运行。不需要 SQLite 服务容器，也不需要旧检索 API 参与这条新链路。仓库保留旧 API 供已有部署使用；更新代码不等于已经更新 DGX。

```text
User → Harness → Answer model calls policy_search
                    ├─ Exact lookup / Jieba＋BM25 → Mounted SQLite
                    └─ Embedding → Chroma → Validate and read SQLite sources
          Model calls policy_read as needed → Article / section / full pages
          Model answers from source evidence → User
```

`documents` 保存每份版本的标题、文号、日期、效力标注、description、全文及来源路径。`content_units` 保存原文条款、标题、段落及其顺序、章节和行号。两套 FTS5 索引分别检索标题/description 和正文，FTS5 的影子表不是业务表。摘要帮助发现文件，回答引用仍以原文为依据。

`policy_search` 返回文件候选或证据片段；`policy_read` 按文档 ID 读取确定版本，不执行相关性召回。概括整部法规时须顺序读到 `has_more=false`，长单元也可跨页。同名版本分别返回，不能只凭发布日期认定最新版本现行有效。

<a id="retrieval"></a>

## 多路召回

代码规则决定通道：明确法规和条号直接定位；全文概括先确定文件再读取全文；明确法规下的具体主题限定在该文件正文；一般主题融合正文 BM25、文档向量和片段向量。模型决定调用工具和如何根据证据回答。

Jieba 用于正文与问题分词，SQLite FTS5 原生 BM25 排序，候选融合后统一取原文。既有 DGX 向量只在构建 ID、原文哈希和片段映射一致时复用。语义服务失败会明确报告，仍可执行 BM25。查询不会自动重建向量。

<a id="deployment"></a>

## 部署方式

| 方式 | Harness / SQLite | 向量与模型 |
| --- | --- | --- |
| A．DGX 网页应用 | Harness 容器＋DGX 宿主机只读挂载 SQLite | DGX 独立容器 |
| B．本地开发验证 | 本地 Harness＋同版本 SQLite 快照 | 调用 DGX；内部端口可用 SSH 隧道 |

A 的部署入口见 [DGX 指南](docs/user/guide/dgx-deployment.zh.md)。B 是新版检索的开发验证组合，需要额外取得 SQLite 与匹配映射文件。旧的“本地 Harness＋远程检索 API”配置仍调用旧版工具，不能用来验证本次 `policy_read` 链路。

<a id="run"></a>
<a id="run-from-source"></a>

<a id="startup"></a>

## 启动与更新

DGX 使用 `deploy/dgx/.env.example` 配置只读数据目录、向量集合、模型接口和密钥文件。首次启动前需准备 SQLite 与匹配的 `policy-v2-documents.compat.json`。合并后由维护者部署数据和应用，参见 [DGX 指南](docs/user/guide/dgx-deployment.zh.md)。

```bash
cd deploy/dgx
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose config --quiet
docker compose build
docker compose up -d --wait
```

依赖、配置和数据未变化时，仅需 `docker compose restart harness`。代码变化后重建镜像；数据变化时准备新目录并同时切换 SQLite 与映射文件，保留旧目录用于回滚。不要把 Windows 的 node_modules 或私有启动配置复制到 Linux。

本地依赖和构建齐全时只运行启动命令，不重复安装和建库。用户终端与 Codex 执行环境的 Node、pnpm、代理和依赖链接可能不同；缺失 `node_modules/.modules.yaml` 可能导致 pnpm 重新链接整个 workspace，启动明显变慢。开发工具组合、参数和离线建库命令见 [插件说明](packages/experimental/environment-policy/README.zh.md)。

<a id="db-viewers"></a>

## 数据库可视化

DGX 可选部署一套 Datasette 与 ChromaDB UI。更新新版 SQLite 后，可视化的只读挂载也须指向相同快照。可视化独立于 Harness，见 [部署指南](deploy/db-viewers/README.zh.md)。

<a id="collaboration"></a>

## 协作与数据

Git 保存代码、依赖锁文件、部署模板和文档，不保存 SQLite、语料、摘要结果、向量、模型、凭据或私有运行记录。协作者运行新版需要 SQLite 快照、对应向量映射、DGX 接口配置和模型凭据；建库还需原始 Markdown、摘要和法规目录。Dependabot、Renovate 未启用。

<a id="verification"></a>

## 验证与局限

本地回归包括 7 项工具/分词/分页/向量关联测试、10 个真实检索问题，以及通过 DGX 模型执行的《水土保持法》《核安全法》全文概括。495 份文件共 1,068 页重组后与导入原文一致；这不代表逐份核对过 PDF，也不代表答案准确率。

主题检索可能召回过宽的候选，部分同名版本条款相近。38 份来源未能无歧义匹配目录元数据；一份旧摘要因原文哈希不符被排除。现有向量映射覆盖 493 条未变化的旧来源记录；新增或变更原文仍可通过 BM25 找到。全文超过模型上下文时，归纳还受压缩保留信息影响。

<a id="documentation"></a>

## 文档入口

- [DGX 应用部署](docs/user/guide/dgx-deployment.zh.md)：挂载、配置、启动和回滚。
- [检索插件](packages/experimental/environment-policy/README.zh.md)：工具参数和离线建库。
- [旧检索服务](packages/experimental/environment-policy/deploy/README.zh.md)：仍在使用旧 API 时的维护说明。
- [数据库可视化](deploy/db-viewers/README.zh.md)：DGX 只读浏览。
- [开发指南](docs/development.zh.md)：仓库构建和检查。

<a id="license"></a>

## 许可证

项目沿用上游 [LICENSE](LICENSE)，依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
