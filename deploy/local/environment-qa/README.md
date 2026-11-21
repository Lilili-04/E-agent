# 本地环境问答

本地 Harness 在 3080 提供「环境政策法规问答」和「环境技能问答」。法规预设让模型调用原文检索、读取和沿革工具，每轮共享 10 次工具调用。技能预设自带[建设项目环评预审](skills/eia-preflight/README.md)，还可加载用户提供的本机技能目录。

先安装 Harness 依赖和环评工具的 Python 依赖。配置 `POLICY_V2_DB_PATH`、`POLICY_V2_SEMANTIC_CONFIG_PATH`、`POLICY_V2_VECTOR_MANIFEST_PATH`、`POLICY_V2_GRAPH_CONFIG_PATH` 和 `POLICY_V2_LATEST_MANIFEST_PATH`，指向相互匹配的原文库、语义服务配置和数据清单。按本机连接方式设置 `DGX_QWEN36_API_KEY`。默认模型接口为 `http://127.0.0.1:18010/v1`，启动前先建立本机到 DGX 的转发。网页搜索需要 `DEEPSEEK_API_KEY`，网页抓取默认启用。

从仓库根目录启动。首次访问使用启动日志给出的私有登录地址。

```powershell
./deploy/local/environment-qa/start.ps1
```

检查合成配置时使用 `-DumpConfig`。通过 `-ExtraSkillsDir` 可加载已有的化学品、申报或调查填报等本地技能。凭据、法规库、图谱快照、样本报告、会话和生成配置由部署方在本地管理。
