import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

// 两轨共享的浏览器栈:同一 UA/视口/启动参数/滚动逻辑,消除 forge 与 clone 的行为漂移。

/** 真实 Chrome UA:自曝身份的 UA 会被 Cloudflare/Wix 等 WAF 拦成人机验证页。 */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export const VIEWPORT = { width: 1440, height: 900 };

export async function launchBrowser(extraArgs: string[] = []): Promise<Browser> {
  return chromium.launch({
    headless: true,
    // SF_CHROME_CHANNEL=chromium → 全量 Chromium 新 headless(缺 headless-shell 系统库的机器)
    channel: (process.env.SF_CHROME_CHANNEL as 'chromium' | undefined) || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...extraArgs], // 1.9G 小机:省内存、配合 swap
  });
}

export function contextOptions(): Parameters<Browser['newContext']>[0] {
  return {
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    userAgent: UA,
    locale: 'en-CA',
    ignoreHTTPSErrors: true, // SMB 站证书链常有瑕疵;资源真实性风险见 docs
  };
}

export async function newPage(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(contextOptions());
  const page = await ctx.newPage();
  return { ctx, page };
}

/** 渐进滚动到底,触发懒加载;回到顶部。 */
export async function autoScroll(page: Page, maxY = 20000): Promise<void> {
  await page.evaluate(async (limit: number) => {
    await new Promise<void>((resolve) => {
      let y = 0;
      const step = 550;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        y += step;
        if (y >= document.body.scrollHeight - window.innerHeight || y > limit) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 110);
    });
  }, maxY);
}
