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
| FOLLOW | 本地服务端关系及组合回归通过 | 新任务已创建；历史关系缺可靠 stable ID 阻断接单，临时隔离待用户单独确认、未修改 | 未进入付款链路 |
| COMMENT_LIKE | 服务端评论＋乐观点赞回归通过 | 11:25 接单；仅点赞不能提交，评论后解锁，插件提交及 Web 核验通过 | 1.2 LUX 待支付，最早 11-17 11:29 |
| 旧规则允许的多动作组合 | worker/binder 原子完成、缺项保护、并发和实际本地付款回归通过 | 待测 | 本地隔离测试通过；线上未验收 |
| 错账号/错目标/跨任务 | 签名、身份、重放及证据篡改已有回归 | 尚未完成逐项 live 验收 | 不得发奖 |
| 超时/限流/断网/重复提交 | 重试、并发和幂等已有回归 | 尚未完成逐项 live 验收 | 不得重复发奖 |
| 撤销动作/删除评论/失败修正 | 纠正提交和资金保护已有回归 | 待测 | 保留失败和恢复证据 |
| 插件休眠唤醒 | 插件完整回归通过 | 本轮正常 worker 唤醒与同步已确认 | 不适用 |

所有最早支付时间为 2026-11-17（Asia/Shanghai）；“待支付”不是实际到账。

旧捕获桥接来自网页消息，HMAC 只能证明签名绑定，不能单独证明真实社媒动作。不能通过关闭核验、伪造捕获或手工改完成状态来制造通过结果。

## 最新实现、部署与测试记录

- 老插件 `d620951` 已推送、构建并在 kingkk 加载；该加载版本完整回归 **43 文件、454 pass**，TypeScript 与测试站 WXT 构建通过。最新跳转修复已通过全套 **43 文件、461 pass** 及 **beta WXT build**，已在 kingkk 原安装目录 reload，CONNECTED 和同步正常。包版本仍为 0.4.17，只含 storage/alarms 和 X/测试站域名权限。
- API/Worker `f1c90ce` 部署 **Done、healthy**；Web `c156545`（`c156`）部署 **Done**。正常 worker 唤醒与同步已确认。
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
- FOLLOW `cmwiot5ts001601ndbeq20wvz`：BinanceResearch 新任务已创建（12＋1.2 LUX），但接单被“历史关注奖励目标身份缺失”拦截。已查到 1 条目标 `feng_btc` 的历史关系：`targetTwitterId=NULL`、`participant=NULL`，对应 unified campaign 缺失，无可靠 stable ID。已请求用户单独确认临时隔离，**尚未答复、未修改**；未完成接单或核验，不记为通过。
- 评论提交后出现 Chrome 离开确认及焦点跳转异常（源码未发现关闭 X 标签）；跳转修复已通过 43 文件、461 项测试及 beta WXT build，已 reload，Open dashboard 实际进入新站 marketplace；成功提交后的自动跳转尚待下一次任务复验。

## 临时 fixture 与剩余工作

**本轮临时 fixture 已于 2026-11-16 11:49 条件恢复并 COMMIT。** 独立回读 `user_restored`／`details_restored`／`participant_restored`／`restore_recorded` **全部为 true**。备份为 `public.lumi_all_actions_backup_1116` 与 `public.lumi_all_actions_participant_1116`，恢复脚本见 `/private/tmp/lh3-all-fixture-sql.txt` 第 3 节。此记录替代此前“尚未恢复”的状态；人工资格不能证明真实资料同步有效。FOLLOW 历史关系临时隔离是单独待确认事项，尚未修改。

剩余事项：等待用户对 FOLLOW 历史关系临时隔离的单独确认，继续处理身份阻断并完成真实链路；执行合法组合真实插件验收；核验到期实际付款与撤销/失败修正场景；reload 跳转修复包并复验提交后焦点/离开确认行为。**当前不能宣称全部互动迁移或全部验收完成。**
