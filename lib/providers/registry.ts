/**
 * Provider 注册中心
 *
 * 服务定位器模式：通过 key 字符串查找构造器，传参创建 Provider 实例。
 * 后续添加 SMSBower 等 Provider 仅需在 Service Worker 启动时注册新类。
 */
import type { ProviderConfig } from './types';
import type { BaseSmsProvider } from './base-provider';

type ProviderFactory = (config: ProviderConfig) => BaseSmsProvider;

export class ProviderRegistry {
  private static readonly _registry = new Map<string, ProviderFactory>();

  /**
   * 注册 Provider 构造器
   * @param key 唯一标识（如 "herosms"、"smsbower"）
   * @param ctor 构造器，接收 ProviderConfig 返回 BaseSmsProvider 实例
   */
  static register(key: string, ctor: ProviderFactory): void {
    ProviderRegistry._registry.set(key, ctor);
  }

  /**
   * 创建 Provider 实例
   * @param key 已注册的 Provider 标识
   * @param config Provider 配置
   * @returns BaseSmsProvider 实例
   */
  static create(key: string, config: ProviderConfig): BaseSmsProvider {
    const factory = ProviderRegistry._registry.get(key);
    if (!factory) {
      throw new Error(`未知的 Provider: ${key}`);
    }
    return factory(config);
  }

  /** 列出所有已注册的 Provider key */
  static listKeys(): string[] {
    return Array.from(ProviderRegistry._registry.keys());
  }
}
