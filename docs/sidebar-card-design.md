# Lighthouse Sidebar Card · Design Spec

> 推特右侧 sidebar "灯塔任务" 卡片的设计规范。
> 配套 mockup:`docs/mockup/sidebar-card.html`(浏览器直接打开)。

---

## 0. 上下文(为何不能套用主 app 的 design context)

`.impeccable.md` 描述的是 **Lighthouse 主 app 的 buyer 端"网购加购物车"流程** —— 用户在自己平台上发广告订单。本场景完全不同:

| 维度          | 主 app (.impeccable.md) | 本卡片(sidebar)            |
| ----------- | --------------------- | -------------------------- |
| 用户身份        | Buyer(项目方/marketer)   | **Seller / KOL**(卖方)      |
| 嵌入环境        | Lighthouse 自家页面        | **第三方网站(Twitter)** 内部     |
| 主要任务        | 装订单、批量邀请、checkout      | **扫一眼、跳过去执行**             |
| 字体可用性       | Rubik / Versus 自由用     | Shadow DOM,**慎加 web font** |
| 持续暴露时长      | 一次性流程(几分钟)            | **每天 X 小时**(长期共存)          |
| 视觉自由度       | 100%                  | 必须尊重 Twitter 原生视觉          |

→ 复用品牌色 + 调性(轻盈 / 克制 / 有节奏),但 anchor / 字体 / 信息层级 **重新决策**。

---

## 1. Anchor(设计锚点)

> 一句话:**机会清单(opportunity list)**,不是任务面板、不是仪表盘、不是广告位。

参考心理模型:
- 证券 app 的"打新申购"清单 —— 有限时性、有报酬、有门槛
- Uber/滴滴司机端的"附近订单"列表 —— 报酬一眼可见、决策依据明确
- 邮箱里的"未读 priority"分组 —— 不打扰但你想瞥一眼

**KOL 滑着 Twitter,余光扫到这张卡片**:期望在 **2 秒内**判断有没有值得做的、值多少钱、要花多久。看到值钱的就跳过去做;没有就继续刷 Twitter。

这决定了一切:**奖励数额是视觉头号锚点**,不是头像,不是作者,不是卡片标题。

---

## 2. 信息优先级(权重排序)

| 优先级 | 信息              | 视觉权重               | 说明                            |
| --- | --------------- | ------------------ | ----------------------------- |
| P0  | **奖励数额** (+N LUX) | 最大字号 + brand teal | 决定值不值得做                       |
| P1  | **动作类型** (赞/转/评) | 中字号 + 色块 chip      | 决定要花几秒(点赞 3 秒,评论 1 分钟)        |
| P2  | **作者 + handle** | 标准字号 + 黑/白         | 决定调性匹配度                       |
| P3  | **推文预览**(1 行)   | 小字号 + muted        | 决定愿不愿意为这条内容站台                 |
| P4  | **评论关键字**       | 小 chip + 异色        | 评论任务才显示,作为约束提示                |
| P5  | **头像**          | 40px → **32px**(降权) | 辅助识别,但不该跟奖励抢焦点                |

**改动 vs 当前实现**:
- 奖励数字 17px → **20px**,字重 800 → **900**(显得更"硬")
- 头像 40px → **32px** (减少视觉噪声,给奖励数字让位)
- 动作 chip 字号 10.5px → **11px** + 字重保持(可读性优先)

---

## 3. 字体选择(impeccable procedure)

**Step 1 — 3 个 brand words**:`迅捷、可信、轻量`(KOL 视角:能快判断、报酬靠谱、不重)

**Step 2 — 反射性候选(全部 reject)**:
- Inter ❌ reflex_fonts_to_reject
- Rubik ❌(主项目用,但加载到 Shadow DOM 内会拖大体积 + 跟 Twitter 系统字体并存违和)
- Versus ❌(同上)

**Step 3 — 实际选择**:**`system-ui` stack** ——
```css
font-family:
  ui-sans-serif, system-ui,
  -apple-system, BlinkMacSystemFont,
  "SF Pro Text", "Segoe UI Variable Text",
  "Segoe UI", Roboto, "Helvetica Neue",
  "PingFang SC", "Hiragino Sans GB",
  sans-serif;
```

理由:
- Twitter 自家也用 system stack(他们的 Chirp 是 fallback,大多数用户看到的是 SF Pro / Segoe UI / Roboto)→ **零违和**
- 跟用户的 OS 原生 UI 一致 → 长期看不烦
- 0 网络成本,0 闪烁,0 FOIT
- 数字部分加 `font-feature-settings: "tnum" 1, "ss01" 1`,数字宽度一致

**例外:奖励数字**(P0 视觉锚点)需要更硬的视觉冲击。两个候选:
- **方向 a(默认推荐)**:仍然 system stack,靠 **900 字重 + tabular-nums + 20px** 撑视觉
- **方向 b(可选)**:专门给这一处用 web font,候选 `Pangram Pangram Inter Display`(非 Inter,是不同的厂)或 `ABC Diatype Mono`。代价:+30-50kB 包体积、Shadow DOM 内 `@font-face` 加载稍慢

**默认采用 a**。如果你觉得奖励数字"力度不够",我们再升 b。

---

## 4. 调色板(OKLCH)

| Token            | Light                       | Dark                          | 用途                |
| ---------------- | --------------------------- | ----------------------------- | ----------------- |
| `--bg-card`      | `oklch(0.99 0.003 195)`     | `oklch(0.18 0.008 240)`       | 卡片底色(neutral 微偏 teal) |
| `--border-card`  | `oklch(0.93 0.005 195)`     | `oklch(0.28 0.01 240)`        | 1px hairline      |
| `--ink-strong`   | `oklch(0.20 0.02 250)`      | `oklch(0.95 0.005 240)`       | 标题、作者名            |
| `--ink-muted`    | `oklch(0.55 0.01 250)`      | `oklch(0.65 0.008 240)`       | handle、预览、副标题     |
| `--brand-teal`   | `oklch(0.62 0.13 195)`      | `oklch(0.72 0.13 195)`        | 奖励数额、logo、链接      |
| `--brand-chip-bg`| `oklch(0.96 0.025 195)`     | `oklch(0.28 0.06 195 / 0.4)`  | 动作 chip 底         |
| `--accent-rose`  | `oklch(0.60 0.17 25)`       | `oklch(0.72 0.16 25)`         | 评论关键字 chip(异色)   |
| `--row-hover`    | `oklch(0.97 0.025 195)`     | `oklch(0.27 0.04 195 / 0.5)`  | 行 hover 背景       |

**遵守原则**(从主项目 .impeccable.md 继承):
- ✅ OKLCH(感知均匀)
- ✅ neutral 微偏 brand hue(chroma 0.003–0.008)
- ✅ 60-30-10 视觉权重:60% neutral surface / 30% ink+border / 10% brand teal
- ❌ 不用 `#000` / `#fff` 纯黑白
- ❌ 不用 gradient text(impeccable BAN 2)
- ❌ 不用 border-left 色条(impeccable BAN 1)

---

## 5. 布局(grid 节奏)

```
┌─────────────────────────────────────────────────┐
│   ┌─┐  灯塔任务                           ●  ●   │  ← header (14px pad)
│   │L│  3 个可抢 · 平均 +6 LUX                    │
│   └─┘                                            │
├─────────────────────────────────────────────────┤
│   ●   Elon Musk @elonmusk              +12      │  ← row
│       Stuff is happening — really big things…   │
│       ♡ 点赞  ↻ 转发                    LUX     │
├─────────────────────────────────────────────────┤
│   ●   Vitalik @VitalikButerin          +8       │
│       Re-decentralizing the internet via state… │
│       💬 评论  #defi                    LUX     │
├─────────────────────────────────────────────────┤
│   ●   Naval @naval                     +5       │
│       When in doubt, optimize for letting go    │
│       ♡ 点赞                            LUX     │
├─────────────────────────────────────────────────┤
│              查看全部 7 个 →                     │  ← footer link
└─────────────────────────────────────────────────┘
```

**grid 模板**:
- header:`flex` · `gap: 12px` · `padding: 14px 16px 12px`
- list-row:`grid-template-columns: 32px 1fr auto` · `gap: 12px` · `padding: 10px 12px`
- footer:hairline border-top · `padding: 10px 16px 12px` · `text-align: center`

**spacing 节奏**(4pt scale):
- 卡片外边距(跟 Twitter 其他 sidebar 卡):`16px` 上下
- 行间无明显分割线(留白即分割)。仅 hover 时背景 tint 出来 → 形成行边界
- 节奏对比:header 用 14/12 大间距 → list 用 10/12 紧凑间距 → footer 回归 10/16 → "舒-紧-舒" 三段节奏

---

## 6. 状态(states)

| 状态          | 处理                                            |
| ----------- | --------------------------------------------- |
| **默认**      | 显示前 5 条,超过则 footer 显示 "查看全部 N 个 →" 链接         |
| **空**(0 任务) | 整个卡片 `return null`,**不挂载**(已实现,保持)            |
| **加载中**(首次同步) | 3 行 shimmer skeleton(头像圆 + 两条文本条 + 数字块)。500ms 后没拿到数据才出现,避免闪烁 |
| **刷新中**     | 卡片右上角一个细 dot pulse(2px 直径 teal),3 秒后消失        |
| **同步失败**    | 卡片照常显示上一次缓存。错误只在 popup 出,**不污染** sidebar 卡片  |
| **新任务流入**   | 列表头插入新行时,该行 `opacity 0→1` + `translateY(-4px → 0)`,400ms exp-out |

---

## 7. 动效

**入场**(首次卡片挂载):
- container `opacity 0→1` + `translateY(8px → 0)`,**240ms** `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quart)
- 行内 staggered:每行 `delay = 60ms × index`,**最多** 5 × 60ms = 300ms 完成

**Hover**:
- row `background-color` 过渡 **120ms ease-out**
- 头像 `transform: scale(1.04)` **160ms ease-out**(暗示"可点击的小延伸")
- 奖励数额 **不动**(它是核心信息,任何 hover 干扰都不必要)

**点击 → 跳转**:
- row `transform: scale(0.98)` `60ms` flicker → 立即由 Twitter 接管 SPA 导航

**Reduced motion**:
- 所有 transform / translateY → 移除
- 只保留 `opacity` 过渡,但缩到 **120ms** linear
- 检测 `prefers-reduced-motion: reduce`

---

## 8. 反 AI-slop checklist(逐项检查)

| 警惕                     | 本设计                                       |
| ---------------------- | ----------------------------------------- |
| Glassmorphism backdrop blur | ❌ 不用                                |
| 紫蓝渐变 / 霓虹              | ❌ 用 brand teal 单色                        |
| Border-left 色条          | ❌ BAN 1,无                                |
| Gradient text          | ❌ BAN 2,无(奖励数字用单色 teal)                  |
| 圆角图标方块在每行              | ❌ 头像是真头像,不是装饰图标方块                       |
| 等大 grid 卡片重复           | ❌ 不是 card grid,是 list                    |
| Hero metric layout(大数+小标+辅助) | ❌ 单卡片不是 dashboard                |
| 全居中布局                  | ❌ 主要是左对齐,reward 右对齐                      |
| 所有 padding 一致          | ❌ 14/10/12 三段节奏                          |
| Sparkline 装饰           | ❌ 不用                                     |
| 通用 drop-shadow         | ❌ 只用 hairline border,无阴影                  |
| Modal                  | ❌ 不用                                     |

---

## 9. Accessibility

- WCAG AA 对比:奖励数字 vs 卡片底色 ≥ 4.5:1(OKLCH 0.62 vs 0.99 → ~5.8:1 ✓)
- Tab focus 顺序:`row1 → row2 → ... → rowN → footer link`
- 每条 row 是 `<a href="...">`,键盘 Enter 直接触发
- 关键字 chip 用 `title` attribute 提供完整 hint(`title="评论需包含 #defi"`)
- 头像 `aria-label` = 作者名,无名时 = "avatar placeholder"
- 颜色不是唯一信号:动作类型 chip 同时有 icon + 文字 label,色盲用户可识别

---

## 10. 主要决策点(需要你确认)

设计上还有 **3 个开放问题**,建议在编码前定:

### Q1 — 视觉融入度

**方向 A(推荐)**:深度融入 Twitter,卡片背景跟 Twitter 同色,只在 logo + 奖励数额上用 brand teal,其他全 neutral 处理。
**方向 B**:Lighthouse 视觉强度,卡片整体微 teal tint + 品牌字大,跟 Twitter 自家卡片有视觉区分,长期看可能像"广告"。

→ 我倾向 **A**(因为 KOL 长期共存),但你最终决定。

### Q2 — 奖励数字字体

**方向 a(推荐)**:system stack + 900 字重 + 20px,不增加任何字体下载。
**方向 b**:专门加载一个 display web font(候选 ABC Diatype Mono 或类似),增加 ~30-50kB 包体积,换更硬的视觉。

→ 我倾向 **a**(轻量为先),但如果你觉得奖励数字"力度不够"可以升 b。

### Q3 — 头像大小

**方向 i(推荐)**:32px(降权,让奖励数字更突出)
**方向 ii**:维持 40px(跟 Twitter 自家头像同尺寸,视觉更"原生")

→ 我倾向 **i**,但 ii 也合理。

---

## 11. 一次完整 mockup

见 `docs/mockup/sidebar-card.html`。该 mockup 是**静态 HTML**,可以在浏览器直接打开。同一个文件展示 4 个场景:
1. 正常态(3 条任务,light mode)
2. 正常态(3 条任务,dark mode,模拟 Twitter 暗色)
3. 加载态(3 行 skeleton)
4. "超过 5 条"态(5 条 + footer 链接)

