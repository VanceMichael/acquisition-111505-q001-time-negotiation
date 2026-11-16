# 合作来源约定

## 资料边界

时间目录 /timeline 返回 original、entries、complete；条目包含 datetime、uri、capture。/gate 接受 Accept-Datetime，返回 Location、Memento-Datetime 和 Vary；最终 /captures/{capture} 自己的 Memento-Datetime 才是该正文的声明。目录并不按日期排序，时间均为带时区 RFC3339。业务选择不晚于目标的最近时刻；同一时刻的不同摘要是并列证据而非任选一项。complete=false 不能声称全站历史不存在。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/timeline`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

## 历史采集约定

`src/collect.mjs` 把上述约定落实为本地策略，未扩展来源协议：`/timeline` 选择版本，`/gate` 只作为交叉核对，条目地址沿跳转取回。取回时 `Accept-Datetime` 用条目自己的目录时刻，而不是业务目标时点，避免邻近时刻的协商把更晚的版本带进来；记录中保留每一跳的角色（`time-negotiation` 或 `representation`）、状态与各自声明的 Memento-Datetime。保存的正文以其自身声明为准，声明晚于业务目标即拒绝。同一目录时刻的不同摘要在同一轮核对中并列保存，跨归档站也不合并。`Archive.accept` 的 `fingerprint` 让相同正文在重复核对时复用版本并追加观察时间，而不是制造伪版本。
