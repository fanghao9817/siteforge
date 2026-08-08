// 工具:给任意 URL 截图。用法: URL=http://... OUT=shot.png [FULL=1] node scripts/screenshot.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  channel: process.env.SF_CHROME_CHANNEL || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1380, height: 900 } });
await page.goto(process.env.URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: process.env.OUT, fullPage: process.env.FULL === '1' });
await browser.close();
console.log('shot →', process.env.OUT);
