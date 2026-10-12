# 当前任务：公开 GitHub 行情归档基础

2026-10-12，计划已由用户明确确认并要求实施。执行者 Codex / pwsh 7 / Node 24.15.0。代码目标 `zfy06011/cs2-market-data:main`，数据目标 `data`。基准为新仓库初始化；来源参考 `cs2-balance-mobile-ui@af51ed1879aff9fa33b78b34cba14cadb78b8e4d`。公开空仓库已创建，源码与受控检查已完成，提交标识以本地 HEAD 为准；**未推送、未运行云端工作流、无正式行情**。

## 已确认计划

- GitHub Actions 采集，GitHub data 分支长期保存；电脑仅开发和测试，不作为正式行情存储。
- Steam 市场首页热门榜顺序取 10 箱＋5 胶囊，固定六个月，不替换失效项，不自动改榜。
- main 代码/配置推送逐次确认。唯一例外是已审核程序自动向 data 的限定目录追加公开行情和运行记录；不覆盖历史，不改代码或应用仓库。
- 用户决定采集时间，尚未给出时间，因此不启用定时。每次最多 30 分钟，服务总费用每月不超过 10 元。
- 本次只做数据基础，不做模型和 Android。后续保留 7 天预测、每种 1 件、90 天积累＋冻结模型后 8 周观察、均值相对改善至少 2% 且最差 20% 不恶化的研究目标，人工确认模型替换。

## 实现结果

- 通过 GitHub REST 创建 `https://github.com/zfy06011/cs2-market-data`：HTTP 201，owner `zfy06011`，`private=false`。随后匿名 GET 无尾斜线的仓库 API 得到 HTTP 200，`default_branch=main`。未初始化远端源码文件。
- 本地独立源码目录 `D:\Codex\cs2-market-data`，不修改 `D:\Codex\cs2-balance-mobile`；后者仍在 codex/mvp 且工作区干净。
- 零运行时 npm 依赖。实现受控金额解析、整数手续费、严格 C5 映射、Steam 最高买单及档位数量适配、同来源间隔/限流/退避、来源审核与预算开关、冻结选品。
- Git Data API 归档固定仓库和 data 分支，仅追加白名单内普通文件。检查公开属性、写入冲突和读回内容；同 run ID 归档完成后重跑不重复行情请求。限流状态立即云端追加，保存失败停止采集。
- 首次获准的云端手动运行会自动建立 data 分支；无需将包含代码的 main 直接复制为 data。没有合格行情时只保存阻塞/状态记录，不写模拟报价。
- 工作流：main push / PR 的只读检查；独立 workflow_dispatch 采集。无 schedule，无 PR 采集，无 Android 构建，无 artifact/cache 上传。采集前先运行受控检查，只有采集步骤注入生产凭证。
- GitHub Actions 的 checkout/setup-node 固定为经 `git ls-remote` 核对的 v4 SHA。后续云端兼容性仍须实际 CI 验证，不把本地测试当成云端通过。
- 源码配置明确保持 Steam/C5 来源关闭、费用未核实。来源审核 URL、日期、收费及费用配置均未伪填。

## 检查与证据

- `npm run check`：四个模块语法检查通过。
- `npm test`：22/22 通过，0 失败/跳过。全部是受控内存数据，未请求真实行情、未写 GitHub 正式数据。
- 测试含：原始 JSON 金额精度、买卖单/币种/数量、固定池和六个月边界、429 跨运行恢复、5xx 上限、请求合并、凭证脱敏、追加/去重/冲突、Git Data API 创建与追加及拒绝 force、外部 PR 隔离、端到端模拟配对、冷却保存失败停止。
- 只读市场结构核查：Steam 首页 HTTP 200，当前热门区 10 项：8 箱、0 胶囊；另有 TF2 钥匙及终端商品。没有保存原始 HTML、Cookie 或账户数据，也未构造虚假的 15 项名单。
- 只读官方 market.js 包含 `Market_LoadOrderSpread` / `itemordershistogram`，仅证明网页使用这些结构，**不证明稳定个人 API、云端可访问或公开再分发许可**。
- [GitHub 计费文档](https://docs.github.com/en/billing/concepts/product-billing/github-actions)确认公开仓库标准托管运行器分钟免费。本项目不使用收费大型运行器和 artifact/cache；C5 接口费用未核实，暂不启用，不声称所有成本均已验证。

## 当前阻塞及接续

1. **首次源码推送待用户确认**：目标 `zfy06011/cs2-market-data:main`，推送会触发 Collector checks（Node 语法及测试），不会自动采集或构建 APK。main 代码修改仍按用户计划逐次确认。
2. 推送后可手动执行默认关闭来源的运行，验证 data 创建、状态归档和随后读回；这只能证明基础设施，不算真实行情成功。默认阻塞运行退出码 2，不能为显示绿色而伪称通过。
3. 热门首页当前不足 10 箱＋5 胶囊。按已确认范围保持阻塞。若用户更改榜单、数量或分类，先记录明确变更后实施。
4. 行情来源的自动访问/再分发依据及费用仍须核实；仅把公开可访问作为事实。审核后再经确认更新 config 开关。Steam 买单 adapter 的真实云端解析仍 NOT TESTED。
5. 不知道新仓库是否已配置 `C5_APP_KEY`，本轮未读取、迁移或上传旧项目凭证。用户在新仓库 Secrets 自行设置；费用模型与 C5 额外买入费需有依据后启用，不能把未知设成 0。
6. 用户尚未决定每日具体时间。真实手动采集和跨运行读回通过后，再把 config 时间与 UTC cron 一起更新并确认推送；未给时间前不选默认时间。
7. 源码与测试可以交付；**长期采集尚未投入运行，首批真实行情、定时运行及公开数据适用性均未通过**。未付费，未新增 Android 功能，未修改账号全局计费设置。

## 工具能力

本轮已验证本地源码读写、Node 检查、Git 本地操作、GitHub 账号查询和创建仓库；认证使用已有 Git Credential Manager，仅在进程内向 api.github.com 发送凭证，不输出或保存 token。GitHub 连接器可读取仓库与 CI；本机无 gh 命令。没有安装 Android 工具链。
