# Lighthouse 开源插件安全加固设计

日期：2026-07-13
状态：已确认，待实施计划

## 1. 背景

Lighthouse 浏览器插件即将开源。插件当前通过一个 GraphQL 端点读取任务、
捕获 X 互动、提交验证证明，并支持一键推广和自动复投。开源后，任何人都能
阅读 operation、请求格式和客户端逻辑。因此，客户端代码、GraphQL 字符串、
扩展 ID、设备 ID 和随包发布的密钥都不能作为秘密。

本设计不加密或混淆接口字符串。HTTPS 继续保护传输机密性；后端通过固定
operation 白名单、设备签名、防重放、限流、幂等和服务端动作核验建立安全
边界。

## 2. 目标

1. 保持现有正常流程的界面、用户操作、任务状态、奖励规则和 GraphQL 业务返回
   不变；只在评论完全未捕获时增加评论 URL 证据兜底。
2. 正常用户升级后无须重新学习流程；旧 token 在迁移期自动绑定设备。
3. 阻止 plugin token 调用未授权的 GraphQL operation 或扩大字段选择集。
4. 阻止篡改 variables、复制请求、跨设备复制 token 和重复执行资金 mutation。
5. 插件捕获继续提供快速、精确的证据定位，但不能单独证明 X 动作真实发生。
6. 后端在发奖前核验 X 动作；数据延迟时保持验证中并自动重试。
7. 支持审计、强制和紧急只读三种运行模式，允许安全灰度与快速止损。

## 3. 非目标

1. 不修改插件正常态 UI、任务卡片、推广弹窗、配对页面或成功提示。评论完全未
   捕获时的 URL 证据表单是唯一新增的异常态界面。
2. 不修改任务领取额度、奖励金额、Tier、冷却期或结算规则。
3. 不依赖代码混淆、隐藏域名、CORS origin 或客户端内置对称密钥防作弊。
4. 不把设备签名解释成官方插件远程证明。设备签名只证明请求来自已绑定设备，
   不能证明该设备运行的是未修改源码。
5. 本阶段不引入新的人工审核界面。

## 4. 当前接口边界

插件继续请求现有 `/graphql` 端点。业务 operation 保持不变。

### 4.1 运行期 operation

| 权限组 | Operation | 用途 |
| --- | --- | --- |
| public | `CreateExtensionPairing` | 创建一次性配对槽 |
| public | `PollExtensionPairing` | 轮询配对结果并单次领取 token |
| read | `Me` | 验证 token，读取余额、Tier 和收益 |
| read | `AvailableEngagements` | 读取可参与互动任务 |
| read | `MyReservedEngagements` | 读取已预约互动任务 |
| read | `AvailableTweets` | 读取创作任务 |
| read | `LighthouseMembers` | 批量识别 Lighthouse 成员 |
| capture | `RecordTweetDwell` | 上报推文停留信号 |
| capture | `ReportEngagementCapture` | 上报插件捕获的互动信号 |
| verify | `MintEngagementTicket` | 为已预约任务签发一次性票据 |
| verify | `SubmitEngagementProof` | 提交签名证据并进入验证队列 |
| spend | `PromoteTweet` | 创建推广订单 |
| spend | `CreateAutoReinvestTask` | 创建自动复投任务 |

`CompleteExtensionPairing` 和 `ReserveEngagementSlot` 继续由主站使用 Cookie/JWT
调用，不属于插件 token 接口。

主站新增 `SubmitEngagementCommentEvidence(campaignId, commentUrl)`，只接受用户
Cookie/JWT，不接受 plugin token。它只用于评论完全未捕获时提交评论 URL，并返回
现有验证状态形态；正常插件请求不调用该 operation。

### 4.2 清理的兼容代码

插件不再尝试用 plugin token 调用以下后端已禁止的 operation：

- `ReserveEngagementSlot`
- `VerifyEngagement`
- `MintWatermarkToken`

删除范围包括未使用的 query 常量、旧 `submitTask` 路径、旧 watermark 客户端
分支和对应消息类型。用户可见功能不依赖这些路径。

## 5. 安全架构

### 5.1 固定 operation 清单

构建过程为每个插件 operation 生成清单项：

```text
operationId
operationName
documentSha256
permissionGroup
version
```

operation ID 使用稳定、可版本化的名称，例如：

```text
ext.available-engagements.v1
ext.submit-engagement-proof.v1
ext.promote-tweet.v1
```

插件仍发送现有 GraphQL document 和 variables，同时增加
`x-plugin-operation-id`。后端在进入 resolver 前计算 document SHA-256，并要求
ID、名称、文档哈希和 token 权限组全部匹配。字段增加、别名变化或自由拼接均被
拒绝。

清单由仓库文件生成并纳入测试。生产环境禁止客户端运行时注册 APQ；新增或修改
operation 必须随服务发布。

### 5.2 设备密钥

插件使用 Web Crypto 生成 ECDSA P-256 密钥对：

- 私钥设置为 `extractable: false`，保存在扩展 origin 的 IndexedDB。
- 公钥使用 JWK 格式发送后端。
- `deviceId` 继续使用现有 UUID，但只作为索引，不作为凭证。

后端新增 `PluginDevice` 记录，至少包含：

```text
id
userId
pluginTokenId
deviceId
publicKeyJwk
status
createdAt
lastUsedAt
revokedAt
```

`pluginTokenId + deviceId` 唯一。后端只保存公钥。

新配对在创建 pairing slot 时带上 `deviceId + publicKeyJwk`，主站完成授权后一次性
绑定 token 和设备。插件界面及用户步骤不变。

旧 token 在 `audit` 期允许通过内部安全 operation `RegisterPluginDevice` 自动绑定
一次。绑定事件记录用户、token、设备、IP 和 User-Agent。进入 `enforce` 后，未绑定
token 和新增设备必须重新走现有主站授权，不能只凭 bearer token 注册公钥。

这是唯一的迁移期安全例外：旧 bearer token 在首次绑定前仍可能被持有者抢先绑定。
`RegisterPluginDevice` 因此只在限时 `audit` 窗口开放，每个 token 最多成功一次、
最多尝试 3 次/天；命中异地或异常 IP 时拒绝自动绑定并要求走主站授权。切换
`enforce` 前必须关闭该 operation。无法在“不要求旧用户重新授权”的前提下完全消除
首次绑定风险，因此迁移窗口应尽可能短。

### 5.3 请求签名

除匿名 pairing 请求外，每次请求增加：

```text
x-plugin-operation-id
x-device-id
x-request-timestamp
x-request-nonce
x-device-signature
```

签名原文固定为 UTF-8：

```text
lhdao-plugin-v1\n
operationId\n
documentSha256\n
variablesSha256\n
deviceId\n
timestamp\n
nonce
```

`variablesSha256` 基于递归排序对象键后的 canonical JSON。数组保持原序；
`undefined` 不编码；数字、布尔值、null 和字符串按 JSON 规则编码。

后端验证顺序为：

1. 验证 plugin token 并得到 `userId + pluginTokenId`。
2. 查找启用状态的设备绑定。
3. 验证 operation 清单和权限组。
4. 验证 ECDSA 签名。
5. 要求时间戳与服务器时间相差不超过 120 秒。
6. 用 Redis `SET NX EX 300` 消费
   `plugin:req:{pluginTokenId}:{deviceId}:{nonce}`。
7. 进入现有 resolver 和业务 service。

任一步失败都不执行业务逻辑。

### 5.4 Token 的作用

现有 plugin token 继续作为用户授权和吊销凭证。数据库仍只保存 bcrypt hash。
设备签名使单独复制 `chrome.storage.local` 中的 token 不足以从另一台设备调用
接口。

本阶段不尝试在插件包中保存可解密 token 的固定密钥。设备私钥可以提高 token
被简单导出后的安全性，但不抵御控制本机和插件运行时的攻击者。

## 6. 动作证据与发奖

### 6.1 证据分级

以下信息均视为客户端提供的待核验证据：

- 捕获的 action type
- tweet ID、目标 handle、评论正文
- 捕获时间和停留时长
- engagement ticket、nonce 和 HMAC
- 设备签名

票据、HMAC 和设备签名负责绑定用户、设备、campaign、请求内容和时间，防止传输
篡改及重放。它们不单独证明用户完成了 X 动作。

### 6.2 评论证据

插件在 `CreateTweet` 或 `CreateNoteTweet` 返回成功后解析响应，提取新评论的 tweet
ID。捕获对象和 proof input 增加可选 `resultTweetId`；现有 UI 和业务返回不变。

发奖前，后端按 `resultTweetId` 获取评论并核对：

1. 评论存在且未删除。
2. 作者是用户绑定的 X 账号。
3. `in_reply_to_tweet_id` 等于 campaign 目标推文。
4. 正文满足任务关键字和现有内容规则。
5. 发布时间处于预约后、任务截止前的有效窗口。
6. 同一评论未被其他任务重复使用。

评论 ID 暂不可见时进入重试，不回退为仅信插件正文。

### 6.3 评论完全未捕获的 URL 兜底

当网页通过插件桥查询不到 COMMENT 捕获，或 proof 中没有可验证的
`resultTweetId` 时，验证区不再永久卡在“未检测到动作”，而是显示一个评论 URL
输入框。该表单只出现在异常态，不改变正常捕获流程。

用户提交后，主站用 Cookie/JWT 调用
`SubmitEngagementCommentEvidence(campaignId, commentUrl)`。后端要求当前用户持有该
campaign 的有效预约，不允许 plugin token 调用。后端先执行以下 URL 校验：

1. 只接受 `https://x.com/<handle>/status/<tweetId>` 或
   `https://twitter.com/<handle>/status/<tweetId>`。
2. 拒绝其他协议、域名、路径和缺失 tweet ID 的输入。
3. 去除 query、fragment 和 `/photo/N` 等展示后缀，保存标准 URL 和 tweet ID。
4. URL 中的 handle 只作为提示，不作为作者身份依据。

随后复用 6.2 的服务端评论核验：作者必须是用户绑定的 X 账号，父推文必须是任务
目标，正文和时间必须符合任务要求。URL 对应评论暂未被 Twitter 数据源索引时，
任务保持验证中并自动重试；明确不匹配时返回现有验证失败状态。

服务端记录评论证据的 `campaignId + participantId + userId + tweetId + source +
status`。`source` 为 `PLUGIN_CAPTURE` 或 `USER_URL`。同一 tweet ID 只能有一个已验证
成功的任务归属；竞争提交在事务内判定，失败证据不能抢占或锁死真实评论。

### 6.4 Like、RT 和 Follow

后端继续使用现有 Twitter 验证能力核对绑定账号与目标 tweet/handle。插件提供的
目标 ID 缩小查询范围，但不替代服务端判断。

Twitter API 暂时不可用或数据延迟时，participant 保持验证中，按现有队列重试。
只有得到明确不匹配结果或超过现有验证期限后，才按现有失败流程处理。

### 6.5 插件权威开关

迁移期间，`ENGAGEMENT_VERIFY_MODE` 和 `ENGAGEMENT_FOLLOW_VERIFY_MODE` 的现有
配置仍可读取，但发奖层不允许仅凭客户端 PASS 跳过上述核验。插件 PASS 可以触发
快速核验和减少搜索范围；插件 UNKNOWN 继续使用现有服务端兜底。

## 7. 资金 mutation

`PromoteTweet` 和 `CreateAutoReinvestTask` 的参数、返回和 UI 保持不变。

插件为每次用户提交生成 `x-idempotency-key`。同一次重试复用同一个 key。后端以
`userId + operationId + idempotencyKey` 建立 24 小时幂等记录，并绑定
`variablesSha256`：

- 相同 key、相同 variables 返回第一次结果。
- 相同 key、不同 variables 返回冲突错误。
- 幂等记录必须与扣款和订单创建的事务结果一致。

服务端继续执行现有余额、最低预算和订单规则。安全层不新增面向正常用户的金额
限制；异常频率由限流和审计处理。

## 8. 限流

限流键优先使用 token、设备和 operation，匿名接口使用 IP 和 pairing code。
初始阈值高于插件正常峰值：

| 接口组 | 初始限制 |
| --- | --- |
| `CreateExtensionPairing` | 10 次/分钟/IP |
| `PollExtensionPairing` | 40 次/分钟/code，120 次/分钟/IP |
| read（不含成员查询） | 30 次/分钟/设备/operation |
| `LighthouseMembers` | 120 次/分钟/设备 |
| capture | 120 次/分钟/设备/operation |
| ticket mint / proof submit | 10 次/分钟/用户/campaign/operation |
| spend | 5 次/分钟/用户/operation |

超限返回 429 和 `Retry-After`。插件后台按 `Retry-After` 退避；不新增弹窗。
阈值全部可通过环境配置调整，并记录命中指标。

## 9. 运行模式与兼容

### 9.1 `audit`

- 接受现有未签名请求。
- 对可识别的新版请求执行完整验证。
- 记录缺签名、未知 operation、文档哈希差异、nonce 重放和旧 token 自动绑定。
- 不因安全迁移影响正常用户。

### 9.2 `enforce`

- 只接受清单内 operation。
- 要求有效 token、启用设备、有效签名、时间窗口和未使用 nonce。
- 未绑定设备要求重新走主站配对。
- 所有资金 mutation 要求幂等键。

### 9.3 `emergency-read-only`

- 允许通过完整鉴权的 read operation。
- 拒绝 capture、verify 和 spend 写操作。
- 不提供“关闭签名后继续发奖/扣款”的回退路径。

模式由后端环境变量控制，修改后无需重新构建插件。

## 10. 错误处理

后端对客户端返回稳定错误码，避免泄露签名和清单校验细节：

```text
PLUGIN_SECURITY_REQUIRED
PLUGIN_DEVICE_DENIED
PLUGIN_OPERATION_DENIED
PLUGIN_REQUEST_EXPIRED
PLUGIN_REQUEST_REPLAY
PLUGIN_SIGNATURE_INVALID
PLUGIN_RATE_LIMITED
PLUGIN_IDEMPOTENCY_CONFLICT
COMMENT_EVIDENCE_INVALID
COMMENT_EVIDENCE_REUSED
```

详细失败原因写入结构化安全日志。插件将这些错误映射到现有 token、网络、验证或
推广失败状态，不新增 UI 状态。

读取接口出现安全依赖故障时，可在 `audit` 期按配置放行并告警。`enforce` 期的
verify 和 spend 始终 fail-closed。Twitter 数据源故障不算安全拒绝，而是保持验证中
并重试。

## 11. 审计和指标

每条安全事件至少记录：

```text
timestamp
mode
operationId
operationName
userId
pluginTokenId
deviceId
ipHash
result
reasonCode
latencyMs
```

日志不记录明文 token、私钥、完整签名、评论正文或完整 variables。至少建立以下
指标和告警：

- operation 白名单拒绝率
- 签名失败率和 nonce 重放率
- 未绑定旧 token 数量和自动绑定成功率
- 每 operation 的 429 比例
- proof 提交后服务端动作核验成功、延迟和失败分布
- spend 幂等命中和冲突数
- `audit` 中仍使用旧请求的活跃设备数

## 12. 测试策略

### 12.1 插件单元测试

- canonical JSON 对键顺序稳定，对数组顺序敏感。
- operation document 和 variables 哈希稳定。
- P-256 签名可被测试公钥验证。
- timestamp、nonce、deviceId 和 variables 任一变化都会导致验签失败。
- `CreateTweet`、`CreateNoteTweet` 多种响应形状均能提取评论 tweet ID。
- 429 使用 `Retry-After` 退避。
- spend 重试复用同一个 idempotency key。

### 12.2 后端单元测试

- 13 个业务 operation 和设备注册 operation 的清单均可加载。
- 未登记、哈希不符、权限组不符的 operation 被拒绝。
- 错误设备、过期时间、篡改 variables、错误签名被拒绝。
- nonce 首次通过，第二次拒绝，且 resolver 只执行一次。
- audit、enforce、emergency-read-only 三种模式符合定义。
- 限流按正确维度隔离，不因共享 IP 误伤不同 token。
- 幂等相同请求返回原结果；冲突请求不重复扣款。

### 12.3 验证服务测试

- Like、RT、Follow 目标和绑定账号匹配才通过。
- 评论作者、父推文、正文、时间或复用任一不符都不发奖。
- 评论 URL 只接受 X/Twitter status URL，并归一化为 tweet ID。
- 评论完全未捕获时，Cookie/JWT 用户可提交 URL；plugin token 调用被拒绝。
- 失败 URL 证据不会占用 tweet ID；已验证评论不能被第二个任务复用。
- Twitter 延迟进入重试，后续可成功完成并正常发奖。
- 客户端 proof PASS 但服务端动作不匹配时拒绝。
- 服务端数据源异常时保持验证中，不误发奖也不误判用户失败。

### 12.4 回归测试

- 插件现有 lint、typecheck、单测和 prod/beta build 全部通过。
- 后端相关模块单测通过。
- 13 个现有 operation 的业务响应字段和含义保持一致。
- 配对、任务同步、动作捕获、评论 URL 兜底、验证、推广和复投完成端到端测试。

## 13. 发布顺序

1. 后端发布 operation 清单、设备表、验证器、审计和 `audit` 模式。
2. 发布新版插件和主站异常态表单：生成设备密钥、自动绑定、签名请求、评论 ID
   捕获、评论 URL 兜底和幂等键。
3. 观察至少一个完整发布周期，确认新版覆盖率、签名成功率和 429 水位。
4. 对仍活跃的旧版本给出正常升级窗口；不在插件内新增业务提示。
5. 后端切到 `enforce`。
6. 单独灰度服务端评论精确核验，再覆盖 Like、RT 和 Follow。
7. 确认发奖核验指标稳定后，删除旧插件请求兼容分支。

## 14. 验收标准

实施完成必须同时满足：

1. 正常用户无需新增操作即可完成现有全部插件功能。
2. 现有 13 个业务 operation 的返回契约不变。
3. 复制 token 到未绑定设备无法调用受保护接口。
4. 修改 variables 或 GraphQL 字段后请求被拒绝。
5. 重放 proof 或 spend 请求不会重复执行。
6. 自行构造 `window.postMessage` 捕获不能绕过服务端 X 动作核验。
7. 评论 proof 缺少可验证评论 ID 时不能仅凭正文发奖。
8. 评论完全未捕获时，用户可以提交评论 URL，并由后端完成同等强度核验。
9. Twitter 延迟不造成正常用户立即失败。
10. 推广重试不会重复扣款或重复建单。
11. `audit`、`enforce` 和 `emergency-read-only` 均有自动化测试和可观测指标。
