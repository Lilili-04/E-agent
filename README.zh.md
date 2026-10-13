# 基于 DSH 的国家级环境政策法规问答系统

[English](README.en.md) | 中文

本项目基于 DeepSeek Harness（DSH），提供国家级中文环境政策法规、标准、规划和政策文件问答。用户在本地 Harness 中提问，系统检索法规原文，再由模型组织带来源的回答。

**默认部署方式：本地运行 Harness，DGX 上通过 Docker 运行检索 API、只读 SQLite、Chroma 向量数据库和 Qwen3 embedding 服务。** 使用远程库的协作者不需要在自己的电脑上保存数据库或 MinerU 解析结果。

## 系统链路

```text
User → Local Harness → policy_search → DGX retrieval API → Source evidence → Local Agent
     ← Cited answer  ← Source evidence ← Query planning / retrieval

DGX retrieval API
  ├─ SQLite: exact lookup / body BM25 / source text
  └─ Qwen3 embedding → Chroma: document vectors / passage vectors → SQLite source text
```

本地 Harness 负责界面、Agent、模型调用和来源展示；DGX 负责查询规划、检索、排序及证据限长。数据库保存法规原文、元数据、正文单元、description 和检索词。模型接收有限原文证据，description 仅辅助发现文档，不能替代原文。

## 当前能力和语料

- 明确法规标题、文号或条款时，优先定位对应文件和正文条目。
- 按主题发现文件，结合标题检索、BM25 正文检索、文档向量与正文分段向量召回。
- 返回目录中记录的发布日期和效力状态。
- 用户未询问历史时，工具优先保留最新版本；明确询问历史时再返回版本信息。
- 回答附法规标题、发布日期、条款或章节等来源信息。

当前索引包含 **494 份国家级文件、61,455 个正文单元**，数据库约 **835 MiB**。SQLite、原始语料、令牌和本机启动配置均不随 Git 提交。

## 已有工作区：启动或重启

在仓库根目录执行：

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-web.patch.yml --no-open
```

本机的 `environment-policy-web.patch.yml` 已配置为远程库模式，接口地址为 `http://172.27.153.44:18080`，令牌从 `.dsh-build/dgx-policy.token` 读取。不要在 README、启动命令或 Git 中明文填写令牌。

打开 DSH 输出的认证地址，通常使用 `http://127.0.0.1:3080`。DGX API 端口 `18080` 用于检索；本地 `3080` 是 Harness 页面，两者用途不同。

依赖和构建产物齐全时，重启只需上述命令。不要每次重复安装或构建；只有依赖变化、构建产物缺失或需要重新生成构建产物时才执行对应步骤。

## 新协作者：需要准备什么

| 内容 | 获取方式 |
| --- | --- |
| 项目代码 | 克隆 Git 仓库 |
| 运行环境 | Windows、macOS 或 Linux；Node.js 22.x（至少 22.19）或 24 及以上版本；pnpm 11 或更高版本 |
| 模型配置 | 在 Harness 的模型设置中配置可用模型和凭据 |
| DGX 接口 | 能访问服务器所在内网，向部署负责人获取接口地址 |
| 查询令牌 | 通过私密渠道获取，保存为本机令牌文件 |
| 启动配置 | 准备适合本机仓库目录的 Agent preset 和启动 patch |

**新克隆的仓库不会包含 `.dsh-build/`。** 当前工作区的 patch 使用本机源码绝对路径，不能原样复制到另一台电脑。部署负责人可按 [远程插件组合](packages/experimental/environment-policy/presets/environment-policy-remote.cordis.yml) 配置协作者的 preset；完整配置说明见 [DGX 部署指南](packages/experimental/environment-policy/deploy/README.zh.md)。

只使用远程检索服务时，协作者需要代码、模型配置、接口、令牌和启动配置，**不需要额外下载 SQLite、policy_md 或 MinerU 输出**。参与语料处理或索引构建时，再单独准备对应数据。

首次准备依赖和构建产物：

```powershell
pnpm install --frozen-lockfile
pnpm run build
```

完成本机启动配置后，使用前面的启动命令。尽量在同一个交互式终端中完成安装、构建和启动。Codex 执行环境与用户终端的 Node、pnpm 和依赖链接状态可能不同；缺少 `node_modules/.modules.yaml` 时，pnpm 可能重新检查并链接整个 workspace，导致启动变慢。

## 目录与部署说明

```text
packages/experimental/environment-policy/src/       Query planner, SQLite and remote providers, tool
packages/experimental/environment-policy/deploy/    Docker API, Compose and deployment guide
packages/experimental/environment-policy/presets/   Local and remote plugin groups
scripts/environment-policy-build-index.ts           Index builder
data/README.md                                     Index inputs and local database preparation
.dsh-build/                                         Machine-specific patches and token; ignored by Git
```

检索实现说明见 [环境政策法规插件](packages/experimental/environment-policy/README.zh.md)。Docker 配置、鉴权接口、数据库更新和 DGX 维护命令统一放在 [DGX 部署指南](packages/experimental/environment-policy/deploy/README.zh.md)。

## 本地索引构建与回滚

本地 SQLite 模式用于独立开发、建库或主动回滚。该模式需要单独准备 `data/policy-national-v1.sqlite`；原始 Markdown、清单、元数据和 description 等构建输入见 [数据准备说明](data/README.zh.md)。

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

构建脚本默认将数据库和清单写入 `data/`。需要使用其他资料位置时，传入 `--inventory`、`--metadata`、`--descriptions`、`--output`、`--manifest` 和 `--source-root` 等参数。

本机已保留本地库回滚配置。停止当前 Harness 后，可用下面的命令选择本地库：

```powershell
pnpm dsh web --patch .dsh-build/environment-policy-local-web.patch.yml --no-open
```

远程服务不可用时会返回错误，不自动混用本地旧库。切换数据库部署方式不需要改动问答工具接口。

## 验证和排查

```powershell
node_modules/.bin/vitest.cmd run packages/experimental/environment-policy/tests
node_modules/.bin/tsc.cmd -p packages/experimental/environment-policy/tsconfig.json --noEmit
```

| 现象 | 检查位置 |
| --- | --- |
| 无法连接 DGX | 内网连接、接口地址及服务器 `/health` |
| HTTP 401 | 令牌文件是否存在、令牌是否与服务器一致 |
| 缺少启动 patch | `.dsh-build/` 不在 Git 中，先准备本机配置 |
| 启动明显变慢 | 是否重复安装或构建、依赖链接是否完整、终端运行环境是否一致 |
| 查询缺少证据 | 法规库是否收录该文件，以及实际返回的正文条目 |

测试包含查询规划、SQLite、真实 HTTP API、鉴权和远程工具组合；远程集成测试会临时启动本机 HTTP 服务。

## 当前范围

语料目前覆盖国家级文件，尚未纳入省级文件。效力状态回答使用目录元数据；系统不独立认定法律效力。精确查询使用 SQLite；普通问题并行使用词法与向量检索，语义超时后返回词法证据。DGX API 容器不占用 GPU，embedding 由独立 GPU 服务提供；回答模型仍由本地 Harness 配置决定。配置与限制见 [部署指南](packages/experimental/environment-policy/deploy/README.zh.md)。

## 相关文档

- [DGX Docker 部署、接口和回滚](packages/experimental/environment-policy/deploy/README.zh.md)
- [环境政策法规插件](packages/experimental/environment-policy/README.zh.md)
- [数据和索引准备](data/README.zh.md)
- [环境政策法规知识问答实施方案](.agents/notes/proposed/feature/2026-09-25-environment-policy-qa.zh.md)

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
