import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite } from './render.js';
import { buildTheme } from './extract/brand.js';
import { buildContent } from './extract/content.js';
import { renderPage } from './ssg.js';
import { assertSlug, urlAllowed } from './safe.js';
import { UA } from './browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 产物写进 sites/<slug>/:index.html(静态站)+ content/theme.json(数据/调试)+ assets/
const SITES_ROOT = join(__dirname, '..', 'sites');

function slugify(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  } catch {
    return 'site';
  }
}

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/** 把客户站的图(logo/hero)搬到产物目录,返回相对路径;失败返回 null(模板有兜底)。 */
async function grabImage(srcUrl: string | null, dir: string, kind: string, referer: string): Promise<string | null> {
  if (!srcUrl) return null;
  if (!/^https?:\/\//.test(srcUrl)) return null; // data:/blob:/file: 一律不搬
  try {
    // 带真实 UA + referer:CDN 热链保护下裸 fetch 会 403,图静默丢失
    const res = await fetch(srcUrl, {
      headers: { 'user-agent': UA, referer, accept: 'image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ext = EXT[ct];
    if (!ext) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 256 || buf.length > 8_000_000) return null;
    const file = `${kind}${ext}`;
    await writeFile(join(dir, file), buf);
    return `assets/${file}`;
  } catch {
    return null;
  }
}

async function main() {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('用法: npm run forge -- <https://网址> [slug]');
    process.exit(1);
  }
  const urlErr = urlAllowed(url);
  if (urlErr) {
    console.error(`❌ URL 被拒:${urlErr}(开发环境可设 SF_ALLOW_PRIVATE=1 放行内网)`);
    process.exit(1);
  }
  const slug = assertSlug(process.argv[3] || slugify(url));
  const dir = join(SITES_ROOT, slug);
  const assets = join(dir, 'assets');
  await mkdir(assets, { recursive: true });

  const host = new URL(url).hostname;
  console.log(`\n🔭 渲染 ${url} …(无头浏览器,JS 已执行)`);
  const cap = await renderSite(url);

  const theme = buildTheme(cap);
  const content = buildContent(cap, host);

  console.log('🎨 搬运品牌图…');
  content.logo = await grabImage(content.logo, assets, 'logo', cap.finalUrl);
  content.hero = await grabImage(content.hero, assets, 'hero', cap.finalUrl);

  // 核心:生成静态 HTML(内容烤进 body + SEO head + JSON-LD + 内联样式)
  const html = renderPage(content, theme);
  await writeFile(join(dir, 'index.html'), html, 'utf-8');
  await writeFile(join(dir, 'content.json'), JSON.stringify(content, null, 2), 'utf-8');
  await writeFile(join(dir, 'theme.json'), JSON.stringify(theme, null, 2), 'utf-8');
  await writeFile(join(dir, 'capture.json'), JSON.stringify({ ...cap, html: undefined }, null, 2), 'utf-8');

  // 爬虫视角自检:静态 HTML 去标签后的可见文字量(SSG 应有几千字,SPA 只有几百)
  const visibleText = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  console.log(`\n✅ 完成 → sites/${slug}/index.html (静态站)`);
  console.log('  品牌套色:');
  console.log(`    primary ${theme.colors.primary} · bg ${theme.colors.bg} · text ${theme.colors.text}`);
  console.log(`    字体 标题=${theme.fonts.heading.split(',')[0]} 正文=${theme.fonts.body.split(',')[0]}`);
  console.log('  内容:');
  console.log(`    品牌名 ${content.brandName}`);
  console.log(`    服务 ${content.services.length} 项: ${content.services.map((s) => s.title).join(', ') || '(无)'}`);
  console.log(`    联系 地址${content.contacts.address ? '✓' : '✗'} 电话${content.contacts.phone ? '✓' : '✗'} 邮箱${content.contacts.email ? '✓' : '✗'}`);
  console.log(`    logo ${content.logo ? '✓' : '✗'} · hero ${content.hero ? '✓' : '✗'}`);
  console.log(`  📄 SEO 自检:静态 HTML 可见文字 ${visibleText.length} 字 · JSON-LD ${html.includes('application/ld+json') ? '✓' : '✗'} · <h1> ${/<h1/.test(html) ? '✓' : '✗'}`);
  console.log(`\n👉 管理与预览: npm run admin → http://<机器IP>:5179/#/site/${slug}\n`);
}

main().catch((e) => {
  console.error('❌ 失败:', e?.message || e);
  process.exit(1);
});
