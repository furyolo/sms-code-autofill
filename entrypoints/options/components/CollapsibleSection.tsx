import { h, ComponentChildren } from 'preact';
import htm from 'htm';
import { useState } from 'preact/hooks';

const html = htm.bind(h);

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: ComponentChildren;
}

/**
 * CollapsibleSection 折叠区域组件
 * 标题栏 + 展开/折叠箭头图标，默认折叠
 */
export default function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return html`
    <div class="collapsible-section">
      <button
        class="collapsible-header"
        onClick=${() => setOpen(!open)}
        aria-expanded=${open}
        type="button"
      >
        <span>${open ? '▼' : '▶'} ${title}</span>
        <span class=${`collapsible-chevron ${open ? 'open' : ''}`}>${open ? '▼' : '▶'}</span>
      </button>
      ${open ? html`
        <div class="collapsible-body">
          ${children}
        </div>
      ` : null}
    </div>
  `;
}
