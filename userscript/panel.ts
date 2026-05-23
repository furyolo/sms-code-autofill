import type { RetryPhase } from '../lib/state-machine';

export interface UserscriptPanelState {
  phase: RetryPhase | 'IDLE' | 'CONFIG_REQUIRED';
  mode: 'cloudflare' | 'sms' | 'idle';
  statusText: string;
  attemptText: string;
  emailText: string;
  phoneText: string;
  canContinue: boolean;
  running: boolean;
}

export interface UserscriptPanelActions {
  start(): void;
  stop(): void;
  continue(): void;
  openSettings(): void;
}

const PANEL_ID = 'sms-code-autofill-userscript-panel';

export class UserscriptPanel {
  private root: HTMLElement;
  private modeEl: HTMLElement;
  private statusEl: HTMLElement;
  private emailRowEl: HTMLElement;
  private smsRowEls: HTMLElement[];
  private emailEl: HTMLElement;
  private attemptEl: HTMLElement;
  private phoneEl: HTMLElement;
  private startButton: HTMLButtonElement;
  private stopButton: HTMLButtonElement;
  private continueButton: HTMLButtonElement;

  constructor(private readonly actions: UserscriptPanelActions) {
    this.root = document.createElement('section');
    this.root.id = PANEL_ID;
    this.root.innerHTML = `
      <style>
        #${PANEL_ID} {
          position: fixed;
          right: 16px;
          bottom: 16px;
          z-index: 2147483647;
          width: 280px;
          padding: 12px;
          border: 1px solid #d4d4d8;
          border-radius: 8px;
          background: #ffffff;
          color: #18181b;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
          font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        #${PANEL_ID} h2 {
          margin: 0 0 8px;
          font-size: 14px;
          font-weight: 650;
        }
        #${PANEL_ID} .sms-row {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          margin: 6px 0;
        }
        #${PANEL_ID} .sms-label { color: #71717a; }
        #${PANEL_ID} .sms-value {
          min-width: 0;
          text-align: right;
          overflow-wrap: anywhere;
        }
        #${PANEL_ID} .sms-actions {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
          margin-top: 10px;
        }
        #${PANEL_ID} button {
          min-height: 30px;
          border: 1px solid #d4d4d8;
          border-radius: 6px;
          background: #fafafa;
          color: #18181b;
          cursor: pointer;
          font: inherit;
        }
        #${PANEL_ID} button[data-primary="true"] {
          background: #155eef;
          border-color: #155eef;
          color: #ffffff;
        }
        #${PANEL_ID} button:disabled {
          opacity: .45;
          cursor: not-allowed;
        }
      </style>
      <h2>SMS Code Autofill</h2>
      <div class="sms-row"><span class="sms-label">阶段</span><span class="sms-value" data-role="mode">就绪</span></div>
      <div class="sms-row"><span class="sms-label">状态</span><span class="sms-value" data-role="status">就绪</span></div>
      <div class="sms-row" data-mode-row="cloudflare"><span class="sms-label">邮箱</span><span class="sms-value" data-role="email">-</span></div>
      <div class="sms-row" data-mode-row="sms"><span class="sms-label">尝试</span><span class="sms-value" data-role="attempt">-</span></div>
      <div class="sms-row" data-mode-row="sms"><span class="sms-label">号码</span><span class="sms-value" data-role="phone">-</span></div>
      <div class="sms-actions">
        <button type="button" data-action="start" data-primary="true">启动</button>
        <button type="button" data-action="stop">停止</button>
        <button type="button" data-action="continue">继续</button>
        <button type="button" data-action="settings">设置</button>
      </div>
    `;
    document.documentElement.appendChild(this.root);

    this.modeEl = this.requireElement('[data-role="mode"]');
    this.statusEl = this.requireElement('[data-role="status"]');
    this.emailRowEl = this.requireElement('[data-mode-row="cloudflare"]');
    this.smsRowEls = Array.from(this.root.querySelectorAll<HTMLElement>('[data-mode-row="sms"]'));
    this.emailEl = this.requireElement('[data-role="email"]');
    this.attemptEl = this.requireElement('[data-role="attempt"]');
    this.phoneEl = this.requireElement('[data-role="phone"]');
    this.startButton = this.requireElement<HTMLButtonElement>('[data-action="start"]');
    this.stopButton = this.requireElement<HTMLButtonElement>('[data-action="stop"]');
    this.continueButton = this.requireElement<HTMLButtonElement>('[data-action="continue"]');

    this.startButton.addEventListener('click', () => this.actions.start());
    this.stopButton.addEventListener('click', () => this.actions.stop());
    this.continueButton.addEventListener('click', () => this.actions.continue());
    this.requireElement<HTMLButtonElement>('[data-action="settings"]')
      .addEventListener('click', () => this.actions.openSettings());
  }

  update(state: UserscriptPanelState): void {
    this.modeEl.textContent = modeLabel(state.mode);
    this.statusEl.textContent = state.statusText;
    this.emailRowEl.style.display = state.mode === 'cloudflare' ? 'flex' : 'none';
    for (const row of this.smsRowEls) row.style.display = state.mode === 'sms' ? 'flex' : 'none';
    this.emailEl.textContent = state.emailText;
    this.attemptEl.textContent = state.attemptText;
    this.phoneEl.textContent = state.phoneText;
    this.startButton.disabled = state.running;
    this.stopButton.disabled = !state.running;
    this.continueButton.disabled = !state.canContinue;
  }

  private requireElement<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Panel element not found: ${selector}`);
    return element;
  }
}

function modeLabel(mode: UserscriptPanelState['mode']): string {
  if (mode === 'cloudflare') return 'Cloudflare 邮箱';
  if (mode === 'sms') return 'SMS 手机号';
  return '就绪';
}
