# Extension icons

不要手动编辑这个目录,这里的文件由 `pnpm run icons` 从 `assets/logo-source.png`
**自动生成**。

WXT 0.20+ 自动检测此目录,生成的 manifest.json 形如:

```json
"icons": {
  "16": "icon/16.png",
  "32": "icon/32.png",
  "48": "icon/48.png",
  "96": "icon/96.png",
  "128": "icon/128.png"
}
```

更新 logo 后:
1. 替换 `assets/logo-source.png`
2. `pnpm run icons`
3. `pnpm run build` 验证 manifest
4. commit `public/icon/*.png` (这些应进 git,CI 不重新生成)
