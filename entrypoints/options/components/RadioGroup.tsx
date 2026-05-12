import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

interface RadioOption {
  label: string;
  value: string;
  hint?: string;
}

interface RadioGroupProps {
  label: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
}

/**
 * RadioGroup 单选组 - 垂直排列的 radio 选项
 */
export default function RadioGroup({ label, options, value, onChange }: RadioGroupProps) {
  return html`
    <div class="options-form-row">
      <div class="options-form-label">
        <span>${label}</span>
      </div>
      <div class="options-radio-group">
        ${options.map((opt) => html`
          <label class="options-radio-item" key=${opt.value}>
            <input
              type="radio"
              class="options-radio-input"
              name="radio-group"
              value=${opt.value}
              checked=${value === opt.value}
              onChange=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
            />
            <span class="options-radio-mark" />
            <span class="options-radio-text">${opt.label}</span>
            ${opt.hint ? html`<span class="options-radio-hint">${opt.hint}</span>` : null}
          </label>
        `)}
      </div>
    </div>
  `;
}
