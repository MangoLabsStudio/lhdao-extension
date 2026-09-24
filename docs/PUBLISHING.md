# Chrome Web Store 上架指南

完整流程 + 必备素材清单。**第一次上架最容易卡在 listing 素材准备而不是技术**,
所以这份文档把"动手前要准备"和"操作步骤"分开。

---

## 📋 Pre-flight checklist

### 1. 注册开发者账号(只需一次)

- 打开 https://chrome.google.com/webstore/devconsole/
- 用 Google 账号登录
- 支付 **$5 一次性注册费**(信用卡 / Google Pay)
- 完成账号 + 邮箱验证

### 2. 准备素材(花的时间 80% 都在这)

| 素材 | 规格 | 必填 | 说明 |
|---|---|---|---|
| **图标** | 128×128 PNG | ✅ | 已在 manifest 里(`public/icon/128.png`)|
| **截图** | 1280×800 或 640×400 PNG/JPG | ✅ | 1-5 张,推荐 5 张展示不同场景 |
| **小磁贴**(Promo Small)| 440×280 PNG/JPG | 推荐 | 在 Chrome Store 列表卡片上显示 |
| **大横幅**(Marquee)| 1400×560 PNG/JPG | 可选 | 只有想被 Chrome 编辑推荐才需要 |
| **应用名** | ≤ 45 字符 | ✅ | "Lighthouse · X 任务一键领" |
| **简短说明** | ≤ 132 字符 | ✅ | 列表卡片下方那一行 |
| **完整描述** | ≤ 16K 字符 | ✅ | 商店详情页主体,支持 markdown-like |
| **分类** | 单选 | ✅ | 推荐 "生产力工具" 或 "社交与通讯" |
| **隐私政策 URL** | 公开可访问 | ✅ | 因为我们存了 plugin token,必须提供 |

### 3. 写文案(中文 + 英文双语,store 支持多语言)

**简短说明范例**(132 字符):
> 在 X (Twitter) timeline 上一键高亮 Lighthouse 任务,做完点 verify 立刻发 LUX。

**完整描述结构**:
- 一句话价值
- 3-5 个 bullet 列功能
- 截图说明(为什么截图里有任务标记)
- 隐私声明摘要(token 只存本地、不上传第三方)
- 使用步骤(1. lhdao.top 创建 token → 2. 粘贴 → 3. 浏览 X)
- 反馈渠道(GitHub Issues / 邮箱)

### 4. 截图(最关键)

5 张 1280×800 PNG,推荐场景:
1. Timeline 上推文有 `+5 LUX` badge 出现的样子
2. 详情页推文头部 badge + claim 按钮
3. Like 按钮呼吸渐变(动作引导)
4. 点击 claim 后 reserve 成功 + verify 倒计时
5. options 页面 plugin token 已绑定的样子

**注意**:截图里不能出现真实用户的头像 / handle / 推文内容,提前用测试账号
+ 测试 campaign 准备好。

### 5. 隐私政策

最简单:在 GitHub Pages 或 Notion 公开页面写一段。模板(**重要:已含 dwell
tracking 披露**,删了会过不了 Chrome Web Store 审核):

```
Lighthouse Extension Privacy Policy

1. 我们存什么(本地)
   - Plugin API token (chrome.storage.local 本地存储)
   - 当前可参与的 Lighthouse 任务列表缓存 (chrome.storage.session,关浏览器
     即清)

2. 我们传什么(到 lhdao 自家后端,无第三方)
   - Bearer 鉴权访问 service.lhdao.top GraphQL API
   - **推文详情页停留时长** (recordTweetDwell mutation):
     · 触发:用户在 x.com / twitter.com 打开任何 /<user>/status/<id>
       页面,并在该页面有"可见"停留 (后台 tab / 最小化不计)
     · 数据:tweet 数字 id + 累积可见毫秒数
     · 用途:作为反作弊信号喂给 lhdao 内部 AntibotV2 评分模型
     · 不影响奖励发放
     · 仅在用户已绑定 plugin token 时发送

3. 不收集的
   - 不读推文正文 / X 账户信息 / 关注列表
   - 不上报普通浏览历史 (非 /status/ 的页面不跟踪)
   - 不访问 cookie / 密码 / 其他扩展数据
   - 无 Google Analytics / Sentry / 任何第三方 SDK

4. 联系 / 数据删除请求
   support@lhdao.top
```

把这段放在公开 URL 比如 `https://lhdao.top/privacy/extension` 或 GitHub README
里某个 anchor。

### 6. 隐私实践声明(在 dev console 填表)

Chrome 会让你逐条勾选 / 解释:

- **Single purpose**:
  > Highlight Lighthouse engagement tasks on X (Twitter) timeline and enable
  > one-click claim & verify.

- **使用 `storage` 权限**:
  > Save the user's Lighthouse API token locally and cache the list of active
  > tasks. Token stays in chrome.storage.local, never transmitted to third parties.

- **使用 `alarms` 权限**:
  > Refresh the list of available engagement tasks every 60 seconds in the
  > background.

- **使用 `host_permissions` (x.com, twitter.com)**:
  > Inject the highlight UI into the tweet metadata header and action button
  > row. The script only reads tweet IDs from anchor href; never reads tweet
  > body content or user info.

- **使用 `host_permissions` (service.lhdao.top, lhdaobeta.top)**:
  > Talk to the Lighthouse backend via GraphQL for fetching tasks and
  > submitting reservation/verification.

- **是否收集用户数据**:
  - personally identifiable info → No
  - health → No
  - financial / payment → No
  - authentication info → **Yes** (the plugin token is auth credential)
    解释:"Plugin API token used for Bearer auth to lhdao backend. Stored only
    locally; never transmitted to third parties."
  - personal communications → No
  - location → No
  - web history → No (we read tweet IDs from current page, not browsing history)
  - **user activity → Yes** ⚠️
    解释:"For every tweet detail page (URL matches /<user>/status/<id>) the
    user opens on x.com / twitter.com, the extension records the visible
    dwell time in milliseconds and sends it to the lhdao backend
    (service.lhdao.top) along with the tweet id. This is used as an
    anti-cheat signal feeding lhdao's internal fraud detection model and
    does not affect reward calculation. Background-tab and minimized-window
    time is excluded. No third parties receive this data."
  - website content → No (we read DOM but only `<time>` / link href for tweet ID)

---

## 🚀 操作步骤

### 1. 产出干净 prod build

```bash
cd ~/Desktop/airdrop/lhdaov3/lhdao-extension
# 确认是 main 分支干净状态
git status
# 用 prod 端点(不是 beta)build
pnpm run build      # ← 默认就是 prod
pnpm run zip        # 产出 .output/chrome-mv3-<version>.zip
ls -lah .output/*.zip
```

build 完看 `.output/chrome-mv3-0.1.0.zip` 这种文件,几百 KB 大小,这就是要上传的。

### 2. 提交到 Chrome Web Store

1. 打开 https://chrome.google.com/webstore/devconsole/
2. 右上 **"+ New item"** → 上传刚才那个 zip
3. 系统解析后进入 listing 编辑界面,依次填:

   **Store listing**(必填):
   - Product name → `Lighthouse · X 任务高亮`
   - Summary(132 字符短描述)
   - Description(完整描述)
   - Category → Productivity 或 Social Networking
   - Language → Chinese (Simplified) + English

   **Graphic assets**:
   - Store icon(自动从 manifest 里读 128×128)
   - Screenshots(5 张 1280×800)
   - Promo tile(440×280)

   **Privacy practices**:
   - Single purpose
   - 各权限解释(见上面模板)
   - Privacy policy URL(填你公开的隐私政策链接)
   - Data usage 勾选(authentication=Yes,其余 No)

   **Distribution**:
   - Visibility → **Public**(或先 Unlisted 仅链接可见,测试期推荐)
   - Geographic distribution → All regions(或只勾你目标市场)

4. 点 **Submit for review**

### 3. 审核

- **首次提交**:1-7 天(中位数 2-3 天)
- **更新**:通常 24h 内
- **常见拒绝原因**:
  - 截图模糊 / 不展示实际功能
  - 描述夸大("世界第一"等)
  - host_permissions 解释含糊(每个域名要单独写理由)
  - 没填隐私政策 URL
  - 代码混淆(minify 可以,但不能用 obfuscator)

### 4. 上线后

通过后用户能在 `https://chrome.google.com/webstore/detail/<extension-id>` 安装。
**注意**:Chrome Web Store 安装的扩展 ID 是 Google 分配的固定值,跟开发模式 ID
不一样。这意味着:

- `host_permissions` 里的 `chrome-extension://[a-z]{32}` 正则**仍然匹配**(因为
  Google 也是分配 32 字母小写 ID)→ backend CORS 不用改
- 用户旧的本地 token 在切到 Web Store 版本后会**清空**(扩展 ID 变了,
  chrome.storage 隔离)→ 提前在网页里告知用户

### 5. 之后的版本更新

```bash
# 1. 改 package.json 的 version (0.1.0 → 0.1.1)
# 2. 改完代码 push 到 GitHub
# 3. tag + 触发 release workflow 或手动:
pnpm run zip
# 4. 回 Chrome Web Store dev console → 上传新 zip → submit
```

CI 已经在 `.github/workflows/release.yml` 里配好了 `git tag v*` 触发自动 zip +
GitHub Release,**Chrome Store 那边的上传目前还要手动**(Google 有 chrome-webstore-upload
工具可以自动化,但需要 OAuth 麻烦,先手动)。

---

## 🌐 多浏览器分发(可选)

- **Edge Add-ons**(Microsoft 商店):https://partner.microsoft.com/dashboard/microsoftedge
  - 同样的 chrome-mv3 zip 可以直接交,Edge 完全 兼容
  - 审核稍慢(3-7 天),无 $5 费用

- **Firefox Add-ons** (AMO):https://addons.mozilla.org/developers/
  - 用 `pnpm run build:firefox` 出 firefox-mv2 build
  - 需要单独签名后才能 self-distribute(或者交 AMO 让他们签)
  - **注意**:Firefox 的 MV2 与 MV3 政策一直在变,2026 可能有大调整
