import { h } from 'preact';
import htm from 'htm';
import { useState, useEffect, useRef } from 'preact/hooks';

const html = htm.bind(h);

interface Option {
  label: string;
  value: string;
}

interface Props {
  value: string;
  options: Option[];
  placeholder?: string;
  onChange: (value: string) => void;
}

/** 可搜索下拉选择器，用于长列表（国家等） */
export default function SearchableSelect({ value, options, placeholder, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = search
    ? options.filter((o) => {
        const s = search.toLowerCase();
        return o.label.toLowerCase().includes(s) || o.value.includes(s);
      })
    : options;

  const selectedLabel = options.find((o) => o.value === value)?.label || '';

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // 打开时自动聚焦搜索框
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  return html`
    <div ref=${containerRef} class="ssearch-wrap">
      <button
        type="button"
        class="ssearch-btn"
        onClick=${() => { setOpen(!open); setSearch(''); }}
      >
        <span class=${selectedLabel ? 'ssearch-btn-text' : 'ssearch-btn-placeholder'}>
          ${selectedLabel || placeholder || '请选择...'}
        </span>
        <svg class=${`ssearch-chevron ${open ? 'ssearch-chevron--open' : ''}`} width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      ${open && html`
        <div class="ssearch-dropdown">
          <div class="ssearch-dropdown-header">
            <input
              ref=${inputRef}
              type="text"
              class="ssearch-input"
              value=${search}
              onInput=${(e: Event) => setSearch((e.target as HTMLInputElement).value)}
              placeholder="搜索..."
            />
          </div>
          <div class="ssearch-list">
            ${filtered.length === 0
              ? html`<div class="ssearch-empty">无匹配结果</div>`
              : filtered.map((o) => html`
                <button
                  key=${o.value}
                  type="button"
                  class=${`ssearch-option ${o.value === value ? 'ssearch-option--active' : ''}`}
                  onClick=${() => { onChange(o.value); setOpen(false); setSearch(''); }}
                >
                  ${o.label}
                </button>
              `)
            }
          </div>
        </div>
      `}
    </div>
  `;
}
