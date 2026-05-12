import { h } from 'preact';
import htm from 'htm';
import { useState } from 'preact/hooks';

const html = htm.bind(h);

interface SecretInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * SecretInput - API Key 遮蔽输入框
 * 默认 type=password，右侧眼睛图标按钮切换显示/隐藏
 */
export default function SecretInput({ label, value, onChange, placeholder }: SecretInputProps) {
  const [visible, setVisible] = useState(false);

  return html`
    <div class="options-form-row">
      <label class="options-form-label">${label}</label>
      <div class="options-secret-wrap">
        <input
          type=${visible ? 'text' : 'password'}
          class="options-text-input"
          value=${value}
          onInput=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
          placeholder=${placeholder || ''}
          autocomplete="new-password"
          data-1p-ignore="true"
          data-lpignore="true"
        />
        <button
          class="options-eye-btn"
          onClick=${() => setVisible(!visible)}
          type="button"
          aria-label=${visible ? '隐藏 API Key' : '显示 API Key'}
          title=${visible ? '隐藏 API Key' : '显示 API Key'}
        >
          ${visible ? EyeOffIcon : EyeIcon}
        </button>
      </div>
    </div>
  `;
}

// 内联 SVG: 睁开眼睛
const EyeIcon = h('svg', {
  width: 16, height: 16, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
  'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}, [
  h('path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }),
  h('circle', { cx: 12, cy: 12, r: 3 }),
]);

// 内联 SVG: 闭上眼睛
const EyeOffIcon = h('svg', {
  width: 16, height: 16, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
  'stroke-linecap': 'round', 'stroke-linejoin': 'round',
}, [
  h('path', { d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94' }),
  h('path', { d: 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19' }),
  h('path', { d: 'm14.12 14.12a3 3 0 1 1-4.24-4.24' }),
  h('line', { x1: 1, y1: 1, x2: 23, y2: 23 }),
]);
