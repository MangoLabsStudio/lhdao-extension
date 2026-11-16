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

以下更新以 `/private/tmp/lh3-live-acceptance-1116-progress.md` 和本轮追加 RT 记录为依据，替代早前“全互动包尚未加载、其他类型尚未实测”的状态。时间均为 Asia/Shanghai。

- API/Worker：`f1c90ce`，部署 Done、healthy；Web：`c156545`（短记 `c156`），部署 Done。
- 老插件：`d620951` 已推送、构建并在 kingkk 重新加载。该加载版本回归 43 文件、454 项通过；最新跳转修复已通过全套 **43 文件、461 项测试**及 **beta WXT build**，已在 kingkk 原安装目录 reload，CONNECTED 和同步正常。正常 worker 唤醒和任务同步已确认。发布、加载与下列 live 结果分别记录，不代表全部场景通过。
- COMMENT：任务 `cmwiolhsw000h01nd3hcm2kww`，11:20 接单，目标 `2121143384744362224`。真实评论 `https://x.com/lumi_lly/status/2122168321596391486`；老插件捕获并提交，Web 显示 COMPLETED、核验通过、待支付 **0.8 LUX**，最早 **2026-11-17 11:22**。
- COMMENT_LIKE：任务 `cmwiomrp1000s01ndcvf4dvjq`，11:25 接单，目标 `2121928196509884566`。真实点赞 15→16 后，插件显示 LIKE 完成、COMMENT 待完成且不可提交；发布评论 `https://x.com/lumi_lly/status/2122169974923964638` 后解锁并提交。Web 显示 COMPLETED、核验通过、待支付 **1.2 LUX**，最早 **2026-11-17 11:29**。评论为服务端核验，点赞仍为乐观核验。
- RT：任务 `cmwioi4gx000601ndhl9q4um6`，**11:33 接单**，目标 `2120398201056596019`。真实转发计数 **32→33**，老插件捕获并 submit；Web 核验通过、待支付 **20 LUX**，最早 **2026-11-17 11:36**。这是新增 live RT 证据，不等同于已实际付款。
- FOLLOW：已创建任务 `cmwiot5ts001601ndbeq20wvz`（BinanceResearch，12 LUX＋1.2 LUX 服务费）。接单被“历史关注奖励目标身份缺失”拦截。已定位 1 条目标 `feng_btc` 的历史关系，`targetTwitterId=NULL`、`participant=NULL`，对应 unified campaign 缺失，无可靠 stable ID。已向用户单独请求临时隔离该记录，**尚未答复、未修改**。尚未完成接单、真实关注提交或核验，不能记为通过。

### 本轮临时 fixture 已恢复（11:49）

2026-11-16 **11:49**，本轮临时资格/旧参与记录 fixture 已条件恢复并 **COMMIT**；独立回读 `user_restored`、`details_restored`、`participant_restored`、`restore_recorded` **全部为 true**。备份为 `public.lumi_all_actions_backup_1116`、`public.lumi_all_actions_participant_1116`，恢复脚本见 `/private/tmp/lh3-all-fixture-sql.txt` 第 3 节。本记录替代此前“尚未恢复”的状态。人工测试资格仍不能证明真实资料同步有效；上述恢复不包含尚未获批的 FOLLOW 历史关系临时隔离。

## 限制和后续

- 当前仅 LIKE、COMMENT、COMMENT_LIKE、RT 有真实老插件提交及核验记录；FOLLOW 阻断、多动作组合真实验收、到期实际付款及撤销/异常恢复仍未完成。上述金额均为待支付，不宣称到账或完整迁移完成。
- 组合 worker/binder 本地回归：6 文件 **69 pass、1 skip、0 fail，645 assertions**；后端类型检查通过。跳过项是浏览器 RT 自动化用例；当前 live RT 已通过，但不能据此将整个跳过用例中的异常/恢复场景记为覆盖。全 contracts **168 pass**。
- 新站完整单元 **1280 pass、3 skip、3 baseline fail**；3 项为独立基线复现的主题颜色约束 1 项、web-session 登录刷新 2 项，不记作全绿。
- COMMENT/COMMENT_LIKE 提交后曾出现 Chrome 离开确认和焦点跳转异常（源码未发现关闭 X 标签）。跳转修复已通过 43 文件、461 项测试及 beta WXT build；已 reload，Open dashboard 实际进入新站 marketplace；成功提交后的自动跳转尚待下一次任务复验。
- 新站实现目录为 `/private/tmp/lh3-engagement-shallow-20261116`；旧 `/Users/kkruis/Desktop/project/LightHouse3.0/.local/wt-central-live` 仅作参考。完整矩阵与未完成项见 [全互动计划](lighthouse3-all-engagement-plan.md)。
