import { h } from 'preact';
import htm from 'htm';
import { useState, useEffect } from 'preact/hooks';
import SecretInput from './components/SecretInput';
import TestButton from './components/TestButton';
import CollapsibleSection from './components/CollapsibleSection';
import NumberInput from './components/NumberInput';
import RadioGroup from './components/RadioGroup';
import Toggle from './components/Toggle';

const html = htm.bind(h);

// ===== 类型定义 =====
interface OptionsFormData {
  // 核心配置
  'hero_sms.api_key': string;
  'hero_sms.country': string;
  'hero_sms.service': string;
  'hero_sms.max_price': number;
  // 重试参数
  'retry.bucket_size': number;
  'retry.max_buckets': number;
  'polling.interval': number;
  'polling.timeout': number;
  // 断路器
  'circuit.enabled': boolean;
  'circuit.threshold_voip': number;
  'circuit.threshold_timeout': number;
  // 暂停模式
  pause_mode: 'bucket_and_circuit' | 'circuit_only';
}

// ===== 默认值 =====
const DEFAULTS: OptionsFormData = {
  'hero_sms.api_key': '',
  'hero_sms.country': '187',
  'hero_sms.service': 'dr',
  'hero_sms.max_price': -1,
  'retry.bucket_size': 10,
  'retry.max_buckets': 3,
  'polling.interval': 5,
  'polling.timeout': 120,
  'circuit.enabled': true,
  'circuit.threshold_voip': 2,
  'circuit.threshold_timeout': 5,
  pause_mode: 'bucket_and_circuit',
};

// ===== 国家选项（硬编码降级列表） =====
const FALLBACK_COUNTRIES: Array<{ label: string; value: string }> = [
  { label: 'United States (187)', value: '187' },
  { label: 'United Kingdom (16)', value: '16' },
  { label: 'Canada (36)', value: '36' },
  { label: 'Australia (27)', value: '27' },
  { label: 'India (26)', value: '26' },
];

// ===== JSON 序列化/反序列化辅助（处理带点号的存储 key） =====
function storageObjectToFormData(obj: Record<string, unknown>): OptionsFormData {
  return {
    'hero_sms.api_key': String(obj['hero_sms.api_key'] ?? DEFAULTS['hero_sms.api_key']),
    'hero_sms.country': String(obj['hero_sms.country'] ?? DEFAULTS['hero_sms.country']),
    'hero_sms.service': String(obj['hero_sms.service'] ?? DEFAULTS['hero_sms.service']),
    'hero_sms.max_price': Number(obj['hero_sms.max_price'] ?? DEFAULTS['hero_sms.max_price']),
    'retry.bucket_size': Number(obj['retry.bucket_size'] ?? DEFAULTS['retry.bucket_size']),
    'retry.max_buckets': Number(obj['retry.max_buckets'] ?? DEFAULTS['retry.max_buckets']),
    'polling.interval': Number(obj['polling.interval'] ?? DEFAULTS['polling.interval']),
    'polling.timeout': Number(obj['polling.timeout'] ?? DEFAULTS['polling.timeout']),
    'circuit.enabled': obj['circuit.enabled'] !== undefined ? Boolean(obj['circuit.enabled']) : DEFAULTS['circuit.enabled'],
    'circuit.threshold_voip': Number(obj['circuit.threshold_voip'] ?? DEFAULTS['circuit.threshold_voip']),
    'circuit.threshold_timeout': Number(obj['circuit.threshold_timeout'] ?? DEFAULTS['circuit.threshold_timeout']),
    pause_mode: (obj.pause_mode === 'circuit_only' ? 'circuit_only' : 'bucket_and_circuit') as OptionsFormData['pause_mode'],
  };
}

/**
 * Options 页面主组件
 * 使用 Preact + htm 实现完整配置页
 */
export default function App() {
  const [form, setForm] = useState<OptionsFormData>(DEFAULTS);
  const [countries, setCountries] = useState(FALLBACK_COUNTRIES);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 页面加载时读取 chrome.storage.local 中的已保存配置
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const keys = [
          'hero_sms.api_key',
          'hero_sms.country',
          'hero_sms.service',
          'hero_sms.max_price',
          'retry.bucket_size',
          'retry.max_buckets',
          'polling.interval',
          'polling.timeout',
          'circuit.enabled',
          'circuit.threshold_voip',
          'circuit.threshold_timeout',
          'pause_mode',
        ];
        const result = await chrome.storage.local.get(keys);
        if (Object.keys(result).length > 0) {
          setForm(storageObjectToFormData(result));
        }
      } catch {
        // 降级使用默认值
      } finally {
        setLoaded(true);
      }
    };

    loadConfig();
  }, []);

  // 尝试从 HeroSMS API 动态加载国家列表，失败时保留硬编码降级
  useEffect(() => {
    const fetchCountries = async () => {
      try {
        const resp = await fetch('https://hero-sms.com/stubs/handler_api.php?action=getCountries&apikey=demo', {
          signal: AbortSignal.timeout(5000),
        });
        const text = await resp.text();
        // HeroSMS 返回格式: 国家名:ID（每行一个），如 "United States:187"
        const parsed = text
          .split('\n')
          .filter((line) => line.includes(':'))
          .map((line) => {
            const [name, id] = line.split(':');
            return { label: `${name.trim()} (${id.trim()})`, value: id.trim() };
          })
          .filter((item) => item.value && /^\d+$/.test(item.value))
          .sort((a, b) => a.label.localeCompare(b.label));

        if (parsed.length > 0) {
          setCountries(parsed);
        }
      } catch {
        // API 不可用，保留硬编码降级列表
      }
    };

    fetchCountries();
  }, []);

  const updateForm = (key: keyof OptionsFormData, value: string | number | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // 编辑时清除保存状态
    if (saved) setSaved(false);
  };

  // 保存配置
  const handleSave = async () => {
    if (saving) return;

    // API Key 为空时警告但不阻止保存
    if (!form['hero_sms.api_key'].trim()) {
      const ok = confirm('API Key 为空，保存后可能无法正常使用。是否继续保存？');
      if (!ok) return;
    }

    setSaving(true);
    try {
      await chrome.storage.local.set({
        'hero_sms.api_key': form['hero_sms.api_key'],
        'hero_sms.country': form['hero_sms.country'],
        'hero_sms.service': form['hero_sms.service'],
        'hero_sms.max_price': form['hero_sms.max_price'],
        'retry.bucket_size': form['retry.bucket_size'],
        'retry.max_buckets': form['retry.max_buckets'],
        'polling.interval': form['polling.interval'],
        'polling.timeout': form['polling.timeout'],
        'circuit.enabled': form['circuit.enabled'],
        'circuit.threshold_voip': form['circuit.threshold_voip'],
        'circuit.threshold_timeout': form['circuit.threshold_timeout'],
        pause_mode: form.pause_mode,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // 保存失败静默处理
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return html`<div class="options-page"><p style="color: var(--text-muted); text-align: center; padding: 40px 0;">加载中...</p></div>`;
  }

  return html`
    <div class="options-page">
      <!-- 页面标题 -->
      <div class="options-page-header">
        <h1>SMS Code Autofill — 设置</h1>
      </div>

      <!-- 核心配置区 -->
      <div class="options-section-card">
        <h2>核心配置</h2>

        <${SecretInput}
          label="API Key"
          value=${form['hero_sms.api_key']}
          onChange=${(v: string) => updateForm('hero_sms.api_key', v)}
          placeholder="请输入 Hero SMS API Key"
        />

        <!-- 国家选择 -->
        <div class="options-form-row">
          <label class="options-form-label">国家</label>
          <div>
            <select
              class="options-select"
              value=${form['hero_sms.country']}
              onChange=${(e: Event) => updateForm('hero_sms.country', (e.target as HTMLSelectElement).value)}
            >
              ${countries.map((c) => html`
                <option key=${c.value} value=${c.value}>${c.label}</option>
              `)}
            </select>
          </div>
        </div>

        <${TestButton}
          apiKey=${form['hero_sms.api_key']}
        />
      </div>

      <!-- 高级设置折叠区 -->
      <${CollapsibleSection} title="高级设置">
        <${NumberInput}
          label="Bucket 大小"
          hint="每轮尝试次数，范围 5-20"
          value=${form['retry.bucket_size']}
          min=${5}
          max=${20}
          step=${1}
          onChange=${(v: number) => updateForm('retry.bucket_size', v)}
        />
        <${NumberInput}
          label="最大轮数"
          hint="最多尝试轮数，范围 1-10"
          value=${form['retry.max_buckets']}
          min=${1}
          max=${10}
          step=${1}
          onChange=${(v: number) => updateForm('retry.max_buckets', v)}
        />
        <${NumberInput}
          label="轮询间隔"
          hint="检查验证码的间隔"
          value=${form['polling.interval']}
          min=${3}
          max=${30}
          step=${1}
          unit="秒"
          onChange=${(v: number) => updateForm('polling.interval', v)}
        />
        <${NumberInput}
          label="请求超时"
          hint="单次等待验证码的最长时间"
          value=${form['polling.timeout']}
          min=${30}
          max=${300}
          step=${10}
          unit="秒"
          onChange=${(v: number) => updateForm('polling.timeout', v)}
        />

        <!-- 暂停模式 RadioGroup -->
        <${RadioGroup}
          label="暂停模式"
          value=${form.pause_mode}
          onChange=${(v: string) => updateForm('pause_mode', v)}
          options=${[
            { label: 'Bucket + 断路器', value: 'bucket_and_circuit', hint: '推荐' },
            { label: '仅断路器', value: 'circuit_only', hint: '更少打断' },
          ]}
        />

        <!-- 断路器敏感度子区 -->
        <div class="options-section-card">
          <h2>断路器敏感度</h2>

          <${NumberInput}
            label="VoIP 阈值"
            hint="连续收到 VoIP 号码触发暂停的次数"
            value=${form['circuit.threshold_voip']}
            min=${2}
            max=${5}
            step=${1}
            onChange=${(v: number) => updateForm('circuit.threshold_voip', v)}
          />
          <${NumberInput}
            label="超时阈值"
            hint="连续请求超时触发暂停的次数"
            value=${form['circuit.threshold_timeout']}
            min=${2}
            max=${5}
            step=${1}
            onChange=${(v: number) => updateForm('circuit.threshold_timeout', v)}
          />

          <!-- 完全关闭断路器 Toggle -->
          <div class="options-form-row">
            <div class="options-form-label">
              <span>断路器</span>
              <div class="options-form-hint">关闭后不再自动暂停</div>
            </div>
            <${Toggle}
              checked=${form['circuit.enabled']}
              onChange=${(v: boolean) => updateForm('circuit.enabled', v)}
            />
          </div>
        </div>
      </${CollapsibleSection}>

      <!-- 关于区 -->
      <${CollapsibleSection} title="关于">
        <div style="padding-top: 8px;">
          <p class="options-version-label">版本: 1.0.0</p>
          <p class="options-version-label" style="margin-top: 4px;">Hero SMS API 接码浏览器扩展</p>
          <p class="options-version-label" style="margin-top: 4px;">基于 Manifest V3 构建</p>
        </div>
      </${CollapsibleSection}>

      <!-- 保存按钮 -->
      <button
        class="options-save-btn"
        onClick=${handleSave}
        disabled=${saving}
        type="button"
      >
        ${saved ? '已保存 ✓' : saving ? '保存中...' : '保存配置'}
      </button>
    </div>
  `;
}
