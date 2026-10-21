# 在 DGX 上运行环境政策法规 Harness

[English](dgx-deployment.md) | 中文

新版由 Harness 容器直接执行检索，SQLite 从宿主机只读挂载，Chroma、Embedding、问答模型分别维护。配置位于 [deploy/dgx](../../../deploy/dgx)，预设位于 [environment-policy-dgx.patch.yml](../../../apps/cli/config/examples/environment-policy-dgx.patch.yml)。

## 部署结构

```text
Browser → Harness container (Agent, policy_search, policy_read, BM25, fusion)
                  ├─ /policy-data → Host SQLite and legacy-vector mapping (read-only)
                  ├─ Chroma container
                  ├─ Embedding model container
                  └─ Answer model container
```

Harness 镜像不包含业务数据、模型权重和凭据。旧检索 API 可继续供旧客户端使用，新预设不调用它。SQLite 不暴露 SQL 服务端口。仅更新 Harness 不会更新 Chroma 或模型。

## 数据库可视化

数据库可视化仍使用 [DGX 独立浏览组件](../../../deploy/db-viewers/README.zh.md)。切换 SQLite 后，维护者须将可视化只读挂载指向同一份新快照。

## 准备服务器

服务器需要 Docker Engine、Compose、ARM64 Node 构建环境和外部 `policy-retrieval` 网络。Harness 使用 CPU。Chroma、Embedding、问答模型须已在该网络运行。不要复制 Windows node_modules 或私有启动配置到 Linux。

复制 `deploy/dgx/.env.example` 为私有 `.env`，设置发布 IP、`HARNESS_TRUSTED_HOSTS`、UID 1000 可写的状态和工作区目录，以及 UID 1000 可读的模型密钥文件 `QWEN_API_KEY_FILE`。不再需要旧政策 API 的密钥。

`POLICY_V2_DATA_DIR` 指向单独发布的数据目录，包含 `POLICY_V2_DB_FILE`（默认 `policy-v2-national.sqlite`）和 `POLICY_V2_COMPATIBILITY_FILE`（默认 `policy-v2-documents.compat.json`）。两者由同一次离线导入生成，必须一起发布；不能把旧 v1 SQLite 改名代替。只有宿主机目录被挂载，文件不进入镜像或 Git。建库见 [插件说明](../../../packages/experimental/environment-policy/README.zh.md)。本地原文路径仅供溯源，线上读取直接使用 SQLite 全文，不需要 Windows 路径可访问。

配置 `POLICY_EMBEDDING_URL`、`POLICY_CHROMA_URL`、`POLICY_EMBEDDING_MODEL`、`POLICY_DOCUMENT_COLLECTION` 和 `POLICY_PASSAGE_COLLECTION`。默认 URL 使用 Docker 名称和内部端口。集合名称必须来自已存在的国家级索引，向量命中须通过构建版本和原文映射校验。`POLICY_SEMANTIC_TIMEOUT_MS` 默认 5000。启动时把配置写到私有状态目录，不写业务数据目录。

## 构建和启动

```bash
cd deploy/dgx
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose ps
docker compose logs --tail 30 harness
```

应用文件系统和数据挂载保持只读；`/tmp:exec,mode=1777` 供原生辅助程序使用。启动先检查数据与密钥文件可读，再生成部署配置并通过 `dsh web` profile 启动。网页健康检查验证监听，不替代一次真实政策问答。

首次打开终端日志中的认证链接，使用所配置的发布地址和端口；认证信息仅私下传递。新建会话选择“环境政策法规问答”。默认 DGX 模型 `qwen3.6-35b-a3b-vllm`，上下文 196608、最大输出 2048、关闭思考。已有会话可能保留旧预设；同一实例共享会话和工作区，不提供多租户隔离。

## 本地 Harness 连接 DGX 数据

本地[远程预设](../../../apps/cli/config/examples/environment-policy-remote-dgx.patch.yml)使用 Qwen3.6 和 v2 HTTP search/read。SQLite、向量与检索均在 DGX 执行，本地保留会话和网页应用，不需要 SQLite 快照。旧 18080 API 不兼容 v2 分页。

构建更新镜像后，启用可选 [API 覆盖配置](../../../deploy/dgx/docker-compose.policy-api.yml)。`POLICY_V2_API_TOKEN_FILE` 指向 UID 1000 可读的私有 token 文件，至少包含 32 个随机字符；通过安全渠道将相同内容传至本地 `.dsh-build/dgx-policy-v2.token`。18081 仅发布到 DGX 内网地址。应用覆盖配置时保留已有 Compose 模型覆盖文件，重建 Harness 前检查合并配置，确保 Qwen3.6 模型覆盖继续生效。

```bash
docker compose -f docker-compose.yml -f docker-compose.policy-api.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.policy-api.yml up -d --wait --no-deps harness
```

以上命令对应全新安装；已有 `docker-compose.override.yml` 时，必须在 API 覆盖文件之前用 `-f` 一并指定。已有覆盖命令中若还包含模型 patch，须保留它，并把 API patch 放在模型 patch 之后。API 使用与网页检索相同的数据库挂载和语义配置。

Windows 本地将模型密钥私下保存到 `.dsh-build/qwen-api.key`。依赖与包构建准备好后，从仓库根目录执行以下命令。启动先检查 v2 鉴权状态和 Qwen3.6 模型，再在 `127.0.0.1:3080` 运行本地 Web profile；使用本次启动的认证链接。脚本不会终止已有监听进程。新会话使用远程 v2 预设，旧会话可能保留之前的模型选择。

```powershell
./deploy/local/start-policy-web.ps1
```

## 重启、更新和回滚

配置和数据未变化时运行 `docker compose restart harness`。代码更新后重建镜像，再 `docker compose up -d --wait --no-deps harness`。保留旧镜像和旧数据目录；切换数据时同时切换 SQLite 与映射目录。回滚须恢复兼容的镜像、数据目录和状态备份。禁止用自动重建向量或重置数据库代替版本切换。

## 验证和排查

验证一条指定条号查询、一个主题问题，以及一个两页以上的全文读取。`policy_read` 必须连续读取到 `has_more=false`。只看到网页正常或 BM25 命中，不代表向量和模型正常。

| 现象 | 检查 |
| --- | --- |
| 容器启动即退出 | 两个数据文件存在且 UID 1000 可读；模型密钥非空；浏览器 Host 已配置 |
| 找不到新工具 | 新建会话、检查预设和镜像版本，不能沿用旧 remote-service 配置 |
| 语义检索降级 | Chroma/Embedding 网络、模型名、集合名、构建 ID 与原文哈希映射 |
| 模型失败 | Qwen 健康状态、模型名、密钥和带 `/v1` 的地址 |
| 网页无法连接 | 发布 IP/端口、Host/Origin 与当前进程认证链接 |

源码回归包括插件测试、部署配置测试和构建后 Web profile 检查；ARM64 镜像构建与独立数据夹具启动由 GitHub CI 执行。合并后需由维护者更新 DGX，不会自动部署。旧 API 维护说明保留在 [旧部署指南](../../../packages/experimental/environment-policy/deploy/README.zh.md)。
