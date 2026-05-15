# Lighthouse Sidebar Card · Design Spec (v2)

> 推特右侧 sidebar 卡片的设计规范。**v2 是大改动**:从单一"任务列表"升级为
> "个人面板 + TWEET 机会清单 + 创作 CTA" 三段式 mini-dashboard。
>
> 配套 mockup:`docs/mockup/sidebar-card.html`(浏览器直接打开,6 个 scene)。

---

## 0. v2 vs v1 — 改了什么

| 维度       | v1                     | v2                                       |
| -------- | ---------------------- | ---------------------------------------- |
| 任务类型     | ENGAGEMENT(点赞/转发/评论)  | **TWEET**(原创/引用转推/draft 类)           |
| 显示模块     | 只任务列表                  | **个人面板** + 任务列表 + **创作 CTA**          |
| 空状态      | `return null` 不挂载       | **挂载 + CTA**(让用户始终能看到 Lighthouse 入口) |
| 隐喻锚点     | "机会清单"(opportunity list) | **"Twitter 内的 Lighthouse mini-dashboard"** |

设计原则继承自 v1(轻盈/克制/有节奏 + OKLCH + system stack + 反 AI-slop),
新增模块按同一套原则扩展。

---

## 1. 信息架构

```
┌──────────────────────────────────────┐
│ ① 身份 strip                          │  ← Logo + Tier chip
│ ② 指标 row                            │  ← 余额 (P0) + 今日 (P2)
│ ③ 主 CTA                              │  ← [ + 发布任务 ]
│ ────── hairline ──────                 │
│ ④ section header                      │  ← "可抢推文任务 · 2"
│ ⑤ 任务 row × N (前 5 条)              │  ← 项目方 / brief / 截止 / 奖励
│ ⑥ footer link (>5 条时)               │  ← "查看全部 N 个 →"
└──────────────────────────────────────┘
```

**空态**(无 TWEET 任务): ④⑤⑥ 替换为单格 empty state — 不重复 CTA(头部已有)。

**未连接 token 态**: 只显示 ① + 简化的"配置 token"提示 + 跳 options 页按钮。

---

## 2. 信息权重(P0 → P5)

| P  | 内容               | 视觉处理                       | 字号/字重         |
| -- | ---------------- | -------------------------- | ------------- |
| P0 | **LUX 可用余额**     | 最大数字 + brand teal          | 22px / 900    |
| P0 | **任务奖励**         | 大数字 + brand teal           | 18px / 900    |
| P1 | **发布任务 CTA**     | filled teal button,全宽      | 13px / 700    |
| P1 | **Tier chip**    | 右上角小 chip,brand teal subtle | 10.5px / 800  |
| P2 | **今日收益**         | 紧贴余额下方,muted teal           | 12px / 600    |
| P2 | **任务 brief**     | 主信息,2 行 max                 | 13.5px / 600  |
| P3 | **项目方名**         | brief 上方,muted              | 12.5px / 500  |
| P3 | **截止时间**         | brief 下方,muted + clock icon | 11px / 500    |
| P4 | **section 头部计数** | "可抢推文任务 · 2",muted uppercase | 11px / 700    |
| P5 | **logo**         | 28px(头部 strip),28px(空态 icon) | —             |

**关键决策**(用户已确认):
- ✅ LUX 余额 = **单数字 `+1,234 LUX`**(可用余额),不分冷却中
- ✅ TWEET 任务行 **4 个字段**:项目方 / brief(60 字)/ 奖励 / 截止时间
- ✅ 空态 **挂载** + CTA

---

## 3. 模块详细规范

### ① 身份 strip(顶部 14/16 padding)

```
┌──────────────────────────────────┐
│  ◉  Lighthouse              [A]  │
│                                  │
└──────────────────────────────────┘
   Logo  品牌名               Tier chip
   28px  16/800              chip 内 10.5/800
```

- Logo:left,28px round-square,PNG 或 fallback SVG
- "Lighthouse":Logo 右,16px 800 ink-strong,letter-spacing -0.01em
- Tier chip:right,brand teal subtle bg(`oklch(0.96 0.025 195)`),teal 600 字色,
  圆 999px,padding 2/7,字"TIER A"(全大写)

### ② 指标 row(16/16 padding)

```
┌──────────────────────────────────┐
│  可用余额                         │
│  +1,234 LUX                      │  ← 22px 900 brand teal
│  今日 +42 LUX                    │  ← 12px 600 muted teal
└──────────────────────────────────┘
```

- 标签 "可用余额":11px 700 muted uppercase,letter-spacing 0.06em
- 余额数字:22px 900 brand teal,tabular-nums,letter-spacing -0.02em
  - "+1,234" 占主视觉,"LUX" 单位 13px 700 同色,**间距 4px**
- "今日 +42 LUX":12px 600,**色 = brand teal hue 但 lightness 拉到 0.7**(更浅,
  避免跟主余额抢焦点)
- 整个 row 左对齐(不居中)

### ③ 主 CTA(10/16 padding,full-width)

```
┌──────────────────────────────────┐
│  +  发布任务                      │
└──────────────────────────────────┘
   icon  label  (13px 700)
```

- Full-width filled button
- Bg: brand teal(`oklch(0.62 0.13 195)`)
- Text: white,字号 13px 700
- Padding: 10px Y / 16px X
- 圆角 10px(跟卡片整体节奏一致)
- Icon: "+" 加号(currentColor),12px,字符或 SVG 任一
- Hover: bg 加深一档(`oklch(0.55 0.14 195)`)
- Active: bg 再深一档 + transform scale(0.98) 60ms
- **不带 drop-shadow**(impeccable 禁用通用 shadow)

### ④ section header(12/16 padding)

```
┌──────────────────────────────────┐
│  可抢推文任务 · 2                  │  ← 11px 700 muted uppercase
└──────────────────────────────────┘
```

- 11px 700 muted,**全大写 letter-spacing 0.08em**
- 上方 hairline divider 1px
- 数字 "·N" 跟 label 同色,不强调

### ⑤ 任务 row(10/12 padding,4 字段)

```
┌──────────────────────────────────┐
│  项目方A                  +20    │  ← 项目方 left,奖励 right
│  写一条关于 ETH ETF 的推文        │  ← brief,2 行 max
│  ◷ 截止 3h 后                LUX │  ← 截止时间,clock icon
└──────────────────────────────────┘
```

- **grid**: `grid-template-columns: 1fr auto` · `gap: 12px` · `padding: 10/12`
- **Left col**(min-width 0):
  - Row 1: 项目方名 12.5px 500 muted,1 行截断
  - Row 2: brief 13.5px 600 ink-strong,2 行 max,`-webkit-line-clamp: 2`
  - Row 3: 截止时间 11px 500 muted + clock icon 10px,gap 4px
- **Right col**:
  - 奖励数字 18px 900 brand teal
  - "LUX" 单位 10px 700 brand teal opacity 0.7,下方
- Hover: 整行背景 → `oklch(0.97 0.025 195)`,过渡 120ms
- 行之间无 divider — 用 hover 区分边界

### ⑥ footer link(10/16 padding,when >5 tasks)

```
┌──────────────────────────────────┐
│      查看全部 12 个 →            │
└──────────────────────────────────┘
```

- 上方 hairline border-top
- 12.5px 700 brand teal,居中
- Hover bg 同 row hover

### 空态(无任务)

```
┌──────────────────────────────────┐
│  ① 身份 strip                     │
│  ② 指标 row                       │
│  ③ 主 CTA                         │
│  ────── hairline ──────            │
│                                  │
│         (decorative dot)          │  ← 1 个 micro dot teal,作 micro-anchor
│      暂无可抢推文任务              │  ← 13px 700 ink
│      新机会出现时会自动显示          │  ← 11.5px 500 muted
│                                  │
└──────────────────────────────────┘
```

- empty state padding 32/16
- 不重复 CTA(头部已经有"发布任务")— 克制原则
- decorative dot 是 6×6 brand teal soft glow(轻微 keyframe pulse 2s,可关)

### 未连接 token 态

```
┌──────────────────────────────────┐
│  ◉  Lighthouse                   │
│                                  │
│      请连接你的 Lighthouse 账号    │
│      [ 配置 token → ]            │  ← link 跳 options.html
└──────────────────────────────────┘
```

- 只显 ① 身份 strip(不显 Tier — 还没认证)
- 居中提示 + ghost 按钮跳 `chrome-extension://.../options.html`
- 没有任务列表 / 余额 / CTA 模块

---

## 4. 调色板补充(v1 token 全部继承)

| Token            | Light                       | Dark                          | 用途              |
| ---------------- | --------------------------- | ----------------------------- | --------------- |
| `--cta-bg`       | `oklch(0.62 0.13 195)`      | `oklch(0.70 0.13 195)`        | 发布任务 button bg |
| `--cta-hover`    | `oklch(0.55 0.14 195)`      | `oklch(0.62 0.13 195)`        | hover bg        |
| `--cta-fg`       | `oklch(0.99 0 0)`           | `oklch(0.18 0.008 240)`       | button 文字     |
| `--today-tint`   | `oklch(0.72 0.10 195)`      | `oklch(0.78 0.10 195)`        | 今日收益数字色      |
| `--tier-chip-bg` | `oklch(0.96 0.025 195)`     | `oklch(0.28 0.06 195 / 0.4)`  | Tier chip bg    |
| `--tier-chip-fg` | `oklch(0.55 0.13 195)`      | `oklch(0.8 0.13 195)`         | Tier chip 文字   |

**继承 v1 的核心 token**(`--bg-card`, `--border-card`, `--ink-strong`,
`--ink-muted`, `--brand-teal`, `--row-hover`)保持不变。

---

## 5. 节奏(spacing rhythm)

```
14px ── header strip ──
16px ── metric row pad
16px ── metric row pad
10px ── CTA button pad-y
─── hairline ───
12px ── section header pad
10px ── task row pad-y × N
─── hairline ───(only if footer)
10px ── footer pad-y
```

节奏特征:**舒-紧-动-紧-舒**(14 → 16 → 10 → 12/10 → 10),
中间紧凑、两端松弛。**这跟 hero-metric layout 不一样** — hero 是"big number
独大、其他都辅助",这里是"多模块协同、每个有自己的视觉权重"。

---

## 6. 动效

| 触发                 | 动效                                                    |
| ------------------ | ----------------------------------------------------- |
| 卡片首次挂载             | container fade-in + translateY(8→0),240ms exp-out  |
| 任务行 staggered 入场   | 每行 60ms delay,400ms exp-out                          |
| 余额数字首次出现           | 数字 odometer-like count-up (0 → final),600ms exp-out(可选,delight) |
| Hover row          | bg 过渡 120ms · 头像/项目方文字 transform 不变                  |
| CTA hover          | bg 颜色加深 120ms,**无 transform**(避免按钮抖)                |
| CTA active(点击瞬间)   | scale(0.98) 60ms 然后跳转                                |
| 空态 dot pulse       | 2s ease-in-out infinite,opacity 0.5↔1                |
| Reduced motion     | 所有 transform / translateY 移除,只保留 opacity 过渡 120ms linear |

---

## 7. 状态总览

| 状态                   | 渲染                                                |
| -------------------- | ------------------------------------------------- |
| 默认 + 有任务             | 所有 6 模块                                            |
| 默认 + 无任务             | 模块 ①②③ + 空态                                       |
| 加载中(首次同步)            | skeleton:身份 strip + 余额行 + CTA(都用 shimmer)+ 3 行任务 shimmer |
| 同步刷新中                | 卡片右上角 2px teal dot pulse 2s 后消失                  |
| 用户信息加载失败,任务正常        | ②③模块降级为"未登录" 提示;任务列表照常                            |
| 任务加载失败,用户信息正常        | ①②③正常,任务列表区显示"加载失败,稍后重试" + 重试链接                  |
| 未配置 token            | 只显 ① + "配置 token →"(跳 options 页)                  |
| 扩展 context invalidated | 整卡 unmount,popup 显示"扩展已重载,刷新页面"                   |

---

## 8. AI-slop 自检(逐项)

| 警惕                      | 本设计                                          |
| ----------------------- | -------------------------------------------- |
| Hero metric layout(大数+supporting stats+gradient) | ❌ 余额是大但**没有 gradient accent / 没有 sparkline / 没有 3-stat 堆叠** |
| Gradient text on 余额数字   | ❌ 单色 brand teal                              |
| Glassmorphism backdrop blur | ❌ 不用                                          |
| 紫蓝渐变 / 霓虹               | ❌ 全 brand teal 单色系                            |
| Border-left 色条           | ❌ BAN 1                                       |
| 圆角图标方块在每个模块标题            | ❌ 只 logo 有圆角,模块用文字 hierarchy 区分             |
| 等大 card grid 重复          | ❌ 不是 grid                                     |
| Sparkline 装饰            | ❌ 不用                                          |
| 通用 drop-shadow          | ❌ 只用 hairline                                |
| 所有 padding 一致           | ❌ 14/16/10/12/10 五段节奏                         |
| Modal 弹窗                | ❌ 不用                                          |
| 全居中布局                  | ❌ 左对齐为主,Tier chip / 奖励数字右对齐               |

---

## 9. 待后端确认的字段

为实现 v2 设计,后端 GraphQL 需要暴露:

| 字段                       | 来源                                | 已有? |
| ------------------------ | --------------------------------- | --- |
| `me.luxBalance`           | User.luxBalance                   | ?  |
| `me.userTier`             | User.userTier (S/A/B/C/D/E)       | ?  |
| `me.todayEarnings`        | sum(LuxTransaction where today)   | 需新加 resolver |
| `availableTweetCampaigns` | Campaign where type=TWEET,Tier 可见 | 需新加 query |
| 任务字段:`projectName`         | Campaign.buyerOrgName / authorName | ?  |
| 任务字段:`brief`              | Campaign.tweetBrief / description | ?  |
| 任务字段:`expectedReward`     | Campaign.expectedReward            | 已有 |
| 任务字段:`deadlineAt`         | Campaign.endTime                   | 已有 |
| 任务字段:`targetUrl`(跳转用)     | Campaign 详情页 URL                 | 拼接 |

**后端 work**:
1. 加 `me` query 返回 `{ luxBalance, userTier, todayEarnings }`
2. 加 `availableTweetCampaigns` query(或扩展现有让其支持 `type` filter)
3. 加 `@AllowPluginToken()` 装饰器在以上 2 个 resolver 上
4. 跑迁移(如果 `todayEarnings` 需要新字段;一般是 derived,不需要)

---

## 10. 剩余决策(可后置)

- **Tier chip 是否点击跳"我的等级详情"页?**(我推荐:可点,跳 `lhdao.top/tier`)
- **余额数字是否点击跳"钱包"页?**(我推荐:可点,跳 `lhdao.top/wallet`)
- **"今日收益"是否需要提示 24h reset 时间?**(我推荐:不需要,克制原则)
- **加载 skeleton 是否要 shimmer 动画?**(我推荐:要,但只一个 1.4s opacity pulse,
  不做 gradient sweep)

这些都不阻塞 mockup approval。

