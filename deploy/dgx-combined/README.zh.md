# DGX 合并库部署

[English](README.md) | 中文

本部署在一台 DGX 上运行已准入的全国与省级合并 SQLite、现有 Chroma 向量及 Neo4j。后端检索并整理原文证据，模型规划保持关闭。Qwen3.6 和 Embedding 使用已有独立服务。

## 发布目录

在独立的版本目录中分别保存 `source/`、`release/`、`state/`、`workspace/` 和 `graph-data/`。`release/` 包含 `policy.sqlite`、`latest.json`、含构建清单的 `vectors/`，以及 `graph/graph.json` 和 `graph/source-config.json`。使用相同数据库版本将完整 Neo4j 存储恢复到 `graph-data/`。保留原发布目录和全部向量缓存。

部署使用 Linux 主机网络，使图谱接口和只读向量适配器仅监听回环地址。Harness 只读挂载数据目录。向量适配器需要可写的 Chroma 副本供库初始化，但接口只开放读取。不要向外开放17475和18104端口。

## 启动与验证

在私有环境文件中设置 Compose 变量：`HARNESS_IMAGE`、`SOURCE_REVISION`、`RELEASE_DIR`、`STATE_DIR`、`WORKSPACE_DIR`、`GRAPH_DATA_DIR`、`QWEN_API_KEY_FILE`、`HARNESS_BIND_ADDRESS` 、`HARNESS_TRUSTED_HOSTS`、`DGX_QWEN_API_BASE_URL` 和 `VIEWERS_HTPASSWD_FILE`。先使用 `HARNESS_PORT=3081`，可信主机配置包含该端口。模型密钥保留在挂载的私有文件中。`prepare.mjs` 校验 SQLite 和图谱摘要，并在私有状态目录生成 Linux 路径及回环接口配置。

```sh
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml config --quiet
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml build
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml up -d
node --test deploy/dgx-combined/prepare.test.mjs
```

切换前验证 SQLite 完整性和摘要、全部向量数量与维度及代表性查询、Neo4j 数量与索引及图谱快照投影、网页登录，以及完整法规知识题回归。保留实际回答、原文证据和逐题评审；部署验收不代表所有回答都正确。

## 备份、切换与恢复

迁移前私密保存旧容器配置与重启策略，导出镜像，保留实际源码及本机覆盖文件，在停止写入进程后备份全部挂载数据库和状态目录。检查归档和 SQLite 完整性后，恢复旧部署，直到新版本验收。

验收后停止旧应用、数据库与查看器容器，将其重启策略设为 `no`，再将新版 Harness 重建到3080端口。保留旧容器、镜像、数据、凭据和已验证的备份。查看器切换到新快照与只读向量适配器。独立模型服务保持运行。回滚时停止新服务，恢复记录的旧重启策略，依次启动旧数据服务、Harness 和查看器，重新验证登录和真实查询。切换与恢复均不得删除数据卷。

仅提交源码、测试、部署文件和文档。数据库、凭据、登录地址、私有环境文件、会话及备份归档不进入 Git。
