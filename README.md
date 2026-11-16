# 历史网页时点协商与版本证据采集

这是面向资料接收人员的 Node.js 服务。提供人工收件与按历史时点的自动采集：自动采集只依据来源给出的时间目录挑选不晚于目标时点的最近版本，并把原网页标识、归档表示和实际观察时间分开保管。核对时的当前网页只作为参照，不会被当成历史事实。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口、来源行为与历史采集。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口展示人工收件、历史采集、时间入口晚于目标、目录不完整与两站同日不同内容，结束即清理，通常只需数秒。

## 容器

`docker build -t time-negotiation:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 time-negotiation:local` 启动。环境准备后，`docker run --rm --network none time-negotiation:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查。正式展示应从干净归档启动真实功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部版本，`GET /api/resolutions` 查询按来源、原网页与日期的核对记录，`GET /health` 检查进程。人工记录身份字段为 original, capture。同一身份与相同原文重复提交复用版本，内容变化保留旧版本；不同来源不能混淆。归档目录有按摘要保存的 blobs、按业务身份保存的 receipts，以及按核对范围保存的 journal。

### 自动采集

`POST /api/collect` 接受：

```json
{ "source": "http://127.0.0.1:4200", "datetime": "2026-10-15T00:00:00Z", "original": "/original/loan" }
```

- `source` 可为单个地址或地址数组；不同归档站各自贡献证据，互不覆盖。
- `datetime` 必须是带时区的 RFC3339 时刻，或只写 `YYYY-MM-DD` 表示按 UTC 整天核对（截止当日 23:59:59.999Z，不会跨入次日）。
- `original` 可选，用于确认目录声明的原网页与业务一致；`includeOriginal: false` 可跳过当前网页参照。

处理顺序：读取 `/timeline`；只保留目录时间不晚于目标的条目；从最近的目录时刻向前逐组取回，取得可用正文即停止；每个条目沿跳转取回，最终正文自己的 `Memento-Datetime` 才是它声明的历史时点，跳转响应里的时间不作数。最终声明晚于目标的正文一律拒绝。

状态与含义：

| 状态 | outcome | code | 含义 |
| --- | --- | --- | --- |
| 201 | collected | collected | 已选定不晚于目标的最近版本 |
| 409 | divergent | same_instant_divergence | 同一时刻有不同正文，已并列保存，未任选其一 |
| 409 | unavailable | representation_after_target | 候选正文取回后声明晚于目标，未存为历史事实 |
| 422 | unavailable | directory_incomplete | 目录 complete=false，无法确认更早是否还有版本 |
| 404 | unavailable | no_version_at_or_before_target | 目录完整且目标时点及以前确实没有版本 |
| 502 | unavailable | no_retrievable_version | 有目录条目但没有任何正文能按其声明取回 |

响应里分别给出：`originalPages`（核对当时的当前网页，`historical: false`，字节单独存 blob）、`timeEntries`（来源时间入口的返回，若晚于目标会标记 `afterTarget: true` 且不采用）、`evidence`（归档表示，含目录时刻、正文声明时刻、观察时刻、版本与 blob 摘要）、`rejected`（取回失败或晚于目标的候选及原因）、`warnings`（目录不完整、退回到更早版本、跳转中重新协商时间、并列证据缺失等）。`resolution` 说明本次与同一来源、原网页、日期上一次核对相比是沿用（`reused: true`）还是改变，并给出原因码与文字解释。

重复核对同一日期：正文与归档时刻相同则复用版本并追加观察时间；正文变化则在同一身份下新增版本，旧版本与旧 blob 保留。核对过程记录在 `GET /api/resolutions`。

## 目录

`src/` 为收件、传输与历史采集（`timepoint.mjs` 负责时间与链接解释，`collect.mjs` 负责目录选择与取证），`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`。
