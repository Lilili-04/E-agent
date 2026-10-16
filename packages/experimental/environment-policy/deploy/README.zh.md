# DGX 政策原文、索引与检索服务部署

[English](README.md) | 中文

本部署在 DGX 上运行检索服务。Harness 可在本地或自己的容器中运行，通过 HTTP 请求原文证据。SQLite 保存政策正文和元数据；关键词索引与 Chroma 向量负责定位候选。检索 API 协调这些操作，本身不是关系数据库。其容器不需要 GPU，也不提供数据写入接口。

## 服务与数据

```text
Harness → policy_search → retrieval API → query planning
  Exact query: title / number / article index → candidate addresses
  Topic query: body BM25 + embedding / Chroma → candidate addresses
  Merged addresses → SQLite batch read → validation / rank fusion → bounded evidence
```

| 项目 | 配置 |
| --- | --- |
| DGX SSH | `health@172.27.153.44:22` |
| 查询 API | `http://172.27.153.44:18080` |
| Docker 部署目录 | `/srv/e-agent/policy-api/deploy` |
| 数据目录 | `/srv/e-agent/policy-data` |
| 数据库 | `policy-national-v1.sqlite`，只读挂载 |
| 容器名 | `e-agent-policy-api` |
| 令牌文件 | `/srv/e-agent/policy-api/.secrets/policy-token` |

SQLite 保存原文、正文单元、元数据、description 和关键词索引。Chroma 保存派生向量、原文标识及可选文本副本，副本不作为引用来源。API 在自己的容器中只读挂载 SQLite；SQLite 是嵌入式数据库，无需另起 SQL 服务容器。Chroma 和 Harness 各自拥有容器与持久化目录。重建向量需要同一原文快照、固定的 Embedding 权重、文本预处理和切分规则。服务启动及重启均不执行重建。

## Docker 配置

将包内的 `src/database.ts`、`src/query.ts`、`src/query-store.ts`、`src/hybrid-store.ts`、`src/release.ts`、`.dockerignore` 和 `deploy/` 部署到 `/srv/e-agent/policy-api`，并将数据库放入上述数据目录。从 `deploy/.env.example` 创建 `deploy/.env`，在令牌文件中写入至少 32 字符的随机令牌，令牌不得进入 Git。

```dotenv
POLICY_DATA_DIR=/srv/e-agent/policy-data
POLICY_API_BIND=172.27.153.44:18080
POLICY_API_TOKEN_FILE=/srv/e-agent/policy-api/.secrets/policy-token
```

DGX 已安装离线导入的官方 ARM64 Node 镜像；该环境另设置 `POLICY_NODE_IMAGE=e-agent-node:24-bookworm-slim-arm64`。镜像下载来自 Docker 官方 Registry，每个配置、清单和数据层均按 SHA-256 校验。正常联网环境可使用 Dockerfile 默认的 `node:24-bookworm-slim`。

在 DGX 上启动或更新容器：

```bash
cd /srv/e-agent/policy-api/deploy
sudo docker network create policy-retrieval  # only when the network does not exist
sudo docker compose build
sudo docker compose up -d --wait
sudo docker compose ps
```

SQLite 目录使用只读绑定挂载；应用以非 root 用户运行，容器根文件系统为只读。令牌通过 Docker secret 文件读取。应用日志轮转，无数据库自动重建。

## 混合检索

已知文件名、文号和条款跳过 GPU。主题查询让 Embedding/向量请求与词法召回交叠执行；同步 SQLite 计算仍占用 Node 事件循环。BM25 先聚合索引词，再读取限量候选正文。两种通道均返回不含引用正文的标识。服务合并、去重标识，每批 SQL 最多读取 100 个不同正文单元，拒绝缺失单元、原文哈希变化或非法 Unicode 片段，再依据 SQLite 元数据过滤并融合名次。同一正文单元在每个通道只贡献一次，同一文件的多条证据共用引用编号。

`policy-retrieval` 是三个容器共用的 Docker 网络。Chroma 和 embedding 的 Compose 文件须将服务加入该外部网络；API 使用容器名访问 `http://chroma:8000` 与 `http://vllm-qwen3-embedding-4b:8000`。现有 Chroma 的主机端口仍绑定 `127.0.0.1:8002`。

`deploy/.env.example` 列出全部语义配置。`POLICY_DOCUMENT_COLLECTION` 指向已有 combined 文档集合，`POLICY_PASSAGE_COLLECTION` 指向本次构建的正文集合。文档候选上限 12、正文候选上限 32；文档集合实际使用平方 L2 距离，默认上限 0.9；正文集合使用余弦距离，默认上限 0.45。阈值是可调整参数，不表示法律判断的置信度。清空两个集合名称即可使用 SQLite 检索。

语义检索预算默认 2000 毫秒。单个向量集合失败时保留另一集合的候选；失败或超时仍保留词法证据，并返回 `semantic-unavailable` 警告。API 本身不可用时 Harness 明确报错。`diagnostics` 提供规划、词法、语义、原文读取和总耗时，候选及不同单元数量，以及缺失单元、哈希和片段关联的拒绝数量。`candidate-source-association-rejected` 标记被丢弃的原文关联。耗时不含回答生成。

离线 [build-passages.py](build-passages.py) 接受 `--database`、`--embedding-url`、`--chroma-url`、`--model`、必填的 `--model-revision` 和 `--kind document|passage`。文档输入组合标题、摘要和限长正文概览；片段输入组合标题、章节和正文，按 1200 个 Unicode 字符、120 字符重叠切分。新集合名包含原文构建标识及模型/输入指纹，续跑要求元数据完全一致。构建器不切换在线版本。已有集合继续支持 legacy 模式，校验构建标识、原文哈希和维度，但不能确认缺失的模型权重版本。

## 本地 Harness

本机访问令牌保存在 `.dsh-build/dgx-policy.token`。本地远程启动配置 `.dsh-build/environment-policy-remote-web.patch.yml` 读取该文件，无需在命令中明文填写令牌。

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-remote-web.patch.yml --no-open
```

供其他开发者使用的通用插件组合见 [environment-policy-remote.cordis.yml](../presets/environment-policy-remote.cordis.yml)。设置 `DGX_POLICY_API_URL` 和 `DGX_POLICY_API_TOKEN_FILE` 可修改接口地址和本机令牌文件。插件默认请求超时为 8 秒，可通过 `timeoutMs` 修改。

项目 A、B 两种部署均使用 DGX 数据库，远程失败时直接报错，不切换本地库。两者共用可选的 [DGX 数据库可视化](../../../../deploy/db-viewers/README.zh.md)。

## HTTP 接口

`GET /health` 无需令牌，报告 SQLite 就绪状态、构建标识、最近语义状态及 legacy/manifest 校验模式，不探测模型。鉴权后的 `GET /v1/policy/status` 不执行推理，只检查集合兼容性，响应明确标记 Embedding 未探测。集合就绪不代表模型可用。`GET /v1/policy/manifest` 返回完整构建清单，需要 `Authorization: Bearer <token>`。`POST /v1/policy/search` 使用相同鉴权，接受以下请求：

```json
{
  "question": "中华人民共和国核安全法第一条是什么",
  "options": {
    "maxResults": 8,
    "maxEvidenceCharacters": 12000
  }
}
```

`options` 还支持 `currentDate` 和 `titleTopic`。HTTP 接口不接收任意 SQL 或结构化数据库过滤器。证据最多 50 条、100000 字符；正文请求最大 512000 字节、问题最大 4000 字符。响应包含 `index`、`evidence` 和 `diagnostics`，模型输出仍由本地工具移除内部路径和检索字段。

无令牌或错误令牌返回 HTTP 401，非法参数返回 HTTP 400。请求超时、连接失败和不兼容的数据库版本会使本地远程服务返回明确错误。

## 验证记录

2026-10-13 的 DGX 实测如下；数字为检索 API 内部处理耗时，不包含网络和 Agent 生成回答，不作为延迟保证。重复查询复用问题 embedding；不同问题仍需各自计算。

| 问题 | 首轮 | 重复 |
| --- | --- | --- |
| 中华人民共和国核安全法 | 7 ms | 1 ms |
| 核安全法第一条规定了什么 | 1 ms | 小于 1 ms |
| 海洋法有哪些 | 407 ms | 182 ms |
| 养猪场粪污处理有哪些要求 | 220 ms | 200 ms |
| 企业污水超标的法律责任 | 336 ms | 268 ms |

正文向量集合包含 38427 个分段。真实远程 `policy_search` 组合验证核安全法概述返回 8 段正文，覆盖第一条和第九十四条，共用一个来源编号。

90 题旧基线有 72 题符合预设标题或有无结果条件，这不是回答准确率。其余问题包括规划、标准没有“第一条”的案例、标准标题别名，以及无答案和否定问法。目前系统仍可能召回与无答案问题部分词语相关的文件，不能把“返回了证据”视为“该证据支持问题前提”；回答必须受原文约束，后续评测须校准这些案例。

## 更新与回滚

将新 SQLite 快照以新文件名保存到 `POLICY_DATA_DIR`，不要覆盖正在打开的文件。离线构建两个匹配集合后，校验整套数据。将占位集合名替换成构建器输出，并使用实际快照文件名。`release.py` 检查每个原文/片段关联和预期覆盖范围，索引不完整、哈希、模型版本或切分规则不一致时拒绝发布。

```bash
python3 release.py prepare --database /srv/e-agent/policy-data/policy-build-a.sqlite --documents DOCUMENT_COLLECTION --passages PASSAGE_COLLECTION --chroma-url http://127.0.0.1:8002 --output /srv/e-agent/policy-data/release-a.json
python3 release.py activate --manifest /srv/e-agent/policy-data/release-a.json --chroma-url http://127.0.0.1:8002 --env-output /srv/e-agent/policy-data/selected.env
```

准备阶段在快照旁写入新清单。激活阶段重新校验整套关联后，才原子替换 `selected.env`，不调用 Docker。清单记录 SQLite 构建标识/哈希、两个集合及数量、Embedding 版本/维度、距离算法、输入版本和切分版本。模型容器还须单独固定到该权重版本；Embedding 协议不能证明模型别名实际加载了哪些权重。

校验和代表性查询通过后，由维护者执行 `docker compose --env-file .env --env-file /srv/e-agent/policy-data/selected.env up -d --wait --no-deps --force-recreate policy-api`，仅重建 API 容器。第二个环境文件选择快照和 `/app/data/release-a.json`，API 从清单确定两个集合。回滚时用保留的清单再次执行 `release.py activate` 和相同 API 命令，成套选择旧 SQLite 与两个索引。在需要回滚期间保留相关快照、集合、凭据及兼容代码。生产部署与本地临时库测试分开，须在合并后验证。

DGX 上的服务只绑定内网地址。HTTP 传输用于可信内网；跨不可信网络时应先部署 HTTPS 或 SSH 隧道。访问令牌授予查询权限，应通过私密渠道分发给协作者。
