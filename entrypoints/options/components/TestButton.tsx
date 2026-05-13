import { h } from 'preact';
import htm from 'htm';
import { useState, useEffect, useRef } from 'preact/hooks';

const html = htm.bind(h);

interface TestButtonProps {
  apiKey: string;
  country?: string;
  service?: string;
  maxPrice?: number;
  label?: string;
}

interface TestResult {
  type: 'success' | 'error';
  message: string;
}

/**
 * TestButton - 测试连接按钮
 * 点击 → chrome.runtime.sendMessage({ type:'TEST_CONNECTION', apiKey })
 * 成功显示绿色条含余额，失败显示红色条含错误原因，5秒后自动消失
 */
export default function TestButton({
  apiKey,
  country,
  service,
  maxPrice,
  label = '测试连接',
}: TestButtonProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 清除旧定时器
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const clearResultAfter = (ms: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setResult(null), ms);
  };

  const handleClick = async () => {
    if (loading) return;
    setResult(null);
    setLoading(true);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_CONNECTION',
        apiKey,
        country,
        service,
        maxPrice,
      });

      if (response?.success) {
        const count = Number(response.count ?? 0);
        const price = response.price === null || response.price === undefined
          ? '未知'
          : `$${Number(response.price).toFixed(4)}`;
        const target = `${response.service || 'dr'} / 国家 ${response.country || '-'}`;
        const availability = count > 0 ? `库存 ${count}` : '无库存';
        const limit = response.priceBlocked
          ? `，当前最大价格会拦截，建议 ≥ $${Number(response.recommendedMaxPrice).toFixed(4)}`
          : '';
        setResult({
          type: count > 0 && !response.priceBlocked ? 'success' : 'error',
          message: `余额 $${(response.balance || 0).toFixed(2)}，${target}，${availability}，价格 ${price}${limit}`,
        });
      } else {
        setResult({
          type: 'error',
          message: response?.error || '未知错误',
        });
      }
    } catch (err: unknown) {
      setResult({
        type: 'error',
        message: err instanceof Error ? err.message : '连接失败，请检查 API Key 或网络',
      });
    } finally {
      setLoading(false);
      clearResultAfter(5000);
    }
  };

  return html`
    <div class="options-form-row">
      <div class="options-form-label">
        <span>连接测试</span>
      </div>
      <div class="options-test-area">
        <button
          class="options-test-btn"
          onClick=${handleClick}
          disabled=${loading || !apiKey}
          type="button"
        >
          ${loading ? '测试中...' : label}
        </button>
        ${result ? html`
          <div class=${`options-test-result ${result.type === 'success' ? 'options-test-result--success' : 'options-test-result--error'}`}>
            <span>${result.type === 'success' ? '✓' : '✗'}</span>
            <span>${result.message}</span>
          </div>
        ` : null}
      </div>
    </div>
  `;
}
