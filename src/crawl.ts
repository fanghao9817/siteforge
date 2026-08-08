import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import { captureSite, type CaptureMeta } from './capture.js';
import { assertTag } from './safe.js';

/**
 * 多页克隆:一个 URL → 抓首页 → 顺着导航抓内部页 → 把页面之间的内部链接改写成本地相对路径,
 * 产出一个"点导航能在本地跳转"的整站静态克隆。这才是"复制客户现有内容"(整站,不是一页)。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    x.search = '';
    let p = x.pathname.replace(/\/index\.(html?|php)$/i, '/');
    if (p !== '/' && p.endsWith('/')) p = p.slice(0, -1);
    return x.origin + p;
  } catch {
    return '';
  }
}

const SKIP_EXT = /\.(pdf|jpe?g|png|webp|gif|svg|zip|docx?|xlsx?|mp4|mp3|dmg|exe)$/i;

/** 从已抓下来的首页 HTML 里抽同源导航链接(去重、按文档顺序、排除文件/外链/锚点)。 */
function extractInternalLinks(html: string, baseUrl: string, homeNorm: string): string[] {
  const $ = load(html);
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  const out: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(href)) return;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).href;
    } catch {
      return;
    }
    if (new URL(abs).origin !== origin) return; // 仅同源
    if (SKIP_EXT.test(new URL(abs).pathname)) return; // 跳过文件下载
    const n = normUrl(abs);
    if (!n || n === homeNorm || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  });
  return out;
}

function slugForPath(u: string): string {
  try {
    const p = new URL(u).pathname.replace(/^\/|\/$/g, '');
    let s = p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    // 'assets' 与每页的资源目录同名:captureSite 开头 rm -rf(outDir) 会把首页 assets/ 整个删掉
    if (s === 'assets') s = 'page-assets';
    return s || 'page';
  } catch {
    return 'page';
  }
}

/** 把某个已克隆页面里的 <a href> 改写:指向"已克隆页面"→本地相对路径;其余同源→保留绝对(不死链)。 */
async function rewriteLinks(pageFile: string, pageFinalUrl: string, urlToLocal: Map<string, string>): Promise<void> {
  const html = await readFile(pageFile, 'utf8');
  const $ = load(html);
  const pageDir = dirname(pageFile);
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(href)) return;
    let abs: string;
    try {
      abs = new URL(href, pageFinalUrl).href;
    } catch {
      return;
    }
    const target = urlToLocal.get(normUrl(abs));
    if (target) {
      const rel = relative(pageDir, target) || 'index.html';
      $(el).attr('href', rel.startsWith('.') ? rel : './' + rel);
    } else {
      $(el).attr('href', abs); // 未克隆的页保留绝对链接,不做死链
    }
  });
  await writeFile(pageFile, $.html(), 'utf8');
}

export interface CrawlResult {
  home: string;
  pages: { url: string; slug: string; file: string; ok: boolean; assetsOk?: number }[];
}

export async function crawlSite(url: string, outDir: string, maxPages = 6): Promise<CrawlResult> {
  await mkdir(outDir, { recursive: true });
  // 1) 首页
  const homeMeta: CaptureMeta = await captureSite(url, outDir);
  const homeNorm = normUrl(homeMeta.finalUrl);
  const homeFile = join(outDir, 'index.html');

  // 2) 从首页抽导航
  const homeHtml = await readFile(homeFile, 'utf8');
  const links = extractInternalLinks(homeHtml, homeMeta.finalUrl, homeNorm).slice(0, maxPages);

  // 3) URL→本地文件 映射(先建全,才能跨页改写)
  const urlToLocal = new Map<string, string>();
  urlToLocal.set(homeNorm, homeFile);
  const pageMeta: { norm: string; finalUrl: string; file: string; slug: string; meta?: CaptureMeta; ok: boolean }[] = [];
  const usedSlugs = new Set<string>(['']);
  for (const l of links) {
    let slug = slugForPath(l);
    let s = slug;
    let i = 2;
    while (usedSlugs.has(s)) s = `${slug}-${i++}`;
    usedSlugs.add(s);
    const file = join(outDir, s, 'index.html');
    urlToLocal.set(l, file);
    pageMeta.push({ norm: l, finalUrl: l, file, slug: s, ok: false });
  }

  // 4) 逐页抓(串行,别把内存打满;每页独立 assets)
  for (const pm of pageMeta) {
    try {
      const m = await captureSite(pm.norm, join(outDir, pm.slug));
      pm.meta = m;
      pm.finalUrl = m.finalUrl;
      pm.ok = true;
    } catch {
      pm.ok = false;
      // 抓取失败的页必须从映射剔除:否则首页导航被改写成指向不存在文件的死链
      urlToLocal.delete(pm.norm);
    }
  }

  // 5) 跨页链接改写(含首页)
  await rewriteLinks(homeFile, homeMeta.finalUrl, urlToLocal);
  for (const pm of pageMeta) {
    if (pm.ok) await rewriteLinks(pm.file, pm.finalUrl, urlToLocal).catch(() => {});
  }

  return {
    home: homeFile,
    pages: [
      { url: homeMeta.finalUrl, slug: '(home)', file: homeFile, ok: true, assetsOk: homeMeta.assetsOk },
      ...pageMeta.map((p) => ({ url: p.norm, slug: p.slug, file: p.file, ok: p.ok, assetsOk: p.meta?.assetsOk })),
    ],
  };
}

async function main() {
  const url = process.argv[2];
  const tag = process.argv[3] || 'crawl';
  const maxPages = Number(process.argv[4] || 6);
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('用法: node dist/crawl.js <https://网址> [outTag] [maxPages]');
    process.exit(1);
  }
  assertTag(tag);
  const outDir = join(ROOT, 'runs', tag);
  console.log(`\n🕸  多页克隆 ${url} (最多 ${maxPages} 内部页) → runs/${tag}/\n`);
  const r = await crawlSite(url, outDir, maxPages);
  for (const p of r.pages) {
    console.log(`  ${p.ok ? '✅' : '❌'} ${p.slug.padEnd(20)} ${p.ok ? `assets ${p.assetsOk}` : '抓取失败'}  ${p.url}`);
  }
  console.log(`\n预览: cd runs/${tag} && python3 -m http.server 8123 → 打开 http://<IP>:8123/\n`);
}

if (process.argv[1] && process.argv[1].endsWith('crawl.js')) main().catch((e) => {
  console.error('❌ 多页克隆失败:', e?.message || e);
  process.exit(1);
});
