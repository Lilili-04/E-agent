# DGX 环境政策数据库部署

[English](README.md) | 中文

本部署将只读 SQLite 索引与检索 API 放在 DGX 的 Docker 容器中。本地 Harness 保留界面、Agent 和模型调用，`policy_search` 通过内网请求返回原文证据。检索 API 容器不需要 GPU；语义检索调用 DGX 上独立的 GPU embedding 容器，不提供数据库写入接口。

## 服务与数据

```text
Harness → policy_search → remote-service → DGX API
                                            ├─ SQLite: metadata / BM25 / source text
                                            └─ Qwen3 embedding → Chroma → SQLite source text
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

数据库已保存原文、内容单元、元数据、description 和检索词。精确与词法查询只需要 SQLite 文件；混合查询额外使用 Chroma 的持久化索引和 Qwen3 embedding 服务，不需要传输 MinerU 输出目录。重新构建索引仍需要原始 Markdown 和相应构建输入。

## Docker 配置

将包的 `src/database.ts`、`src/query.ts`、`src/query-store.ts`、`src/hybrid-store.ts`、`.dockerignore` 和 `deploy/` 部署到 `/srv/e-agent/policy-api`，数据库放入上述数据目录。以 `deploy/.env.example` 为模板创建 `deploy/.env`，并将至少 32 字符的随机令牌写入对应令牌文件。令牌文件不加入 Git。

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

已知文件名、文号和条款直接读取 SQLite，跳过 GPU。普通问题同时执行正文 BM25 与语义召回；一次问题 embedding 供文档和正文两种向量查询共用，最多缓存 256 个问题。文档向量定位候选文件，正文向量定位分段；所有证据均回读 SQLite 原文。多路结果按名次融合，同一法规保留多条证据并共用引用编号。

`policy-retrieval` 是三个容器共用的 Docker 网络。Chroma 和 embedding 的 Compose 文件须将服务加入该外部网络；API 使用容器名访问 `http://chroma:8000` 与 `http://vllm-qwen3-embedding-4b:8000`。现有 Chroma 的主机端口仍绑定 `127.0.0.1:8002`。

`deploy/.env.example` 列出全部语义配置。`POLICY_DOCUMENT_COLLECTION` 指向已有 combined 文档集合，`POLICY_PASSAGE_COLLECTION` 指向本次构建的正文集合。文档候选上限 12、正文候选上限 32；文档集合实际使用平方 L2 距离，默认上限 0.9；正文集合使用余弦距离，默认上限 0.45。阈值是可调整参数，不表示法律判断的置信度。清空两个集合名称即可使用 SQLite 检索。

语义检索预算默认 2000 毫秒，失败或超时会返回同一远程 SQLite 的词法结果和 `semantic-unavailable` 警告。远程 API 本身不可用时，本地 Harness 仍明确报错。`diagnostics` 提供规划、词法、语义和总耗时，并标明是否调用语义链路；这些耗时不包含 Agent 生成回答。

正文索引构建脚本 [build-passages.py](build-passages.py) 在 DGX 上读取只读 SQLite，通过已有 embedding API 将条款和段落按 1200 个 Unicode 字符、120 字符重叠写入新的余弦集合；脚本可按分段 ID 续建，全部写入后才生成 `passage-manifest.json`。当前脚本的 DB、服务地址、模型、分段和批量参数在文件顶部；构建其他环境时须先调整。SQLite 更新后须重建对应正文集合并同步配置，禁止混用不同 buildId 的索引。

## 本地 Harness

本机访问令牌保存在 `.dsh-build/dgx-policy.token`。本地远程启动配置 `.dsh-build/environment-policy-remote-web.patch.yml` 读取该文件，无需在命令中明文填写令牌。

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-remote-web.patch.yml --no-open
```

供其他开发者使用的通用插件组合见 [environment-policy-remote.cordis.yml](../presets/environment-policy-remote.cordis.yml)。设置 `DGX_POLICY_API_URL` 和 `DGX_POLICY_API_TOKEN_FILE` 可修改接口地址和本机令牌文件。插件默认请求超时为 8 秒，可通过 `timeoutMs` 修改。

原有本地库启动组合保留为 `.dsh-build/environment-policy-local-web.patch.yml`，用于主动回滚。远程失败不会自动混用本地数据库。

## HTTP 接口

`GET /health` 不需要令牌，返回健康状态与数据库构建标识。`GET /v1/policy/manifest` 返回完整构建清单，需要 `Authorization: Bearer <token>`。`POST /v1/policy/search` 使用同一鉴权，支持下列请求：

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

上传新的数据库时先写入临时文件并验证 SHA-256，再停止本项目容器、保留旧库、更换数据库文件并重新启动。禁止直接改写正在使用的 SQLite 文件。通过健康接口、构建清单和代表性查询确认更新；失败时恢复旧文件和对应代码版本。

DGX 上的服务只绑定内网地址。HTTP 传输用于可信内网；跨不可信网络时应先部署 HTTPS 或 SSH 隧道。访问令牌授予查询权限，应通过私密渠道分发给协作者。
