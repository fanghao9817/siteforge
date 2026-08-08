import type { Content } from './types.js';

const esc = (s: string) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface HeadOpts {
  /** 站点正式域名(https://example.com)。有它才能产出 canonical/og:url/绝对 og:image。 */
  baseUrl?: string;
  /** 需要从 Google Fonts 加载的字体族名(非系统字体)。查无此族时链接静默 404,无副作用。 */
  fontFamilies?: string[];
}

/** base + 相对路径 → 绝对 URL;无 base 返回空串(og/JSON-LD 里相对路径等于没写)。 */
function absUrl(base: string | undefined, rel: string): string {
  if (!base || !rel) return '';
  try {
    return new URL(rel, base.endsWith('/') ? base : base + '/').href;
  } catch {
    return '';
  }
}

/** 生成 <head> 内容:标题/描述/OG/Twitter/canonical/字体/favicon/JSON-LD(LocalBusiness)。只写真实存在的字段,不编造。 */
export function buildHead(c: Content, opts: HeadOpts = {}): string {
  // 标题:品牌名 +(短且不与品牌名重复的 tagline);tagline 是长描述时只用品牌名,避免半词截断
  const t = (c.tagline || '').trim();
  const useTag = t && t.length <= 60 && !t.toLowerCase().startsWith(c.brandName.toLowerCase());
  const title = (useTag ? `${c.brandName} — ${t}` : c.brandName).slice(0, 70);
  const desc = (c.tagline || c.about || '').slice(0, 160);
  const imgRel = c.hero || c.logo || '';
  const imgAbs = absUrl(opts.baseUrl, imgRel);
  const pageUrl = opts.baseUrl ? (opts.baseUrl.endsWith('/') ? opts.baseUrl : opts.baseUrl + '/') : '';

  // JSON-LD:只放确定字段,避免无效/编造 markup 被 Google 判罚
  const ld: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: c.brandName };
  if (desc) ld.description = desc;
  if (pageUrl) ld.url = pageUrl;
  if (c.contacts.phone) ld.telephone = c.contacts.phone;
  if (c.contacts.email) ld.email = c.contacts.email;
  if (c.contacts.address) ld.address = { '@type': 'PostalAddress', streetAddress: c.contacts.address };
  if (imgAbs) ld.image = imgAbs;
  // <script> 里嵌 JSON:转义 < 防止提前闭合
  const ldJson = JSON.stringify(ld).replace(/</g, '\\u003c');

  // 品牌 webfont:优先尝试 Google Fonts(SMB 站字体绝大多数在其上);查无此族仅浪费一个 404 请求
  const families = (opts.fontFamilies || []).filter(Boolean).slice(0, 2);
  const fontsHref = families.length
    ? `https://fonts.googleapis.com/css2?${families.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;700;800`).join('&')}&display=swap`
    : '';

  const tags = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    desc ? `<meta name="description" content="${esc(desc)}">` : '',
    pageUrl ? `<link rel="canonical" href="${esc(pageUrl)}">` : '',
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${esc(title)}">`,
    desc ? `<meta property="og:description" content="${esc(desc)}">` : '',
    pageUrl ? `<meta property="og:url" content="${esc(pageUrl)}">` : '',
    imgAbs ? `<meta property="og:image" content="${esc(imgAbs)}">` : '',
    imgAbs ? '<meta name="twitter:card" content="summary_large_image">' : '',
    fontsHref ? '<link rel="preconnect" href="https://fonts.googleapis.com">' : '',
    fontsHref ? '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' : '',
    fontsHref ? `<link rel="stylesheet" href="${esc(fontsHref)}">` : '',
    c.logo ? `<link rel="icon" href="${esc(c.logo)}">` : '',
    `<script type="application/ld+json">${ldJson}</script>`,
  ];
  return tags.filter(Boolean).join('\n');
}

/** 单页站 sitemap.xml(baseUrl 必填)。 */
export function buildSitemap(baseUrl: string, lastmodISO: string): string {
  const u = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${esc(u)}</loc><lastmod>${esc(lastmodISO.slice(0, 10))}</lastmod></url>
</urlset>
`;
}

export function buildRobots(baseUrl: string): string {
  const u = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  return `User-agent: *\nAllow: /\nDisallow: /content.json\nDisallow: /theme.json\nDisallow: /capture.json\nDisallow: /site.json\nDisallow: /leads.jsonl\n\nSitemap: ${u}sitemap.xml\n`;
}
