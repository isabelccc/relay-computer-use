import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { Policy } from './policy.js';
import {
  ExecutionError,
  type Action,
  type Checkpoint,
  type Control,
  type Observation,
  type Scenario,
  type Target,
} from './schema.js';

/** The engine depends only on this seam; browser locators stay in the adapter. */
export interface Surface {
  observe(): Promise<Observation>;
  checkpoint(): Promise<Checkpoint>;
  perform(
    action: Action,
    params: Record<string, string>,
    actor: 'automation' | 'human',
  ): Promise<void>;
  read(target: Target): Promise<string>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}
export const target = (
  name: string,
  strategy: 'role' | 'label' = 'role',
  role: Target['role'] = 'button',
): Target => ({
  surface: 'browser',
  frame: 'Core workspace',
  strategy,
  ...(strategy === 'role' ? { role } : {}),
  name,
  rationale:
    strategy === 'role'
      ? 'Exact accessible role and name, scoped to a titled frame; requires one visible match.'
      : 'Exact accessible label in the titled frame; independent of element IDs and table position.',
});
export class BrowserSurface implements Surface {
  private violation: string | undefined;
  private constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    readonly policy: Policy,
  ) {}
  static async create(
    policy: Policy,
    scenario: Scenario = 'normal',
    variant = 'base',
    entryUrl = `${policy.origin}/bank`,
  ): Promise<BrowserSurface> {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {}),
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 1120, height: 760 },
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      context.setDefaultTimeout(policy.config.stepTimeoutMs);
      await context.addInitScript(
        ({ scenario, variant }) => {
          sessionStorage.setItem('scenario', scenario);
          sessionStorage.setItem('variant', variant);
        },
        { scenario, variant },
      );
      const page = await context.newPage();
      const surface = new BrowserSurface(browser, context, page, policy);
      await context.route('**/*', async (route) => {
        const req = route.request();
        if (!policy.permitsUrl(req.url()) || !['GET', 'HEAD'].includes(req.method())) {
          surface.violation = 'NETWORK_BLOCKED';
          await route.abort('blockedbyclient');
          return;
        }
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 5000 });
          // Browser routing does not reliably re-intercept redirect chains. Reject
          // redirects before delivering them, including same-origin redirects.
          if (response.status() >= 300 && response.status() < 400) {
            surface.violation = 'REDIRECT_BLOCKED';
            await route.abort('blockedbyclient');
            return;
          }
          await route.fulfill({ response });
        } catch {
          surface.violation = 'NETWORK_FAILED';
          await route.abort('failed').catch(() => {});
        }
      });
      await context.routeWebSocket(/.*/, (socket) => {
        surface.violation = 'WEBSOCKET_BLOCKED';
        socket.close();
      });
      context.on('page', (p) => {
        if (p !== page) {
          surface.violation = 'POPUP_BLOCKED';
          void p.close();
        }
      });
      page.on('dialog', (dialog) => {
        surface.violation = 'UNEXPECTED_BROWSER_DIALOG';
        void dialog.dismiss();
      });
      page.on('download', (download) => {
        surface.violation = 'DOWNLOAD_BLOCKED';
        void download.cancel();
      });
      policy.assertUrl(entryUrl);
      await page.goto(entryUrl, { waitUntil: 'load' });
      await page
        .frameLocator('iframe[title="Core workspace"]')
        .getByRole('heading', { name: 'Member search', exact: true })
        .waitFor();
      return surface;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  private guard() {
    if (this.violation) throw new ExecutionError(this.violation);
    this.policy.assertUrl(this.page.url());
    for (const frame of this.page.frames())
      if (frame !== this.page.mainFrame()) this.policy.assertUrl(frame.url());
  }
  private locator(t: Target): Locator {
    this.policy.assertTarget(t);
    const frame = this.page.frameLocator('iframe[title="Core workspace"]');
    if (t.strategy === 'label') return frame.getByLabel(t.name, { exact: true });
    if (!t.role) throw new ExecutionError('INVALID_TARGET');
    return frame.getByRole(t.role, { name: t.name, exact: true });
  }
  private async unique(t: Target): Promise<Locator> {
    const loc = this.locator(t),
      count = await loc.count();
    if (count !== 1) throw new ExecutionError(count > 1 ? 'AMBIGUOUS_TARGET' : 'TARGET_MISSING');
    if (!(await loc.isVisible())) throw new ExecutionError('TARGET_HIDDEN');
    return loc;
  }
  async checkpoint(): Promise<Checkpoint> {
    this.guard();
    const frame = this.page.frameLocator('iframe[title="Core workspace"]');
    const headings = frame.getByRole('heading', { level: 1 });
    if ((await headings.count()) !== 1 || !(await headings.isVisible()))
      return { frame: 'Core workspace', heading: 'Unrecognized screen' };
    const text = await headings.innerText();
    // Unknown text is never exported: headings can contain names or identifiers.
    return {
      frame: 'Core workspace',
      heading: this.policy.config.headings.includes(text) ? text : 'Unrecognized screen',
    };
  }
  async observe(): Promise<Observation> {
    const checkpoint = await this.checkpoint();
    const controls: Control[] = [];
    const candidates = [
      ...new Set([...this.policy.config.humanClick, ...this.policy.config.irreversible]),
    ].map((name) => target(name));
    candidates.push(
      ...[...this.policy.config.fill, ...this.policy.config.read].map((name) =>
        target(name, 'label'),
      ),
    );
    for (const t of candidates) {
      const loc = this.locator(t);
      const count = await loc.count();
      if (count === 0) continue;
      // Duplicates remain observable, and are rejected by unique() on execution.
      if (!(await loc.first().isVisible())) continue;
      controls.push({
        id: createHash('sha256')
          .update(`${checkpoint.heading}:${t.strategy}:${t.name}`)
          .digest('hex')
          .slice(0, 12),
        target: t,
        writable: this.policy.config.fill.includes(t.name),
        readable: this.policy.config.read.includes(t.name),
        bounds: count === 1 ? await loc.boundingBox() : null,
      });
    }
    return { checkpoint, controls, observedAt: new Date().toISOString() };
  }
  async perform(action: Action, params: Record<string, string>, actor: 'automation' | 'human') {
    this.guard();
    this.policy.assertAction(action, actor);
    const loc = await this.unique(action.target);
    if (action.kind === 'fill') {
      const value = params[action.input];
      if (typeof value !== 'string' || !/^\d{5}$/.test(value))
        throw new ExecutionError('INVALID_INPUT');
      await loc.fill(value);
    } else await loc.click();
    this.guard();
  }
  async read(t: Target) {
    this.guard();
    this.policy.assertRead(t);
    return (await this.unique(t)).inputValue();
  }
  async screenshot() {
    this.guard();
    return this.page.screenshot({ type: 'png' });
  }
  async close() {
    await this.browser.close();
  }
}
