# SMS Code Autofill

一个基于 WXT + Preact 的浏览器扩展，用于自动获取并填入 OpenAI 手机验证码。

## 功能

- 监听验证码相关流程并辅助填写 SMS Code
- 提供后台逻辑、内容脚本、弹窗与选项页
- 集成 Hero SMS 与 OpenAI 相关访问权限

## 技术栈

- WXT
- TypeScript
- Preact
- webextension-polyfill

## 项目结构

- `entrypoints/background.ts`：后台脚本
- `entrypoints/content.ts`：内容脚本
- `entrypoints/popup/`：弹窗页面
- `entrypoints/options/`：选项页面
- `lib/`：核心业务逻辑与工具函数

## 常用命令

```bash
pnpm install
pnpm dev
pnpm dev:firefox
pnpm build
pnpm build:firefox
pnpm zip
pnpm zip:firefox
pnpm check
```

## 配置说明

- 扩展权限与站点白名单在 `wxt.config.ts` 中配置。
- 本地构建产物会生成在 `.output/` 和 `.wxt/`，这些目录已在 `.gitignore` 中忽略。

## 许可证

ISC
