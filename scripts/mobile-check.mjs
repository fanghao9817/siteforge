#!/usr/bin/env node
// 移动端可用性闸门:390×844 下检查横向溢出与导航可用性。
//
// 动机(实测 60 站克隆产物):21/60 站移动端不可用 —— 12 站横向溢出(Wix 类靠 JS 做响应式,
// 剥 script 后 @media max-width 规则数为 0,永远是 980px 桌面版)、9 站汉堡点不开。
// 桌面像素分 97.6% 完全没反映这一点,因为它只测 1440px。
//
// 用法:
//   node scripts/mobile-check.mjs sites/<slug>            单站
//   node scripts/mobile-check.mjs runs/round5             批量(目录下每个子目录)
// 退出码 1 = 有站点未通过(可用作发布前闸门)。
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const MOBILE = { width: 390, height: 844 };
const MAX_W = 400; // 允许 10px 余量
const MIN_NAV = 3; // 首屏可达导航链接下限(汉堡展开后应 ≥ 此值)
const MAX_CLIPPED = 3; // 允许的"超出视口右边界"元素数(装饰性元素难免有个别)

const target = process.argv[2];
if (!target) {
  console.error('用法: node scripts/mobile-check.mjs <sites/slug | 含多个站点的目录>');
  process.exit(1);
}

async function pagesToCheck(p) {
  const abs = resolve(p);
  const st = await stat(abs).catch(() => null);
  if (!st) throw new Error(`路径不存在: ${p}`);
  const direct = join(abs, 'index.html');
  if (await stat(direct).then(() => true).catch(() => false)) return [{ name: abs.split('/').pop(), file: direct }];
  const dirs = (await readdir(abs, { withFileTypes: true })).filter((d) => d.isDirectory());
  const out = [];
  for (const d of dirs) {
    const f = join(abs, d.name, 'index.html');
    if (await stat(f).then(() => true).catch(() => false)) out.push({ name: d.name, file: f });
  }
  return out;
}

const list = await pagesToCheck(target);
if (!list.length) {
  console.error('未找到任何 index.html');
  process.exit(1);
}

const browser = await chromium.launch({
  headless: true,
  channel: process.env.SF_CHROME_CHANNEL || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });

const fails = [];
console.log(`\n移动端闸门 ${MOBILE.width}×${MOBILE.height}(scrollWidth ≤ ${MAX_W}、可达导航 ≥ ${MIN_NAV})\n`);
for (const { name, file } of list) {
  const page = await ctx.newPage();
  let r = { sw: 0, nav: 0, mq: 0, sfNav: false, err: '' };
  try {
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(250);
    // 有我们注入的零 JS 汉堡菜单则先展开,再统计可达链接
    const hasSfNav = await page.locator('.sf-nav > summary').count().then((n) => n > 0);
    if (hasSfNav) await page.click('.sf-nav > summary').catch(() => {});
    await page.waitForTimeout(150);
    r = await page.evaluate((vw) => {
      // 关键:不能只看 scrollWidth —— overflow-x:hidden 会把溢出"藏起来"(内容其实被裁掉),
      // 让坏站骗过闸门。所以同时统计**真实超出视口右边界的可见元素**。
      let clipped = 0;
      let worstRight = 0;
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('.sf-nav')) continue;
        const b = el.getBoundingClientRect();
        if (b.width < 8 || b.height < 8 || b.top > 4000) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
        if (b.right > vw + 8) {
          clipped++;
          worstRight = Math.max(worstRight, Math.round(b.right));
        }
      }
      return {
        sw: document.documentElement.scrollWidth,
        clipped,
        worstRight,
        nav: [...document.querySelectorAll('a[href]')].filter((a) => {
          const b = a.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && b.top < 3000;
        }).length,
        mq: [...document.styleSheets].reduce((n, ss) => {
          try {
            return n + [...ss.cssRules].filter((x) => x.type === 4 && /max-width/.test(x.conditionText || '')).length;
          } catch {
            return n;
          }
        }, 0),
        sfNav: !!document.querySelector('.sf-nav'),
        err: '',
      };
    }, MOBILE.width);
  } catch (e) {
    r.err = String(e?.message || e).slice(0, 60);
  }
  await page.close();

  const okW = r.sw <= MAX_W;
  const okClip = (r.clipped || 0) <= MAX_CLIPPED;
  const okNav = r.nav >= MIN_NAV;
  const ok = okW && okClip && okNav && !r.err;
  if (!ok) fails.push({ name, ...r });
  const wixHint = r.mq === 0 ? '(移动媒体查询=0,Wix 类 JS 响应式 → 建议走 forge 轨)' : '';
  const why = r.err
    ? `错误 ${r.err}`
    : !okW
      ? `横向溢出 ${r.sw}px${wixHint}`
      : !okClip
        ? `${r.clipped} 个元素被裁切(最远 ${r.worstRight}px)${wixHint}`
        : !okNav
          ? `可达导航仅 ${r.nav}`
          : '';
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(30)} 宽${String(r.sw).padStart(5)} 裁切${String(r.clipped ?? 0).padStart(3)} 导航${String(r.nav).padStart(3)} ${r.sfNav ? 'sf-nav✓' : '       '} ${why}`);
}
await browser.close();

console.log(`\n  ${list.length - fails.length}/${list.length} 通过`);
if (fails.length) {
  console.log(`\n  未通过(建议这些站走 forge 轨):`);
  fails.forEach((f) => console.log(`    ${f.name}`));
  process.exit(1);
}
