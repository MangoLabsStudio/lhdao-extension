# Lighthouse 浏览器扩展安装指南

本指南适用于 `0.4.0` 的 Chrome / Edge / Firefox MV3 内测包。

## 1. 下载并解压

从 [GitHub Releases](https://github.com/MangoLabsStudio/lhdao-extension/releases) 下载与浏览器匹配的包：

- `lhdao-extension-0.4.0-chrome.zip`
- `lhdao-extension-0.4.0-edge.zip`
- `lhdao-extension-0.4.0-firefox.zip`

解压后应直接看到 `manifest.json`。加载已解压扩展时不要选择 zip，也不要选择多包了一层
的外部目录。

## 2. 加载扩展

### Chrome

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择 Chrome 包解压目录。

### Edge

1. 打开 `edge://extensions`。
2. 开启“开发人员模式”。
3. 点击“加载解压缩的扩展”，选择 Edge 包解压目录。

### Firefox（临时内测）

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”。
3. 选择 Firefox 解压目录内的 `manifest.json`。

Firefox 包是 MV3 可运行产物，但尚未配置用于 AMO 签名的稳定 Gecko ID 与数据分类，因此不应
直接提交 AMO。

## 3. 连接 Lighthouse 账号

1. 点击工具栏中的 Lighthouse 图标。
2. 点击“立即登录”，在 `https://app.lhdao.top` 完成授权；或在 Options 中手动粘贴
   plugin token。
3. Popup 显示 `Connected` 后，点击同步按钮获取最新任务。

Plugin token 保存在扩展的 `storage.local` 中，并只作为 Bearer credential 发送给
Lighthouse 后端。不会发送给第三方服务。

## 4. 验证 X engagement 任务

1. 打开 `https://x.com` 或 `https://twitter.com`。
2. 在 timeline 或推文详情中完成 Lighthouse 标记的动作。
3. 使用扩展注入的按钮预约并验证任务。

## 5. 产品体验任务

产品体验由 Buyer 在 Lighthouse 网站人工审核，无需扩展采集或验证客户网站。

详细数据使用见 [PRIVACY.md](./PRIVACY.md)。

## 升级

开发者模式加载的版本不会自动升级。下载新包、解压到新目录，然后在扩展管理页面重新加载。
