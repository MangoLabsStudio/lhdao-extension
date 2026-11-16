# 老插件全互动类型接入与验收

目标：沿用 Lighthouse 0.4.17 的界面、任务累积、设备签名及原始证据格式，使新灯塔支持旧互动类型并逐项验收。用户已明确要求全部类型，不再以 LIKE 单项通过代表迁移完成。

## 实施路径

1. 在最新远端 dev 独立目录实现，保留现有修改。核对旧系统 LIKE、RT、COMMENT、FOLLOW、COMMENT_LIKE 和复合动作规则。
2. 任务同步返回真实动作集合；不得将所有任务改写为 LIKE。缺失或未知动作拒绝处理。
3. 新后端按真实类型提供精确签名能力。复用现有身份、接单、票据、时限、幂等与 worker 流程，不将插件 token 伪装成登录会话。FOLLOW 保留服务端关系验证；COMMENT/RT 保留服务端核对，组合任务须全部满足。
4. 老插件把原始 proof 和稳定请求键提交到对应入口，网络未知时保留原命令恢复。服务端已受理与核验通过、奖励支付分开显示。
5. 先编写失败测试，覆盖类型映射、错误目标/身份/回执、过期/重放、缺动作、重复/并发及重试；再跑原捕获与新接口/worker/账务回归。
6. 发布测试站后，逐项创建任务，以真实网页接单和 X 动作进行老插件验证。记录版本、任务、提交与核验状态、奖励状态。临时测试资料先备份后恢复并回读核对。

## 验收矩阵（2026-11-16 更新，整体未完成）

| 类型/场景 | 自动化 | 真实插件 | 支付 |
|---|---|---|---|
| LIKE | 既有回归及本轮 central 回归通过 | 已通过提交及乐观核验 | 0.4 LUX 待支付，最早 11-17 01:47 |
| RT | 后端回归通过；浏览器自动化用例仍 skip | 11:33 接单，真实 RT 32→33，插件捕获提交，Web 核验通过 | 20 LUX 待支付，最早 11-17 11:36 |
| COMMENT | 精确服务端回执、无 URL 搜索及付款绑定回归通过 | 11:20 接单，真实评论、插件提交及 Web 核验通过 | 0.8 LUX 待支付，最早 11-17 11:22 |
| FOLLOW | display＋count 修复 43 文件、467 测试及 typecheck/build 通过 | 1116d：9d17 loaded，LIVE 1／12 LUX 卡片正常；真实关注后点击验证，15:02 WITHDRAWN／席位释放，DB 确认首次 SYSTEM 异常释放，具体 provider 原因未存，live 失败 | 未核验通过，不记作付款成功 |
| COMMENT_LIKE | 服务端评论＋乐观点赞回归通过 | 11:25 接单；仅点赞不能提交，评论后解锁，插件提交及 Web 核验通过 | 1.2 LUX 待支付，最早 11-17 11:29 |
| 旧规则允许的多动作组合 | worker/binder 原子完成、缺项保护、并发和实际本地付款回归通过 | 待测 | 本地隔离测试通过；线上未验收 |
| 错账号/错目标/跨任务 | 签名、身份、重放及证据篡改已有回归 | 尚未完成逐项 live 验收 | 不得发奖 |
| 超时/限流/断网/重复提交 | 重试、并发和幂等已有回归 | 尚未完成逐项 live 验收 | 不得重复发奖 |
| 撤销动作/删除评论/失败修正 | 纠正提交和资金保护已有回归 | 待测 | 保留失败和恢复证据 |
| 插件休眠唤醒 | 插件完整回归通过 | 本轮正常 worker 唤醒与同步已确认 | 不适用 |

所有最早支付时间为 2026-11-17（Asia/Shanghai）；“待支付”不是实际到账。

旧捕获桥接来自网页消息，HMAC 只能证明签名绑定，不能单独证明真实社媒动作。不能通过关闭核验、伪造捕获或手工改完成状态来制造通过结果。

## 最新实现、部署与测试记录

- 老插件 `d620951` 已推送、构建并在 kingkk 加载；该加载版本完整回归 **43 文件、454 pass**，TypeScript 与测试站 WXT 构建通过。此前跳转修复已通过全套 **43 文件、461 pass** 及 **beta WXT build**，已在 kingkk 原安装目录 reload，CONNECTED 和同步正常。包版本仍为 0.4.17，只含 storage/alarms 和 X/测试站域名权限。
- API/Worker `f1c90ce` 部署 **Done、healthy**；Web 最新 `69deb15`，Dokploy 部署 **Done**；`origin/dev` 最新也为 `69deb15`（此前 Web 为 `c156545`）。正常 worker 唤醒与同步已确认。
- 组合 admission、consumer、binder 已实现；所有要求的动作通过后才一次原子完成。FOLLOW 核验前后锁定并复查身份，关系防重复记录和奖励同事务；支付绑定逐动作检查。保留旧报价规则：COMMENT_LIKE 不能与 LIKE 或 COMMENT 同批，不为验收放宽规则。
- 后端相关回归 **69 pass、1 skip、0 fail，645 assertions / 6 文件**，包括合法 FOLLOW 组合、缺动作、身份变化、原子回滚、并发幂等、URL-free 评论实际本地延迟付款和 RT 并发修复。后端类型检查通过。日志：`/private/tmp/central-combination-final-regression.log`、`/private/tmp/central-combination-final-types.log`。
- 上述 skip 是浏览器 RT 自动化用例。下述新增 live RT 已通过正常链路，但不代表该 skip 中所有异常/恢复情形已验证。
- 全 contracts **168 pass**。新站完整单元 **1280 pass、3 skip、3 baseline fail**；独立基线复现同样的 3 项失败（主题颜色约束 1、web-session 登录刷新 2），不能标成全绿。日志：`/private/tmp/lh3-unit-full-1116.log`、`/private/tmp/lh3-baseline-failures-1116.log`。
- 既有隔离安全回归 18 pass、146 assertions；关注 HTTP→独立 Worker→完成状态 1 pass、59 assertions。以上均为本地隔离测试，不替代真实 X 验收。

## 最新 live 证据与阻断

来源：`/private/tmp/lh3-live-acceptance-1116-progress.md`，另追加本轮 RT 及 FOLLOW 状态；时间均为 Asia/Shanghai。

- COMMENT `cmwiolhsw000h01nd3hcm2kww`：11:20 接单，目标 `2121143384744362224`；真实评论 `https://x.com/lumi_lly/status/2122168321596391486`。插件捕获并提交，Web COMPLETED／核验通过，待支付 0.8 LUX，最早 Nov 17 11:22。
- COMMENT_LIKE `cmwiomrp1000s01ndcvf4dvjq`：11:25 接单，目标 `2121928196509884566`；真实点赞 15→16 时 COMMENT 尚未完成、不可提交，评论 `https://x.com/lumi_lly/status/2122169974923964638` 后解锁。插件提交，Web COMPLETED／核验通过，待支付 1.2 LUX，最早 Nov 17 11:29；评论服务端核验、点赞乐观核验。
- RT `cmwioi4gx000601ndhl9q4um6`：**11:33 接单**，目标 **`2120398201056596019`**，真实转发 **32→33**；plugin 捕获并 submit，Web 核验通过，**20 LUX 待支付，最早 Nov 17 11:36**。
- FOLLOW：任务 `cmwiot5ts001601ndbeq20wvz`（BinanceResearch，12 LUX＋1.2 LUX 服务费）已于 **2026-11-16 14:12:23** 真实成功预留；claim 为 `cmwiv9euy000101qn380s01qq`，deadline **14:22:23**。预留时 DB `baselineCheckedAt=14:12:23.254`，seller／target 检查均为 true，状态 ACTIVE，acceptance receipt 存在（true）。当次插件显示 **LIVE 0**，**未执行 X follow**，未提交关注证明或通过核验。当次已定位无 `tweetId` 的 FOLLOW 被 sidebar 过滤；后续纯 FOLLOW display＋count 修复已完成，全套 **43 文件、467 项测试、typecheck、beta WXT build 均通过**，独立 review 无阻塞，并已在 kingkk reload 原插件。该修复后的 1116d 已执行真实关注，但验证后 WITHDRAWN，详见下文失败记录。此前网页 received 请求返回 HTTP 200，包含 `engagementFulfillmentMode: DISPATCH`，但旧标签页客户端 strict 契约拒绝；确认 Web `69deb15` 已部署 Done 后，对卖方页硬刷新，FOLLOW 详情恢复正常，显示 **14:22 超时退出／席位释放**。该网页问题是旧标签页客户端未更新，**无需代码修复**。此前阻断涉及 1 条 `feng_btc` 历史关系（`targetTwitterId=NULL`、`participant=NULL`、对应 unified campaign 缺失，无可靠 stable ID）；它不再是“尚未成功预留”的当前状态。
- 评论提交后出现 Chrome 离开确认及焦点跳转异常（源码未发现关闭 X 标签）；跳转修复已通过 43 文件、461 项测试及 beta WXT build，已 reload，Open dashboard 实际进入新站 marketplace；成功提交后的自动跳转尚待下一次任务复验。

### 纯 FOLLOW 修复与 1116c 重试状态

纯 FOLLOW display＋count 修复已通过全套 **43 文件、467 项测试**、**typecheck** 和 **beta WXT build**；独立 review 无阻塞，已在 **kingkk reload 原插件**。这证明构建与加载完成，不代表真实 FOLLOW 核验通过。

1116c fixture／history 重试准备后，浏览器再次被切换窗口；**未接新任务、未执行关注**，随即恢复。1116c history 为 **RESTORED_EXACT**，fixture **4 项布尔检查全部 true**，恢复已 **COMMIT**，**该轮无临时遗留**。这是 1116c 的历史状态；后续 1116d 的失败及已确认恢复记录见下文。

### 1116d 真实 FOLLOW 失败、DB 结论与恢复确认

- 新 campaign `cmwiwrbni000501m36ctp2pu4`，2026-11-16 **15:01 接单，deadline 15:11**。插件 **`9d17` 已加载**，popup **LIVE 1**，profile card 正常显示 **12 LUX**。
- lumi 已真实关注 BinanceResearch，点击“我已关注验证”后，**15:02 参与状态变为 WITHDRAWN／席位释放**。DB 已确认首次 SYSTEM 异常触发释放，非 deadline 超时，亦非确认未关注；这是 FOLLOW live 失败记录，不是核验通过。
- DB claim `cmwix0t3l000f01m35hjfgn3q`：`RELEASED`、`attempts=1`、`submitted=2026-11-16T07:02:37.212Z`、`finished=2026-11-16T07:02:44.217Z`（UTC，对应本地 15:02），`lastError=NULL`；review 为 `RELEASE`，reason 为“系统核验通道异常重试耗尽”。event 为 `DELIVERED`、`attempts=1`。3 个 policy keys 查询为 0 rows，使用默认 `true / true / 60m`。这支持首次 SYSTEM 异常释放的结论；**具体 provider 原因未存储，不能据此判断为未关注或指定某个 provider 故障**。
- `open-campaign` 仍覆盖旧任务 tab，触发离站警告；选择 cancel 后保留，已补充精确目标页复用修复，**`30ce403` 已推送旧插件 feature branch**，474 项测试、类型检查与 beta 构建通过；**尚未 reload**，尚未在浏览器复验。此前构建和 reload 通过不代表该问题已解决。
- Chrome 切到无关 Google 登录窗口时，1116d 曾仍为 ACTIVE、尚未确认恢复，并再次请求用户暂停操作。**随后 1116d 已恢复并经 DB 确认：history COMMIT、RESTORED_EXACT；fixture COMMIT、4 flags 全部 true；当前无 active 夹具。** 这是 1116d 自身的恢复证据，不沿用先前 1116c 的恢复结论。

## 临时 fixture 与剩余工作

**1116、1116b、1116c、1116d 各轮已恢复并 COMMIT，当前无 active 夹具。** 1116d history 独立确认 `RESTORED_EXACT`，fixture 的 4 flags 全部 true。 较早的 all-actions 夹具于 11:49 条件恢复，独立 `user_restored`／`details_restored`／`participant_restored`／`restore_recorded` 全部为 true；本次 1116b 另确认 **RESTORED_EXACT＋4 项布尔检查全部 true**。1116d 的恢复另以上述独立 DB 结果确认。较早的 all-actions 备份为 `public.lumi_all_actions_backup_1116`、`public.lumi_all_actions_participant_1116`；关注重试使用 `lumi_follow_run_backup_1116*`、`lumi_follow_run_participant_1116*`、`lumi_follow_history_backup_1116*`，恢复脚本见 `/private/tmp/lh3-all-fixture-sql.txt` 第 3 节。人工测试资格不能证明真实资料同步有效；恢复历史夹具也不表示新 FOLLOW 接单已完成核验。

剩余事项：等待用户暂停并发浏览器操作；调查首次 SYSTEM 异常释放的具体 provider 原因（当前未存储），核对释放策略行为；reload 并复验已推送 `30ce403` 的 open-campaign 修复，再继续 FOLLOW 真实链路及剩余合法组合验收；核验到期实际付款与撤销/失败修正场景。**当前无 active 夹具，但仅 LIKE、RT、COMMENT、COMMENT_LIKE 四类型 live 通过；FOLLOW 和剩余组合尚未通过，不能宣称全部验收完成。**
