import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

/**
 * Toggle 开关组件 - 44x24px pill 样式
 * 用于断路器完全关闭选项
 */
export default function Toggle({ checked, onChange, disabled }: ToggleProps) {
  const handleClick = () => {
    if (!disabled) {
      onChange(!checked);
    }
  };

  return html`
    <button
      class=${`options-toggle ${checked ? 'options-toggle--active' : ''} ${disabled ? 'options-toggle--disabled' : ''}`}
      role="switch"
      aria-checked=${checked}
      aria-disabled=${disabled}
      onClick=${handleClick}
      type="button"
    >
      <span class="options-toggle__knob" />
    </button>
  `;
}
