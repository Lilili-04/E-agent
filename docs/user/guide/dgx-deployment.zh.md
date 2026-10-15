# 在 DGX 上运行环境政策法规 Harness

[English](dgx-deployment.md) | 中文

本指南在 DGX 上用独立 Docker 容器运行 Web 界面和 Agent。浏览器连接该容器；检索 API 协调基于 SQLite 原文数据和 Chroma 索引的关键词、语义通道。SQLite 是嵌入式原文数据库，不是网络服务；逻辑职责与容器部署分别说明。配置位于 [deploy/dgx](../../../deploy/dgx)，可复用的 Agent 预设位于 [environment-policy-dgx.patch.yml](../../../apps/cli/config/examples/environment-policy-dgx.patch.yml)。

## 部署结构

Harness 镜像只包含应用代码和依赖，不包含语料、SQLite 文件、向量索引、模型权重或凭据。

| 组件 | 容器 | 持久化数据 / 接口 |
| --- | --- | --- |
| Web 界面和 Agent | 新的 Harness Compose 项目 | 独立的 Harness 状态和工作区目录；浏览器端口 3080 |
| 检索服务 | 已有 `e-agent-policy-api` | 协调召回，只读打开独立持久化的 SQLite 原文快照；Docker 内部 HTTP 8080 |
| 语义检索索引 | 已有 `chroma` | 独立目录保存可重建的向量和原文标识；Docker 内部 HTTP 8000 |
| Embedding 模型 | 已有 `vllm-qwen3-embedding-4b` | 自己的模型目录；Docker 内部 HTTP 8000 |
| 回答模型 | 已有 `vllm-qwen38-27b` | 自己的模型目录；Docker 内部 OpenAI 兼容 HTTP 8000 |

SQLite 是嵌入式数据库，由独立的检索 API 容器只读打开，不对外暴露 SQL 数据库端口。Harness 不挂载该数据库。更新或停止 Harness Compose 项目不会更新、重启或删除上述四个已有服务及其数据。它们的配置仍由[检索部署指南](../../../packages/experimental/environment-policy/deploy/README.zh.md)维护。

```text
Browser → Harness container → policy API container → candidate recall / fusion → SQLite source evidence
                  │                    └→ lexical indexes + embedding / Chroma semantic indexes
                  └→ Qwen generation container → cited answer
```

## 准备服务器

使用安装了 Docker Engine 和 Compose 插件的 ARM64 Linux DGX，预留源码构建磁盘空间，并确保能访问 Node 镜像、Debian 软件源和 npm registry。Harness 容器使用 CPU，不申请 GPU。已有容器应已运行，并加入外部 `policy-retrieval` 网络。

在仓库根目录创建私有状态和凭据目录。UID/GID 1000 应与容器内的 `node` 用户一致；下面的命令复制两个已有凭据，不修改原文件。

```bash
cp deploy/dgx/.env.example deploy/dgx/.env
sudo install -d -o 1000 -g 1000 -m 700 /srv/e-agent/harness-state /srv/e-agent/harness-workspace /srv/e-agent/harness-secrets
sudo install -o 1000 -g 1000 -m 400 /srv/e-agent/policy-api/.secrets/policy-token /srv/e-agent/harness-secrets/policy-token
sudo install -o 1000 -g 1000 -m 400 /home/health/vllm/qwen38/.secrets/qwen38-api-key /srv/e-agent/harness-secrets/qwen-api-key
docker network inspect policy-retrieval
```

按目标机器修改 `deploy/dgx/.env`。`HARNESS_BIND_ADDRESS` 是宿主机内网 IP；`HARNESS_TRUSTED_HOSTS` 是逗号分隔的浏览器访问地址，包含发布端口，例如 `172.27.153.44:3080`。使用反向代理时，加入代理的访问地址。默认内部服务地址使用 Docker 容器名和内部端口，而不是宿主机发布的端口。凭据变量只填写宿主机文件路径，不把密钥贴入该文件或 YAML。`.env`、状态、工作区和凭据目录均被 Git 忽略，并排除在构建上下文之外。启动时生成 `/state/dsh/deployment/dgx.patch.yml`，其中模型端点是普通字符串，只保存凭据引用；部署参数应在 `.env` 或源码模板中修改，因为生成的配置会在重启时覆盖。

当前 DGX 示例使用检索 API `http://e-agent-policy-api:8080` 和模型 API `http://vllm-qwen38-27b:8000/v1`。Docker 网络、服务名称或部署目录不同时，需相应修改 `.env`。不要把 Windows 的 `.dsh-build` 配置或 Windows `node_modules` 复制到服务器。

## 构建和启动

在 `deploy/dgx` 执行以下命令。镜像安装锁定的 Linux 依赖，构建应用和原生辅助程序，再通过受支持的 `dsh web` profile 启动；不下载或启动数据库及模型。

构建上下文包含 Host 类型检查所需的快照辅助模块及其类型声明，以及镜像启动测试使用的 Vitest 配置；录制的会话数据仍被排除。修改 `.dockerignore` 时应保留这些构建输入。

应用文件系统保持只读。原生模块加载器和子进程辅助程序需要加载或执行临时文件，因此 `/tmp` 的 tmpfs 允许执行；沿用 Docker 对该挂载默认设置的 `noexec` 会导致启动失败。Compose 配置应保留 `/tmp:exec,mode=1777`。

```bash
cd deploy/dgx
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose ps
docker compose logs --tail 30 harness
```

启动日志打印带当前进程认证信息的地址。内网直连时，保留该地址的 token，使用 `http://<HARNESS_BIND_ADDRESS>:<HARNESS_PORT>/?token=...`；不要公开分享日志或带令牌的链接。Docker 专用配置监听容器网络接口，Compose 仅向选定的宿主机 IP 发布端口。Host/Origin 校验和进程令牌仍启用，该配置不改变 CLI 默认只监听本机的行为。跨不可信网络时使用 HTTPS 或 SSH 隧道。

首次打开页面时，添加 `/workspace` 为工作区。新会话预设为**环境政策法规问答**，默认模型为 **Qwen3.8-27B（DGX NVFP4）**，模型 ID 为 `qwen3.8-27b`，上下文 32768，最大输出 2048，关闭思考。日期上下文已启用，用于查询当前效力状态。已保存的设置及已有会话可以保留自己的模型选择。同一实例的所有使用者共享会话、设置和工作区，不提供多租户隔离。

## 重启、更新和回滚

在 `deploy/dgx` 使用以下命令。`restart` 复用当前镜像，源码变化后才需要重建。更新前记录当前镜像 ID，并保留旧镜像。Harness 状态和工作区应与检索数据库、Chroma 索引分别备份。

```bash
docker compose restart harness
docker compose images
export HARNESS_SOURCE_REVISION="$(git rev-parse HEAD)"
docker compose build
docker compose up -d --wait --no-deps harness
```

回滚应用代码时，在 `.env` 中将 `HARNESS_IMAGE` 设为保留的旧镜像标签，再执行 `docker compose up -d --no-build --wait harness`。应用版本改变持久化格式时，应恢复兼容的状态备份。`docker compose stop harness` 只停止当前 Harness，不停止检索或模型 Compose 项目。Harness 升级不应伴随数据库重置或向量重建。

## 验证和排查

分别检查页面、一次政策查询，以及已有检索和模型服务。容器健康检查要求未认证的首页请求返回 HTTP 401，在保留浏览器认证的同时验证 Web 监听，但不代表下游服务或模型凭据一定可用。镜像冒烟测试使用临时启动令牌换取浏览器 Cookie，并验证认证后的页面返回 HTTP 200。

| 现象 | 检查项 |
| --- | --- |
| 镜像构建失败 | Node 镜像、Debian/npm 连通性、锁定的包管理器和 ARM64 原生构建输出 |
| 容器启动前退出 | 凭据文件非空、UID 1000 可读，以及 `HARNESS_TRUSTED_HOSTS` |
| 浏览器连接被拒绝 | 发布 IP/端口、准确的 Host/Origin 地址，以及当前进程令牌 |
| 检索或模型 HTTP 401 | 两个独立凭据文件及对应上游凭据 |
| 检索不可用 | 已有检索 API 健康状态及 `policy-retrieval` 网络成员关系 |
| 模型不可用 | 已有 Qwen 健康状态、服务模型名，以及带 `/v1` 的基地址 |
| 无法保存状态 | 宿主机目录应已存在，且 UID 1000 可写 |

可选预设也可用于本地源码工作区：设置私有的 `DSH_HOME`，提供 `DGX_POLICY_API_URL`、`DGX_POLICY_API_TOKEN_FILE`、`DGX_QWEN_API_BASE_URL` 和凭据 `DGX_QWEN38_API_KEY`，再运行 `node deploy/dgx/prepare-config.mjs`。启动命令为 `pnpm dsh web --patch <DSH_HOME>/deployment/dgx.patch.yml --no-open`，将占位符替换为实际目录。不要叠加 Docker 专用的 `web.patch.yml`，本地模式保留正常的本机监听。语料准备和检索诊断仍见[检索部署指南](../../../packages/experimental/environment-policy/deploy/README.zh.md)。
