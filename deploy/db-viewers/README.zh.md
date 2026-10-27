---
description: "为 A、B 两种部署配置共享的 DGX 数据库浏览页面，包含只读访问、登录、容器维护与隔离验证。"
---

# DGX 数据库可视化

[English](README.md) | 中文

## 概要

项目只有 A（DGX Harness）和 B（本地 Harness 连接 DGX）两种部署方式。两者的数据库均在 DGX，因此只部署本目录这一套可视化组件。DGX 使用独立 Compose 项目，不修改 Harness、检索 API、数据库或模型的启动配置。下文的本地查看器用于浏览独立的开发快照。

## 目录

- [组件与访问范围](#components)
- [Windows 本地 SQLite 快照](#local)
- [Windows 本地向量数据库](#local-vector)
- [在 DGX 准备配置](#prepare)
- [构建、启动与验证](#start)
- [更新、停止与排查](#maintain)
- [隔离测试与上游版本](#tests)

<a id="components"></a>

## 组件与访问范围

| 组件 | 页面与默认端口 | 数据来源 |
| --- | --- | --- |
| Datasette | SQLite 表浏览、分页和只读 SQL；18101 | 只读绑定现有 SQLite 快照 |
| Nginx＋ChromaDB UI | 集合、记录、元数据和向量查询；18102 | 经同源网关访问现有 Chroma V2 API |

两个页面使用同一份独立的 HTTP Basic 登录文件。网关只转发 SQLite 的 GET/HEAD，以及 Chroma 的读取、`get` 和 `query` 请求；创建、更新、删除、重置和其他 API 均被拒绝。登录凭据不会转发到 Chroma。服务以非 root 用户运行，根文件系统只读，日志轮转。

该组件不占用 GPU，不导入或复制语料，不创建 Chroma 集合，也不重建向量。它用于查看数据；RAG 主题检索继续使用 `policy_search` 和检索 API。

<a id="local"></a>

## Windows 本地 SQLite 快照

本地离线查看器采用相同的 Datasette 0.65.5 界面，仅绑定 `127.0.0.1:18101`，无需登录。它以 immutable 只读模式打开 `data/policy-combined-local-20261022-r2.sqlite`：2,045 份文件、187,087 个正文单元。数据库页面提供地域数量统计和带参数的标题搜索。它不连接 DGX 或 Chroma，也不改变 Harness 的数据库配置。

在仓库根目录的 PowerShell 中，使用 Python 3.10 或更新版本安装一次，然后启动或停止隐藏的后台进程：

```powershell
python -m venv .dsh-build/local-db-viewer-venv
.dsh-build/local-db-viewer-venv/Scripts/python.exe -m pip install datasette==0.65.5
./deploy/db-viewers/local-sqlite.ps1
./deploy/db-viewers/local-sqlite.ps1 -Stop
```

打开 <http://127.0.0.1:18101/policy-combined-local-20261022-r2>。`documents` 包含元数据和完整正文；`content_units` 包含按顺序排列的正文单元。表格可按 `region` 等字段过滤，自定义 SQL 仅允许读取。启动和停止均可用 `-Port 18103` 指定其他端口；端口被占用时拒绝启动。PID 和日志保存在 `.dsh-build/local-db-viewer-<port>.*`；停止时核实记录的进程身份。重建快照后需要重启，immutable 连接不会跟踪文件变动。

<a id="local-vector"></a>

## Windows 本地向量数据库

本地查看器使用与 DGX 相同的固定版本 ChromaDB UI，隐藏写入控件。它仅绑定 `127.0.0.1:18102`，无需登录，打开已完成的 `data/policy-combined-local-vectors-r2` 构建：2,045 条文件向量、126,804 条正文向量。读取适配器只暴露清单中的两个集合，拒绝 API 写入。浏览已有向量无需连接 DGX，也不占用 GPU。

使用[本地向量构建](../local-vectors/README.zh.md)中的 Python 环境，并安装带 npm 的 Node.js。在仓库根目录先构建一次前端，再启动隐藏的后台进程：

```powershell
.dsh-build/local-vector-venv/Scripts/python.exe -X utf8 deploy/db-viewers/build-local-chroma-ui.py
./deploy/db-viewers/local-chroma.ps1
```

打开 <http://127.0.0.1:18102/>，点击 **Connect to Chroma**，选择集合。可以浏览文本和元数据、展开记录，或点击 **Vector** 查看 2,560 维数值及范数。每批最多加载 500 条，顶部 Previous/Next 按钮切换批次；表格搜索和元数据筛选仅作用于当前批次。Query Viewer 接受数值向量，不从文本生成向量。自然语言检索请先停止查看器，再使用所链接的查询命令。

```powershell
./deploy/db-viewers/local-chroma.ps1 -Stop
```

构建、验证、从其他嵌入式客户端查询或替换向量库前，先停止查看器。不要让多个进程同时打开这个本地 Chroma 目录。启动和停止均可用 `-Port 18104` 指定其他端口，端口被占用时拒绝启动。PID、停止信号和日志使用 `.dsh-build/local-chroma-viewer-<port>.*`。前端构建会校验 DGX 网关 Dockerfile 中记录的压缩包哈希，无需安装 Docker。

<a id="prepare"></a>

## 在 DGX 准备配置

需要 Docker Engine、Docker Compose V2、Python 3 和 OpenSSL，以及已运行的 Chroma V2 服务。操作账号需要 Docker 权限；没有权限时，按服务器规范使用 sudo。以下命令从 DGX 的仓库根目录执行。

```bash
cp deploy/db-viewers/.env.example deploy/db-viewers/.env
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 700 /srv/e-agent/db-viewers-secrets
python3 deploy/db-viewers/prepare.py --username viewer --output /srv/e-agent/db-viewers-secrets/viewers.htpasswd
```

脚本交互式输入并确认至少 12 字符的密码，只保存带随机盐的 SHA-512 crypt 哈希，不把密码放入命令行或 Git；已有文件会拒绝覆盖。私有父目录权限为 700，哈希文件可由容器中的非 root 用户读取。请将此账号与 SSH、检索 API 及模型凭据分开管理。

编辑 `deploy/db-viewers/.env`，至少核对下面各项；完整模板见 [.env.example](.env.example)。`.env` 和登录文件不会提交到 Git。

| 配置 | 当前 DGX 示例 | 含义 |
| --- | --- | --- |
| `VIEWERS_BIND_ADDRESS` | `172.27.153.44` | 绑定 DGX 内网 IP；不要填其他电脑的 IP |
| `POLICY_SQLITE_FILE` | `/srv/e-agent/policy-data/policy-national-v1.sqlite` | 必须是已有文件，且与检索 API 使用的快照一致 |
| `VIEWERS_HTPASSWD_FILE` | `/srv/e-agent/db-viewers-secrets/viewers.htpasswd` | 上一步生成的登录文件 |
| `POLICY_RETRIEVAL_NETWORK` | `policy-retrieval` | Chroma 已连接的外部 Docker 网络 |
| `CHROMA_UPSTREAM` | `chroma:8000` | 该网络内的 Chroma 容器名和容器端口 |
| `SQLITE_VIEWER_PORT` / `CHROMA_VIEWER_PORT` | `18101` / `18102` | DGX 对浏览器开放的端口 |

确认 `docker network inspect policy-retrieval` 中包含 Chroma。网关通过容器网络连接 Chroma，不需要把当前仅绑定宿主机回环的 8002 端口开放到内网，也不需要修改 Chroma CORS。SQLite 的父目录和文件必须允许 UID 1000 读取；使用服务已选定的完整快照，不挂载还在写入中的构建产物。

<a id="start"></a>

## 构建、启动与验证

```bash
cd deploy/db-viewers
docker compose config --quiet
docker compose build
docker compose up -d --wait
docker compose ps
curl -I http://172.27.153.44:18101/
curl -I http://172.27.153.44:18102/
```

未登录时两个页面应返回 HTTP 401；浏览器输入上面设置的账号密码后应加载页面。可视化登录保护不提供 TLS：当前地址用于可信内网；跨不可信网络访问时，应通过 HTTPS 反向代理或 SSH 隧道。

打开 SQLite 页面后选择 `policy` 数据库，可以浏览表、查看字段、筛选行和执行 SELECT 查询。默认每页 50 条、最多返回 1000 行，SQL 执行时间限制为 1500 ms；数据库文件下载被禁用。对大表尽量使用筛选条件。

打开 Chroma 页面，连接地址默认是当前页面来源，租户和数据库选择 `default_tenant`、`default_database`。连接后选择现有集合；每批最多取 500 条，通过顶部上一批、下一批切换。表格筛选只作用于已加载批次。上游页面仍显示部分写入按钮，提交后网关返回 403，不会修改真实集合。

向量查询默认使用已有 Embedding 向量的 JSON 输入，维度和模型应与所选集合一致。这里没有接入文本自动向量化，也不默认配置外部模型密钥；普通中文主题问题仍通过 Harness 的政策查询工具完成。

<a id="maintain"></a>

## 更新、停止与排查

更新页面代码后重新构建并创建容器。SQLite 快照路径改变或同名文件被替换时，也必须重新创建容器，以免绑定挂载继续指向旧文件。只重启 Harness 不会更新可视化。

```bash
cd deploy/db-viewers
docker compose build
docker compose up -d --force-recreate --wait
docker compose logs --tail 60
docker compose down
```

最后一条命令仅停止本项目的可视化容器和内部网络，不停止 Chroma、检索 API 或 Harness，也不删除它们的数据。修改密码时用脚本生成新的登录文件，将 `.env` 指向新文件并重新创建容器；不要覆盖正在使用的文件。

如果页面打不开，先检查容器健康、绑定 IP、端口与内网路由。此前 DGX 的代理 TUN 曾使跨网段回复走错出口；应排查实际路由，不在本组件中自动改代理。HTTP 401 表示需要正确的可视化账号；写操作 HTTP 403 是预期限制。构建失败时检查 Docker 镜像源和 GitHub、npm、PyPI 连通性，可通过模板中的镜像参数选择服务器已验证的源。

<a id="tests"></a>

## 隔离测试与上游版本

从仓库根目录执行以下测试；它使用临时 SQLite、模拟 Chroma、随机 Compose 名称和 Docker 分配的回环端口，不读取线上数据。失败时也等待容器与网络清理完成。

```bash
python3 deploy/db-viewers/smoke-test.py --build
```

测试验证登录、SQLite 浏览与禁止写入、Chroma V2 读取与查询、写接口阻断、凭据不转发和原数据库不变。GitHub Actions 在 ARM64 runner 上运行同一测试；模拟服务测试不等于对所有 Chroma 版本的兼容性保证。

Datasette 固定为 0.65.5；[ChromaDB UI](https://github.com/BlackyDrum/chromadb-ui) 固定到 Dockerfile 中指定的上游提交和 SHA-256 归档校验值，MIT 许可证随镜像保留。构建补丁仅调整同源地址、连接探测、默认向量输入和批量浏览；若上游标记改变，构建会失败。升级时同时更新固定版本、校验值、补丁与隔离测试，不跟随 latest 自动更新。

## 开发备注

无。
