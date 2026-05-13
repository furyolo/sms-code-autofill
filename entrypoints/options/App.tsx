import { h } from 'preact';
import htm from 'htm';
import { useState, useEffect } from 'preact/hooks';
import SecretInput from './components/SecretInput';
import TestButton from './components/TestButton';
import CollapsibleSection from './components/CollapsibleSection';
import NumberInput from './components/NumberInput';
import RadioGroup from './components/RadioGroup';
import Toggle from './components/Toggle';
import SearchableSelect from './components/SearchableSelect';
import PriceInput from './components/PriceInput';

const html = htm.bind(h);

// ===== 类型定义 =====
interface OptionsFormData {
  // 核心配置
  'hero_sms.api_key': string;
  'hero_sms.country': string;
  'hero_sms.service': string;
  'hero_sms.max_price': number;
  'hero_sms.auto_country': boolean;
  'hero_sms.auto_country_min_stock': number;
  'hero_sms.auto_country_max_price': number;
  'hero_sms.reuse_phone_to_max': boolean;
  'hero_sms.phone_extra_max': number;
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
  'hero_sms.auto_country': false,
  'hero_sms.auto_country_min_stock': 20,
  'hero_sms.auto_country_max_price': -1,
  'hero_sms.reuse_phone_to_max': false,
  'hero_sms.phone_extra_max': 3,
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
  { label: '美国 (187)', value: '187' },
  { label: '英国 (16)', value: '16' },
  { label: '加拿大 (36)', value: '36' },
  { label: '澳大利亚 (175)', value: '175' },
  { label: '印度 (22)', value: '22' },
  { label: '俄罗斯 (0)', value: '0' },
  { label: '印度尼西亚 (6)', value: '6' },
  { label: '菲律宾 (4)', value: '4' },
  { label: '泰国 (52)', value: '52' },
  { label: '巴西 (73)', value: '73' },
];

// ===== 存储辅助函数 =====
function storageObjectToFormData(obj: Record<string, unknown>): OptionsFormData {
  return {
    'hero_sms.api_key': String(obj['hero_sms.api_key'] ?? DEFAULTS['hero_sms.api_key']),
    'hero_sms.country': String(obj['hero_sms.country'] ?? DEFAULTS['hero_sms.country']),
    'hero_sms.service': String(obj['hero_sms.service'] ?? DEFAULTS['hero_sms.service']),
    'hero_sms.max_price': Number(obj['hero_sms.max_price'] ?? DEFAULTS['hero_sms.max_price']),
    'hero_sms.auto_country': obj['hero_sms.auto_country'] !== undefined ? Boolean(obj['hero_sms.auto_country']) : DEFAULTS['hero_sms.auto_country'],
    'hero_sms.auto_country_min_stock': Number(obj['hero_sms.auto_country_min_stock'] ?? DEFAULTS['hero_sms.auto_country_min_stock']),
    'hero_sms.auto_country_max_price': Number(obj['hero_sms.auto_country_max_price'] ?? DEFAULTS['hero_sms.auto_country_max_price']),
    'hero_sms.reuse_phone_to_max': obj['hero_sms.reuse_phone_to_max'] === true,
    'hero_sms.phone_extra_max': Number(obj['hero_sms.phone_extra_max'] ?? DEFAULTS['hero_sms.phone_extra_max']),
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
 * 从 HeroSMS API 动态获取国家列表 (getCountries).
 * 响应为 JSON 对象 { "0": {"id":0,"eng":"Russia","chn":"俄罗斯"}, ... } 或数组.
 * 不需要 API Key. 优先显示简体中文名称.
 */
async function fetchCountries(): Promise<Array<{ label: string; value: string }>> {
  const resp = await fetch('https://hero-sms.com/stubs/handler_api.php?action=getCountries', {
    signal: AbortSignal.timeout(8000),
  });
  const data = await resp.json();

  if (Array.isArray(data)) {
    return data
      .filter((item: Record<string, unknown>) => item.id != null)
      .map((item: Record<string, unknown>) => {
        const id = String(item.id ?? '');
        const chn = String(item.chn || item.name || id);
        const eng = String(item.eng || '');
        const name = eng && eng !== chn ? `${chn} / ${eng}` : chn;
        return { label: `${name} (${id})`, value: id };
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  }

  if (typeof data === 'object' && data !== null) {
    const entries = Object.entries(data as Record<string, unknown>)
      .filter(([key]) => !['status', 'message', 'data', 'error'].includes(key));
    return entries
      .map(([key, value]) => {
        const item = value as Record<string, unknown>;
        const id = String(item.id ?? key);
        const chn = String(item.chn || item.name || key);
        const eng = String(item.eng || '');
        const name = eng && eng !== chn ? `${chn} / ${eng}` : chn;
        return { label: `${name} (${id})`, value: id };
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  }

  throw new Error('Unexpected response format');
}

/** Options 页面主组件 */
export default function App() {
  const [form, setForm] = useState<OptionsFormData>(DEFAULTS);
  const [countries, setCountries] = useState(FALLBACK_COUNTRIES);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 加载已保存配置
  useEffect(() => {
    const loadConfig = async () => {
      try {
        const keys = [
          'hero_sms.api_key', 'hero_sms.country', 'hero_sms.service',
          'hero_sms.max_price', 'hero_sms.auto_country',
          'hero_sms.auto_country_min_stock', 'hero_sms.auto_country_max_price',
          'hero_sms.reuse_phone_to_max', 'hero_sms.phone_extra_max',
          'retry.bucket_size', 'retry.max_buckets',
          'polling.interval', 'polling.timeout',
          'circuit.enabled', 'circuit.threshold_voip', 'circuit.threshold_timeout',
          'pause_mode',
        ];
        const result = await chrome.storage.local.get(keys);
        if (Object.keys(result).length > 0) {
          setForm(storageObjectToFormData(result));
        }
      } catch { /* 降级使用默认值 */ }
      finally { setLoaded(true); }
    };
    loadConfig();
  }, []);

  // 动态加载国家列表（HeroSMS API，失败时保留硬编码降级）
  useEffect(() => {
    fetchCountries()
      .then(setCountries)
      .catch(() => { /* 保持 FALLBACK_COUNTRIES */ });
  }, []);

  const updateForm = (key: keyof OptionsFormData, value: string | number | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (saved) setSaved(false);
  };

  const handleSave = async () => {
    if (saving) return;
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
        'hero_sms.auto_country': form['hero_sms.auto_country'],
        'hero_sms.auto_country_min_stock': form['hero_sms.auto_country_min_stock'],
        'hero_sms.auto_country_max_price': form['hero_sms.auto_country_max_price'],
        'hero_sms.reuse_phone_to_max': form['hero_sms.reuse_phone_to_max'],
        'hero_sms.phone_extra_max': form['hero_sms.phone_extra_max'],
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
    } catch { /* 静默失败 */ }
    finally { setSaving(false); }
  };

  if (!loaded) {
    return html`<div class="options-page"><p style="color: var(--text-muted); text-align: center; padding: 40px 0;">加载中...</p></div>`;
  }

  return html`
    <div class="options-page">
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

        <!-- 国家选择（可搜索） -->
        <div class="options-form-row">
          <label class="options-form-label">默认国家</label>
          <div>
            <${SearchableSelect}
              value=${form['hero_sms.country']}
              options=${countries}
              placeholder="请选择国家..."
              onChange=${(v: string) => updateForm('hero_sms.country', v)}
            />
          </div>
        </div>

        <!-- 最大价格 -->
        <div class="options-form-row">
          <label class="options-form-label">最大价格 (可选)</label>
          <div>
            <${PriceInput}
              value=${form['hero_sms.max_price']}
              placeholder="-1 (不限)"
              onChange=${(v: number) => updateForm('hero_sms.max_price', v)}
            />
            <div class="options-form-hint" style="margin-top:2px;">-1 表示不限价</div>
          </div>
        </div>

        <${TestButton}
          apiKey=${form['hero_sms.api_key']}
          country=${form['hero_sms.country']}
          service=${form['hero_sms.service']}
          maxPrice=${form['hero_sms.max_price']}
        />
      </div>

      <!-- 智能选国 -->
      <div class="options-section-card">
        <div class="options-form-row">
          <div class="options-form-label">
            <span>自动选择最优国家</span>
            <div class="options-form-hint">启用后忽略默认国家，自动选价格最低且库存充足的国家</div>
          </div>
          <${Toggle}
            checked=${form['hero_sms.auto_country']}
            onChange=${(v: boolean) => updateForm('hero_sms.auto_country', v)}
          />
        </div>
        ${form['hero_sms.auto_country'] && html`
          <div style="margin-top: 12px; padding-left: 8px; border-left: 2px solid var(--border);">
            <${NumberInput}
              label="最低库存"
              hint="国家库存需达到此数量才纳入考虑"
              value=${form['hero_sms.auto_country_min_stock']}
              min=${5} max=${100} step=${5}
              onChange=${(v: number) => updateForm('hero_sms.auto_country_min_stock', v)}
            />
            <div class="options-form-row" style="margin-top: 12px;">
              <label class="options-form-label">最高价格</label>
              <div>
                <${PriceInput}
                  value=${form['hero_sms.auto_country_max_price']}
                  placeholder="-1 (不限)"
                  onChange=${(v: number) => updateForm('hero_sms.auto_country_max_price', v)}
                />
                <div class="options-form-hint" style="margin-top:2px;">-1 表示不限价</div>
              </div>
            </div>
          </div>
        `}
      </div>

      <!-- 号码复用 -->
      <div class="options-section-card">
        <div class="options-form-row">
          <div class="options-form-label">
            <span>复用号码至最大</span>
            <div class="options-form-hint">同一号码验证成功后继续复用于后续注册，节省费用</div>
          </div>
          <${Toggle}
            checked=${form['hero_sms.reuse_phone_to_max']}
            onChange=${(v: boolean) => updateForm('hero_sms.reuse_phone_to_max', v)}
          />
        </div>
        ${form['hero_sms.reuse_phone_to_max'] && html`
          <${NumberInput}
            label="号码复用额外上限"
            hint="单号码成功验证后最多可额外复用的次数"
            value=${form['hero_sms.phone_extra_max']}
            min=${0} max=${10} step=${1}
            onChange=${(v: number) => updateForm('hero_sms.phone_extra_max', v)}
          />
        `}
      </div>

      <!-- 高级设置折叠区 -->
      <${CollapsibleSection} title="高级设置">
        <${NumberInput}
          label="Bucket 大小"
          hint="每轮尝试次数，范围 5-20"
          value=${form['retry.bucket_size']}
          min=${5} max=${20} step=${1}
          onChange=${(v: number) => updateForm('retry.bucket_size', v)}
        />
        <${NumberInput}
          label="最大轮数"
          hint="最多尝试轮数，范围 1-10"
          value=${form['retry.max_buckets']}
          min=${1} max=${10} step=${1}
          onChange=${(v: number) => updateForm('retry.max_buckets', v)}
        />
        <${NumberInput}
          label="轮询间隔"
          hint="检查验证码的间隔"
          value=${form['polling.interval']}
          min=${3} max=${30} step=${1} unit="秒"
          onChange=${(v: number) => updateForm('polling.interval', v)}
        />
        <${NumberInput}
          label="请求超时"
          hint="单次等待验证码的最长时间"
          value=${form['polling.timeout']}
          min=${30} max=${300} step=${10} unit="秒"
          onChange=${(v: number) => updateForm('polling.timeout', v)}
        />

        <${RadioGroup}
          label="暂停模式"
          value=${form.pause_mode}
          onChange=${(v: string) => updateForm('pause_mode', v)}
          options=${[
            { label: 'Bucket + 断路器', value: 'bucket_and_circuit', hint: '推荐' },
            { label: '仅断路器', value: 'circuit_only', hint: '更少打断' },
          ]}
        />

        <div class="options-section-card">
          <h2>断路器敏感度</h2>
          <${NumberInput}
            label="VoIP 阈值"
            hint="连续收到 VoIP 号码触发暂停的次数"
            value=${form['circuit.threshold_voip']}
            min=${2} max=${5} step=${1}
            onChange=${(v: number) => updateForm('circuit.threshold_voip', v)}
          />
          <${NumberInput}
            label="超时阈值"
            hint="连续请求超时触发暂停的次数"
            value=${form['circuit.threshold_timeout']}
            min=${2} max=${5} step=${1}
            onChange=${(v: number) => updateForm('circuit.threshold_timeout', v)}
          />
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

      <${CollapsibleSection} title="关于">
        <div style="padding-top: 8px;">
          <p class="options-version-label">版本: 1.0.0</p>
          <p class="options-version-label">Hero SMS API 接码浏览器扩展</p>
          <p class="options-version-label">基于 Manifest V3 构建</p>
          <p class="options-version-label">国家/服务列表动态加载自 HeroSMS API</p>
        </div>
      </${CollapsibleSection}>

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
