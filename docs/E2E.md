# E2E Manual Test Checklist

灯塔 (Lighthouse) 浏览器扩展端到端手动验收清单。**发布 v0.2.0 前必须完整执行。**

---

## Pre-conditions

- [ ] **Backend** 已部署到 dev (Railway: `MangoLabsStudio/lhdao-service` `dev` 分支)
  - `service.lhdaobeta.top/graphql` 可访问
  - `availableEngagements` query 返回非空(dev DB 至少 1 个 active ENGAGEMENT campaign)
  - campaign 的 `targetUrl` 指向一条**当前测试账号的 timeline 上能看到**的真实推文
- [ ] **Web** 已部署到 dev (Railway: `MangoLabsStudio/lhdao-app` `dev` 分支)
  - `https://app.lhdaobeta.top/settings/plugin-tokens` 可访问
- [ ] **测试账号**:
  - 在 lhdao 已登录
  - 已绑定的 X 账号是当前 Chrome 浏览器登录的同一账号
  - tier 不是 D/E(避免 reward = 0 干扰判断)
- [ ] **扩展端点**同时指向同一环境。本地 HTTP 联调必须设置
  `WXT_LOCAL_BUILD=true`，且 API/Web 都使用 `localhost`、`127.0.0.1` 或 `[::1]`；
  不得混用生产与本地 host。
- [ ] **Beta 扩展构建**使用完整的 API/Web 端点：

  ```bash
  WXT_API_ENDPOINT=https://service.lhdaobeta.top/graphql \
  WXT_WEB_ENDPOINT=https://app.lhdaobeta.top \
  pnpm run build
  ```

---

## 1. Token 创建 + 插件绑定

- [ ] 浏览器登录 lhdao 测试账号
- [ ] 访问 `https://app.lhdaobeta.top/settings/plugin-tokens`
- [ ] 点击 **"创建 token"** → 弹出输入 label 弹窗 → 输入 "E2E Mac" → 创建
- [ ] **明文 token 弹窗** 出现 → 点击 "复制" → toast "已复制"
- [ ] 关闭弹窗 → 列表里出现新 token,prefix 8 字符显示

- [ ] 加载扩展(开发模式 `pnpm run dev` 自动加载,或 `chrome://extensions` 手动加载 `.output/chrome-mv3/`)
- [ ] 点工具栏 Lighthouse 图标 → popup 显示 "**未配置 token**"
- [ ] 点 popup 里的 "**去配置**" → options 页打开
- [ ] **粘贴 token** 到文本框 → 点 "保存并验证"
- [ ] 期望:出现绿色 BoundCard,显示 "已绑定 @<username>" + tier
- [ ] 切回 popup → 显示 KPI grid(活跃任务 + 覆盖推文)和 "上次同步 X 秒前"

---

## 2. Chip 在 timeline 出现

- [ ] 等 5-60 秒(等首次 sync alarm),或在 popup 里点 "**刷新**"
- [ ] 打开 `x.com/home`(或推文所在 user 的 profile 页)
- [ ] 滚动到 **targetUrl 指向的那条推文**
- [ ] 期望:推文卡片下方出现 chip:
  - Header: `🗼 LIGHTHOUSE · 1 task` + `+5 LUX` badge
  - Sub-row: `❤️ 点赞 · +5 LUX` + `[✓ 我做完了]` 按钮
- [ ] **DevTools** → Elements 检查注入的 chip 是 `<div data-lhdao-chip-host="1">` 含 `#shadow-root (open)`,内部 React 树独立

---

## 3. Reserve + Verify 成功路径

- [ ] **在 X 原生 UI 上真的点赞**这条推文
- [ ] 回到 chip,点 "**✓ 我做完了**"
- [ ] 期望流程:
  - 按钮变 "**提交中**"
  - 几秒后变 "**🎉 +5 LUX**" 绿色 badge
- [ ] 60 秒内 chip 消失(下次 sync 这个 campaign 已不在 active 列表)
- [ ] 在 lhdao web `/dashboard` 验证 `newLux` 余额 +5

---

## 4. 失败路径(必跑)

### 4a. 评论缺关键字
- [ ] dev DB 有一个 COMMENT 类 campaign,`commentGuide = "#lhdao"`
- [ ] 在 X 评论该推文,但**不带** `#lhdao`
- [ ] chip 点 "我做完了" → 期望显示 "**评论缺关键字 · 重试**"

### 4b. 没真的做动作
- [ ] 没点赞推文,直接 chip 点 "我做完了"
- [ ] 期望 `submitting` → 5s 重试 → 最终显示 "**未检测到动作 · 重试**" 或 "**X API 延迟 · 重试**"

### 4c. token 失效
- [ ] 在 lhdao web `/settings/plugin-tokens` 吊销当前 token
- [ ] 60s 内 popup 自动刷新 → KPI 变成 "0 活跃任务"
- [ ] 在 X timeline 上之前出现的 chip 应该被卸载消失
- [ ] options 页保存空字符串 → BoundCard 消失,回到 idle

### 4d. 离线
- [ ] 打开 DevTools → Network → Offline
- [ ] popup 里点 "刷新" → KPI 不变(保留旧数据,不清空)
- [ ] 切回 Online → 自动恢复

---

## 5. 性能 / 安全 sanity check

- [ ] **chrome://extensions** → Lighthouse → Service Worker → "检查视图: 后台页"
  - Console 应该看到 `[lhdao] background worker booted`
  - 每 60s 看到一次 sync 输出 / 网络请求(DevTools Network)
- [ ] **Performance**:在 X timeline 滚动 30s,DevTools Performance 录制
  - chip mount/unmount 不应造成 layout thrash
  - MutationObserver 不应飙到 Long Tasks (>50ms)
- [ ] **CSP**:Twitter 不报 CSP 违规 (chip CSS 走 Shadow DOM,不是 inline style)
- [ ] **token 隔离**:在 X timeline DevTools → Console 输入 `chrome.storage.local.get('apiToken')` 应该 `Promise<{}>`(content script world 拿不到 background 的 storage)

---

## 6. Product Experience / activeTab 验收

使用 Buyer 发布的 TEST ticket 和可控的客户页面。页面至少包含两个声明式规则，其中一个
为 `TEXT_CONTAINS` 或 `ATTRIBUTE_EQUALS`。

- [ ] 在 Lighthouse 页保存 Product Experience TEST 任务后，Popup 显示 campaign title、
  `0 / N` 与“准备验证”。
- [ ] 按钮旁精确显示“只在本次授权的当前网站读取 Buyer 配置的完成标记”；不宣称浏览器
  会弹权限警告。
- [ ] 点击前，客户页没有运行 `product-experience.js`；manifest 也没有客户 host permission
  或静态 evaluator。
- [ ] 在允许的客户页点击“开始验证”，状态依次进入授权/检查，完成数随页面标记变化。
- [ ] 完整 reload 与同 Origin 第二页会自动重新注入，不重新 mint ticket。
- [ ] 导航到不同 Origin 后立即进入“需要重新授权”，保留已命中数，且不自动注入。
- [ ] 重新打开 Popup 并点击“重新授权”后才继续。
- [ ] 所有规则完成后只提交一次 proof，最终显示“验证通过”。
- [ ] 重启 extension service worker / 重开 Popup 后，不确定网络结果使用同一份已签名 payload
  重试，不生成新 nonce。

## 7. Product Experience 隐私检查

- [ ] DevTools 确认 proof 只含 rule ID、时间、origin、path hash 与防重放字段。
- [ ] `TEXT_CONTAINS` 的 matched text 没有出现在 message、storage、request 或 log 中。
- [ ] 验证过程不读 Cookie、input value、整页 HTML、iframe document 或表单数据。
- [ ] Popup 和 Lighthouse page bridge 不显示 ticket、MAC key、selector、matched text 或 device ID。

## 8. Chrome / Edge / Firefox MV3

- [ ] `pnpm run build`、`pnpm run build:edge`、`pnpm run build:firefox` 均退出 0。
- [ ] `node scripts/verify-product-manifests.mjs` 通过。
- [ ] Chrome 完整执行 engagement 和 Product Experience 正常/跨 Origin 流程。
- [ ] Edge 使用新 TEST ticket 重复 Product Experience 授权、pending → done 与 proof accepted。
- [ ] Firefox 使用新 TEST ticket 重复同一流程，不得出现 MV2 API/permission 错误。

Firefox 这一步只验证 MV3 runtime artifact。提交 AMO 前还必须完成
[PUBLISHING.md](./PUBLISHING.md) 中的 Gecko ID 与 data collection permission 门禁。

## 9. 发布 v0.2.0

三个生产 zip 构建、解压并通过 manifest verifier 后，先记录 tested commit SHA 和三份
zip 的 SHA-256，再停止，不得自行打 tag。将这些证据提交给 release owner；只有取得
明确批准后，才可执行：

```bash
git tag -a v0.2.0 -m "release: extension v0.2.0"
git push origin v0.2.0
```

Release workflow 会重新执行 test/typecheck/lint，构建三个生产 zip，解压后运行同一 manifest
verifier，然后只上传 Chrome、Edge 和 Firefox 三个已验证包。
