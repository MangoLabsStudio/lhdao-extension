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

## 未完成及恢复入口

浏览器控制连续超时，无法继续部署控制台核验。发布后空配对请求仍返回 `LOCAL_RUNTIME_WRITE_SCOPE`，不能声明新 API 已部署或配对成功。新站 API/Worker 需核对版本及显式插件/LIKE 开关，保持其余环境配置。插件来源应精确配置为 `chrome-extension://jenfbnidlggkkpedonpiakaabbbghcfj`。最终包对任务广场链接修正后已重新构建，浏览器中还需重新加载。

新站源码：`/Users/kkruis/Desktop/project/LightHouse3.0/.local/wt-central-live`。该本地工作区未拉取到上述远端新提交（Git HTTPS 连接重置/超时，发布改走 GitHub 连接工具）；不要直接强推本地 HEAD。远端 dev 是当前已发布来源。

尚需：核对 API/Worker 部署 → 重新加载老插件 → lumi 配对 → 真实 X 动作捕获和服务端回执 → 还原必要临时测试数据。此前 lumi 临时资料与旧参与记录已恢复，本轮未重新修改。
