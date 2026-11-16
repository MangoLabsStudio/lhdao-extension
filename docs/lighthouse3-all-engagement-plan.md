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
| FOLLOW | display＋count、服务端关系及付款绑定已有回归；导航修复 474 测试通过 | 1116f 17:57 接单后真实关注；插件验证一次，Web 核验通过；精确新 received 页打开且旧 COMMENT 页保留 | 12 LUX 待支付，最早 11-17 18:01，尚未实际付款 |
| COMMENT_LIKE | 服务端评论＋乐观点赞回归通过 | 11:25 接单；仅点赞不能提交，评论后解锁，插件提交及 Web 核验通过 | 1.2 LUX 待支付，最早 11-17 11:29 |
| 旧规则允许的多动作组合 | worker/binder 原子完成、缺项保护、并发和实际本地付款回归通过 | 待测 | 本地隔离测试通过；线上未验收 |
| 错账号/错目标/跨任务 | 签名、身份、重放及证据篡改已有回归 | 尚未完成逐项 live 验收 | 不得发奖 |
| 超时/限流/断网/重复提交 | 重试、并发和幂等已有回归 | 尚未完成逐项 live 验收 | 不得重复发奖 |
| 撤销动作/删除评论/失败修正 | 纠正提交和资金保护已有回归 | 待测 | 保留失败和恢复证据 |
| 插件休眠唤醒 | 插件完整回归通过 | 本轮正常 worker 唤醒与同步已确认 | 不适用 |

所有最早支付时间为 2026-11-17（Asia/Shanghai）；“待支付”不是实际到账。

旧捕获桥接来自网页消息，HMAC 只能证明签名绑定，不能单独证明真实社媒动作。不能通过关闭核验、伪造捕获或手工改完成状态来制造通过结果。

## 最新实现、部署与测试记录

- 老插件早期构建记录：`d620951` 已推送、构建并在 kingkk 加载；该加载版本完整回归 **43 文件、454 pass**，TypeScript 与测试站 WXT 构建通过。此前跳转修复已通过全套 **43 文件、461 pass** 及 **beta WXT build**，已在 kingkk 原安装目录 reload，CONNECTED 和同步正常。包版本仍为 0.4.17，只含 storage/alarms 和 X/测试站域名权限。
- API／Worker 当前已部署 `c8d1d8cb69cbe6a962833bcdc625d286f73b3b13`（`c8d1d8c`），均 Done；关系查询上限已验证为 1MiB，资料查询仍为 100KB。该修复 37 项测试、165 断言及后端类型检查通过，独立 review 无阻塞。此前 API／Worker `f1c90ce`、Web `69deb15` 的部署记录为历史记录，不再把 `69deb15` 标为最新 origin/dev。
- 组合 admission、consumer、binder 已实现；所有要求的动作通过后才一次原子完成。FOLLOW 核验前后锁定并复查身份，关系防重复记录和奖励同事务；支付绑定逐动作检查。保留旧报价规则：COMMENT_LIKE 不能与 LIKE 或 COMMENT 同批，不为验收放宽规则。
- 后端相关回归 **69 pass、1 skip、0 fail，645 assertions / 6 文件**，包括合法 FOLLOW 组合、缺动作、身份变化、原子回滚、并发幂等、URL-free 评论实际本地延迟付款和 RT 并发修复。后端类型检查通过。日志：`/private/tmp/central-combination-final-regression.log`、`/private/tmp/central-combination-final-types.log`。
- 上述 skip 是浏览器 RT 自动化用例。下述新增 live RT 已通过正常链路，但不代表该 skip 中所有异常/恢复情形已验证。
- 全 contracts **168 pass**。新站完整单元 **1280 pass、3 skip、3 baseline fail**；独立基线复现同样的 3 项失败（主题颜色约束 1、web-session 登录刷新 2），不能标成全绿。日志：`/private/tmp/lh3-unit-full-1116.log`、`/private/tmp/lh3-baseline-failures-1116.log`。
- 既有隔离安全回归 18 pass、146 assertions；关注 HTTP→独立 Worker→完成状态 1 pass、59 assertions。以上均为本地隔离测试，不替代真实 X 验收。

## 最新 live 证据与阻断

### 当前结果：1116f 真实 FOLLOW 与导航通过

- 2026-11-16，campaign **`cmwj31f1f000i01qielzrh7fz`** 于 **17:57 接单，deadline 18:07**（Asia/Shanghai）；接单后执行真实 X 关注。
- 用户批准的只读缓存检查显示 **`LOCAL_RESERVED`、`captureExists=true`、`pending=false`**。这只是捕获/提交前状态；最终核验结果以下述 Web 回执为准。
- 老插件验证按钮只点击一次，自动打开**精确对应的新 received 任务标签页**，同时保留旧 COMMENT 标签页。Web 显示 **“核验已通过／待支付 12 LUX”，最早支付 2026-11-17 18:01**。因此 `30ce403` 导航修复已通过本次 live 复验；待支付不代表已到账。
- **1116f 恢复已独立截图确认：history `RESTORED_EXACT`、COMMIT；fixture 的 `user`／`details`／`participant`／`restore_recorded` 全部 true、COMMIT。当前无 active 夹具。** 这是 1116f 自身的恢复证据。
- 当前 **LIKE、RT、COMMENT、COMMENT_LIKE、FOLLOW 五种单类型均已真实提交并核验通过**；LIKE 及 COMMENT_LIKE 中的点赞仍为乐观核验。**剩余组合、负向/恢复场景和到期实际付款仍未完成，不宣称整体验收完成。**

来源：`/private/tmp/lh3-live-acceptance-1116-progress.md`，另追加本轮 RT 及 FOLLOW 状态；时间均为 Asia/Shanghai。

- COMMENT `cmwiolhsw000h01nd3hcm2kww`：11:20 接单，目标 `2121143384744362224`；真实评论 `https://x.com/lumi_lly/status/2122168321596391486`。插件捕获并提交，Web COMPLETED／核验通过，待支付 0.8 LUX，最早 Nov 17 11:22。
- COMMENT_LIKE `cmwiomrp1000s01ndcvf4dvjq`：11:25 接单，目标 `2121928196509884566`；真实点赞 15→16 时 COMMENT 尚未完成、不可提交，评论 `https://x.com/lumi_lly/status/2122169974923964638` 后解锁。插件提交，Web COMPLETED／核验通过，待支付 1.2 LUX，最早 Nov 17 11:29；评论服务端核验、点赞乐观核验。
- RT `cmwioi4gx000601ndhl9q4um6`：**11:33 接单**，目标 **`2120398201056596019`**，真实转发 **32→33**；plugin 捕获并 submit，Web 核验通过，**20 LUX 待支付，最早 Nov 17 11:36**。
- FOLLOW 早期失败经过（历史记录）：任务 `cmwiot5ts001601ndbeq20wvz`（BinanceResearch，12 LUX＋1.2 LUX 服务费）已于 **2026-11-16 14:12:23** 真实成功预留；claim 为 `cmwiv9euy000101qn380s01qq`，deadline **14:22:23**。预留时 DB `baselineCheckedAt=14:12:23.254`，seller／target 检查均为 true，状态 ACTIVE，acceptance receipt 存在（true）。当次插件显示 **LIVE 0**，**未执行 X follow**，未提交关注证明或通过核验。当次已定位无 `tweetId` 的 FOLLOW 被 sidebar 过滤；后续纯 FOLLOW display＋count 修复已完成，全套 **43 文件、467 项测试、typecheck、beta WXT build 均通过**，独立 review 无阻塞，并已在 kingkk reload 原插件。该修复后的 1116d 已执行真实关注，但验证后 WITHDRAWN，详见下文失败记录。此前网页 received 请求返回 HTTP 200，包含 `engagementFulfillmentMode: DISPATCH`，但旧标签页客户端 strict 契约拒绝；确认 Web `69deb15` 已部署 Done 后，对卖方页硬刷新，FOLLOW 详情恢复正常，显示 **14:22 超时退出／席位释放**。该网页问题是旧标签页客户端未更新，**无需代码修复**。此前阻断涉及 1 条 `feng_btc` 历史关系（`targetTwitterId=NULL`、`participant=NULL`、对应 unified campaign 缺失，无可靠 stable ID）；它不再是“尚未成功预留”的当前状态。
- 评论提交后出现 Chrome 离开确认及焦点跳转异常（源码未发现关闭 X 标签）；跳转修复已通过 43 文件、461 项测试及 beta WXT build，已 reload，Open dashboard 实际进入新站 marketplace；成功提交后的自动跳转当时待复验，后续已在 1116f 通过，且保留旧 COMMENT 标签页。

### 纯 FOLLOW 修复与 1116c 重试状态（历史记录）

纯 FOLLOW display＋count 修复已通过全套 **43 文件、467 项测试**、**typecheck** 和 **beta WXT build**；独立 review 无阻塞，已在 **kingkk reload 原插件**。这证明构建与加载完成，不代表真实 FOLLOW 核验通过。

1116c fixture／history 重试准备后，浏览器再次被切换窗口；**未接新任务、未执行关注**，随即恢复。1116c history 为 **RESTORED_EXACT**，fixture **4 项布尔检查全部 true**，恢复已 **COMMIT**，**该轮无临时遗留**。这是 1116c 的历史状态；后续 1116d 的失败及已确认恢复记录见下文。

### 1116d 真实 FOLLOW 失败、DB 结论与恢复确认（历史记录）

- 新 campaign `cmwiwrbni000501m36ctp2pu4`，2026-11-16 **15:01 接单，deadline 15:11**。插件 **`9d17` 已加载**，popup **LIVE 1**，profile card 正常显示 **12 LUX**。
- lumi 已真实关注 BinanceResearch，点击“我已关注验证”后，**15:02 参与状态变为 WITHDRAWN／席位释放**。DB 已确认首次 SYSTEM 异常触发释放，非 deadline 超时，亦非确认未关注；这是 FOLLOW live 失败记录，不是核验通过。
- DB claim `cmwix0t3l000f01m35hjfgn3q`：`RELEASED`、`attempts=1`、`submitted=2026-11-16T07:02:37.212Z`、`finished=2026-11-16T07:02:44.217Z`（UTC，对应本地 15:02），`lastError=NULL`；review 为 `RELEASE`，reason 为“系统核验通道异常重试耗尽”。event 为 `DELIVERED`、`attempts=1`。3 个 policy keys 查询为 0 rows，使用默认 `true / true / 60m`。这支持首次 SYSTEM 异常释放的结论；**具体 provider 原因未存储，不能据此判断为未关注或指定某个 provider 故障**。
- 当时 `open-campaign` 仍覆盖旧任务 tab，触发离站警告；选择 cancel 后保留，已补充精确目标页复用修复，**`30ce403` 已推送旧插件 feature branch**，474 项测试、类型检查与 beta 构建通过；**当时尚未 reload／浏览器复验**；后续已 reload，并在 1116f 通过精确新任务页导航复验。当时仅有构建和 reload 结果，后续以 1116f 的 live 导航结果确认修复。
- Chrome 切到无关 Google 登录窗口时，1116d 曾仍为 ACTIVE、尚未确认恢复，并再次请求用户暂停操作。**随后 1116d 已恢复并经 DB 确认：history COMMIT、RESTORED_EXACT；fixture COMMIT、4 flags 全部 true；当前无 active 夹具。** 这是 1116d 自身的恢复证据，不沿用先前 1116c 的恢复结论。

## 临时 fixture 与剩余工作

**1116、1116b、1116c、1116d、1116e、1116f 各轮均已恢复并 COMMIT，当前无 active 夹具。** 1116e history 已 `RESTORED_EXACT`，fixture 4 flags true；最新 1116f 的 history 和 fixture 恢复另经独立截图确认，详见当前结果。 1116d history 独立确认 `RESTORED_EXACT`，fixture 的 4 flags 全部 true。 较早的 all-actions 夹具于 11:49 条件恢复，独立 `user_restored`／`details_restored`／`participant_restored`／`restore_recorded` 全部为 true；本次 1116b 另确认 **RESTORED_EXACT＋4 项布尔检查全部 true**。1116d 的恢复另以上述独立 DB 结果确认。较早的 all-actions 备份为 `public.lumi_all_actions_backup_1116`、`public.lumi_all_actions_participant_1116`；关注重试使用 `lumi_follow_run_backup_1116*`、`lumi_follow_run_participant_1116*`、`lumi_follow_history_backup_1116*`，恢复脚本见 `/private/tmp/lh3-all-fixture-sql.txt` 第 3 节。人工测试资格不能证明真实资料同步有效；恢复历史夹具也不表示新 FOLLOW 接单已完成核验。

剩余事项：完成剩余合法组合、负向/恢复场景的真实验收及到期实际付款核对；保留并调查历史 SYSTEM 异常释放证据，不将后续成功视为历史失败已通过。**当前五种单类型均已提交并核验通过（LIKE 乐观），30ce403 导航 live 通过，1116f 已独立恢复确认、无 active 夹具；整体验收仍未完成。**

### FOLLOW 查询通道探测与 1116e 失败经过（历史记录）

以下为 1116f 成功前的排查记录；其中“未通过”“待复验”等描述仅指当时，不代表当前状态。当前以开头 1116f 记录为准。

1116e：同 `c8d1d8c` 构造函数的独立只读 probe 返回 FOLLOWING（2365ms），但任务 `cmwj0vu1b000301qi2o153uu3` 在真实取消关注再关注后提交显示 ACTION_NOT_DETECTED；再次提交与只读捕获检查当时受审批阻断，未确认任务通过。该轮 history 已 COMMIT、RESTORED_EXACT；fixture 4 flags true、COMMIT。该轮失败不被后续 1116f 成功覆盖。

查询修复：Tweet241 HTTP 200 正常列表为 139,678 bytes，超过原 100KB 上限；`c8d1d8c` 将关系查询上限改为 1MiB，资料查询仍 100KB，API／Worker 部署均 Done，37 项测试、165 断言及后端类型检查通过。`30ce403` 后续已在 kingkk reload；最终导航结果见 1116f。


2026-11-16，从测试站 Worker 容器执行有界只读探测：`LH_FOLLOW_ENABLED` 和 `LH_FOLLOW_X_READS_APPROVED` 为 true，Tweet241/xAPI 凭据均存在。分别使用各池首个 key 查询 BinanceResearch 的 followers／following 第一页，Tweet241 HTTP **403**、xAPI HTTP **402**，均为 HTTP_ERROR；未输出凭据或响应正文，未修改验证结果。此证据证明当时两次请求被服务商拒绝，不证明全部 key 均不可用，也不能还原 15:02 的具体响应。需恢复可用查询通道后复验 FOLLOW；不能以插件已提交替代服务端核验通过。
