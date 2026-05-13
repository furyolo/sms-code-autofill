import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'SMS Code Autofill',
    version: '1.0.0',
    description: '自动获取并填入 OpenAI 手机验证码',
    permissions: [
      'storage',
      'alarms',
      'notifications',
      'activeTab',
      'tabs',
    ],
    host_permissions: [
      'https://hero-sms.com/*',
      'https://auth.openai.com/*',
    ],
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.options_ui) {
        manifest.options_ui.open_in_tab = true;
      }
    },
  },
  srcDir: '.',
  entrypointsDir: 'entrypoints',
});
