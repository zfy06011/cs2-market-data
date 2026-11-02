# 当前任务：清空旧实现，保留数据与预测研究用途

## 当前任务：先验证 GitHub 云端采集（2026-11-02）

用户要求“先验证能否 GitHub 云端采集”。执行工具 Codex / pwsh 7，工作目录 D:\Codex\cs2-market-data，目标 zfy06011/cs2-market-data:main，本地基准 dcf0234188e02493db43a75b8408e0f68de6f7ad。此前清理仍为未提交状态；本轮准备最小云端探针，不恢复原完整采集器。未修改宇额助手工作区。

范围：固定变革武器箱 ID 4578，最多四次 SMIS 只读请求，验证网页、公开客户端配置、完整商品身份和 360 天历史；仅输出诊断摘要，不留存或公开原始行情，不建 data 分支、不训练。标准 ubuntu-latest / Node 24、contents:read、无 Secrets、无 schedule。推送到 main 后自动触发该探针，也可手动触发。

本地检查：9 / 9 受控测试、脚本语法、工作流 YAML 解析及 diff 检查通过。验证 429 即停、身份错配、格式变化、异常脱敏、本地 CLI 不发真实请求与工作流只读范围。用户已确认将本次清理与探针推送到 zfy06011/cs2-market-data:main 并运行验证。云端结果待本次实际运行，不用本地测试代替。旧清理记录如下。

2026-10-29，用户明确要求“清空仓库，用于以后存储数据，训练预测模型”。执行工具 Codex / pwsh 7，目标仓库 zfy06011/cs2-market-data，本地分支 main，清理基准 dcf0234188e02493db43a75b8408e0f68de6f7ad。

计划已确认并完成：将旧采集程序、配置、测试、package.json、GitHub Actions 和旧文档移到仓库外备份；只保留基础说明、协作规则、交接和 Git 忽略 / 换行设置。未建立新的采集或训练流程。

## 结果与检查

- GitHub 远端本来就是空仓库；本轮再次确认分支列表为空、Actions 运行数为 0，无线上内容需要删除。未推送或修改远端。
- 本地 .github、config、src、tests、docs、package.json、README.md 和 AGENTS.md 共 8 个目标已归档。README / AGENTS / 本交接为新用途重写。
- 仓库外备份：D:\Codex\_archives\cs2-market-data-before-reset-20261029-225246。files 目录保留原文件；repository.bundle 保留原提交与引用，已通过 git bundle verify；manifest.json 记录原 14 个受控文件的 SHA-256，已核对移出的文件摘要。
- Git 历史保留，当前清理尚未提交；HEAD 仍为旧基准，后续不得把旧 HEAD 直接当作已清理版本推送。
- 本轮只验证清理范围、备份与最终文件树，不运行旧采集或训练。

后续先确定数据来源、格式、版本与预测目标，再建设数据写入和训练流程。此前的 10 箱＋5 胶囊、冻结六个月和旧 data 分支目录约定不再作为默认要求。
