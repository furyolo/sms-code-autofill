import { HeroSmsProvider } from '../providers/hero-provider';

/**
 * 处理测试连接消息
 * 由 background.ts 中的 chrome.runtime.onMessage 导入并调用
 * 创建临时 HeroSmsProvider 实例 → 调用 getBalance() → 返回结果
 */
export async function handleTestConnection(apiKey: string): Promise<{
  success: boolean;
  balance?: number;
  error?: string;
}> {
  try {
    const provider = new HeroSmsProvider(apiKey, {
      apiKey,
      country: '187',
      service: 'dr',
    });
    const balance = await provider.getBalance();
    return { success: true, balance };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
