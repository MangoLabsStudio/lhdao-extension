# lhdao-extension

Lighthouse 浏览器插件 — 自动在 X (Twitter) timeline 上高亮可参与的
engagement 任务,点击一键预约 + 验证 + 结算 LUX。

> Browser extension that highlights Lighthouse engagement tasks on the X
> (Twitter) timeline and lets KOLs reserve / verify / claim with one click.

---

## 开发

```bash
pnpm install
pnpm run dev          # WXT dev mode,Chrome 自动加载
pnpm run dev:firefox  # Firefox 调试
```

构建:

```bash
pnpm run build         # → .output/chrome-mv3/
pnpm run build:firefox # → .output/firefox-mv2/
pnpm run zip           # 生成发布包
```

## 安装(内测)

1. 下载最新 [Release](https://github.com/MangoLabsStudio/lhdao-extension/releases)
   的 `.zip` 文件
2. 解压到任意目录
3. Chrome → `chrome://extensions` → 打开右上角 "开发者模式"
4. 点击 "加载已解压的扩展程序" → 选中解压目录

## 配置

1. 在 [https://lhdao.top/settings/plugin-tokens](https://lhdao.top/settings/plugin-tokens)
   创建一个 plugin token,**复制明文(只显示一次)**
2. 点击浏览器右上角 Lighthouse 插件图标 → "Options" → 粘贴 token

## 架构

| 模块 | 职责 |
|---|---|
| `entrypoints/background.ts` | service worker,60s alarm 同步任务,所有网络请求出口 |
| `entrypoints/content/` | 注入 X timeline,DOM 监听 + 高亮 chip |
| `entrypoints/popup/` | 浏览器图标弹窗,显示概览 + 跳转到 web |
| `entrypoints/options/` | token 录入 + 调试开关 |
| `lib/` | 纯工具(tweetId 提取 / GraphQL fetcher / messaging RPC) |
| `components/chip/` | Shadow DOM React component,timeline 上的高亮按钮 |

详细设计:[docs/plans/2026-05-10-lighthouse-extension-design.md](https://github.com/MangoLabsStudio/lhdaov3/blob/main/docs/plans/2026-05-10-lighthouse-extension-design.md)
(主仓内部)。

## 浏览器支持

- ✅ Chromium 系(Chrome / Edge / Brave / Arc / Opera)
- ⚠️ Firefox 实验性(MV2 build,未做主流回归)
- ❌ Safari(暂不支持)

## License

MIT — see [LICENSE](./LICENSE).
