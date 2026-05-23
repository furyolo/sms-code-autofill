# SMS Code Autofill

一个基于 WXT + Preact 的浏览器扩展，用于自动获取并填入 OpenAI 手机验证码。

## 功能

- 监听验证码相关流程并辅助填写 SMS Code
- 提供后台逻辑、内容脚本、弹窗与选项页
- 集成 Hero SMS 与 OpenAI 相关访问权限
- 可选生成 Tampermonkey 油猴脚本版，用于页面打开期间的轻量自动化

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
pnpm build:userscript
```

## 配置说明

- 扩展权限与站点白名单在 `wxt.config.ts` 中配置。
- 本地构建产物会生成在 `.output/` 和 `.wxt/`，这些目录已在 `.gitignore` 中忽略。

## Tampermonkey 油猴脚本版

油猴版是并行分发形态，不替换浏览器扩展版。它聚焦 `auth.openai.com` 页面打开期间的核心自动化：配置 Cloudflare Temp Email 与 HeroSMS、生成注册邮箱、填入邮箱、轮询邮箱验证码、填写姓名和年龄、获取手机号、填入手机号、轮询短信验证码、填入验证码、停止与继续。

生成脚本：

```bash
pnpm build:userscript
```

产物位置：

```text
.output/userscript/sms-code-autofill.user.js
```

能力差异：

- 油猴版不提供 toolbar badge。
- 油猴版不做跨标签页目标页探测。
- 页面关闭后不保证继续轮询。
- 若检测到扩展版 Content Script 已注入，油猴版默认不自动启动，避免重复取号。
- 注册邮箱名使用自动生成的英文姓名加年龄，例如 `miaharris23@example.com`。

## 许可证

ISC
