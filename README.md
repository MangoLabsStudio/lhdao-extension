# Lighthouse browser extension

Lighthouse 浏览器扩展让用户在 X (Twitter) 上完成 engagement 任务，并在用户主动
授权的客户网站上验证 Product Experience 任务。

## 开发

```bash
pnpm install
pnpm run dev
pnpm run dev:firefox
pnpm run test
pnpm run typecheck
pnpm run lint
```

生产构建与发布包：

```bash
pnpm run build          # .output/chrome-mv3/
pnpm run build:edge     # .output/edge-mv3/
pnpm run build:firefox  # .output/firefox-mv3/

pnpm run zip
pnpm run zip:edge
pnpm run zip:firefox
node scripts/verify-product-manifests.mjs
```

默认端点为 `https://service.lhdao.top/graphql` 和 `https://app.lhdao.top`。生产构建拒绝 HTTP
和 loopback 端点。本地联调必须同时使用两个 loopback 端点并显式开启 local mode：

```bash
WXT_LOCAL_BUILD=true \
WXT_API_ENDPOINT=http://127.0.0.1:4000/graphql \
WXT_WEB_ENDPOINT=http://localhost:3000 \
pnpm run build
```

`localhost`、`127.0.0.1` 和 `[::1]` 是唯一允许的本地 host；不允许本地与生产端点混用。

## 产品验证的权限边界

- Manifest 只有 `storage`、`alarms`、`activeTab` 和 `scripting` 权限。
- Manifest 不包含 `<all_urls>` 或客户网站 host permission。
- 只有当用户打开扩展 Popup 并点击“开始验证”后，扩展才在当前标签页临时注入
  Product Experience evaluator。
- 跨 Origin 导航会立即进入“需要重新授权”，必须由用户再次点击；已命中的规则
  ID 进度会保留。
- `TEXT_CONTAINS` 只在内存中比对。Product Experience proof 不上传页面正文、DOM、
  Cookie 或表单值。

详细数据边界见 [PRIVACY.md](./PRIVACY.md)。

## 架构

| 模块 | 职责 |
|---|---|
| `src/entrypoints/background.ts` | MV3 service worker、任务同步、验证 controller 和网络请求 |
| `src/entrypoints/content.ts` | X timeline 的 engagement UI |
| `src/entrypoints/product-experience.content.ts` | 仅由 runtime injection 启动的声明式规则 evaluator |
| `src/entrypoints/web-presence.content.ts` | Lighthouse 页面与扩展的脱敏 bridge |
| `src/entrypoints/popup/` | 账号概览与 Product Experience 临时授权入口 |
| `src/entrypoints/options/` | Plugin token 配置 |
| `src/lib/` | GraphQL、storage、proof、watcher 和强类型 messaging |

## 浏览器状态

- Chrome / Edge：MV3 构建与发布包验证。
- Firefox：MV3 构建与发布包验证。AMO 提交前仍需发布方确认稳定 Gecko ID 和数据
  收集分类；当前产物不宣称 AMO-ready。
- Safari：暂不支持。

## 安装与发布

- 本地安装：[INSTALL.md](./INSTALL.md)
- 人工 E2E：[docs/E2E.md](./docs/E2E.md)
- 发布检查：[docs/PUBLISHING.md](./docs/PUBLISHING.md)

## License

MIT — see [LICENSE](./LICENSE).
