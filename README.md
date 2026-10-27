# E-agent：环境政策法规问答系统

[English](README.en.md) | [中文](README.zh.md)

E-agent 基于 DeepSeek Harness，先检索环境政策原文，再生成带来源的回答。当前合并版覆盖国家级与省级资料。

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

合并 SQLite 包含2,045份文件，支持法规名称、文号、条号、主题、全文概括，以及图谱辅助的历史版本查询。数据库和语料不进入 Git；目录效力标注和库内最新版均不等于独立核验的现行有效状态。

<a id="architecture"></a>

## 架构与问答链路

检索在 Harness 中运行。后端先自动搜索、读取原文，并持久化记录证据，再交给模型回答。SQLite 只读挂载，向量和图谱服务独立运行；模型意图识别与拆题保持关闭，历史版本和效力问题按需使用图谱。

```text
User → Harness backend → Exact lookup / Jieba＋BM25 / Chroma
                         → Read SQLite original sources
                         → Graph history when needed
                         → Persist evidence → Answer model → User
```

`documents` 保存每份版本的标题、文号、日期、效力标注、description、全文及来源路径。`content_units` 保存原文条款、标题、段落及其顺序、章节和行号。两套 FTS5 索引分别检索标题/description 和正文，FTS5 的影子表不是业务表。摘要帮助发现文件，回答引用仍以原文为依据。

`policy_search` 返回文件候选或证据片段；`policy_read` 按文档 ID 读取确定版本，不执行相关性召回。概括整部法规时须顺序读到 `has_more=false`，长单元也可跨页。同名版本分别返回，不能只凭发布日期认定最新版本现行有效。

<a id="retrieval"></a>

## 多路召回

后端规则选择精确定位、BM25与语义召回、文件读取或图谱辅助历史检索。回答模型使用已经准备好的证据，可通过受限工具补查来源，不需要主动发起首次检索。

Jieba 用于正文与问题分词，SQLite FTS5 原生 BM25 排序，候选融合后统一取原文。既有 DGX 向量只在构建 ID、原文哈希和片段映射一致时复用。语义服务失败会明确报告，仍可执行 BM25。查询不会自动重建向量。

<a id="deployment"></a>

## 部署方式

| 方式 | Harness / SQLite | 向量与模型 |
| --- | --- | --- |
| A．DGX 网页应用 | Harness 容器＋DGX 宿主机只读挂载 SQLite | DGX 独立容器 |
| B．本地网页应用 | 本地 Harness；通过 v2 API 读取 DGX SQLite | DGX 独立容器 |

当前 A 方式使用[合并版 DGX 部署指南](deploy/dgx-combined/README.zh.md)。B 需要另行启用受鉴权的 v2 API，合并部署默认不开放该接口。迁移验收后，旧应用和数据服务停止运行并作为回滚资源保留。

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

测试覆盖后端证据整理、精确定位、语义来源校验、分页、图谱沿革和远程传输。真实问题报告分别评估检索、回答准确性与引用；通过部署检查不等于全部法规或回答均准确。

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
