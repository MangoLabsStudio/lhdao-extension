# Lighthouse 3 beta：沿用老插件

2026-11-16，用户要求继续使用老灯塔插件。基线为 origin/dev c5ad753（0.4.17）。

保留原 popup、X content/capture/bridge、设备密钥、签名与证明格式。仅在下列明确构建配置下使用新站 REST 适配，默认旧站 GraphQL 不变：

```sh
WXT_API_ENDPOINT=https://app.lhdaobeta.top/lighthouse3.0/api/v3 \
WXT_WEB_ENDPOINT=https://app.lhdaobeta.top/lighthouse3.0 pnpm build
```

当前验收范围：网页先接 LIKE 任务 → 老插件同步本人有效接单 → X 实际动作捕获 → 票据 → 原证明提交 → 新站异步核验。网络结果不明时持久化原命令并重发，提交返回 VERIFYING 不代表成功或奖励到账。其他互动、账号分析、插件内抢单等旧操作尚未接通，不应当作完整迁移验收。

## 已验证

- 连接、重试、回执绑定、原证明保留、manifest 权限、旧 popup：36 项测试通过。
- 插件 TypeScript 检查通过；Chrome MV3 构建及实际 manifest 检查通过。
- kingkk 已安装启用 Lighthouse 0.4.17，ID `jenfbnidlggkkpedonpiakaabbbghcfj`。
- 仅 storage/alarms 与 X/测试站域名权限；不使用 debugger。独立验收插件保持停用。
- 新后端改动已发布 dev `36b7c2bf1ab38398aa4ea1ee7977a1ee1ab82d0c` 并回读确认；基于远端 `9e30da0` 保留其新增 7 个提交，使用非强制带预期 SHA 的更新。

## 2026-11-16 浏览器实际验收

- 新站 API、Worker 部署记录均为 Done，版本 `c7fd682c6a17881c4f7693f42183b3eb77822b9b`。插件来源按安装 ID 精确配置，未启用 LIKE_COUNT 兜底。
- kingkk 中老插件成功配对 lumi / @lumi_lly，正常显示 CONNECTED。网页接单后手动同步由 TASKS LIVE 0 变为 1。
- 测试任务 `cmwi45trg000601o695c5fewl`（老插件验收 LIKE 20261116），发布者 0xWang健林，5 个 A 档席位，预算 2 LUX + 0.2 LUX 服务费。lumi 于 01:44 接单，约定净奖励 0.4 LUX。
- 目标 `https://x.com/BinanceResearch/status/2120398201056596019`，X 当前账号 @lumi_lly。点击真实点赞后由 122 变为 123，老插件原任务面板由“点赞 待完成”变为“点赞 已完成”，停留要求满足后点击“验证发奖”。
- 老插件显示“验证已提交 · 奖励发放中”；新站本人接单详情显示“已完成 / 核验已通过 / 待支付 0.4 LUX”，最早支付时间为 2026-11-17 01:47（Asia/Shanghai）。这是乐观核验提交及处理通过，**尚未实际支付**，不代表独立 X 二次核查或资金到账。
- 验收临时将 lumi AI 改为 WEB3，补充测试认证和 public_metrics.followers_count=1000，并隔离一条已结束旧任务参与记录。测试资格是人工夹具，不能证明真实资料同步有效。原始值已备份至测试数据库容器 `/tmp/lumi-plugin-profile-1116.jsonl`、`/tmp/lumi-plugin-participant-1116.jsonl`。验收后恢复，独立查询 type_restored、details_restored、participant_exact_restored 均为 true；旧参与记录整行 JSON 与备份相同。
- 保留真实点赞供延迟审核；此前 COMMENT 验收评论也保留。

## 限制和后续

其他互动类型尚未接入这个老插件适配，不能宣称完整迁移完成。还需核验到期后的实际支付与撤销/异常处理。浏览器验收时 Service Worker DevTools 曾保持打开，本轮尚未验证普通休眠唤醒行为。

当前安装构建还含配对错误提示保留的四行本地诊断改动（background.scheduleReset），未纳入已推送功能提交；不将它认定为配对成功的必要修复。

新站源码：`/Users/kkruis/Desktop/project/LightHouse3.0/.local/wt-central-live`。本地工作区尚未对齐上述远端提交，不要直接强推本地 HEAD。老插件功能提交 `daedf67` 位于 `feat/lh3-legacy-plugin-beta`，未合并老插件 dev/main。
