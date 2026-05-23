import { CircuitBreaker, classifyError, CircuitErrorType, DEFAULT_CIRCUIT_CONFIG } from '../lib/circuit-breaker';
import { fillCodeAndSubmit, fillPhoneAndSubmit, preflightPhoneForm } from '../lib/content/page-automation';
import {
  detectRegistrationPageKind,
  fillEmailCodeAndSubmit,
  fillProfileAndSubmit,
  fillSignupEmailAndSubmit,
  waitForSignupEntryState,
  waitForRegistrationPageChange,
  type IdentityProfile,
} from '../lib/content/registration-automation';
import { HeroSmsProvider } from '../lib/providers';
import { TypedError, type ProviderConfig } from '../lib/providers/types';
import { RetryPhase, type RetryState } from '../lib/state-machine';
import { serializeRetryState, deserializeRetryState, type SerializedRetryState } from '../lib/state-machine/persistence';
import type { PlatformAdapter } from '../lib/platform';
import { UserscriptPanel } from './panel';
import {
  CloudflareTempEmailProvider,
  normalizeBaseUrl,
  normalizeDomain,
  normalizeEmailLocalPart,
  type CloudflareTempEmailAccount,
} from './cloudflare-temp-email';

interface UserscriptConfig {
  apiKey: string;
  country: string;
  countryNames: string[];
  service: string;
  maxPrice: number;
  bucketSize: number;
  maxBuckets: number;
  pollInterval: number;
  requestTimeout: number;
  cloudflareTempEmailBaseUrl: string;
  cloudflareTempEmailAdminAuth: string;
  cloudflareTempEmailDomain: string;
  emailPollInterval: number;
  emailRequestTimeout: number;
}

interface HeroCountryOption {
  id: string;
  label: string;
  names: string[];
}

const CONFIG_KEY = 'userscript_config';
const STATE_KEY = 'retry_state';
const EMAIL_STATE_KEY = 'registration_email_state';
const EMAIL_RUNNING_KEY = 'registration_email_running';
const POLL_TIMER = 'poll-code';
const HERO_COUNTRIES_URL = 'https://hero-sms.com/stubs/handler_api.php?action=getCountries';

const DEFAULT_CONFIG: UserscriptConfig = {
  apiKey: '',
  country: '187',
  countryNames: ['USA', 'United States', '美国', '美国（物理)'],
  service: 'dr',
  maxPrice: -1,
  bucketSize: 10,
  maxBuckets: 3,
  pollInterval: 5000,
  requestTimeout: 120000,
  cloudflareTempEmailBaseUrl: '',
  cloudflareTempEmailAdminAuth: '',
  cloudflareTempEmailDomain: '',
  emailPollInterval: 3000,
  emailRequestTimeout: 120000,
};

interface RegistrationEmailState {
  email: string;
  localPart: string;
  firstName: string;
  lastName: string;
  age: number;
  usedCodes: string[];
  beforeEmailIds: string[];
}

export class UserscriptRuntime {
  private state: RetryState = this.createInitialState();
  private provider: HeroSmsProvider | null = null;
  private emailProvider: CloudflareTempEmailProvider | null = null;
  private emailState: RegistrationEmailState | null = null;
  private emailRegistrationActive = false;
  private readonly circuitBreaker = new CircuitBreaker({ ...DEFAULT_CIRCUIT_CONFIG });
  private readonly panel: UserscriptPanel;
  private stopped = false;

  constructor(private readonly platform: PlatformAdapter) {
    this.panel = new UserscriptPanel({
      start: () => void this.startWithErrorBoundary(),
      stop: () => void this.stop(),
      continue: () => void this.continueAfterPause(),
      openSettings: () => void this.openSettings(),
    });
    this.render('就绪');
  }

  async init(): Promise<void> {
    const saved = await this.platform.sessionStorage.get(STATE_KEY);
    const raw = saved[STATE_KEY] as SerializedRetryState | undefined;
    if (raw) {
      this.state = deserializeRetryState(raw);
      if (this.state.phase === RetryPhase.WAIT_CODE && this.state.currentActivationId) {
        await this.schedulePoll();
      }
      this.render(this.describePhase());
    }

    const emailSaved = await this.platform.sessionStorage.get(EMAIL_STATE_KEY);
    const localEmailSaved = await this.platform.localStorage.get(EMAIL_STATE_KEY);
    const rawEmailState = (emailSaved[EMAIL_STATE_KEY] || localEmailSaved[EMAIL_STATE_KEY]) as RegistrationEmailState | undefined;
    if (rawEmailState?.email) {
      this.emailState = rawEmailState;
      this.render(this.describePhase());
    }

    const runningSaved = await this.platform.sessionStorage.get(EMAIL_RUNNING_KEY);
    const pageKind = detectRegistrationPageKind();
    if ((pageKind === 'add_phone' || pageKind === 'complete') && this.emailState?.email) {
      await this.clearEmailState();
      await this.saveEmailRunning(false);
    }
    if (pageKind === 'email_otp' && !this.emailState?.email) {
      this.render('邮箱验证码页缺少邮箱状态，请回到邮箱页重新启动');
      return;
    }
    if (this.shouldResumeEmailRegistration(pageKind, runningSaved[EMAIL_RUNNING_KEY] === true)) {
      void this.resumeEmailRegistrationAfterNavigation();
    }
  }

  private async startWithErrorBoundary(): Promise<void> {
    try {
      this.render('启动中');
      await this.start();
    } catch (error) {
      console.error('[Userscript] 启动失败:', error);
      this.render(`启动失败：${errorMessage(error)}`);
    }
  }

  async start(): Promise<void> {
    const config = await this.loadConfig();
    this.stopped = false;

    let pageKind = detectRegistrationPageKind();

    if (pageKind !== 'add_phone') {
      this.emailRegistrationActive = true;
      await this.saveEmailRunning(true);
      const registrationResult = await this.runEmailRegistration(config, pageKind);
      if (!registrationResult.success) {
        if (isEmailRegistrationPending(registrationResult.error)) return;
        this.emailRegistrationActive = false;
        await this.saveEmailRunning(false);
        this.render(`注册邮箱阶段失败：${registrationResult.error}`);
        return;
      }
      this.emailRegistrationActive = false;
      await this.saveEmailRunning(false);
      await this.clearEmailState();
    }

    if (!config.apiKey.trim()) {
      this.render('请先配置 HeroSMS API Key');
      await this.openSettings();
      return;
    }

    const preflight = await preflightPhoneForm();
    if (!preflight.success) {
      this.render(`页面预检失败：${preflight.error}`);
      return;
    }

    this.provider = this.createProvider(config);
    this.state = {
      ...this.createInitialState(),
      phase: RetryPhase.GET_PHONE,
      sessionId: crypto.randomUUID(),
      maxBuckets: config.maxBuckets,
      bucketSize: config.bucketSize,
      pollInterval: config.pollInterval,
      requestTimeout: config.requestTimeout,
      startedAt: Date.now(),
      lastTransitionAt: Date.now(),
    };
    await this.saveState();
    this.render('获取手机号');
    await this.getPhone(config);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.platform.timer.clear(POLL_TIMER);
    if (this.provider && this.state.currentActivationId) {
      try {
        await this.provider.cancel(this.state.currentActivationId);
      } catch {
        // 停止时取消失败不阻断 UI 回到停止态。
      }
    }
    this.state.phase = RetryPhase.STOPPED;
    this.state.lastTransitionAt = Date.now();
    await this.saveState();
    await this.saveEmailRunning(false);
    this.render('已停止');
  }

  private async resumeEmailRegistrationAfterNavigation(): Promise<void> {
    try {
      this.emailRegistrationActive = true;
      this.render('继续邮箱注册');
      const config = await this.loadConfig();
      const registrationResult = await this.runEmailRegistration(config, detectRegistrationPageKind());
      if (!registrationResult.success) {
        if (isEmailRegistrationPending(registrationResult.error)) return;
        this.emailRegistrationActive = false;
        await this.saveEmailRunning(false);
        this.render(`注册邮箱阶段失败：${registrationResult.error}`);
        return;
      }
      this.emailRegistrationActive = false;
      await this.saveEmailRunning(false);
      await this.clearEmailState();
      await this.start();
    } catch (error) {
      this.emailRegistrationActive = false;
      console.error('[Userscript] 恢复邮箱注册失败:', error);
      this.render(`恢复邮箱注册失败：${errorMessage(error)}`);
    }
  }

  private shouldResumeEmailRegistration(
    pageKind: ReturnType<typeof detectRegistrationPageKind>,
    running: boolean,
  ): boolean {
    if (pageKind === 'complete') return false;
    if (running) return true;
    return Boolean(this.emailState?.email && ['email_otp', 'about_you'].includes(pageKind));
  }

  async continueAfterPause(): Promise<void> {
    if (this.state.phase !== RetryPhase.AWAIT_CONFIRM) return;
    const preflight = await preflightPhoneForm();
    if (!preflight.success) {
      this.render(`仍在暂停：请先回到手机号输入页（${preflight.error}）`);
      return;
    }

    this.state.currentBucket += 1;
    this.state.attemptInBucket = 0;
    this.state.phase = RetryPhase.GET_PHONE;
    this.state.lastError = null;
    this.state.lastTransitionAt = Date.now();
    await this.saveState();
    const config = await this.loadConfig();
    this.provider = this.createProvider(config);
    await this.getPhone(config);
  }

  private async runEmailRegistration(
    config: UserscriptConfig,
    initialPageKind = detectRegistrationPageKind(),
  ): Promise<{ success: boolean; error?: string }> {
    if (initialPageKind === 'complete') return { success: true };
    if (!config.cloudflareTempEmailBaseUrl.trim() || !config.cloudflareTempEmailDomain.trim()) {
      await this.openSettings();
      return { success: false, error: '请先配置 Cloudflare Temp Email Base URL 和域名' };
    }

    this.emailProvider = this.createEmailProvider(config);
    let pageKind: ReturnType<typeof detectRegistrationPageKind> = initialPageKind;

    if (pageKind === 'home' || pageKind === 'unknown') {
      this.render('识别注册入口');
      const entryState = await waitForSignupEntryState({
        timeout: 20000,
        autoOpenEntry: true,
      });
      if (entryState.state === 'email_entry') {
        pageKind = 'email';
      } else if (entryState.state === 'phone_entry') {
        pageKind = 'unknown';
      } else if (entryState.state === 'password_page') {
        pageKind = 'complete';
      } else {
        pageKind = detectRegistrationPageKind();
      }
    }

    if (pageKind === 'email' || pageKind === 'unknown') {
      this.render('创建临时邮箱');
      const account = await this.ensureRegistrationEmail();
      this.render('填入邮箱');
      await this.recordEmailSubmitBaseline(account.email);
      const filled = await fillSignupEmailAndSubmit(account.email);
      if (!filled.success) return filled;
      return { success: false, error: 'EMAIL_VERIFICATION_PAGE_PENDING' };
    }

    if (pageKind === 'email_otp') {
      const emailState = this.emailState;
      const emailProvider = this.emailProvider;
      if (!emailState?.email || !emailProvider) return { success: false, error: 'EMAIL_STATE_MISSING' };
      this.render('等待邮箱验证码');
      const code = await emailProvider.waitForCode(emailState.email, new Set(emailState.usedCodes), {
        beforeIds: new Set(emailState.beforeEmailIds || []),
      });
      if (!code) return { success: false, error: 'EMAIL_CODE_TIMEOUT' };
      emailState.usedCodes.push(code);
      this.emailState = emailState;
      await this.saveEmailState();
      const filled = await fillEmailCodeAndSubmit(code);
      if (!filled.success) return filled;
      pageKind = await waitForRegistrationPageChange(pageKind);
    }

    if (pageKind === 'about_you') {
      const profile = this.profileFromEmailState();
      if (!profile) return { success: false, error: 'PROFILE_STATE_MISSING' };
      this.render(`填写资料 ${profile.firstName} ${profile.lastName} ${profile.age}`);
      const filled = await fillProfileAndSubmit(profile);
      if (!filled.success) return filled;
      await this.clearEmailState();
      await this.saveEmailRunning(false);
      pageKind = await waitForRegistrationPageChange(pageKind);
    }

    if (pageKind === 'email' || pageKind === 'email_otp') {
      this.render('邮箱注册流程进行中');
      return { success: false, error: 'EMAIL_REGISTRATION_IN_PROGRESS' };
    }

    if (pageKind === 'unknown' && this.emailState?.email) {
      this.render('邮箱注册流程进行中');
      return { success: false, error: 'EMAIL_REGISTRATION_IN_PROGRESS' };
    }

    if (pageKind === 'add_phone' || pageKind === 'complete') {
      await this.clearEmailState();
      return { success: true };
    }

    return { success: false, error: `UNSUPPORTED_REGISTRATION_PAGE_${pageKind}` };
  }

  async openSettings(): Promise<void> {
    const current = await this.loadConfig();
    const fallbackCountries = [this.countryOptionFromConfig(current)];
    const countriesPromise = this.loadHeroCountries().catch((error) => {
      console.warn('[Userscript] 获取 HeroSMS 国家列表失败，设置页保留当前国家:', error);
      return fallbackCountries;
    });
    const next = await this.showSettingsDialog(current, fallbackCountries, countriesPromise);
    if (!next) return;
    await this.saveConfig(next);
    this.render(next.apiKey.trim() ? '配置已保存' : '请配置 API Key');
  }

  private async getPhone(config: UserscriptConfig): Promise<void> {
    if (!this.provider || this.stopped) return;
    try {
      const activation = await this.provider.getNumber(config.service, config.country);
      this.state.phase = RetryPhase.FILL_PHONE;
      this.state.currentActivationId = activation.activationId;
      this.state.currentPhoneNumber = activation.phoneNumber;
      this.state.currentActivationCountry = activation.country;
      this.state.lastTransitionAt = Date.now();
      await this.saveState();
      this.render('填入手机号');

      const result = await fillPhoneAndSubmit({
        phoneNumber: activation.phoneNumber,
        providerCountry: activation.country,
        providerCountryNames: this.countryNamesForActivation(config, activation.country),
      });

      if (!result.success) {
        await this.handleRejected(new TypedError('PROVIDER', result.error || 'PHONE_REJECTED', '手机号被页面拒绝', true));
        return;
      }

      this.state.phase = RetryPhase.WAIT_CODE;
      this.state.startedAt = Date.now();
      this.state.lastTransitionAt = Date.now();
      await this.saveState();
      this.render('等待验证码');
      await this.schedulePoll();
    } catch (error) {
      const typed = error instanceof TypedError
        ? error
        : new TypedError('PROVIDER', 'UNKNOWN', String(error), true);
      await this.handleRejected(typed);
    }
  }

  private async pollCode(): Promise<void> {
    if (!this.provider || this.stopped || this.state.phase !== RetryPhase.WAIT_CODE || !this.state.currentActivationId) return;
    const elapsed = Date.now() - this.state.startedAt;
    if (elapsed >= this.state.requestTimeout) {
      await this.handleCodeTimeout();
      return;
    }

    try {
      const code = await this.provider.getCode(this.state.currentActivationId);
      if (code) {
        const result = await fillCodeAndSubmit(code);
        if (result.success) {
          this.state.phase = RetryPhase.DONE;
          this.state.usedCodes.add(code);
          this.state.lastTransitionAt = Date.now();
          await this.provider.reportSuccess(this.state.currentActivationId);
          await this.saveState();
          this.render('已填入验证码');
          await this.platform.notification.notify({
            title: 'SMS Code Autofill',
            message: '验证码已填入',
          });
          return;
        }
      }
    } catch {
      // 单次轮询失败不终止流程，继续等待下一轮。
    }

    this.render(this.describePhase());
    await this.schedulePoll();
  }

  /** 验证码等待超时表示页面已进入验证码输入态，不能直接换号重填手机号。 */
  private async handleCodeTimeout(): Promise<void> {
    const error = new TypedError('PROVIDER', 'CODE_TIMEOUT', '等待验证码超时', true);
    if (this.state.currentActivationId && this.provider) {
      try {
        await this.provider.cancel(this.state.currentActivationId);
      } catch {
        // 忽略取消失败，避免卡住暂停态。
      }
    }

    this.state.attemptInBucket += 1;
    this.state.totalAttempts += 1;
    this.state.currentActivationId = null;
    this.state.currentPhoneNumber = null;
    this.state.currentActivationCountry = null;
    this.state.lastError = error;
    if (this.state.currentBucket >= this.state.maxBuckets) {
      this.stopped = true;
      this.state.phase = RetryPhase.STOPPED;
      this.state.lastTransitionAt = Date.now();
      await this.saveState();
      this.render('已停止：等待验证码超时');
      await this.platform.notification.notify({
        title: 'SMS Code Autofill',
        message: `已停止：共尝试 ${this.state.totalAttempts} 次，所有轮次已耗尽。`,
      });
      return;
    }

    this.state.phase = RetryPhase.AWAIT_CONFIRM;
    this.state.lastTransitionAt = Date.now();
    await this.saveState();
    this.render('暂停：等待验证码超时，请回到手机号输入页后继续');
    await this.platform.notification.notify({
      title: 'SMS Code Autofill',
      message: '等待验证码超时。请回到手机号输入页后点击继续，脚本不会在验证码页自动换号。',
      requireInteraction: true,
    });
  }

  private async handleRejected(error: TypedError): Promise<void> {
    if (this.state.currentActivationId && this.provider) {
      try {
        await this.provider.cancel(this.state.currentActivationId);
      } catch {
        // 忽略取消失败，避免卡住重试。
      }
    }

    this.state.attemptInBucket += 1;
    this.state.totalAttempts += 1;
    this.state.lastError = error;
    this.state.phase = RetryPhase.REJECTED;
    this.state.lastTransitionAt = Date.now();
    await this.saveState();

    const config = await this.loadConfig();
    // 普通页面拒号不触发 UNKNOWN_REJECT=3 的断路器，避免 3 个号码后提前暂停。
    const breaker = this.shouldUseCircuitBreaker(error)
      ? this.circuitBreaker.recordError(classifyError(error))
      : { tripped: false };
    const bucketExhausted = this.state.attemptInBucket >= this.state.bucketSize;
    const allBucketsExhausted = bucketExhausted && this.state.currentBucket >= this.state.maxBuckets;
    if (bucketExhausted || breaker.tripped) {
      if (allBucketsExhausted) {
        this.stopped = true;
        this.state.phase = RetryPhase.STOPPED;
        await this.saveState();
        this.render(`已停止：${error.message}`);
        await this.platform.notification.notify({
          title: 'SMS Code Autofill',
          message: `已停止：共尝试 ${this.state.totalAttempts} 次，所有轮次已耗尽。`,
        });
        return;
      }

      this.state.phase = RetryPhase.AWAIT_CONFIRM;
      await this.saveState();
      this.render(`暂停：${error.message}`);
      await this.platform.notification.notify({
        title: 'SMS Code Autofill',
        message: `已暂停：${error.message}`,
        requireInteraction: true,
      });
      return;
    }

    this.render(`重试：${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.state.phase = RetryPhase.GET_PHONE;
    await this.saveState();
    await this.getPhone(config);
  }

  /** 断路器只处理明确可分类的问题；普通拒号交给 Bucket 计数。 */
  private shouldUseCircuitBreaker(error: TypedError): boolean {
    if (error.code !== 'PHONE_REJECTED') return false;
    return classifyError(error) !== CircuitErrorType.UNKNOWN_REJECT;
  }

  private async schedulePoll(): Promise<void> {
    await this.platform.timer.schedule(POLL_TIMER, this.state.pollInterval, () => this.pollCode());
  }

  private createProvider(config: UserscriptConfig): HeroSmsProvider {
    const providerConfig: ProviderConfig = {
      apiKey: config.apiKey,
      country: config.country,
      service: config.service,
      maxPrice: config.maxPrice,
      reusePhoneToMax: false,
      phoneSuccessMax: 1,
      httpClient: this.platform.http,
      storage: this.platform.sessionStorage,
    };
    return new HeroSmsProvider(config.apiKey, providerConfig);
  }

  private createEmailProvider(config: UserscriptConfig): CloudflareTempEmailProvider {
    return new CloudflareTempEmailProvider(this.platform.http, {
      baseUrl: config.cloudflareTempEmailBaseUrl,
      adminAuth: config.cloudflareTempEmailAdminAuth,
      domain: config.cloudflareTempEmailDomain,
      pollInterval: config.emailPollInterval,
      requestTimeout: config.emailRequestTimeout,
    });
  }

  private async ensureRegistrationEmail(): Promise<CloudflareTempEmailAccount> {
    if (this.emailState?.email) {
      return {
        email: this.emailState.email,
        localPart: this.emailState.localPart,
        domain: this.emailState.email.split('@')[1] ?? '',
      };
    }
    if (!this.emailProvider) throw new Error('Cloudflare Temp Email Provider 未初始化');

    const profile = generateIdentityProfile();
    const localPart = normalizeEmailLocalPart(`${profile.firstName}${profile.lastName}${profile.age}`);
    const account = await this.emailProvider.createEmail(localPart);
    this.emailState = {
      email: account.email,
      localPart: account.localPart,
      firstName: profile.firstName,
      lastName: profile.lastName,
      age: profile.age,
      usedCodes: [],
      beforeEmailIds: [],
    };
    await this.saveEmailState();
    return account;
  }

  private async recordEmailSubmitBaseline(email: string): Promise<void> {
    if (!this.emailState || !this.emailProvider) return;
    let beforeEmailIds: string[] = [];
    try {
      beforeEmailIds = Array.from(await this.emailProvider.getCurrentIds(email));
    } catch (error) {
      console.warn('[Userscript] 记录提交前邮件基线失败，将仅使用时间过滤:', error);
    }
    this.emailState = {
      ...this.emailState,
      beforeEmailIds,
    };
    await this.saveEmailState();
  }

  private profileFromEmailState(): IdentityProfile | null {
    if (!this.emailState) return null;
    return {
      firstName: this.emailState.firstName,
      lastName: this.emailState.lastName,
      age: this.emailState.age,
    };
  }

  private async loadConfig(): Promise<UserscriptConfig> {
    const data = await this.platform.localStorage.get({ [CONFIG_KEY]: DEFAULT_CONFIG });
    const raw = data[CONFIG_KEY] as Partial<UserscriptConfig> | undefined;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      countryNames: Array.isArray(raw?.countryNames) ? raw.countryNames : DEFAULT_CONFIG.countryNames,
      cloudflareTempEmailBaseUrl: normalizeBaseUrl(String(raw?.cloudflareTempEmailBaseUrl ?? DEFAULT_CONFIG.cloudflareTempEmailBaseUrl)),
      cloudflareTempEmailDomain: normalizeDomain(String(raw?.cloudflareTempEmailDomain ?? DEFAULT_CONFIG.cloudflareTempEmailDomain)),
    };
  }

  private async saveConfig(config: UserscriptConfig): Promise<void> {
    await this.platform.localStorage.set({ [CONFIG_KEY]: config });
  }

  /** 从 HeroSMS 实时国家表生成设置项，避免用户记忆供应商内部国家 ID。 */
  private async loadHeroCountries(): Promise<HeroCountryOption[]> {
    const response = await this.platform.http.request<unknown>({
      url: HERO_COUNTRIES_URL,
      responseType: 'json',
      timeoutMs: 8000,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HeroSMS getCountries HTTP ${response.status}`);
    }

    const items = Array.isArray(response.body)
      ? response.body
      : Object.entries(response.body as Record<string, unknown>)
        .filter(([key]) => !['status', 'message', 'data', 'error'].includes(key))
        .map(([, value]) => value);

    return items
      .map((item) => this.countryOptionFromRaw(item))
      .filter((item): item is HeroCountryOption => item !== null)
      .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  }

  private countryOptionFromRaw(item: unknown): HeroCountryOption | null {
    if (typeof item !== 'object' || item === null) return null;
    const raw = item as Record<string, unknown>;
    if (raw.id === undefined || raw.id === null) return null;

    const id = String(raw.id);
    const chn = String(raw.chn || '').trim();
    const eng = String(raw.eng || '').trim();
    const name = chn && eng && chn !== eng ? `${chn} / ${eng}` : (chn || eng || id);
    const names = [eng, chn].filter((value) => value.length > 0);
    return { id, label: `${name} (${id})`, names };
  }

  private countryOptionFromConfig(config: UserscriptConfig): HeroCountryOption {
    const names = config.countryNames.length > 0 ? config.countryNames : [config.country];
    return {
      id: config.country,
      label: `${names.join(' / ')} (${config.country})`,
      names,
    };
  }

  private countryNamesForActivation(config: UserscriptConfig, activationCountry: string | null): string[] | null {
    if (!activationCountry || activationCountry === config.country) {
      return config.countryNames.length > 0 ? config.countryNames : null;
    }
    return null;
  }

  private showSettingsDialog(
    current: UserscriptConfig,
    initialCountries: HeroCountryOption[],
    countriesPromise?: Promise<HeroCountryOption[]>,
  ): Promise<UserscriptConfig | null> {
    let countries = initialCountries;
    const currentCountry = countries.find((country) => country.id === current.country)
      ?? this.countryOptionFromConfig(current);

    return new Promise((resolve) => {
      let closed = false;
      const root = document.createElement('section');
      root.id = 'sms-code-autofill-userscript-settings';
      root.innerHTML = `
        <style>
          #sms-code-autofill-userscript-settings {
            position: fixed;
            inset: 0;
            z-index: 2147483647;
            display: grid;
            place-items: center;
            background: rgba(24, 24, 27, .36);
            color: #18181b;
            font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          #sms-code-autofill-userscript-settings form {
            width: min(420px, calc(100vw - 32px));
            max-height: min(720px, calc(100vh - 32px));
            overflow: auto;
            padding: 16px;
            border: 1px solid #d4d4d8;
            border-radius: 8px;
            background: #ffffff;
            box-shadow: 0 18px 48px rgba(0, 0, 0, .22);
          }
          #sms-code-autofill-userscript-settings h2 {
            margin: 0 0 12px;
            font-size: 15px;
          }
          #sms-code-autofill-userscript-settings fieldset {
            margin: 12px 0;
            padding: 12px;
            border: 1px solid #e4e4e7;
            border-radius: 8px;
          }
          #sms-code-autofill-userscript-settings legend {
            padding: 0 6px;
            color: #27272a;
            font-weight: 650;
          }
          #sms-code-autofill-userscript-settings label {
            display: grid;
            gap: 5px;
            margin: 10px 0;
            color: #52525b;
          }
          #sms-code-autofill-userscript-settings input {
            min-height: 34px;
            padding: 6px 8px;
            border: 1px solid #d4d4d8;
            border-radius: 6px;
            color: #18181b;
            background: #ffffff;
            font: inherit;
          }
          #sms-code-autofill-userscript-settings .sms-current-country {
            display: grid;
            grid-template-columns: 1fr 30px;
            align-items: center;
            gap: 8px;
            min-height: 28px;
            padding: 6px 8px;
            border-radius: 6px;
            background: #f4f4f5;
            color: #3f3f46;
            overflow-wrap: anywhere;
          }
          #sms-code-autofill-userscript-settings .sms-current-country span {
            min-width: 0;
          }
          #sms-code-autofill-userscript-settings .sms-country-clear {
            width: 28px;
            min-height: 28px;
            padding: 0;
            border-radius: 999px;
          }
          #sms-code-autofill-userscript-settings .sms-country-list {
            display: grid;
            gap: 4px;
            max-height: 238px;
            overflow: auto;
            padding: 4px;
            border: 1px solid #e4e4e7;
            border-radius: 6px;
            background: #fafafa;
          }
          #sms-code-autofill-userscript-settings .sms-country-status {
            min-height: 20px;
            color: #71717a;
            font-size: 12px;
          }
          #sms-code-autofill-userscript-settings .sms-country-option {
            min-height: 30px;
            padding: 5px 8px;
            text-align: left;
            border: 1px solid transparent;
            background: transparent;
            color: #27272a;
          }
          #sms-code-autofill-userscript-settings .sms-country-option:hover,
          #sms-code-autofill-userscript-settings .sms-country-option[data-selected="true"] {
            border-color: #bfdbfe;
            background: #eff6ff;
          }
          #sms-code-autofill-userscript-settings .sms-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 14px;
          }
          #sms-code-autofill-userscript-settings button {
            min-height: 32px;
            padding: 0 12px;
            border: 1px solid #d4d4d8;
            border-radius: 6px;
            background: #fafafa;
            color: #18181b;
            cursor: pointer;
            font: inherit;
          }
          #sms-code-autofill-userscript-settings button[data-primary="true"] {
            border-color: #155eef;
            background: #155eef;
            color: #ffffff;
          }
        </style>
        <form>
          <h2>SMS Code Autofill 设置</h2>
          <fieldset>
            <legend>Cloudflare 邮箱设置</legend>
            <label>
              Cloudflare Temp Email Base URL
              <input name="cloudflareTempEmailBaseUrl" autocomplete="off" placeholder="https://temp.example.com" />
            </label>
            <label>
              Cloudflare Temp Email 域名
              <input name="cloudflareTempEmailDomain" autocomplete="off" placeholder="mail.example.com" />
            </label>
            <label>
              Cloudflare Admin Auth
              <input name="cloudflareTempEmailAdminAuth" autocomplete="off" />
            </label>
          </fieldset>
          <fieldset>
            <legend>SMS 手机号设置</legend>
            <label>
              API Key
              <input name="apiKey" autocomplete="off" />
            </label>
            <label>
              默认国家
              <span class="sms-current-country" data-role="current-country">
                <span data-role="current-country-label"></span>
                <button type="button" class="sms-country-clear" data-action="clear-country" title="重新选择国家">×</button>
              </span>
              <input name="country" autocomplete="off" placeholder="输入国家名或 ID 搜索" />
              <span class="sms-country-status" data-role="country-status"></span>
              <div class="sms-country-list" data-role="country-list"></div>
            </label>
            <label>
              最大价格
              <input name="maxPrice" type="number" min="-1" step="0.01" />
            </label>
          </fieldset>
          <div class="sms-actions">
            <button type="button" data-action="clear-email">清除邮箱</button>
            <button type="button" data-action="cancel">取消</button>
            <button type="submit" data-primary="true">保存</button>
          </div>
        </form>
      `;

      const form = root.querySelector('form') as HTMLFormElement;
      const apiKeyInput = form.elements.namedItem('apiKey') as HTMLInputElement;
      const countryInput = form.elements.namedItem('country') as HTMLInputElement;
      const maxPriceInput = form.elements.namedItem('maxPrice') as HTMLInputElement;
      const cloudflareBaseUrlInput = form.elements.namedItem('cloudflareTempEmailBaseUrl') as HTMLInputElement;
      const cloudflareDomainInput = form.elements.namedItem('cloudflareTempEmailDomain') as HTMLInputElement;
      const cloudflareAdminAuthInput = form.elements.namedItem('cloudflareTempEmailAdminAuth') as HTMLInputElement;
      const currentCountryEl = root.querySelector('[data-role="current-country"]') as HTMLElement;
      const currentCountryLabelEl = root.querySelector('[data-role="current-country-label"]') as HTMLElement;
      const countryStatusEl = root.querySelector('[data-role="country-status"]') as HTMLElement;
      const countryListEl = root.querySelector('[data-role="country-list"]') as HTMLElement;
      const clearCountryButton = root.querySelector('[data-action="clear-country"]') as HTMLButtonElement;
      let selectedCountry: HeroCountryOption | null = currentCountry;
      let selectingCountry = false;

      apiKeyInput.value = current.apiKey;
      cloudflareBaseUrlInput.value = current.cloudflareTempEmailBaseUrl;
      cloudflareDomainInput.value = current.cloudflareTempEmailDomain;
      cloudflareAdminAuthInput.value = current.cloudflareTempEmailAdminAuth;
      countryStatusEl.textContent = countriesPromise ? '正在加载国家列表...' : '';
      maxPriceInput.value = String(current.maxPrice);

      const renderCountryField = () => {
        currentCountryEl.style.display = selectedCountry ? 'grid' : 'none';
        currentCountryLabelEl.textContent = selectedCountry ? `当前：${selectedCountry.label}` : '';
        countryInput.style.display = selectingCountry ? '' : 'none';
        countryListEl.style.display = selectingCountry ? 'grid' : 'none';
        if (!selectingCountry && selectedCountry) {
          countryStatusEl.textContent = countries.length > 1 ? `已加载 ${countries.length} 个国家` : countryStatusEl.textContent;
        }
      };

      const renderCountryOptions = () => {
        renderCountryField();
        if (!selectingCountry) return;
        const query = countryInput.value.trim().toLowerCase();
        const normalizedQuery = normalizeSettingSearchText(query);
        const visibleCountries = countries
          .filter((country) => this.countryOptionMatches(country, normalizedQuery));

        countryListEl.replaceChildren();
        if (visibleCountries.length === 0) {
          const empty = document.createElement('span');
          empty.className = 'sms-country-status';
          empty.textContent = '没有匹配的国家';
          countryListEl.appendChild(empty);
          return;
        }
        for (const country of visibleCountries) {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'sms-country-option';
          option.textContent = country.label;
          option.dataset.selected = country.id === selectedCountry?.id ? 'true' : 'false';
          option.addEventListener('click', () => {
            selectedCountry = country;
            selectingCountry = false;
            countryInput.value = '';
            renderCountryOptions();
          });
          countryListEl.appendChild(option);
        }
      };
      renderCountryOptions();

      const close = (value: UserscriptConfig | null) => {
        closed = true;
        root.remove();
        resolve(value);
      };

      root.querySelector('[data-action="clear-email"]')?.addEventListener('click', async () => {
        await this.clearEmailState();
        await this.saveEmailRunning(false);
        this.render('已清除注册邮箱状态');
      });
      root.querySelector('[data-action="cancel"]')?.addEventListener('click', () => close(null));
      clearCountryButton.addEventListener('click', () => {
        selectedCountry = null;
        selectingCountry = true;
        countryStatusEl.textContent = countries.length > 1 ? `已加载 ${countries.length} 个国家` : countryStatusEl.textContent;
        renderCountryOptions();
        countryInput.focus();
      });
      countryInput.addEventListener('input', renderCountryOptions);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const country = this.resolveCountryInput(countryInput.value, countries, selectedCountry ?? currentCountry);
        close({
          ...current,
          apiKey: apiKeyInput.value.trim(),
          country: country.id,
          countryNames: country.names,
          service: DEFAULT_CONFIG.service,
          maxPrice: parseMaxPrice(maxPriceInput.value, current.maxPrice),
          cloudflareTempEmailBaseUrl: normalizeBaseUrl(cloudflareBaseUrlInput.value),
          cloudflareTempEmailDomain: normalizeDomain(cloudflareDomainInput.value),
          cloudflareTempEmailAdminAuth: cloudflareAdminAuthInput.value.trim(),
        });
      });

      document.documentElement.appendChild(root);
      apiKeyInput.focus();

      if (countriesPromise) {
        countriesPromise.then((loadedCountries) => {
          if (closed) return;
          countries = loadedCountries.length > 0 ? loadedCountries : countries;
          const refreshedSelected = selectedCountry
            ? countries.find((country) => country.id === selectedCountry?.id)
            : null;
          if (refreshedSelected) {
            selectedCountry = refreshedSelected;
          }
          countryStatusEl.textContent = countries.length > 1 ? `已加载 ${countries.length} 个国家` : '国家列表加载失败，仅保留当前国家';
          renderCountryOptions();
        });
      }
    });
  }

  private resolveCountryInput(
    value: string,
    countries: HeroCountryOption[],
    fallback: HeroCountryOption,
  ): HeroCountryOption {
    const trimmed = value.trim();
    const idMatch = trimmed.match(/\((\d+)\)$/);
    const id = idMatch?.[1] ?? (/^\d+$/.test(trimmed) ? trimmed : '');
    return countries.find((country) => country.label === trimmed || country.id === id) ?? fallback;
  }

  private countryOptionMatches(country: HeroCountryOption, query: string): boolean {
    if (!query) return true;
    const searchable = normalizeSettingSearchText([country.id, country.label, ...country.names].join(' '));
    return searchable.includes(query);
  }

  private async saveState(): Promise<void> {
    await this.platform.sessionStorage.set({ [STATE_KEY]: serializeRetryState(this.state) });
  }

  private async saveEmailState(): Promise<void> {
    await Promise.all([
      this.platform.sessionStorage.set({ [EMAIL_STATE_KEY]: this.emailState }),
      this.platform.localStorage.set({ [EMAIL_STATE_KEY]: this.emailState }),
    ]);
  }

  private async clearEmailState(): Promise<void> {
    this.emailState = null;
    await Promise.all([
      this.platform.sessionStorage.remove(EMAIL_STATE_KEY),
      this.platform.localStorage.remove(EMAIL_STATE_KEY),
    ]);
  }

  private async saveEmailRunning(running: boolean): Promise<void> {
    if (running) {
      await this.platform.sessionStorage.set({ [EMAIL_RUNNING_KEY]: true });
      return;
    }
    await this.platform.sessionStorage.remove(EMAIL_RUNNING_KEY);
  }

  private createInitialState(): RetryState {
    return {
      phase: RetryPhase.IDLE,
      sessionId: '',
      currentBucket: 1,
      attemptInBucket: 0,
      totalAttempts: 0,
      maxBuckets: DEFAULT_CONFIG.maxBuckets,
      bucketSize: DEFAULT_CONFIG.bucketSize,
      currentActivationId: null,
      currentPhoneNumber: null,
      currentActivationCountry: null,
      lastError: null,
      startedAt: 0,
      lastTransitionAt: 0,
      notificationId: null,
      usedCodes: new Set(),
      attemptedSmsKeys: new Set(),
      firstResendDone: false,
      lastResendAt: 0,
      pauseMode: 'bucket_and_circuit',
      costPerAttempt: 0.05,
      pollInterval: DEFAULT_CONFIG.pollInterval,
      requestTimeout: DEFAULT_CONFIG.requestTimeout,
    };
  }

  private describePhase(): string {
    if (this.state.phase === RetryPhase.WAIT_CODE) {
      const remaining = Math.max(0, Math.ceil((this.state.requestTimeout - (Date.now() - this.state.startedAt)) / 1000));
      return `等待验证码 ${remaining}s`;
    }
    return this.state.phase;
  }

  private render(statusText: string): void {
    this.panel.update({
      phase: this.state.phase,
      mode: this.panelMode(),
      statusText,
      attemptText: `${this.state.attemptInBucket}/${this.state.bucketSize} 轮次 ${this.state.currentBucket}/${this.state.maxBuckets}`,
      emailText: this.emailState?.email ?? '-',
      phoneText: this.state.currentPhoneNumber ? maskPhone(this.state.currentPhoneNumber) : '-',
      canContinue: this.state.phase === RetryPhase.AWAIT_CONFIRM,
      running: this.emailRegistrationActive || ![RetryPhase.IDLE, RetryPhase.STOPPED, RetryPhase.DONE].includes(this.state.phase),
    });
  }

  private panelMode(): 'cloudflare' | 'sms' | 'idle' {
    if (this.emailRegistrationActive || this.emailState?.email) return 'cloudflare';
    if (![RetryPhase.IDLE, RetryPhase.STOPPED, RetryPhase.DONE].includes(this.state.phase)) return 'sms';
    return 'idle';
  }
}

const FIRST_NAMES = [
  'Aaliyah', 'Aaron', 'Abigail', 'Adam', 'Adrian', 'Aiden', 'Alexa', 'Alice',
  'Allison', 'Amelia', 'Andrew', 'Anna', 'Anthony', 'Aria', 'Arthur', 'Audrey',
  'Aurora', 'Austin', 'Ava', 'Avery', 'Bella', 'Benjamin', 'Blake', 'Brandon',
  'Brianna', 'Brooklyn', 'Caleb', 'Cameron', 'Caroline', 'Charles', 'Charlotte',
  'Chloe', 'Claire', 'Connor', 'Daniel', 'David', 'Dylan', 'Eleanor', 'Elena',
  'Eli', 'Elijah', 'Elizabeth', 'Ella', 'Emily', 'Emma', 'Ethan', 'Eva',
  'Evelyn', 'Ezra', 'Gabriel', 'Grace', 'Grayson', 'Hannah', 'Harper', 'Hazel',
  'Henry', 'Hudson', 'Hunter', 'Isaac', 'Isabella', 'Jack', 'Jackson', 'Jacob',
  'James', 'Jasmine', 'Jayden', 'John', 'Joseph', 'Joshua', 'Julia', 'Julian',
  'Katherine', 'Kayla', 'Kennedy', 'Kevin', 'Landon', 'Layla', 'Leah', 'Leo',
  'Levi', 'Liam', 'Lily', 'Logan', 'Lucas', 'Lucy', 'Luke', 'Madeline',
  'Madison', 'Mason', 'Matthew', 'Maya', 'Mia', 'Michael', 'Mila', 'Nathan',
  'Nicholas', 'Noah', 'Nolan', 'Nora', 'Oliver', 'Olivia', 'Owen', 'Paisley',
  'Penelope', 'Riley', 'Ryan', 'Samuel', 'Savannah', 'Scarlett', 'Sebastian',
  'Sofia', 'Sophia', 'Stella', 'Thomas', 'Victoria', 'Violet', 'William', 'Wyatt',
  'Zachary', 'Zoe',
];
const LAST_NAMES = [
  'Adams', 'Alexander', 'Allen', 'Anderson', 'Bailey', 'Baker', 'Barnes', 'Bell',
  'Bennett', 'Brooks', 'Brown', 'Bryant', 'Butler', 'Campbell', 'Carter', 'Clark',
  'Collins', 'Cook', 'Cooper', 'Cox', 'Davis', 'Diaz', 'Edwards', 'Evans',
  'Fisher', 'Flores', 'Foster', 'Garcia', 'Gonzalez', 'Gray', 'Green', 'Griffin',
  'Hall', 'Harris', 'Hayes', 'Henderson', 'Hernandez', 'Hill', 'Howard', 'Hughes',
  'Jackson', 'James', 'Jenkins', 'Johnson', 'Jones', 'Kelly', 'King', 'Lee',
  'Lewis', 'Long', 'Lopez', 'Martin', 'Martinez', 'Miller', 'Mitchell', 'Moore',
  'Morgan', 'Morris', 'Murphy', 'Nelson', 'Parker', 'Patterson', 'Perez', 'Perry',
  'Peterson', 'Phillips', 'Powell', 'Price', 'Ramirez', 'Reed', 'Reyes', 'Richardson',
  'Rivera', 'Roberts', 'Robinson', 'Rodriguez', 'Rogers', 'Ross', 'Russell',
  'Sanchez', 'Sanders', 'Scott', 'Simmons', 'Smith', 'Stewart', 'Taylor', 'Thomas',
  'Thompson', 'Torres', 'Turner', 'Walker', 'Ward', 'Washington', 'Watson', 'White',
  'Williams', 'Wilson', 'Wood', 'Wright', 'Young', 'Bishop', 'Bowman', 'Boyd',
  'Bradley', 'Burke', 'Carpenter', 'Chavez', 'Cole', 'Coleman', 'Cruz', 'Daniels',
  'Dixon', 'Duncan', 'Ellis', 'Ford', 'Gibson', 'Gordon', 'Grant', 'Hamilton',
  'Harper', 'Hart',
];
const MIN_IDENTITY_AGE = 19;
const MAX_IDENTITY_AGE = 50;

function generateIdentityProfile(): IdentityProfile {
  return {
    firstName: pick(FIRST_NAMES),
    lastName: pick(LAST_NAMES),
    age: randomInt(MIN_IDENTITY_AGE, MAX_IDENTITY_AGE),
  };
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function maskPhone(phone: string): string {
  if (phone.length <= 6) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function normalizeSettingSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseMaxPrice(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'UNKNOWN_ERROR');
}

function isEmailRegistrationPending(error?: string): boolean {
  return error === 'EMAIL_VERIFICATION_PAGE_PENDING' || error === 'EMAIL_REGISTRATION_IN_PROGRESS';
}
