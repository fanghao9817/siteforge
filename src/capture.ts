import { type BrowserContext, type Page } from 'playwright';
import { load } from 'cheerio';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { UA, VIEWPORT, launchBrowser, contextOptions, autoScroll } from './browser.js';
import { urlAllowed } from './safe.js';

export { VIEWPORT }; // score.ts 等下游继续从本模块取

/**
 * Capture-first 克隆引擎。
 *
 * 目标:像素级复刻任意中小商户站。做法不是"抽内容塞进我们的模板"(那是有损再诠释),
 * 而是:无头渲染 JS 执行后的真实 DOM → 把它引用的每一个外部资源(样式表/字体/图片/
 * 背景图/favicon)下载到本地 assets/ 并改写引用 → 产出一个自包含、脱网也能逐像素
 * 还原的静态站。同时截一张"渲染当时"的整页参考图 reference.png,供评分器对比。
 */

// 冻结动画/过渡/光标,保证参考图与克隆图都停在稳定帧(否则轮播/淡入让像素对比失真)。
export const FREEZE_CSS =
  '*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;' +
  'transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}' +
  'html{scroll-behavior:auto!important}';

export interface CaptureMeta {
  url: string;
  finalUrl: string;
  title: string;
  fullHeight: number;
  viewportWidth: number;
  htmlBytes: number;
  assetsOk: number;
  assetsFail: number;
  notes: string[];
}

const CT_EXT: Record<string, string> = {
  'text/css': '.css',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'font/woff2': '.woff2',
  'font/woff': '.woff',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff2': '.woff2',
  'application/font-woff': '.woff',
  'application/x-font-ttf': '.ttf',
  'application/vnd.ms-fontobject': '.eot',
};

function extFor(ct: string, url: string): string {
  const clean = (ct || '').split(';')[0].trim().toLowerCase();
  if (CT_EXT[clean]) return CT_EXT[clean];
  const m = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return m ? '.' + m[1].toLowerCase() : '.bin';
}

/** 有界并发 map(资源下载别一次性打满,也别一个个串行等)。 */
async function mapPool<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length || 1) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// 第三方 JS 挂件(评价/社媒/聊天/预约):靠 JS 渲成紧凑组件,剥脚本后内部内容会摊开撑爆布局高度。
// 这些内容本就不是我们能静态复现的(Google 评价、IG feed…),正确做法=冻结成它"当时的占位尺寸"。
const EMBED_SELECTOR = [
  '[class*="elfsight-app-"]', // Elfsight(SMB 最常见的评价/挂件平台)
  '.es-embed-root',
  '.instagram-media',
  '[class*="tawk-"]', '[id*="tawk"]', // Tawk 聊天
  '[class*="crisp-"]', '[id*="crisp"]', // Crisp 聊天
  '.intercom-lightweight-app', '[id*="intercom"]',
  '[class*="fb_iframe"]', '.fb-page', // Facebook 挂件
  '[data-widget-id]', '[data-elfsight-app-lazy]',
].join(',');

/** 页内规整:挂件冻结、懒加载图落定、srcset 收敛、脚本剥离。让序列化出来的 DOM = 眼睛看到的那一帧。 */
async function normalizeInPage(page: Page): Promise<void> {
  await page.evaluate((embedSel: string) => {
    // 0) 冻结第三方挂件到当前(JS 渲染后)的真实尺寸,防剥脚本后内部摊开撑爆高度
    for (const el of Array.from(document.querySelectorAll(embedSel)) as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.height > 40 && r.height < 20000) {
        el.style.height = Math.round(r.height) + 'px';
        el.style.maxHeight = Math.round(r.height) + 'px';
        el.style.overflow = 'hidden';
      }
    }
    // 懒加载真图常藏在 data-* 属性里(lazyload / RevSlider 的 data-src-rs-ref / parallax 等),
    // 无 JS 时不会落地。下面主动把它们解析成真实 src / background-image。
    const LAZY_ATTRS = [
      'data-src', 'data-lazy-src', 'data-lazy', 'data-original', 'data-echo',
      'data-src-rs-ref', 'data-full-src', 'data-large', 'data-image', 'data-hi-res-src',
    ];
    const IMG_RE = /\.(jpe?g|png|webp|avif|gif)(\?|$)/i;
    const absify = (u: string) => (u.startsWith('//') ? 'https:' + u : u);

    // 1) 图片:懒加载兜底 + 把 currentSrc(srcset 实际选中的那张)固化到 src,去掉响应式属性
    for (const img of Array.from(document.images)) {
      const cur = img.currentSrc || img.getAttribute('src') || '';
      const isPlaceholder =
        !cur ||
        /^data:image\/(gif|svg)/i.test(cur) ||
        /(blank|placeholder|1x1|spacer|lazy|loader|transparent)\.(gif|png|svg)/i.test(cur) ||
        (img.naturalWidth <= 2 && img.naturalHeight <= 2);
      if (isPlaceholder) {
        for (const a of LAZY_ATTRS) {
          const v = img.getAttribute(a);
          if (v && IMG_RE.test(v)) {
            img.setAttribute('src', absify(v));
            break;
          }
        }
      } else {
        const chosen = img.currentSrc || img.src;
        if (chosen) img.setAttribute('src', chosen);
      }
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.removeAttribute('loading');
      img.removeAttribute('decoding');
      img.removeAttribute('crossorigin');
    }

    // 1b) 懒加载背景图:元素当前无背景图,但 data-* 里存了真图 → 落成内联 background-image
    //     (RevSlider 的 <rs-sbg data-src-rs-ref>、data-bg、视差 hero 等都靠这个救回)
    const BG_ATTRS = ['data-src-rs-ref', 'data-bg', 'data-background', 'data-background-image', 'data-bgimage', 'data-parallax-image', 'data-image-src'];
    for (const el of Array.from(document.querySelectorAll('[' + BG_ATTRS.join('],[') + ']')) as HTMLElement[]) {
      const cbg = getComputedStyle(el).backgroundImage;
      if (cbg && cbg !== 'none' && cbg.includes('url(')) continue;
      for (const a of BG_ATTRS) {
        const v = el.getAttribute(a);
        if (v && IMG_RE.test(v)) {
          el.style.backgroundImage = `url("${absify(v)}")`;
          el.style.backgroundSize = el.style.backgroundSize || 'cover';
          el.style.backgroundPosition = el.style.backgroundPosition || 'center';
          break;
        }
      }
    }
    // 2) <picture>:<source> 会覆盖我们固化的 img.src,直接删掉
    for (const src of Array.from(document.querySelectorAll('picture source'))) src.remove();
    // 3) 脚本剥离:克隆是静态快照,DOM 已是 JS 跑完的结果,不需要也不想要再执行脚本
    for (const s of Array.from(document.querySelectorAll('script'))) s.remove();
    // 4) 预加载/预取指令无意义且可能 404 噪声
    for (const l of Array.from(document.querySelectorAll('link'))) {
      const rel = (l.getAttribute('rel') || '').toLowerCase();
      if (/(preload|prefetch|modulepreload|dns-prefetch|preconnect)/.test(rel)) l.remove();
      l.removeAttribute('integrity');
      l.removeAttribute('crossorigin');
    }
  }, EMBED_SELECTOR);
}

export async function captureSite(url: string, outDir: string): Promise<CaptureMeta> {
  const notes: string[] = [];
  await rm(outDir, { recursive: true, force: true });
  const assetsDir = join(outDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  const browser = await launchBrowser(['--hide-scrollbars']);

  // 渲染时经过网络的资源体,按最终 URL 存一份,后面内联优先查这里(和浏览器真正加载的一致)。
  // seenBytes 设总量上限:资源特多的站不至于把 1.9G 内存盒吃穿(超限资源走 refetch 兜底)。
  const seen = new Map<string, Buffer>();
  const seenCt = new Map<string, string>();
  let seenBytes = 0;
  const SEEN_BUDGET = 256_000_000;
  const pending: Promise<void>[] = [];

  try {
    const ctx: BrowserContext = await browser.newContext(contextOptions());
    const page = await ctx.newPage();

    page.on('response', (resp) => {
      const rt = resp.request().resourceType();
      if (!/stylesheet|font|image|other/.test(rt)) return;
      pending.push(
        (async () => {
          try {
            if (!resp.ok()) return;
            const buf = await resp.body();
            if (buf.length > 12_000_000 || seenBytes + buf.length > SEEN_BUDGET) return;
            const u = resp.url();
            seen.set(u, buf);
            seenBytes += buf.length;
            seenCt.set(u, (resp.headers()['content-type'] || '').split(';')[0].trim());
          } catch {
            /* body 不可读(重定向/被复用),忽略,后面 refetch 兜底 */
          }
        })(),
      );
    });

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    } catch {
      notes.push('networkidle 超时,退回 domcontentloaded');
      // 双重失败必须抛出:静默吞掉会把 about:blank 空白页当"克隆成功"高分入库
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e) {
        throw new Error(`导航彻底失败(networkidle 与 domcontentloaded 均超时): ${String((e as Error)?.message || e).slice(0, 200)}`);
      }
    }
    await autoScroll(page).catch(() => notes.push('autoScroll 失败'));
    await page.waitForTimeout(800);
    await Promise.allSettled(pending);

    const finalUrl = page.url();
    const title = await page.title().catch(() => '');

    // 参考图:注入冻结样式后,截"渲染当时"的整页图。这是评分的 ground truth。
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
    // 关键:截参考图之前先冻结 JS 驱动的轮播/自动播放 + 移除 cookie 浮层,
    // 保证"参考图"与随后序列化的"克隆 DOM"是同一帧、同一状态(否则轮播会在两者之间转帧,克隆对不上)。
    const freezeMode = process.env.SF_FREEZE || 'interval';
    await page
      .evaluate((mode: string) => {
        // 冻结 JS 驱动的轮播自动播放 → 停在当前帧。注意:清 setTimeout 可能打断"一次性布局回调"
        // (某些站靠 setTimeout 应用桌面断点),故默认只清 setInterval(轮播自动播放的常用形式)。
        if (mode !== 'none') {
          const hiI = Number(setInterval(() => {}, 1e9));
          for (let i = 0; i <= hiI + 3000; i++) clearInterval(i);
          if (mode === 'all') {
            const hiT = Number(setTimeout(() => {}, 0));
            for (let i = 0; i <= hiT + 3000; i++) clearTimeout(i);
            const raf = Number(requestAnimationFrame(() => {}));
            for (let i = 0; i <= raf + 3000; i++) cancelAnimationFrame(i);
          }
        }
        // 移除 cookie / 同意 / 隐私浮层(非站点内容;无 JS 时会撑爆高度或状态不一致,如 Cookiebot 全展开)
        const JUNK =
          '#CybotCookiebotDialog,[id*="Cookiebot"],#onetrust-consent-sdk,[id*="onetrust"],' +
          '[class*="cookie-consent"],[class*="cookie-banner"],[class*="cookie-notice"],[id*="cookie-law"],' +
          '[class*="cookieConsent"],.cc-window,[aria-label*="cookie" i],#gdpr,[class*="gdpr-"]';
        document.querySelectorAll(JUNK).forEach((e) => e.remove());
      }, freezeMode)
      .catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    try {
      await page.screenshot({ path: join(outDir, 'reference.png'), fullPage: true, timeout: 40000, animations: 'disabled' });
    } catch {
      // 个别站有字体永远 load 不完 → screenshot 卡"waiting for fonts"。退回系统字体后再截,不挂整站。
      notes.push('参考图字体卡住,退回系统字体');
      await page.addStyleTag({ content: '*{font-family:Arial,Helvetica,sans-serif!important}' }).catch(() => {});
      await page.screenshot({ path: join(outDir, 'reference.png'), fullPage: true, timeout: 20000, animations: 'disabled' });
    }

    await normalizeInPage(page);
    const html = await page.content();

    // ---- 资源本地化(Node 侧,用 ctx.request 兜底重取)----
    let assetsOk = 0;
    let assetsFail = 0;
    const failedUrls: string[] = [];
    const localized = new Map<string, Promise<string | null>>(); // absUrl -> assets/xxx | null(去重,含在途)

    // 兜底重取用 Node 原生 fetch(不用 Playwright 的 ctx.request:它有个 TLS 证书解析 bug
    // —— 遇到 subject 缺失的证书会抛未捕获异常直接杀进程)。带 referer 抗热链保护。
    const fetchBuf = async (abs: string): Promise<{ buf: Buffer; ct: string } | null> => {
      const cached = seen.get(abs);
      if (cached) return { buf: cached, ct: seenCt.get(abs) || '' };
      // Node 侧重取也过 SSRF 底线:恶意源站可把内网/元数据地址当资源引用(url()/@import/img),
      // 不能让 Node fetch 替它去打私网。渲染期浏览器已加载的资源在 seen 缓存里,不受影响。
      if (urlAllowed(abs)) return null;
      try {
        const r = await fetch(abs, {
          headers: { 'user-agent': UA, referer: finalUrl, accept: '*/*' },
          signal: AbortSignal.timeout(8000),
          redirect: 'follow',
        });
        if (r.ok) {
          const buf = Buffer.from(await r.arrayBuffer());
          return { buf, ct: (r.headers.get('content-type') || '').split(';')[0].trim() };
        }
      } catch {
        /* 网络/证书错误:忽略,该资源保持原远程引用 */
      }
      return null;
    };

    const localize = (rawUrl: string, base: string): Promise<string | null> => {
      let abs: string;
      try {
        abs = new URL(rawUrl, base).href;
      } catch {
        return Promise.resolve(null);
      }
      if (abs.startsWith('data:')) return Promise.resolve(rawUrl);
      const hit = localized.get(abs);
      if (hit) return hit;
      const job = (async () => {
        const got = await fetchBuf(abs);
        if (!got || got.buf.length === 0 || got.buf.length > 12_000_000) {
          assetsFail++;
          if (process.env.SF_DEBUG) failedUrls.push(abs + (seen.has(abs) ? ' [in-seen-but-empty]' : ' [refetch-fail]'));
          return null;
        }
        const name = createHash('sha1').update(abs).digest('hex').slice(0, 16) + extFor(got.ct, abs);
        await writeFile(join(assetsDir, name), got.buf);
        assetsOk++;
        return 'assets/' + name;
      })();
      localized.set(abs, job);
      return job;
    };

    // CSS 内 url(...) 与 @import 改写(递归)。base = 该样式表自身 URL。
    const rewriteCss = async (css: string, base: string, depth = 0): Promise<string> => {
      if (depth > 4) return css;
      // @import
      const imports = [...css.matchAll(/@import\s+(?:url\()?["']?([^"')\s]+)["']?\)?[^;]*;/gi)];
      for (const im of imports) {
        const impAbs = (() => {
          try {
            return new URL(im[1], base).href;
          } catch {
            return null;
          }
        })();
        let inlined = '';
        if (impAbs) {
          // 兜底重取统一走 fetchBuf(Node fetch):ctx.request 遇 subject 缺失的证书会
          // 抛未捕获异常直接杀进程,@import 路径不能留这个雷
          const got = await fetchBuf(impAbs);
          if (got) inlined = await rewriteCss(got.buf.toString('utf8'), impAbs, depth + 1);
        }
        css = css.replace(im[0], inlined);
      }
      // url(...) — 并行取,回来再统一替换(同一 url 可能多处出现,用 split/join 全量替)
      const urls = [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
      const reps = (
        await Promise.all(
          urls.map(async (u) => {
            const ref = u[2].trim();
            if (ref.startsWith('data:') || ref.startsWith('#')) return null;
            const rel = await localize(ref, base);
            return rel ? { from: u[0], to: `url(${rel})` } : null;
          }),
        )
      ).filter((r): r is { from: string; to: string } => r !== null);
      for (const r of reps) css = css.split(r.from).join(r.to);
      return css;
    };

    const $ = load(html);

    // 1) 原有内联 <style> 改写(base = 页面 URL)。必须在"外链→内联"之前做,
    //    否则会把下面新生成的、已本地化(url(assets/...))的 <style> 又当相对路径重解析。
    await mapPool($('style').toArray(), 8, async (el) => {
      const css = $(el).html() || '';
      if (!css.includes('url(') && !css.includes('@import')) return;
      $(el).text(await rewriteCss(css, finalUrl));
    });

    // 2) 外链样式表 → 取 CSS、改写、变成内联 <style>。并行取,但按 DOM 原位替换保序(级联不变)。
    const links = $('link[rel~="stylesheet"]').toArray();
    await mapPool(links, 8, async (el) => {
      const href = $(el).attr('href');
      if (!href) return;
      let abs: string;
      try {
        abs = new URL(href, finalUrl).href;
      } catch {
        return;
      }
      const got = await fetchBuf(abs);
      if (!got) {
        assetsFail++;
        return;
      }
      const css = await rewriteCss(got.buf.toString('utf8'), abs);
      const media = $(el).attr('media');
      const style = $('<style></style>').text(css);
      if (media) style.attr('media', media);
      $(el).replaceWith(style);
    });

    // 3) <img>、favicon、其它含 url 的属性
    await mapPool($('img').toArray(), 12, async (el) => {
      $(el).removeAttr('srcset');
      const src = $(el).attr('src');
      if (!src) return;
      const rel = await localize(src, finalUrl);
      if (rel) $(el).attr('src', rel);
    });
    await mapPool(
      $('link[rel~="icon"], link[rel~="apple-touch-icon"], link[rel~="mask-icon"]').toArray(),
      6,
      async (el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const rel = await localize(href, finalUrl);
        if (rel) $(el).attr('href', rel);
      },
    );
    await mapPool($('img[data-src], [poster]').toArray(), 8, async (el) => {
      for (const attr of ['data-src', 'poster']) {
        const v = $(el).attr(attr);
        if (v) {
          const rel = await localize(v, finalUrl);
          if (rel) $(el).attr(attr, rel);
        }
      }
    });

    // 4) 内联 style="...url(...)..." 改写
    await mapPool($('[style]').toArray(), 10, async (el) => {
      const st = $(el).attr('style') || '';
      if (!st.includes('url(')) return;
      const urls = [...st.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)];
      const reps = (
        await Promise.all(
          urls.map(async (u) => {
            const ref = u[2].trim();
            if (ref.startsWith('data:')) return null;
            const rel = await localize(ref, finalUrl);
            return rel ? { from: u[0], to: `url(${rel})` } : null;
          }),
        )
      ).filter((r): r is { from: string; to: string } => r !== null);
      let out = st;
      for (const r of reps) out = out.split(r.from).join(r.to);
      if (out !== st) $(el).attr('style', out);
    });

    // 5) 删掉任何 <base>:所有资源已本地化为 assets/ 相对路径,必须相对"本地 index.html"
    //    解析。若留 <base href=远程>,file:// 下 assets/* 会被解析到远程 origin → 全部 404。
    $('base').remove();
    $('head').append(`<style>${FREEZE_CSS}</style>`);

    const finalHtml = $.html();
    await writeFile(join(outDir, 'index.html'), finalHtml, 'utf8');

    const meta: CaptureMeta = {
      url,
      finalUrl,
      title,
      fullHeight,
      viewportWidth: VIEWPORT.width,
      htmlBytes: Buffer.byteLength(finalHtml),
      assetsOk,
      assetsFail,
      notes,
    };
    await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    if (process.env.SF_DEBUG && failedUrls.length) {
      await writeFile(join(outDir, 'assets-fail.txt'), failedUrls.join('\n'), 'utf8');
    }
    return meta;
  } finally {
    await browser.close();
  }
}
