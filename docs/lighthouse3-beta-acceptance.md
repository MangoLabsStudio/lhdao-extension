# Lighthouse 3 beta：沿用老插件

2026-11-16，用户要求继续使用老灯塔插件。基线为 origin/dev c5ad753（0.4.17）。

保留原 popup、X content/capture/bridge、设备密钥、签名与证明格式。仅在下列明确构建配置下使用新站 REST 适配，默认旧站 GraphQL 不变：

```sh
WXT_API_ENDPOINT=https://app.lhdaobeta.top/lighthouse3.0/api/v3 \
WXT_WEB_ENDPOINT=https://app.lhdaobeta.top/lighthouse3.0 pnpm build
```

首次 LIKE 验收范围：网页先接 LIKE 任务 → 老插件同步本人有效接单 → X 实际动作捕获 → 票据 → 原证明提交 → 新站异步核验。网络结果不明时持久化原命令并重发，提交返回 VERIFYING 不代表成功或奖励到账。该次记录仅覆盖 LIKE，不应当作完整迁移验收。后续全互动扩展见 lighthouse3-all-engagement-plan.md；账号分析、插件内抢单不在本次迁移范围。

## 首轮 LIKE 已验证（历史记录）

- 连接、重试、回执绑定、原证明保留、manifest 权限、旧 popup：36 项测试通过。
- 插件 TypeScript 检查通过；Chrome MV3 构建及实际 manifest 检查通过。
- kingkk 已安装启用 Lighthouse 0.4.17，ID `jenfbnidlggkkpedonpiakaabbbghcfj`。
- 仅 storage/alarms 与 X/测试站域名权限；不使用 debugger。独立验收插件保持停用。
- 新后端改动已发布 dev `36b7c2bf1ab38398aa4ea1ee7977a1ee1ab82d0c` 并回读确认；基于远端 `9e30da0` 保留其新增 7 个提交，使用非强制带预期 SHA 的更新。

## 2026-11-16 首轮 LIKE 浏览器实际验收（历史记录）

- 新站 API、Worker 部署记录均为 Done，版本 `c7fd682c6a17881c4f7693f42183b3eb77822b9b`。插件来源按安装 ID 精确配置，未启用 LIKE_COUNT 兜底。
- kingkk 中老插件成功配对 lumi / @lumi_lly，正常显示 CONNECTED。网页接单后手动同步由 TASKS LIVE 0 变为 1。
- 测试任务 `cmwi45trg000601o695c5fewl`（老插件验收 LIKE 20261116），发布者 0xWang健林，5 个 A 档席位，预算 2 LUX + 0.2 LUX 服务费。lumi 于 01:44 接单，约定净奖励 0.4 LUX。
- 目标 `https://x.com/BinanceResearch/status/2120398201056596019`，X 当前账号 @lumi_lly。点击真实点赞后由 122 变为 123，老插件原任务面板由“点赞 待完成”变为“点赞 已完成”，停留要求满足后点击“验证发奖”。
- 老插件显示“验证已提交 · 奖励发放中”；新站本人接单详情显示“已完成 / 核验已通过 / 待支付 0.4 LUX”，最早支付时间为 2026-11-17 01:47（Asia/Shanghai）。这是乐观核验提交及处理通过，**尚未实际支付**，不代表独立 X 二次核查或资金到账。
- 验收临时将 lumi AI 改为 WEB3，补充测试认证和 public_metrics.followers_count=1000，并隔离一条已结束旧任务参与记录。测试资格是人工夹具，不能证明真实资料同步有效。原始值已备份至测试数据库容器 `/tmp/lumi-plugin-profile-1116.jsonl`、`/tmp/lumi-plugin-participant-1116.jsonl`。验收后恢复，独立查询 type_restored、details_restored、participant_exact_restored 均为 true；旧参与记录整行 JSON 与备份相同。
- 保留真实点赞供延迟审核；此前 COMMENT 验收评论也保留。

## 2026-11-16 最新部署与真实插件验收

### 当前结果：1116f 真实 FOLLOW 与导航通过

- 2026-11-16，campaign **`cmwj31f1f000i01qielzrh7fz`** 于 **17:57 接单，deadline 18:07**（Asia/Shanghai）；接单后执行真实 X 关注。
- 用户批准的只读缓存检查显示 **`LOCAL_RESERVED`、`captureExists=true`、`pending=false`**。这只是捕获/提交前状态；最终核验结果以下述 Web 回执为准。
- 老插件验证按钮只点击一次，自动打开**精确对应的新 received 任务标签页**，同时保留旧 COMMENT 标签页。Web 显示 **“核验已通过／待支付 12 LUX”，最早支付 2026-11-17 18:01**。因此 `30ce403` 导航修复已通过本次 live 复验；待支付不代表已到账。
- **1116f 恢复已独立截图确认：history `RESTORED_EXACT`、COMMIT；fixture 的 `user`／`details`／`participant`／`restore_recorded` 全部 true、COMMIT。当前无 active 夹具。** 这是 1116f 自身的恢复证据。
- 当前 **LIKE、RT、COMMENT、COMMENT_LIKE、FOLLOW 五种单类型均已真实提交并核验通过**；LIKE 及 COMMENT_LIKE 中的点赞仍为乐观核验。**剩余组合、负向/恢复场景和到期实际付款仍未完成，不宣称整体验收完成。**

以下更新以 `/private/tmp/lh3-live-acceptance-1116-progress.md` 和本轮追加 RT 记录为依据，替代早前“全互动包尚未加载、其他类型尚未实测”的状态。时间均为 Asia/Shanghai。

- API／Worker 当前已部署 `c8d1d8cb69cbe6a962833bcdc625d286f73b3b13`（`c8d1d8c`），均 Done；关系查询上限已验证为 1MiB，资料查询仍为 100KB。该修复 37 项测试、165 断言及后端类型检查通过，独立 review 无阻塞。此前 API／Worker `f1c90ce`、Web `69deb15` 的部署记录为历史记录，不再把 `69deb15` 标为最新 origin/dev。
- 老插件早期构建记录：`d620951` 已推送、构建并在 kingkk 重新加载。该加载版本回归 43 文件、454 项通过；此前跳转修复已通过全套 **43 文件、461 项测试**及 **beta WXT build**，已在 kingkk 原安装目录 reload，CONNECTED 和同步正常。正常 worker 唤醒和任务同步已确认。发布、加载与下列 live 结果分别记录，不代表全部场景通过。
- COMMENT：任务 `cmwiolhsw000h01nd3hcm2kww`，11:20 接单，目标 `2121143384744362224`。真实评论 `https://x.com/lumi_lly/status/2122168321596391486`；老插件捕获并提交，Web 显示 COMPLETED、核验通过、待支付 **0.8 LUX**，最早 **2026-11-17 11:22**。
- COMMENT_LIKE：任务 `cmwiomrp1000s01ndcvf4dvjq`，11:25 接单，目标 `2121928196509884566`。真实点赞 15→16 后，插件显示 LIKE 完成、COMMENT 待完成且不可提交；发布评论 `https://x.com/lumi_lly/status/2122169974923964638` 后解锁并提交。Web 显示 COMPLETED、核验通过、待支付 **1.2 LUX**，最早 **2026-11-17 11:29**。评论为服务端核验，点赞仍为乐观核验。
- RT：任务 `cmwioi4gx000601ndhl9q4um6`，**11:33 接单**，目标 `2120398201056596019`。真实转发计数 **32→33**，老插件捕获并 submit；Web 核验通过、待支付 **20 LUX**，最早 **2026-11-17 11:36**。这是新增 live RT 证据，不等同于已实际付款。
- FOLLOW 早期失败经过（历史记录）：任务 `cmwiot5ts001601ndbeq20wvz`（BinanceResearch，12 LUX＋1.2 LUX 服务费）已于 **2026-11-16 14:12:23** 真实成功预留；claim 为 `cmwiv9euy000101qn380s01qq`，deadline **14:22:23**。预留时 DB `baselineCheckedAt=14:12:23.254`，seller／target 检查均为 true，状态 ACTIVE，acceptance receipt 存在（true）。当次插件显示 **LIVE 0**，**未执行 X follow**，未提交关注证明或通过核验。当次已定位无 `tweetId` 的 FOLLOW 被 sidebar 过滤；后续纯 FOLLOW display＋count 修复已完成，全套 **43 文件、467 项测试、typecheck、beta WXT build 均通过**，独立 review 无阻塞，并已在 kingkk reload 原插件。该修复后的 1116d 已执行真实关注，但验证后 WITHDRAWN，详见下文失败记录。此前网页 received 请求返回 HTTP 200，包含 `engagementFulfillmentMode: DISPATCH`，但旧标签页客户端 strict 契约拒绝；确认 Web `69deb15` 已部署 Done 后，对卖方页硬刷新，FOLLOW 详情恢复正常，显示 **14:22 超时退出／席位释放**。该网页问题是旧标签页客户端未更新，**无需代码修复**。此前阻断涉及 1 条 `feng_btc` 历史关系（`targetTwitterId=NULL`、`participant=NULL`、对应 unified campaign 缺失，无可靠 stable ID）；它不再是“尚未成功预留”的当前状态。

### 纯 FOLLOW 修复与 1116c 重试状态（历史记录）

纯 FOLLOW display＋count 修复已通过全套 **43 文件、467 项测试**、**typecheck** 和 **beta WXT build**；独立 review 无阻塞，已在 **kingkk reload 原插件**。这证明构建与加载完成，不代表真实 FOLLOW 核验通过。

1116c fixture／history 重试准备后，浏览器再次被切换窗口；**未接新任务、未执行关注**，随即恢复。1116c history 为 **RESTORED_EXACT**，fixture **4 项布尔检查全部 true**，恢复已 **COMMIT**，**该轮无临时遗留**。这是 1116c 的历史状态；后续 1116d 的失败及已确认恢复记录见下文。

### 1116d 真实 FOLLOW 失败、DB 结论与恢复确认（历史记录）

- 新 campaign `cmwiwrbni000501m36ctp2pu4`，2026-11-16 **15:01 接单，deadline 15:11**。插件 **`9d17` 已加载**，popup **LIVE 1**，profile card 正常显示 **12 LUX**。
- lumi 已真实关注 BinanceResearch，点击“我已关注验证”后，**15:02 参与状态变为 WITHDRAWN／席位释放**。DB 已确认首次 SYSTEM 异常触发释放，非 deadline 超时，亦非确认未关注；这是 FOLLOW live 失败记录，不是核验通过。
- DB claim `cmwix0t3l000f01m35hjfgn3q`：`RELEASED`、`attempts=1`、`submitted=2026-11-16T07:02:37.212Z`、`finished=2026-11-16T07:02:44.217Z`（UTC，对应本地 15:02），`lastError=NULL`；review 为 `RELEASE`，reason 为“系统核验通道异常重试耗尽”。event 为 `DELIVERED`、`attempts=1`。3 个 policy keys 查询为 0 rows，使用默认 `true / true / 60m`。这支持首次 SYSTEM 异常释放的结论；**具体 provider 原因未存储，不能据此判断为未关注或指定某个 provider 故障**。
- 当时 `open-campaign` 仍覆盖旧任务 tab，触发离站警告；选择 cancel 后保留，已补充精确目标页复用修复，**`30ce403` 已推送旧插件 feature branch**，474 项测试、类型检查与 beta 构建通过；**当时尚未 reload／浏览器复验**；后续已 reload，并在 1116f 通过精确新任务页导航复验。当时仅有构建和 reload 结果，后续以 1116f 的 live 导航结果确认修复。
- Chrome 切到无关 Google 登录窗口时，1116d 曾仍为 ACTIVE、尚未确认恢复，并再次请求用户暂停操作。**随后 1116d 已恢复并经 DB 确认：history COMMIT、RESTORED_EXACT；fixture COMMIT、4 flags 全部 true；当前无 active 夹具。** 这是 1116d 自身的恢复证据，不沿用先前 1116c 的恢复结论。

### 各轮恢复记录（已包含 1116f 独立确认）

**1116、1116b、1116c、1116d、1116e、1116f 各轮均已恢复并 COMMIT，当前无 active 夹具。** 1116e history 已 `RESTORED_EXACT`，fixture 4 flags true；最新 1116f 的 history 和 fixture 恢复另经独立截图确认，详见当前结果。 1116d history 独立确认 `RESTORED_EXACT`，fixture 的 4 flags 全部 true。 较早的 all-actions 夹具于 11:49 条件恢复，独立 `user_restored`／`details_restored`／`participant_restored`／`restore_recorded` 全部为 true；本次 1116b 另确认 **RESTORED_EXACT＋4 项布尔检查全部 true**。1116d 的恢复另以上述独立 DB 结果确认。较早的 all-actions 备份为 `public.lumi_all_actions_backup_1116`、`public.lumi_all_actions_participant_1116`；关注重试使用 `lumi_follow_run_backup_1116*`、`lumi_follow_run_participant_1116*`、`lumi_follow_history_backup_1116*`，恢复脚本见 `/private/tmp/lh3-all-fixture-sql.txt` 第 3 节。人工测试资格不能证明真实资料同步有效；恢复历史夹具也不表示新 FOLLOW 接单已完成核验。

## 限制和后续

- 1116f 已独立确认恢复，当前无 active 夹具；`30ce403` 精确任务导航已 live 通过。1116d 首次 SYSTEM 异常释放的具体 provider 原因未存，保留其失败证据，不用后续成功追认该轮通过。

- 当前五种单类型均有真实老插件提交及核验通过记录（LIKE 乐观）；剩余组合、负向/恢复场景及到期实际付款尚未完成。上述金额均为待支付，不宣称到账或完整迁移完成。
- 组合 worker/binder 本地回归：6 文件 **69 pass、1 skip、0 fail，645 assertions**；后端类型检查通过。跳过项是浏览器 RT 自动化用例；当前 live RT 已通过，但不能据此将整个跳过用例中的异常/恢复场景记为覆盖。全 contracts **168 pass**。
- 新站完整单元 **1280 pass、3 skip、3 baseline fail**；3 项为独立基线复现的主题颜色约束 1 项、web-session 登录刷新 2 项，不记作全绿。
- COMMENT/COMMENT_LIKE 提交后曾出现 Chrome 离开确认和焦点跳转异常（源码未发现关闭 X 标签）。跳转修复已通过 43 文件、461 项测试及 beta WXT build；已 reload，Open dashboard 实际进入新站 marketplace；成功提交后的自动跳转当时待复验，后续已在 1116f 通过，且保留旧 COMMENT 标签页。
- 新站实现目录为 `/private/tmp/lh3-engagement-shallow-20261116`；旧 `/Users/kkruis/Desktop/project/LightHouse3.0/.local/wt-central-live` 仅作参考。完整矩阵与未完成项见 [全互动计划](lighthouse3-all-engagement-plan.md)。

### FOLLOW 查询通道探测与 1116e 失败经过（历史记录）

以下为 1116f 成功前的排查记录；其中“未通过”“待复验”等描述仅指当时，不代表当前状态。当前以开头 1116f 记录为准。

1116e 实际验收：同 `c8d1d8c` 构造函数的独立只读 probe 在新 Worker 中返回 `FOLLOWING`，卖方 X ID `1823536928639344641`，耗时2365ms；未调用 Worker 入口或写DB。这证明真实关系查询可用，不等于任务通过。新任务 `cmwj0vu1b000301qi2o153uu3`（老插件 FOLLOW 1MiB 复验 1116e，1A席、12 LUX＋1.2费用）已创建、接单截止17:07。老插件 LIVE1，X刷新后卡片出现；实际取消关注再关注，但提交显示 ACTION_NOT_DETECTED。再次提交被自动审批拦截，要求先核对捕获；只读打开 Service Worker Console 也被拦截（将此前无 debugger 限制解释为禁止 DevTools），检查器已关闭，待用户明确允许只读任务ID/捕获布尔检查。尚未确认提交成功、自动跳转或任务核验通过。**1116e history 已 COMMIT RESTORED_EXACT；账号/资料/旧参与记录恢复已 COMMIT、4flags全true，无 active 夹具。** 新 claim 最终状态尚待回读；实际 X 关注保留。

后续修复（2026-11-16）：只读完整探测 Tweet241 返回 HTTP200、139,678 bytes、TIMELINE_SHAPE_OK，确认100KB限制会拒绝正常列表。修复 `c8d1d8cb69cbe6a962833bcdc625d286f73b3b13` 已推送并独立回读远端 dev；API／Worker 部署均 Done，日志确认 Recreated／Started，Worker 新容器 `c534a4ac830b` 产物中关系查询上限确为1MiB，`FOLLOW_PRECLAIM_CHECK_ENABLED` 未启用。仅调整关系查询，资料查询仍100KB；37项测试、165断言和完整后端类型检查通过，独立 review 无阻塞。book 索引有3项既有告警，未记为全绿。老插件 `30ce403` 已在 kingkk 点击重新加载并看到“已重新加载”；当时 X 页面新 content script 与提交跳转仍需真实任务复验，未将部署本身记为 FOLLOW 通过；后续 1116f 已完成真实关注、核验及导航复验。

更新（2026-11-16）：经用户授权，将老灯塔 production 服务已保存配置中的 `TWEET241_API_KEYS`、`XAPI_KEY` 同步到新测试站 API／Worker，仅修改这两项，生产服务未修改。两项服务部署均 Done（代码 `69deb15`）；API 容器 `4eb7afddc35b`、Worker 容器 `c7994a6b3be7` 内分别通过摘要比较确认两项运行时值与来源一致，未记录密钥。新 Worker 只读首 key 探测结果：Tweet241 HTTP **200**，但响应超过当时 **100KB** 上限；xAPI HTTP **401**。因此凭据同步及部署完成，FOLLOW 核验仍未通过，需调查响应限制及 xAPI 认证。来源是生产已保存配置，不代表已独立核验生产运行容器。下段 403／402 为换 key 前的历史结果。

2026-11-16，从测试站 Worker 容器执行有界只读探测：`LH_FOLLOW_ENABLED` 和 `LH_FOLLOW_X_READS_APPROVED` 为 true，Tweet241/xAPI 凭据均存在。分别使用各池首个 key 查询 BinanceResearch 的 followers／following 第一页，Tweet241 HTTP **403**、xAPI HTTP **402**，均为 HTTP_ERROR；未输出凭据或响应正文，未修改验证结果。此证据证明当时两次请求被服务商拒绝，不证明全部 key 均不可用，也不能还原 15:02 的具体响应。需恢复可用查询通道后复验 FOLLOW；不能以插件已提交替代服务端核验通过。
