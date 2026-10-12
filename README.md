# CS2 Market Data

公开、小规模、可追溯的 CS2 行情归档基础。目标仓库：`zfy06011/cs2-market-data`。

**当前没有正式行情、没有冻结选品名单、没有启用定时任务。** 已实现受控测试和采集/归档流程；源码首次推送、云端检查、来源审核和真实采集仍须完成。当前配置默认关闭行情来源，手动运行将保存阻塞状态并以非零状态结束，不生成伪行情。

## 存储与执行

- `main`：程序、配置、测试及 `docs/HANDOFF.md`。
- `data`：独立历史分支，由首次获准的云端运行自动创建，无代码工作流。
- 正式采集只在本仓库 main 的 GitHub Actions 手动/已配置定时事件执行；本机仅开发与受控测试。
- 每批由 GitHub run ID 标识，重跑同一已归档 run 不重复请求行情。已归档失败批次如需重试，用新的手动运行保留前次事实。
- 断点恢复读取最新完整冷却快照；限流时立即持久化状态。无法保存冷却则停止本次任务，不能继续请求。
- 追加通过 GitHub Git Data API 完成，限定 `data` 分支及路径，不使用 force 更新。出现并发写冲突停止，交由下一次运行读回后恢复。

| 路径 | 内容 |
|---|---|
| `pool/frozen-v1.json` | 一次冻结的 15 项名单、时间与版本 |
| `selection/YYYY/MM/DD/RUN.json` | 当时首页可见的箱/胶囊及原始顺序；不是成交量榜 |
| `quotes/YYYY/MM/DD/RUN.jsonl` | 每项 C5 报价、Steam 买单及失败状态 |
| `runs/YYYY/MM/DD/RUN.json` | 运行、源码版本、配置摘要、覆盖和容量状态 |
| `state/YYYY/MM/DD/TIME-RUN-NNN.json` | 完整冷却与最近请求时间快照 |
| `index/RUN.json` | 已归档运行索引，跨日期重跑去重 |

写入后逐文件读回核对。历史修正需要人工确认并追加更正，不修改旧文件。超过六个月暂停名单继续使用，不能自动重选。

## 启用顺序

1. 推送 main 并通过 `Collector checks`。首次可手动运行验证云端数据分支与阻塞归档，但这不算真实行情通过。
2. 核对来源访问条件、再分发依据及收费；审核 `config/collection.json` 的 source 开关、公开证据 URL、审核日期、每月成本，确认后提交。没有依据保持关闭。
3. 用户在 Settings → Secrets and variables → Actions 设置 `C5_APP_KEY`。不向聊天、命令行或代码填写 key。
4. 现有 Steam 首页仅展示 10 条，2026-10-12 只读核查得到 8 箱、0 胶囊，不够 15 项；严格保留阻塞。改变榜单或范围须先由用户确认。本程序不通过查询参数伪称扩大了同一个热门榜。
5. 校验 CNY 买单与数量、C5 买价与数量和精确商品映射；填写已验证费用参数及版本。Steam `itemordershistogram` 适配器是网页使用接口，不宣称为有稳定保障的个人官方 API；来源审核前不请求它。
6. 完成真实手动运行和下次读回。用户指定北京时间后，将 `schedule.enabled`、`timeAsiaShanghai` 与 workflow 的 UTC cron 一起更新，经确认推送。错过时段记录实际缺测，不伪造历史。

仓库脚本没有模拟数据生产开关。测试通过内存模拟接口，不写 GitHub；不允许给生产 CLI 加入模拟 provider。

## 数据含义

C5 `onSaleCount` 为在售数量，Steam `topLevelQuantity` 为最高买单这一档的数量，均不等于成交量。只读取显式 CNY 买单，不以最低卖价替代。价格为整数分，未知费用保持未核实，报价模拟不证明账户可售或订单成交。收到物品后的真实限制由后续使用者另行核对。

后续研究目标是 7 天余额兑换效率、每种 1 件；至少 90 天积累及冻结模型后 8 周观察，均值相对基线提高 2% 且最差 20% 不恶化，并经独立评估和用户确认才启用。此次不提供预测、交易和 Android 功能。

## 成本、存储与运行限制

[GitHub 官方计费文档](https://docs.github.com/en/billing/concepts/product-billing/github-actions)说明公开仓库的标准托管运行器执行分钟免费。本项目使用 `ubuntu-latest`，不上传 Actions artifacts、不启用缓存或大型运行器；行情接口费用仍未核实，必须纳入每月 10 元总上限。不开启额外付费。

每次报告数据树文件数及字节数，达到 100 MiB 提醒人工复核；这是当前文件体积，不是 Git 历史体积。每月人工检查仓库整体大小、历史增长和账号实际费用，不自动清理。[GitHub 仓库容量建议](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)。

公开仓库的定时工作流可能因长期无仓库活动自动停用，调度也可能延迟；`data` 的每日提交通常提供活动，但仍需每月核对 Actions 是否启用以及最新成功/失败记录。不要把计划时间当作实际采集时间。

## 开发检查

Node.js 24，无运行时 npm 依赖：

```text
npm run check
npm test
```

完整校验在生产 Secret 注入前运行。外部 PR 只有只读受控检查，采集没有 push/PR 触发器，追加不会触发 Android 或递归任务。

## 来源

整数手续费算法、请求间隔和退避思路改编自用户自己的 [cs2-balance-mobile-ui](https://github.com/zfy06011/cs2-balance-mobile-ui/tree/af51ed1879aff9fa33b78b34cba14cadb78b8e4d)。本仓库未复制其他项目的库实现，也未自动授予市场数据再分发许可。

- [C5 批量在售价接口](https://opendoc.c5game.com/api-125914570)
- [Steam 市场首页](https://steamcommunity.com/market/)
- [Steam 市场 FAQ](https://help.steampowered.com/en/faqs/view/61f0-72b7-9a18-c70b)
- [Steam 合作方市场 API 访问限制](https://partner.steamgames.com/doc/webapi/IEconMarketService)

来源页面可读、程序实现、云端可访问及获准公开再分发是不同条件，不能相互代替。
