import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(root, '.output/userscript/sms-code-autofill.user.js');

const header = `// ==UserScript==
// @name         SMS Code Autofill Userscript
// @namespace    sms-code-autofill
// @version      0.1.0
// @description  自动获取并填入 OpenAI 手机验证码
// @match        https://auth.openai.com/*
// @run-at       document-idle
// @connect      hero-sms.com
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.notification
// @grant        GM.registerMenuCommand
// ==/UserScript==
`;

const tempDir = resolve(root, '.output/userscript/.tmp');
const tempFile = resolve(tempDir, 'sms-code-autofill.bundle.js');
async function resolveBundledVitePath() {
  const pnpmDir = resolve(root, 'node_modules/.pnpm');
  const entries = await readdir(pnpmDir);
  const viteEntry = entries
    .filter((name) => name.startsWith('vite@'))
    .sort()
    .at(-1);
  if (!viteEntry) {
    throw new Error('未找到 WXT 依赖的 Vite，请先运行 pnpm install');
  }
  return resolve(pnpmDir, viteEntry, 'node_modules/vite/dist/node/index.js');
}

await mkdir(dirname(outFile), { recursive: true });
await mkdir(tempDir, { recursive: true });

const { build } = await import(pathToFileURL(await resolveBundledVitePath()).href);

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(root, 'userscript/main.ts'),
      name: 'SmsCodeAutofillUserscript',
      formats: ['iife'],
      fileName: () => 'sms-code-autofill.bundle.js',
    },
    outDir: tempDir,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

const body = await readFile(tempFile, 'utf8');
await writeFile(outFile, `${header}\n${body}`, 'utf8');
console.log(`Wrote ${outFile}`);
