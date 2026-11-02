# CS2 Market Data

用于后续保存 CS2 市场数据，并开展预测模型训练与评估。

旧采集程序与配置已移出。当前具备 SMIS 云端可用性探针，以及近一年历史首轮试训流程；未启用持续采集或定时训练。

## 近一年历史首轮训练

数据使用 SMIS 的 Steam 聚合在售价、总在售量，沿用供应商人民币展示口径，未独立证明原生币种。源客户端最长支持 360 天；训练截取过去 365 天窗口中的实际记录，单独披露每个商品的覆盖，缺失日不补造。价格和在售量不代表实际成交价、成交量。

- 首批由现有市场身份缓存按类别轮转产生 40 个候选定位符，每项联网核对 appid、完整英文市场名、ID，收满 20 个各至少 180 个有效完整 UTC 日的商品即停止。候选不是完整市场目录或历史时点商品全集；不按回测收益筛选。
- 最多 82 次串行请求，至少间隔三秒；429、访问拒绝、重定向或网络错误停止，无自动重试。不使用账号、Cookie、Secrets；公开客户端配置仅在内存中使用。
- 七个 UTC 自然日后的对数报价变化用 Ridge / HistGradientBoostingRegressor 预测，下跌概率用逻辑回归 / HistGradientBoostingClassifier 预测。共六组固定候选，饰品等权拟合；风险单类别时显式退回历史比例。
- 统一全商品日期边界，28 天验证、28 天最终测试，边界隔离七天。预处理只拟合对应训练段，关闭内部自动早停，只用验证集选模型。
- 评估模型与用全部成熟标签重训的最新模型分别保存。报告输出价格误差、Brier、概率分箱、类别与单品结果、实际时间覆盖、输入和源码哈希；效果不超过基准仍标记为实验结果。

Node 24、Python 3.12；Python 依赖固定于 requirements-training.txt。本地以当前虚拟环境执行：

~~~powershell
node scripts/collect-training-history.mjs --live config/training-cohort.json .local/year-training
.local/venv/Scripts/python.exe training/train.py --input .local/year-training --output .local/year-training/results
~~~

输出目录必须是 .local 内的新目录，防止覆盖已有实验。历史快照、每日数据、模型、预测和报告保存在忽略目录，不进入 Git 提交。测试：

~~~powershell
npm run check
node --check scripts/collect-training-history.mjs
npm test
.local/venv/Scripts/python.exe -m unittest discover -s training -p 'test_*.py' -v
~~~

GitHub 的 Train seven-day quotes from near-year history 工作流仅支持 main 上手动触发，contents:read，无定时任务或仓库写回。新运行会重新抓取历史，结果可能随源数据变化。模型和实验报告作为 Artifact 保留七天，默认不上传历史快照或 dataset.jsonl。云端产物不包含完整重训数据；完整快照在本地实验目录保留，不能把单次报告称为全市场或前瞻验证。

## 云端只读验证

`SMIS cloud connectivity probe` 在 main 的相关代码推送或手动触发时运行。使用公共仓库标准 Ubuntu 托管运行器、Node 24 和 `contents: read`；不使用 Secrets，不启用定时任务，不创建 data 分支，不上传 artifacts。

验证固定商品 Revolution Case（SMIS ID 4578）的 360 天历史，最多四次请求：公开页面、页面引用的脚本、商品身份、历史序列。请求串行且至少间隔三秒；429、403、重定向或格式变化立即停止，不自动重试。

Actions 日志与 Step Summary 只记录阶段、HTTP 状态、源码 SHA、样本数、覆盖区间和失败代码。网页公开客户端的请求配置只在内存中使用，不输出请求头、配置值、原始响应或逐项价格。通过只证明一次已知商品的云端读取与解析，不代表全量覆盖、持续稳定性、公开再分发或训练能力通过。

本机仅运行 `npm run check` 与 `npm test`。`npm run probe:cloud` 要求指定仓库 main 的 GitHub 托管 Linux 环境；本地运行不会发起真实请求。

公开客户端解析思路复用宇额助手本地基准 `a5a67796fbb3d29bde10ab1785383878dafd4575` 的 SMIS 只读适配器，没有新增访问绕过或其他数据源。

后续根据确定的数据来源、字段、更新频率与预测目标建设。公开仓库不存放密钥、账号、Cookie 或私人库存。
