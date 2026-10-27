---
description: "基于已准入 SQLite 记录、可复用国家向量及 DGX 现有 Embedding 模型构建并验证本地政策 Chroma 集合。"
---

# 本地政策向量库

[English](README.md) | 中文

## 概要

本地构建器从已准入的合并 SQLite 快照生成独立的文件和正文集合。它通过 SSH 隧道读取已有国家级向量，并向 DGX 发送新增向量计算请求，不写入远端集合、不改变 DGX 服务。本地查询命令在向量召回前过滤地域，并对照 SQLite 核验返回证据。可选的本地 Harness 配置接入已完成的语料，不改变 DGX 服务。

## 目录

- [前置条件与构建](#build)
- [验证与查询](#query)
- [本地 Harness 链路](#harness)
- [复用与恢复](#recovery)

<a id="build"></a>

## 前置条件与构建

使用 Python 3.10 或更新版本，在 `.dsh-build/local-vector-venv` 环境安装 `requirements.txt`。准备 `data/policy-combined-local-20261022-r2.sqlite` 和 `.dsh-build/policy-v2-documents.compat.json`。命令从仓库根目录执行。保持以下 SSH 隧道开启；它仅转发回环端口，并提示输入已有 SSH 密码：

```powershell
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:59329:127.0.0.1:8000 -L 127.0.0.1:59330:127.0.0.1:8002 health@172.27.153.44
```

在另一终端构建或续跑：

```powershell
.dsh-build/local-vector-venv/Scripts/python.exe -X utf8 -u scripts/build-policy-local-vectors.py --database data/policy-combined-local-20261022-r2.sqlite --compatibility .dsh-build/policy-v2-documents.compat.json --output data/policy-combined-local-vectors-r2
```

`--batch-size` 默认 64，接受 1–128，控制模型请求批量。`--index-batch-size` 默认 512，接受 1–2,048，控制本地写入批量。同一输出目录只能有一个构建器写入。产物包括 `chroma/`、支持续跑的 `staging.sqlite`、各集合复用审计和 `manifest.json`。清单记录 SQLite SHA-256、集合名、向量维度、来源数量和构建完成状态。该目录属于数据，执行会移除构建产物的仓库清理命令前应先保存。

<a id="query"></a>

## 验证与查询

不调用模型，核验每条已索引记录的 ID、文件哈希、地域、输入校验值、原文位置，并对照暂存库比对落盘向量：

```powershell
.dsh-build/local-vector-venv/Scripts/python.exe -X utf8 scripts/query-policy-local-vectors.py --root data/policy-combined-local-vectors-r2 --verify
```

通过隧道调用同一个 DGX 模型查询：

```powershell
.dsh-build/local-vector-venv/Scripts/python.exe -X utf8 scripts/query-policy-local-vectors.py --root data/policy-combined-local-vectors-r2 --question "江苏省危险废物管理有哪些要求" --region 江苏省 --only
```

默认地域为 `全国`。指定省份时联合全国与本省，添加 `--only` 则仅查本省；地域名必须与 SQLite 完全一致。各地域独立分配候选数量，并交替合并结果。`--document-id` 进一步限定文件；`--kind document` 从正文证据切换为文件发现。结果展示标题、地域、距离和限长原文片段。构建未完成或 SQLite 快照发生变化时拒绝查询。检索相关性仍需评测，来源核验不代表已经确认法律适用范围。

浏览集合、元数据和已有向量可使用[本地只读查看器](../db-viewers/README.zh.md#local-vector)。运行会打开嵌入式向量库的命令前，先停止查看器。

<a id="harness"></a>

## 本地 Harness 链路

将已完成的 SQLite 快照与向量目录配套保留。在仓库根目录启动本地网页 Harness，使用 `.dsh-build/qwen-api.key` 中已有的模型密钥：

```powershell
./deploy/local/start-policy-local-web.ps1
```

首次使用启动输出中带令牌的链接登录，随后打开 <http://127.0.0.1:3080/>，选择环境政策预设。脚本检查 SQLite 身份和模型可用性，启动或复用 18102 端口上独立的本机回环向量 API，通过生成的补丁加载本地源码提供者。可选的可视化前端共用该 API，关闭浏览器页面不会停止检索；前端不可用也不影响 API 启动。检索不经过 DGX 检索 API 或远端向量集合，仅调用现有 DGX Embedding 和对话模型。`-EmbeddingUrl` 和 `-VectorPort` 可覆盖模型地址及本地 API 端口。脚本退出时恢复环境变量，网页端口被占用时拒绝启动，不停止其他进程。

本地补丁加载 `deploy/local/policy-latest.json`，默认只查全国及库内最新版。审核后的来源数据变更时，用 `python scripts/build-policy-latest.py --graph-config deploy/local/policy-graph.json --database data/policy-combined-local-20261022-r2.sqlite --output deploy/local/policy-latest.json` 重建。普通搜索和读取不需要 Neo4j 连接。历史版本、沿革及效力请求通过 `deploy/local/policy-graph.json` 按需使用 17475 端口已有本地 Neo4j 的 `policy-combined-v4` 分区；此类请求需要启动该实例。图谱不一致时历史请求失败。更换任一元数据快照后须重启 Harness。旧分区和向量集合均保持不变；最新正文缺失或版本顺序不明时排除，不用旧文替代。

工具仍是 `policy_search` 和 `policy_read`。找文件合并标题/摘要 BM25 与文件向量；主题问题合并正文 BM25、正文向量，以及向量发现文件内的低权重 BM25 证据。每个地域分别保留 30 个关键词、10 个文件向量、30 个正文向量和 20 个文件引导候选。省份默认联合全国，`region_mode=only` 时仅该省；查询前同时限定地域和可选文件 ID。RRF 合并排名而非原始距离，再将每份文件限制为三个单元、合并相邻证据，最多返回八块、12,000 字符。文件摘要不能代替原文证据。

本地语义设置使用归一化向量的数学距离边界（L2 为 4，cosine 为 2），尚未标定相关性截断阈值。排名靠前的结果仍可能无关，需要单独评测回答相关性。共享的 60 秒语义超时用于容纳索引冷加载，热查询耗时取决于本机。传输失败重试仍使用同一原问题。模型或向量失败返回警告并保留关键词检索，调用方取消仍会终止请求。启动时拒绝不兼容清单，运行时拒绝来源、单元或文本偏移不符的结果。

用 Ctrl+C 停止前台 Harness。向量服务仍可浏览，使用其他嵌入式客户端或重建前，请另行执行 `./deploy/db-viewers/local-chroma.ps1 -Stop`。回到先前的 DGX 数据服务配置时，先停止当前 Harness，再运行 `./deploy/local/start-policy-web.ps1`。两套配置均保留已有数据库，这两个命令都不会部署到 DGX。

<a id="recovery"></a>

## 复用与恢复

文件向量编码 `标题` 和 `内容概述`。正文向量编码标题、章节及原始正文；新片段按 1,200 个 Unicode 码点、重叠 120 个切分，跳过标题及去除首尾空白后不足 30 字符的单元。旧片段在源哈希、标题、已保存输入、偏移及 SQLite 正文全部吻合时保留旧切分。未覆盖且满足条件的单元生成新向量。每条向量记录 `document_id`、`region`、`source_hash`、`build_id` 和向量输入哈希；正文另记录有序单元 ID，以及拼接后统一 CRLF 为 LF 的正文偏移。

旧版本没有记录固定权重版本。每个集合对照当前模型检查六个样本，要求余弦相似度至少 0.999，审计明确记录这一经验性限制。随后为输入一致的记录复用归一化后的 2,560 维向量。文件集合保留 L2 距离，正文集合保留余弦距离。这是兼容性证据，不是权重完全一致的密码学保证。

新增请求使用模型兼容 OpenAI 的 base64 float32 输出，按小端数值解码并在本地归一化，减少传输体积且不量化向量。暂存库使用 SQLite WAL，避免进度读取阻塞批次提交；本地 HNSW 批量构建采用 10,000 条同步间隔和八个索引线程。

网络失败采用有上限的退避重试。计算出的向量先提交暂存库，再写入索引；重跑同一命令会从检查点继续，对照缓存样本核实模型，并安全重复未提交状态的 upsert。在输出目录创建空 `STOP` 文件可在当前批次结束后停止；等待进程退出，续跑前删除该文件。SQLite 哈希、兼容映射哈希或构建器版本不同，必须使用新输出目录。构建期间不要编辑或替换 SQLite，导出期间不要改变远端来源集合。保留旧集合，替代版本完整验证并单独获准部署后再切换。

Windows 下从仓库根目录执行，使原生 HNSW 库收到 ASCII 相对存储路径。该固定版本在中文绝对路径下可能仅生成 SQLite 和元数据文件，缺少 HNSW 二进制文件，导致重新打开失败。构建器与查询命令统一转换相对路径，并拒绝非 ASCII 相对路径。构建后必须在新进程验证，仅在原进程内查询成功不能证明索引已经落盘。

## 开发备注

无。
