import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

interface NumberInputProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
}

/**
 * NumberInput 步进数值输入组件
 * [-] 按钮 + 数值显示 + [+] 按钮，边界 disabled
 */
export default function NumberInput({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: NumberInputProps) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  return html`
    <div class="options-form-row">
      <div class="options-form-label">
        <span>${label}</span>
        ${hint ? html`<div class="options-form-hint">${hint}</div>` : null}
      </div>
      <div class="options-number-input">
        <button
          class="options-stepper-btn"
          disabled=${value <= min}
          onClick=${() => onChange(clamp(value - step))}
          type="button"
          aria-label=${`减少 ${label}`}
        >−</button>
        <span class="options-number-value">
          ${value}${unit ? html`<span class="options-number-unit">${unit}</span>` : null}
        </span>
        <button
          class="options-stepper-btn"
          disabled=${value >= max}
          onClick=${() => onChange(clamp(value + step))}
          type="button"
          aria-label=${`增加 ${label}`}
        >+</button>
      </div>
    </div>
  `;
}
