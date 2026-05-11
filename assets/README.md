# Source assets

## `logo-source.png`

**你的灯塔插件 logo 原图**(高分辨率方图,**最好 512×512 或更大**)。

放在这里以后,跑:

```bash
pnpm run icons
```

会自动生成 `public/icon/{16,32,48,96,128}.png` 五个尺寸,WXT build 时
manifest.json 的 `icons` 字段被自动塞入。

源图建议:
- 至少 512×512(Chrome Web Store 上架页面用 128×128,但素材审核需要高清原图)
- PNG 透明背景或纯色背景皆可,有透明边距更好(浏览器工具栏会自动留 margin)
- 中央留 ~10% padding,避免被裁掉
