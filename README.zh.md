# 基于 DSH 的国家级环境政策法规问答系统

[English](README.md) | 中文

本项目基于 DeepSeek Harness（DSH）的插件架构，面向国家级中文环境政策法规、标准、规划和政策文件提供知识问答能力。

系统从本地 SQLite 索引中检索证据，再由 DSH agent 用自然语言组织答案。检索和生成分开处理：模型只接收有限长度的原文证据和引用元数据，索引和语料由部署者在本地管理。

## 当前问答能力

- 回答条款问题，例如“《中华人民共和国海洋环境保护法》第一条是什么？”
- 按主题查找法规，例如查询海洋保护、水污染、固体废物、城市排水等相关国家级文件。
- 查询元数据中记录的发布日期和效力状态。
- 用户没有询问历史时优先使用最新版本；用户明确询问历史时再返回修订版本信息。
- 结合标题精确匹配、元数据检索、BM25 全文检索和有限证据筛选。
- 在答案中列出文件名、发布日期、条款或章节位置和原文证据。

当前本地索引包含 494 份国家级文件和 61,455 个解析后的正文单元。索引是生成的本地数据产物，出于体积和部署原因不会上传到 GitHub。

## 项目目录

```text
packages/experimental/environment-policy/   Environment policy service, query planner, tools, and preset
data/README.md                              Local index preparation instructions
scripts/environment-policy-build-index.ts   SQLite index builder
data/policy-national-v1.sqlite              Local database, ignored by Git
.dsh-build/environment-policy-web.patch.yml Local launch overlay, ignored by Git
```

## 运行环境

- Windows、macOS 或 Linux
- Node.js 22.19 或更高版本
- pnpm 11 或更高版本
- 本地 `data/policy-national-v1.sqlite` 索引

数据库是体积较大的生成产物，不包含在仓库中。请把已有索引放在 `data/policy-national-v1.sqlite`，或者按照 [data/README.zh.md](data/README.zh.md) 使用本地语料重新构建。

## 本地启动

在仓库根目录执行：

```powershell
pnpm install
pnpm run build
pnpm dsh web --patch .dsh-build/environment-policy-web.patch.yml --no-open
```

打开 DSH 输出的地址，通常是 `http://127.0.0.1:3080`。启动 overlay 会把环境政策 SQLite 服务和 `policy_search` 工具挂载到环境政策问答 preset 中。

preset 使用仓库相对路径 `./data/policy-national-v1.sqlite`。请从仓库根目录启动 DSH，确保相对路径能够正确解析。

## 构建或替换本地索引

默认构建命令会把数据库和清单写入 `data/`：

```powershell
node --experimental-strip-types scripts/environment-policy-build-index.ts
```

输入文件属于本地语料产物。如果文件位于其他位置，可以使用 `--inventory`、`--metadata`、`--descriptions`、`--output`、`--manifest` 和 `--source-root` 参数。默认记录的资料根目录标识为 `data/policy_md/national`，可避免把本机绝对路径写入生成清单。

## 验证实现

```powershell
node_modules/.bin/vitest.cmd run packages/experimental/environment-policy/tests/query.spec.ts packages/experimental/environment-policy/tests/database.spec.ts packages/experimental/environment-policy/tests/service.spec.ts
node_modules/.bin/tsc.cmd -p packages/experimental/environment-policy/tsconfig.json --noEmit
node_modules/.bin/tsc.cmd -p tsconfig.host.json --noEmit
```

## 当前范围和限制

- 当前语料覆盖国家级文件，暂未纳入省级文件。
- 效力状态回答使用政策元数据中的记录，系统不独立出具法律意见。
- 新克隆的仓库需要单独准备 SQLite 索引。
- 涉及合规或法律决定时，应回到原始文件核验。

## 相关文档

- [环境政策法规插件说明](packages/experimental/environment-policy/README.zh.md)
- [环境政策法规知识问答实施方案](.agents/notes/proposed/feature/2026-09-25-environment-policy-qa.zh.md)

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
