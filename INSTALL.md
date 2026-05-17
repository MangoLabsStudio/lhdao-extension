# Lighthouse 浏览器插件 · 安装指南

> Chrome Web Store 上架审核中。提前体验请走"开发者模式"加载。3 步,2 分钟。

---

## 第 1 步:下载 zip

打开 **https://lhdao.top/extension** → 点 "下载 ZIP · v0.1.0" 按钮 → 拿到
`lhdao-extension-0.1.0-chrome.zip`。

把 zip **双击解压**到一个你能记住的固定位置(推荐 `~/Downloads/lighthouse`
或 `~/Applications/lighthouse`)。

> ⚠ **不要**装完了就把这个文件夹删了或者挪走 — Chrome 是直接从这个文件
> 夹加载扩展的,文件夹一动扩展就失效。

如果 Safari 阻挡 zip 下载,改用 Chrome 打开同一个链接,或者 terminal:

```bash
curl -O https://lhdao.top/lhdao-extension-0.1.0-chrome.zip
unzip lhdao-extension-0.1.0-chrome.zip -d ~/Downloads/lighthouse
```

---

## 第 2 步:Chrome 加载已解压扩展

1. 浏览器地址栏输入 `chrome://extensions` 回车
2. 页面右上角找到 **"开发者模式"** 开关 → 打开
3. 左上角出现三个新按钮 → 点 **"加载已解压的扩展程序"**
4. 弹出文件选择器 → 选刚才解压出来的目录(**里面要有 `manifest.json` 那一层**,
   不是 zip 文件本身,也不是解压后多嵌套了一层的外层)
5. 装好后扩展列表里出现一张 "Lighthouse" 卡 → 拷贝它显示的 **ID**(`abc...`
   32 个字母),以后排查用得上

**(可选)把图标钉在工具栏**:
- Chrome 工具栏右侧拼图图标 🧩 → 找到 Lighthouse → 点旁边的图钉 📌
- 之后灯塔图标常驻工具栏,点一下就能看任务状态

---

## 第 3 步:粘贴 plugin token 绑定账号

1. 点工具栏的灯塔图标 → 弹出 popup
2. 看到 "未配置 token" → 点 **"去配置"** → 打开 options 页
3. options 页指引你去 `https://lhdao.top/settings/plugin-tokens` 创建一个
   新 token
4. 在 lhdao 网站点 "创建 token" → 起个名(随便,比如 "我的 Mac · Chrome")→
   弹窗显示完整 token,**只显示一次**,立刻复制
5. 回到 options 页 → 把 token 粘进输入框 → 点 "保存并验证"
6. 看到绿色 **"已绑定 @你的用户名"** → 完成

---

## 验证

去 `https://x.com` (或 `https://twitter.com`),刷新页面。如果你账号已经有可
抢的任务,会看到:

- **timeline 推文上方** 出现 `+N LUX` 小标签
- **like / RT / 评论按钮** 出现品牌色呼吸光晕
- 进推文详情页,action 行末尾出现 **[抢单]** + **[验证]** 两个按钮
- 右侧 sidebar 出现 "灯塔任务" 卡片(显示余额 + 今日 + TWEET 任务列表)

---

## 常见问题

### 装好了什么都看不到?

1. **Chrome console 看日志**:F12 → Console → 找 `[lhdao]` 开头的行
   - 看到 `snapshot loaded: 0 tweets, 0 authors` → 你账号当前没可抢任务(正常)
   - 看到 `snapshot fetch failed` → token 失效 / 网络问题
   - 完全没 `[lhdao]` 日志 → 扩展没装载到 x.com,刷新页面

2. **chrome://extensions 看扩展状态**:Lighthouse 卡片必须是 **"已启用"** 状态
   (绿色开关打开)

### 网址 / token 不匹配?

token 是 **per-environment** 的:
- `lhdao.top` 创建的 token → 只能用于 prod 扩展(上线后)
- `lhdaobeta.top` 创建的 token → 只能用于 beta 扩展(开发用)

这个 zip 是 **prod 版本**(指向 `service.lhdao.top`)。如果你的 token 是 beta
创建的,把它换成 `lhdao.top` 上重新创建的就行。

### 升级新版怎么办?

Chrome Web Store 上线之前,升级 = **手动下载新 zip + 重装**:
1. 删除旧 `chrome://extensions` 中的 Lighthouse(右下角"移除")
2. 从 https://lhdao.top/extension 下载新 zip
3. 解压 → load unpacked → 重新粘贴 token

Web Store 上线后会自动后台更新,这个步骤就免了。

---

## 隐私与安全

- 插件只在 `x.com` / `twitter.com` / `service.lhdao.top` 三个域生效
- 没有 `<all_urls>` 权限,不读其他网站任何内容
- Token 存在 `chrome.storage.local`,**不进 cookie / localStorage** — 任何
  XSS 也偷不到
- 上报内容仅:tweetId + 累积可见时长 + (新增)推文 URL + 作者 handle —
  仅发到 `service.lhdao.top`,**无任何第三方收集**(无 GA / Sentry)
- 详细技术文档:`https://github.com/MangoLabsStudio/lhdao-extension/blob/main/CLAUDE.md`
