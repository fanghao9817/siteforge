import type { RawCapture } from './types.js';
import { launchBrowser, newPage, autoScroll } from './browser.js';

/**
 * 无头渲染一个 URL,返回渲染后(JS 已执行)的内容素材 + 品牌色板。
 * 这是相对"纯 HTML 抓取"的关键升级:Wix/JS 站的电话/地址/图/真实配色,只有渲染后才看得到。
 */
export async function renderSite(url: string, timeoutMs = 45000): Promise<RawCapture> {
  const browser = await launchBrowser();
  try {
    const { page } = await newPage(browser);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    } catch {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    }
    await autoScroll(page).catch(() => {});
    await page.waitForTimeout(700);

    const data = await page.evaluate(() => {
      // ---- 前置清理:cookie/consent/促销浮层不是品牌内容,会劫持色板与文案 ----
      const JUNK =
        '#CybotCookiebotDialog,[id*="Cookiebot"],#onetrust-consent-sdk,[id*="onetrust"],' +
        '[class*="cookie-consent"],[class*="cookie-banner"],[class*="cookie-notice"],[id*="cookie-law"],' +
        '[class*="cookieConsent"],.cc-window,[aria-label*="cookie" i],#gdpr,[class*="gdpr-"]';
      document.querySelectorAll(JUNK).forEach((e) => e.remove());

      // rgba? 解析 → [r,g,b, alpha];全透明返回 null
      const parse = (s: string | null): { c: [number, number, number]; a: number } | null => {
        if (!s) return null;
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        if (p.some((n) => Number.isNaN(n))) return null;
        const a = p.length >= 4 ? p[3] : 1;
        if (a === 0) return null;
        return { c: [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])], a };
      };
      const add = (map: Map<string, number>, v: { c: [number, number, number]; a: number } | null, w: number) => {
        if (!v || w <= 0) return;
        const k = v.c.join(',');
        // 半透明按 alpha 折算权重:0.1 透明度的巨幅叠层不再冒充实色背景
        map.set(k, (map.get(k) || 0) + w * v.a);
      };
      const top = (map: Map<string, number>, n: number) =>
        [...map.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([k, w]) => ({ c: k.split(',').map(Number) as [number, number, number], w }));
      const abs = (u: string | null | undefined): string | null => {
        if (!u) return null;
        try {
          return new URL(u, location.href).href;
        } catch {
          return null;
        }
      };
      // 不可见元素(display:none/visibility/0 尺寸)不参与内容与色板统计
      const visible = (el: HTMLElement): boolean => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) > 0.05;
      };

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const bgMap = new Map<string, number>();
      const txtMap = new Map<string, number>();
      const accMap = new Map<string, number>();

      const els = (Array.from(document.querySelectorAll('body *')) as HTMLElement[]).filter(visible);
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        const area = Math.min(r.width, vw) * Math.min(r.height, vh * 2);
        add(bgMap, parse(st.backgroundColor), area);
        const txt = (el.innerText || '').trim();
        if (txt && txt.length < 400) add(txtMap, parse(st.color), txt.length);
        const tag = el.tagName.toLowerCase();
        if (/^(a|button)$/.test(tag) || /^h[1-3]$/.test(tag) || el.closest('nav,header,.btn,[class*="button"]')) {
          add(accMap, parse(st.color), area);
          add(accMap, parse(st.backgroundColor), area);
        }
      }

      const hEl = document.querySelector('h1, h2');
      const headingFont = hEl ? getComputedStyle(hEl).fontFamily : '';
      const bodyFont = getComputedStyle(document.body).fontFamily;

      // 页面真实背景:body→html 里第一个非透明背景色(判浅色站/深色站的可靠信号,
      // 不受大 hero 区块面积干扰)
      let pageBg: [number, number, number] | null = null;
      for (const el of [document.body, document.documentElement]) {
        const p = parse(getComputedStyle(el).backgroundColor);
        if (p) {
          pageBg = p.c;
          break;
        }
      }

      // logo:优先 header/nav 里"像 logo"的图;再全文档像 logo 的;最后 header/nav 第一张图
      const imgs = Array.from(document.images).filter((i) => visible(i));
      const logoish = (i: HTMLImageElement) => /logo/i.test(`${i.src} ${i.alt} ${i.className}`);
      let logo: string | null = null;
      const headerImgs = imgs.filter((i) => i.closest('header,nav'));
      const pick = headerImgs.find(logoish) || imgs.find(logoish) || headerImgs[0] || null;
      if (pick) logo = abs(pick.currentSrc || pick.src);

      // hero:首屏内最大的内容图(header/nav 内的不算,避免大 logo 顶替 hero);没有再找首屏大块 CSS 背景图
      let hero: string | null = null;
      let best = 0;
      for (const i of imgs) {
        if (i.closest('header,nav')) continue;
        const r = i.getBoundingClientRect();
        if (r.top < vh && r.width > 280) {
          const a = r.width * r.height;
          if (a > best) {
            best = a;
            hero = abs(i.currentSrc || i.src);
          }
        }
      }
      if (!hero) {
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.top < vh && r.width > vw * 0.6 && r.height > 200) {
            const m = getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)/);
            if (m) {
              hero = abs(m[1]);
              break;
            }
          }
        }
      }

      const headings = (Array.from(document.querySelectorAll('h1,h2,h3')) as HTMLElement[])
        .filter(visible)
        .map((h) => h.innerText.trim())
        .filter(Boolean)
        .slice(0, 40);
      const paragraphs = (Array.from(document.querySelectorAll('p,li')) as HTMLElement[])
        .filter(visible)
        .map((p) => p.innerText.trim())
        .filter((t) => t.length > 40)
        .slice(0, 60);

      // 标题→紧随段落 配对(服务卡描述、about 精准定位都靠它)
      const sections: { h: string; p: string }[] = [];
      for (const h of Array.from(document.querySelectorAll('h1,h2,h3,h4')) as HTMLElement[]) {
        if (!visible(h)) continue;
        const ht = h.innerText.trim();
        if (!ht) continue;
        let sib = h.nextElementSibling as HTMLElement | null;
        let hops = 0;
        while (sib && hops < 3) {
          if (visible(sib)) {
            const pt = (sib.matches('p,div,span') ? sib.innerText : '').trim();
            if (pt.length > 30) {
              sections.push({ h: ht, p: pt.slice(0, 500) });
              break;
            }
          }
          sib = sib.nextElementSibling as HTMLElement | null;
          hops++;
        }
        if (sections.length >= 30) break;
      }

      const descEl = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;

      // 长页保头也保尾:页脚的地址/营业时间不能被截掉
      const full = document.body.innerText;
      const fullText = full.length > 40000 ? full.slice(0, 30000) + '\n' + full.slice(-10000) : full;

      return {
        title: document.title || '',
        description: descEl?.content || '',
        lang: (document.documentElement.getAttribute('lang') || '').trim(),
        pageBg,
        fullText,
        backgrounds: top(bgMap, 12),
        texts: top(txtMap, 8),
        accents: top(accMap, 12),
        headingFont,
        bodyFont,
        logo,
        hero,
        headings,
        paragraphs,
        sections,
      };
    });

    const html = await page.content();
    return { url, finalUrl: page.url(), html, ...data };
  } finally {
    await browser.close();
  }
}
