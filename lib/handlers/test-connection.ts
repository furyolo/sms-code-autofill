import { HeroSmsProvider } from '../providers/hero-provider';
import { calculateRecommendedMaxPrice } from '../providers/price';

/**
 * 处理测试连接消息
 * 由 background.ts 中的 chrome.runtime.onMessage 导入并调用
 * 创建临时 HeroSmsProvider 实例 → 调用 getBalance() → 返回结果
 */
export interface TestConnectionConfig {
  country?: string;
  service?: string;
  maxPrice?: number;
}

export async function handleTestConnection(apiKey: string, overrides: TestConnectionConfig = {}): Promise<{
  success: boolean;
  balance?: number;
  country?: string;
  service?: string;
  price?: number | null;
  count?: number;
  maxPrice?: number;
  recommendedMaxPrice?: number | null;
  priceBlocked?: boolean;
  error?: string;
}> {
  try {
    const config = await chrome.storage.local.get([
      'hero_sms.country',
      'hero_sms.service',
      'hero_sms.max_price',
    ]);
    const country = String(overrides.country || config['hero_sms.country'] || '187');
    const service = String(overrides.service || config['hero_sms.service'] || 'dr');
    const maxPrice = Number(overrides.maxPrice ?? config['hero_sms.max_price'] ?? -1);
    const provider = new HeroSmsProvider(apiKey, {
      apiKey,
      country,
      service,
      maxPrice,
    });
    const balance = await provider.getBalance();
    const availability = await provider.getAvailability(service, country);
    const price = availability?.price ?? null;
    const count = availability?.count ?? 0;
    const recommendedMaxPrice = price === null ? null : calculateRecommendedMaxPrice(price);
    const priceBlocked = recommendedMaxPrice !== null && maxPrice > 0 && maxPrice < recommendedMaxPrice;
    return {
      success: true,
      balance,
      country,
      service,
      price,
      count,
      maxPrice,
      recommendedMaxPrice,
      priceBlocked,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
