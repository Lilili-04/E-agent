# DGX 合并库部署

[English](README.md) | 中文

本部署在一台 DGX 上运行已准入的全国与省级合并 SQLite、现有 Chroma 向量及 Neo4j。后端检索并整理原文证据，模型规划保持关闭。Qwen3.6 和 Embedding 使用已有独立服务。

## 发布目录

在独立的版本目录中分别保存 `source/`、`release/`、`state/`、`workspace/` 和 `graph-data/`。`release/` 包含 `policy.sqlite`、`latest.json`、含构建清单的 `vectors/`，以及 `graph/graph.json` 和 `graph/source-config.json`。使用相同数据库版本将完整 Neo4j 存储恢复到 `graph-data/`。保留原发布目录和全部向量缓存。

Harness 通过回环地址17475端口的内部代理查询图谱；只读向量接口18104保持内部使用。需要认证的 Neo4j Browser 和 Bolt 仅绑定 `NEO4J_BIND_ADDRESS`，端口分别为17475和17687。原生 HTTP 还绑定内部回环地址17476端口。内部代理从挂载的凭据文件读取认证信息，无需修改 Harness 图谱配置。Harness 只读挂载数据目录；向量适配器需要可写的 Chroma 副本供初始化，但接口只开放读取。

## 启动与验证

在私有环境文件中设置 Compose 变量：`HARNESS_IMAGE`、`SOURCE_REVISION`、`RELEASE_DIR`、`STATE_DIR`、`WORKSPACE_DIR`、`GRAPH_DATA_DIR`、`QWEN_API_KEY_FILE`、`HARNESS_BIND_ADDRESS` 、`HARNESS_TRUSTED_HOSTS`、`DGX_QWEN_API_BASE_URL` 、`VIEWERS_HTPASSWD_FILE`、`NEO4J_BIND_ADDRESS`（DGX 网卡地址）和 `GRAPH_BACKEND_AUTH_FILE`。先使用 `HARNESS_PORT=3081`，可信主机配置包含该端口。模型密钥保留在挂载的私有文件中。`prepare.mjs` 校验 SQLite 和图谱摘要，并在私有状态目录生成 Linux 路径及回环接口配置。

```sh
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml config --quiet
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml build
docker compose --env-file /private/combined.env -f deploy/dgx-combined/compose.yml up -d
node --test deploy/dgx-combined/prepare.test.mjs
```

切换前验证 SQLite 完整性和摘要、全部向量数量与维度及代表性查询、Neo4j 数量与索引及图谱快照投影、网页登录，以及完整法规知识题回归。保留实际回答、原文证据和逐题评审；部署验收不代表所有回答都正确。

## Neo4j 登录

开放网络入口前设置现有 `neo4j` 用户的密码；`NEO4J_AUTH` 不会替换已有数据库密码。登录信息不进入 Git。`GRAPH_BACKEND_AUTH_FILE` 只包含一行 `Basic <base64(username:password)>` 请求头，由容器 UID 1000 读取。该文件等同密码。每次改密后同步更新文件并重启 `graph-backend`，否则 Harness 图谱查询会失败。

打开 `http://<DGX地址>:17475/browser/`，连接 `bolt://<DGX地址>:17687` 并登录。当前连接在部署网络内使用未加密传输。验证未登录查询返回401、认证后的 HTTP 和 Bolt 返回预期图谱数量、Browser 展示示例路径，以及 Harness 回环查询正常。内部代理没有独立登录，仅供可信本机进程使用，不限制 Cypher 为只读。Neo4j Community 默认账号有修改权限，浏览时使用读取语句。

## 法规沿革查看器

只读法规沿革页面位于 `http://<DGX地址>:18103/`，与 SQLite、Chroma 查看器共用 Basic 登录。内部 Python 服务仅监听回环地址18106端口，通过现有图谱代理执行固定 Neo4j 查询，从只读挂载的 SQLite 读取原文。名称、文号与地区用于筛选目录；版本关系、法规关联、时间线和来源行号高亮沿用原 G6 页面。资料选择器不包含另一个实例中的旧规则参考图。

`HISTORY_VIEWER_DATA_DIR` 指向可迁移的查看器证据目录，`POLICY_SQLITE_SHA256` 设置为已准入数据库摘要。保留九个 SDK 图谱分区的原始查看器元数据、审查决定、台账及八份补充原件。补充资料清单使用相对证据目录的路径；启动前按 `viewer-files-manifest.json` 核验全部文件。这些运行时证据文件不进入 Git。`history-viewer` 和 `history-gateway` 可以独立重建，停止它们不影响 Harness 及数据库。网关对 HTML、脚本和全部接口要求登录，并拒绝写入；不提供任意 Cypher 执行接口。

## 备份、切换与恢复

迁移前私密保存旧容器配置与重启策略，导出镜像，保留实际源码及本机覆盖文件，在停止写入进程后备份全部挂载数据库和状态目录。检查归档和 SQLite 完整性后，恢复旧部署，直到新版本验收。

验收后停止旧应用、数据库与查看器容器，将其重启策略设为 `no`，再将新版 Harness 重建到3080端口。保留旧容器、镜像、数据、凭据和已验证的备份。查看器切换到新快照与只读向量适配器。独立模型服务保持运行。回滚时停止新服务，恢复记录的旧重启策略，依次启动旧数据服务、Harness 和查看器，重新验证登录和真实查询。切换与恢复均不得删除数据卷。

仅提交源码、测试、部署文件和文档。数据库、凭据、登录地址、私有环境文件、会话及备份归档不进入 Git。
