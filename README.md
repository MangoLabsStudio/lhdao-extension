# Lighthouse browser extension

Lighthouse 浏览器扩展让用户在 X (Twitter) 上完成 engagement 任务。产品体验任务由 Buyer 在 Lighthouse 网站人工审核。

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
node scripts/verify-manifests.mjs
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

## 权限边界

- Manifest 只使用 `storage` 和 `alarms`。
- 主机访问限定为 X、Twitter 及配置的 Lighthouse API 和网站。
- 产品体验自动采集、规则匹配及证明运行时已移除。

详细数据边界见 [PRIVACY.md](./PRIVACY.md)。

## 架构

| 模块 | 职责 |
|---|---|
| `src/entrypoints/background.ts` | MV3 service worker、任务同步、验证 controller 和网络请求 |
| `src/entrypoints/content.ts` | X timeline 的 engagement UI |
| `src/entrypoints/web-presence.content.ts` | Lighthouse 页面与扩展的脱敏 bridge |
| `src/entrypoints/popup/` | 账号概览与登录连接 |
| `src/entrypoints/options/` | Plugin token 配置 |
| `src/lib/` | GraphQL、storage、互动证明和强类型 messaging |

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

币安广场功能已在 dev 注释停用：专用实现和测试保留在 `.disabled` 文件中，不参与构建。恢复前需同时恢复入口、后台、权限与测试。
