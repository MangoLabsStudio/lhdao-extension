# E2E Manual Test Checklist

灯塔 (Lighthouse) 浏览器插件端到端手动验收清单。**首次发布 v0.1.0 前必跑一遍。**

---

## Pre-conditions

- [ ] **Backend** 已部署到 dev (Railway: `MangoLabsStudio/lhdao-service` `dev` 分支)
  - `service.lhdaobeta.top/graphql` 可访问
  - `availableEngagements` query 返回非空(dev DB 至少 1 个 active ENGAGEMENT campaign)
  - campaign 的 `targetUrl` 指向一条**当前测试账号的 timeline 上能看到**的真实推文
- [ ] **Web** 已部署到 dev (Railway: `MangoLabsStudio/lhdao-app` `dev` 分支)
  - `lhdaobeta.top/settings/plugin-tokens` 可访问
- [ ] **测试账号**:
  - 在 lhdao 已登录
  - 已绑定的 X 账号是当前 Chrome 浏览器登录的同一账号
  - tier 不是 D/E(避免 reward = 0 干扰判断)

---

## 1. Token 创建 + 插件绑定

- [ ] 浏览器登录 lhdao 测试账号
- [ ] 访问 `lhdaobeta.top/settings/plugin-tokens`
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

## 6. 跨浏览器(可选,内测可后置)

- [ ] **Edge**:`pnpm build:edge` → `chrome://extensions` 加载,流程同 Chrome
- [ ] **Brave / Arc**:Chromium 系应该免改动,基本流程过即可

---

## 7. 发布 v0.1.0

全部步骤通过后:

```bash
git tag v0.1.0
git push origin v0.1.0
```

→ `.github/workflows/release.yml` 自动跑,在
`MangoLabsStudio/lhdao-extension/releases/v0.1.0` 上传 `.zip`。

把 GitHub Release 链接发给内测用户即可。
