# Binance Square 互动任务设计

日期：2026-08-03
状态：已确认，待实施计划

## 1. 背景

Lighthouse 当前通过浏览器插件捕获 X 上的点赞、评论、转发和关注动作，并把
插件证据提交给后端验证与结算。平台需要把同一类互动任务扩展到 Binance Square，
首期支持点赞、评论、分享和关注。

Binance Square 暂无可供 Lighthouse 查询指定用户互动状态的公开 API。因此，
Binance Square 任务采用插件权威模式：后端验证插件签名证明和任务约束，不调用
外部平台 API 二次确认动作。

## 2. 目标

1. 支持买方发布 Binance Square 点赞、评论、分享和关注任务。
2. 支持卖方从任务大厅接单、跳转 Binance Square、完成动作并自动提交证明。
3. 复用现有插件设备签名、票据、防重放、冷却、风控和 LUX 结算能力。
4. 保持现有 X 任务行为和服务端 Twitter 核验不变。
5. 将平台差异封装在独立适配器中，避免继续扩大 X 专用字段和大型入口文件。

## 3. 非目标

1. 不调用或保存用户的 Binance Cookie、访问令牌或完整网络请求体。
2. 不宣称插件权威证明等同于 Binance 官方证明或不可篡改远程证明。
3. 不在首期支持原创发帖、引用内容、删除内容后的长期复查或移动端 App。
4. 不用 DOM 按钮颜色或文案单独触发发奖。
5. 不在本阶段删除 `tweetId`、`targetUsername` 或 `RT` 等 X 兼容字段。

## 4. 方案选择

### 4.1 直接复制 X 捕获链

该方案开发快，但会把 Binance 内容 ID 塞进 `tweetId`，并让 X 与 Binance 的内部
接口判断混在同一组文件中。接口变化和错误处理会继续扩大现有入口文件。

### 4.2 平台适配器

X 和 Binance Square 分别实现动作捕获、证据解析和撤销识别；公共层负责消息桥、
任务匹配、证明签名和提交。该方案改动适中，并保留清晰的平台边界。

### 4.3 只检查 DOM

该方案最简单，但页面改版容易失效，也容易被开发者工具伪造，不适合作为资金
发放依据。

采用 4.2。DOM 检查仅用于界面提示和诊断。

## 5. 总体架构

```text
Binance Square 页面动作
  → MAIN World 捕获请求和成功响应
  → Binance Square Adapter 提取白名单字段
  → ISOLATED Bridge 校验消息
  → Background 匹配任务票据和绑定账号
  → 设备私钥签署标准证明
  → 后端校验任务、设备、账号、目标、时间和防重放字段
  → Binance 插件权威核验器
  → 冷却期
  → 现有 LUX 发奖流程
```

插件增加平台适配器目录：

```text
src/platform-adapters/
  shared/            # 标准证据、桥接消息和适配器契约
  x/                 # 包装现有 X 捕获与解析逻辑
  binance-square/    # Binance 请求识别、响应解析和撤销规则
```

X 适配器继续走 Twitter 服务端核验。Binance Square 适配器走插件权威核验。两条
链路共用插件 Token、设备密钥、请求签名和后端结算基础设施。

## 6. 标准证据

```ts
interface PlatformEngagementEvidence {
  platform: 'X' | 'BINANCE_SQUARE'
  actionType: 'LIKE' | 'COMMENT' | 'RT' | 'SHARE' | 'FOLLOW'
  targetContentId?: string
  targetAuthorId?: string
  resultContentId?: string
  actorId: string
  capturedAt: string
}
```

字段约束：

- 点赞必须包含 `targetContentId`。
- 评论必须包含 `targetContentId` 和新生成的评论 ID，后者写入
  `resultContentId`。
- X 转发使用 `RT`，Binance Square 站内转发使用 `SHARE`，两者不
  互相映射。
- Binance Square 分享必须包含原内容 ID 和新生成的站内分享
  内容 ID。“分享”仅指 Square 内部转发；复制链接或分享到外部应用
  不属于本任务。
- 关注必须包含 `targetAuthorId`。
- `actorId` 必须等于当前 Lighthouse 用户绑定的 Binance UID。
- 插件不上传 Cookie、Token、请求头、完整请求体或完整响应体。

`RT` 仅对 `X` 合法，`SHARE` 仅对 `BINANCE_SQUARE` 合法。其他平台和
动作组合在插件和后端都必须拒绝。

## 7. 动作捕获

领取任务后，后端签发短期票据，绑定以下信息：

```text
userId
deviceId
platform
actionType
targetContentId 或 targetAuthorId
issuedAt
expiresAt
ticketId
```

MAIN World 捕获器仅在 Binance Square 页面启用，并只读取已登记的互动请求。动作
必须同时满足以下条件才生成证据：

1. 网络请求对应当前票据要求的动作。
2. 请求中的目标 ID 与票据目标一致。
3. HTTP 响应成功。
4. Binance 响应中的业务状态明确表示成功。
5. 评论和分享响应能够提取新的结果 ID。

Binance 内部接口名称和响应结构不写死在设计文档中。实施前先用 beta 捕获探针
记录脱敏结构，并将真实样本固化为解析器 fixture。解析器必须按已确认的实际结构
实现，未知结构失败关闭。

捕获器也识别取消点赞、取消关注、删除评论和删除分享。冷却期内出现撤销动作时，
插件提交撤销证明，后端使参与记录失效。冷却期结束后的长期撤销不在首期范围内。

## 8. 消息桥和证明

MAIN World 只向页面 `postMessage` 发送标准证据字段。ISOLATED Bridge 执行运行时
结构校验，拒绝未知平台、未知动作、缺失目标、超长字段和无活动票据的消息。

Background 将证据与活动任务、设备和 Binance 账号绑定，构造版本化证明：

```text
lighthouse-platform-engagement-v1
platform
actionType
campaignId
participantId
actorId
targetContentId
targetAuthorId
resultContentId
capturedAt
ticketId
proofNonce
```

证明使用设备私钥签名。后端验证固定 operation、文档哈希、变量哈希、设备签名、
时间窗、单次任务票据和 `proofNonce`。`proofNonce` 由 Background 在捕获
成功动作时生成，并作为签名负载的一部分。完全相同的已签名证明可
幂等重试并返回首次结果；同一 `ticketId` 搭配不同证明，或者重用已消费的
`proofNonce`，必须拒绝且不重复发奖。

设备签名证明请求来自已绑定插件设备，但不能证明用户运行的是未修改源码。插件
权威模式接受这一限制，并通过短期票据、账号绑定、响应成功校验、冷却和异常风控
提高伪造成本。

## 9. Binance 账号绑定

用户首次启动 Binance Square 任务时，插件从已登录页面的实际账号响应中提取
Binance UID 和公开显示信息。用户确认后，插件通过设备签名请求将 Binance UID
绑定至 Lighthouse 账号。

约束如下：

- 一个 Lighthouse 用户同时只有一个有效 Binance UID。
- 一个 Binance UID 只能绑定一个 Lighthouse 用户。
- 每份互动证明必须包含当前绑定 UID。
- 插件检测到页面登录账号变化时立即停止观察并要求重新绑定。
- 换绑需要重新确认，并写入账号绑定历史和安全审计日志。

插件不读取或上传 Binance 登录凭证。

## 10. 数据模型

后端新增：

```prisma
enum EngagementPlatform {
  X
  BINANCE_SQUARE
}

model PlatformAccountBinding {
  id                String
  userId            String
  platform          EngagementPlatform
  externalAccountId String
  displayName       String?
  status            String
  createdAt         DateTime
  revokedAt         DateTime?
}

model PlatformAccountBindingEvent {
  id         String
  bindingId  String
  eventType  String
  createdAt  DateTime
}
```

数据库为 `(platform, externalAccountId)` 建立唯一约束，保证一个平台账号
不能绑定多个 Lighthouse 用户。每个 `(userId, platform)` 同时只能有一条
有效绑定，该约束由 PostgreSQL 部分唯一索引保证。换绑由单个数据库
事务撤销旧记录、写入事件历史并创建或重新激活新记录。已归属某个
Lighthouse 用户的 Binance UID 不允许转移给另一个用户。

`UnifiedCampaign` 增加：

```text
platform          EngagementPlatform，默认 X
targetContentId   可空
targetAuthorId    可空
```

`ActionTypeV2` 增加 `SHARE`。现有 X 任务继续使用 `RT`；不在数据库中把 Binance
分享伪装成 `RT`。`tweetId` 和 `targetUsername` 在迁移期继续服务 X。

插件证明和捕获记录增加 `platform`、平台通用目标字段、`actorId`、
`resultContentId` 和撤销状态。

数据库约束保证同一平台账号不能同时绑定多个 Lighthouse 用户。同一用户、任务、
动作和目标只产生一个有效完成记录。

## 11. 后端核验与结算

统一核验入口按 `campaign.platform` 分发：

- `X`：继续调用现有 Twitter 核验和插件辅助证据链。
- `BINANCE_SQUARE`：调用 Binance 插件权威核验器，不进入 Twitter API 队列。

Binance 插件权威核验器依次检查：

1. Campaign、participant 和票据仍有效。
2. 设备、插件 Token 和 Binance UID 绑定有效。
3. 平台、动作和目标与 Campaign 一致。
4. 证明签名、时间窗、单次票据和 `proofNonce` 有效。
5. 评论或分享具备结果 ID。
6. 未出现重复证明或冷却期撤销。
7. 用户和设备未命中现有黑名单、频率或异常规则。

通过后进入现有冷却期。冷却结束且没有撤销证明时，复用现有 participant 完成和
LUX 发奖流程。

## 12. 前端流程

买方发布 Engagement Campaign 时选择 X 或 Binance Square。选择 Binance Square
后，前端只接受 Binance Square 内容链接或作者链接，并解析对应目标 ID；无法稳定
解析时拒绝发布，不让买方手填任意 ID。后端再次校验 URL 的域名、路径、
平台和目标 ID，不信任前端解析结果。

卖方任务大厅显示平台标识和动作要求。接单后打开目标 Binance Square 页面，插件
侧边栏显示当前账号、目标和四种动作状态。账号不匹配时不启动捕获。

## 13. 错误处理

首期提供稳定错误码：

```text
BINANCE_ACCOUNT_NOT_BOUND
BINANCE_ACCOUNT_CHANGED
BINANCE_TARGET_MISMATCH
BINANCE_ACTION_NOT_CAPTURED
BINANCE_RESULT_ID_MISSING
BINANCE_RESPONSE_UNRECOGNIZED
PLATFORM_PROOF_EXPIRED
PLATFORM_PROOF_REPLAY
PLATFORM_ACTION_REVOKED
PLUGIN_VERSION_TOO_OLD
```

未知请求或响应结构一律失败关闭。插件版本过旧时提示升级，不回退到 DOM 发奖。
Twitter 任务不受 Binance 功能开关或错误影响。

## 14. 运行模式与止损

后端提供按平台和动作控制的模式：

```text
shadow   捕获、签名和记录，但不影响奖励
enforce  证明通过后进入冷却和发奖
paused   停止接收新的 Binance 完成证明
```

每种动作可以独立从 `shadow` 切到 `enforce`，也可以独立暂停。系统记录捕获成功率、
证明拒绝率、账号不匹配率、撤销率和最终发奖率。

## 15. 测试

### 插件单元测试

- 四类动作的真实脱敏请求和响应 fixture。
- 成功、失败、未知业务码、错误目标和缺失结果 ID。
- 取消点赞、取消关注、删除评论和删除分享。
- MAIN → ISOLATED 消息字段白名单和恶意消息拒绝。
- 账号切换、票据过期和无活动任务。

### 跨仓库证明测试

插件与后端共享固定证明向量。测试覆盖字段顺序、Unicode、空字段、时间戳、
`ticketId`、`proofNonce`、
目标篡改、账号篡改和结果 ID 篡改。

### 后端测试

- 平台核验分发正确，Binance 不调用 Twitter API。
- 账号唯一绑定、换绑审计和已撤销绑定拒绝。
- 票据单次消费、防重放、幂等和并发重复提交。
- 冷却期撤销阻止发奖。
- Binance 开关不影响 X 任务。

### 前端测试

- 平台选择和 Binance URL 校验。
- 任务大厅平台标识、跳转和插件状态提示。
- 账号未绑定、切换和插件版本过低提示。

### 手工闭环

在 beta 环境使用内部 Binance 账号逐项验证点赞、评论、分享和关注，包括失败响应、
重复操作、错误目标、账号切换和冷却期撤销。

## 16. 灰度发布

1. `shadow` 模式部署捕获探针，确定四类实际接口和脱敏 fixture。
2. 内部账号完成端到端验证，不发奖励。
3. 每种动作分别收集至少 100 次 beta 样本。
4. 单个动作捕获成功率达到 98%，且内部样本零误发后，将该动作切到 `enforce`。
5. 逐步扩大用户范围；异常时按动作切回 `shadow` 或 `paused`。

第一阶段不要求四种动作同时切换到 `enforce`。某一动作未达到门槛时，其他已达标
动作可以独立上线。

## 17. 成功标准

- 买方能发布四类 Binance Square 互动任务。
- 卖方能在浏览器插件中完成任务且无需上传截图。
- Binance 证明不能进入 Twitter 核验路径。
- 重复、过期、错误账号、错误目标和撤销证明不能触发发奖。
- X 任务现有测试、捕获、验证和结算结果保持不变。
