import { h } from 'preact';
import htm from 'htm';
import { useState, useEffect } from 'preact/hooks';

const html = htm.bind(h);

interface Props {
  value: number;
  placeholder?: string;
  onChange: (value: number) => void;
}

/**
 * 价格输入框——处理小数输入的中间状态，避免光标跳动
 * -1 = 不限价，输入空或 - 时设为 -1
 * 内部维护显示文本，onBlur 时提交最终值
 */
export default function PriceInput({ value, placeholder = '-1 (不限)', onChange }: Props) {
  const [text, setText] = useState(value < 0 ? '' : String(value));

  // 外部值变更时同步（如加载已保存配置）
  useEffect(() => {
    setText(value < 0 ? '' : String(value));
  }, [value]);

  const handleInput = (e: Event) => {
    setText((e.target as HTMLInputElement).value);
  };

  const handleBlur = () => {
    const raw = text.trim();
    if (raw === '' || raw === '-') {
      onChange(-1);
      setText('');
    } else {
      const v = parseFloat(raw);
      if (!isNaN(v) && v >= 0) {
        onChange(v);
        setText(String(v));
      } else {
        // 无效输入——恢复为当前值
        setText(value < 0 ? '' : String(value));
      }
    }
  };

  return html`
    <input
      type="text"
      inputmode="decimal"
      class="options-input"
      style="width: 120px;"
      value=${text}
      placeholder=${placeholder}
      onInput=${handleInput}
      onBlur=${handleBlur}
    />
  `;
}
