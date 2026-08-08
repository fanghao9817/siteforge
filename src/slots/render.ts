import { load, type CheerioAPI } from 'cheerio';
import type { Slot, SlotDoc, SlotRenderOpts } from './types.js';

/**
 * renderSlots():与 forge 轨 renderPage(content, theme) 对称的纯函数。
 * 骨架 + 槽位值 → 可发布的 index.html。后管每次保存即调用,秒级重渲染。
 *
 * 顺序:回填槽位 → 后处理管线(链接/表单/iframe/模态/head/移动导航)。
 * 每个后处理器可独立开关,便于定位问题。
 */

// ---------- 安全:拒绝危险协议(而非前缀白名单) ----------
// 注意:克隆件里的资源引用是**裸相对路径**(assets/ab12cd.webp),前缀白名单会把它们全判死 →
// 图片失效 → 布局塌缩。所以只拒危险协议,其余(含裸相对路径)放行。
const DANGEROUS = /^\s*(javascript|vbscript|file|about|blob)\s*:/i;
const safeUrl = (u: string): string => {
  const t = (u || '').trim();
  if (!t) return '';
  if (DANGEROUS.test(t)) return '#';
  // data: 只允许图片
  if (/^\s*data:/i.test(t) && !/^\s*data:image\//i.test(t)) return '#';
  return t;
};

const esc = (s: string) =>
  String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 按原值的分隔符模板重排新值:"(NNN) NNN-NNNN" + "6045550188" → "(604) 555-0188"。
 *  字符宽度不变 → 零换行零位移(克隆骨架里容器高度是固定的)。 */
function applyFormat(fmt: string | undefined, value: string): string {
  if (!fmt) return value;
  const digits = value.replace(/\D/g, '');
  const need = (fmt.match(/N/g) || []).length;
  if (digits.length !== need) return value; // 位数不符就原样用,不强行套
  let i = 0;
  return fmt.replace(/N/g, () => digits[i++]);
}

// ---------- 1) 槽位回填 ----------
function backfill($: CheerioAPI, slots: Slot[]): number {
  let applied = 0;
  for (const s of slots) {
    if (s.type === 'text') {
      const m = s.id.match(/^(e\d+)#(\d+)$/);
      if (!m) continue;
      const $el = $(`[data-sf-el="${m[1]}"]`);
      if (!$el.length) continue;
      const idx = Number(m[2]);
      const node: any = $el.contents().toArray()[idx];
      if (!node || node.type !== 'text') continue;
      const raw: string = node.data || '';
      // 保留原有前后空白:inline 布局靠它维持词间空格
      const lead = raw.match(/^\s*/)?.[0] ?? '';
      const trail = raw.match(/\s*$/)?.[0] ?? '';
      node.data = lead + applyFormat(s.fmt, s.v) + trail;
      applied++;
    } else if (s.type === 'image') {
      const $el = $(`[data-sf-el="${s.id}"]`);
      if (!$el.length) continue;
      $el.attr('src', safeUrl(s.v));
      if (s.alt !== undefined) $el.attr('alt', s.alt);
      applied++;
    } else if (s.type === 'link') {
      const $el = $(`[data-sf-link="${s.id}"]`);
      if (!$el.length) continue;
      $el.attr('href', safeUrl(s.v));
      applied++;
    } else if (s.type === 'head') {
      if (s.id === 'head:title') {
        if ($('title').length) $('title').first().text(s.v);
        else $('head').prepend(`<title>${esc(s.v)}</title>`);
      } else if (s.id === 'head:description') {
        if ($('meta[name="description"]').length) $('meta[name="description"]').attr('content', s.v);
        else $('head').append(`<meta name="description" content="${esc(s.v)}">`);
      }
      applied++;
    }
  }
  return applied;
}

// ---------- 2) 链接改写:防跳回旧站 ----------
/** 实测 2696 条绝对 <a> 泄回旧域 —— 客户点导航会离开新站。
 *  同源绝对链接 → 根相对(复刻站最终跑在客户同域,保住内链结构);外链加 rel=noopener。 */
function fixLinks($: CheerioAPI, sourceHost?: string): number {
  if (!sourceHost) return 0;
  const bare = sourceHost.replace(/^www\./, '');
  let n = 0;
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') || '').trim();
    if (/^https?:\/\//i.test(href)) {
      try {
        const u = new URL(href);
        if (u.hostname.replace(/^www\./, '') === bare) {
          $a.attr('href', u.pathname + u.search + u.hash || '/');
          n++;
        } else {
          const rel = ($a.attr('rel') || '').split(/\s+/).filter(Boolean);
          if (!rel.includes('noopener')) $a.attr('rel', [...rel, 'noopener'].join(' '));
        }
      } catch {
        /* ignore */
      }
    } else if (/^javascript:/i.test(href) || href === '') {
      $a.removeAttr('href');
      n++;
    }
  });
  return n;
}

// ---------- 3) 表单接管 ----------
/** 实测 61 个 form:19 无 action(提交自身,静态托管必死)、17 绝对(**把客户询盘连同访客 PII 发回原站主机**)。
 *  全部改写到我们的询盘端点;字段名映射到语义名,原 name 保留在 data-sf-orig-name(防属性选择器丢样式)。 */
const FIELD_MAP: [RegExp, string][] = [
  [/name|fname|full[-_]?name|your[-_]?name|nombre/i, 'name'],
  [/phone|tel|mobile|contact[-_]?number/i, 'phone'],
  [/e-?mail/i, 'email'],
  [/message|comment|enquiry|inquiry|details|question/i, 'message'],
];

function adoptForms($: CheerioAPI, formAction: string): number {
  let n = 0;
  $('form').each((_, el) => {
    const $f = $(el);
    // 搜索表单在静态站上是死按钮,直接移除
    const isSearch =
      $f.find('input[type=search]').length > 0 ||
      /search/i.test($f.attr('class') || '') ||
      /search/i.test($f.attr('id') || '') ||
      ($f.find('input,textarea,select').length <= 1 && /search/i.test($f.html() || ''));
    if (isSearch) {
      $f.remove();
      return;
    }
    $f.attr('action', formAction).attr('method', 'post');
    $f.removeAttr('onsubmit').removeAttr('data-action');
    // 蜜罐(与后管 /api/leads 的 _hp 约定一致)
    if (!$f.find('input[name="_hp"]').length) {
      $f.prepend('<input type="text" name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute!important;left:-9999px!important;width:1px;height:1px;opacity:0">');
    }
    $f.find('input, textarea, select').each((__, f) => {
      const $i = $(f);
      const type = ($i.attr('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return;
      const orig = $i.attr('name') || '';
      const hint = `${orig} ${$i.attr('id') || ''} ${$i.attr('placeholder') || ''} ${$i.attr('aria-label') || ''}`;
      const hit = FIELD_MAP.find(([re]) => re.test(hint));
      if (hit) {
        if (orig) $i.attr('data-sf-orig-name', orig);
        $i.attr('name', hit[1]);
      } else if (!orig) {
        $i.attr('name', type === 'email' ? 'email' : 'message');
      }
    });
    n++;
  });
  return n;
}

// ---------- 4) iframe 三分 ----------
/** 实测 73 个远程 iframe:16 地图 + 6 视频(该静态化)、5 追踪(该杀)、
 *  **11 个是客户还在正常工作的预约入口**(OpenTable/Mangomint/CareCru/Jobber)——一刀切会关掉转化漏斗。 */
const IFRAME_TRACKER = /doubleclick|googletagmanager|google-analytics|facebook\.com\/tr|addtoany|cookiebot|hotjar|clarity\.ms/i;
const IFRAME_BOOKING = /opentable|mangomint|carecru|jobber|wishpond|calendly|acuityscheduling|square(up)?\.site|resy|sevenrooms|booksy|vagaro|setmore|simplybook|schedulicity/i;
const IFRAME_MAP = /google\.com\/maps|maps\.google|openstreetmap|mapbox/i;
const IFRAME_VIDEO = /youtube|youtu\.be|vimeo|wistia|dailymotion/i;

function triageIframes($: CheerioAPI, staticize: boolean): { kept: number; removed: number; placeheld: number } {
  let kept = 0;
  let removed = 0;
  let placeheld = 0;
  $('iframe').each((_, el) => {
    const $f = $(el);
    const src = $f.attr('src') || $f.attr('data-src') || '';
    if (!src) return;
    if (IFRAME_TRACKER.test(src)) {
      // 追踪像素/标签管理器:无视觉、纯隐私负担,必杀
      $f.remove();
      removed++;
      return;
    }
    if (IFRAME_BOOKING.test(src)) {
      // 功能性预约入口:iframe 不是 script,剥 script 没打死它们 —— 必须保留
      kept++;
      return;
    }
    // 地图/视频:实测它们剥 script 后**仍然正常工作**,静态化会损失保真(占位 div 与 iframe
    // 有基线间隙差)与功能。复刻优先 → 默认保留;需要极致隐私时用 staticizeEmbeds 开启。
    if (staticize && (IFRAME_MAP.test(src) || IFRAME_VIDEO.test(src))) {
      const w = $f.attr('width') || '100%';
      const h = $f.attr('height') || '360';
      const isMap = IFRAME_MAP.test(src);
      const label = isMap ? '在地图中查看' : '播放视频';
      $f.replaceWith(
        `<div class="sf-embed-ph" style="width:${esc(String(w))};height:${esc(String(h))}px;max-width:100%;vertical-align:bottom;display:flex;align-items:center;justify-content:center;background:#eef0f3;border-radius:10px;border:1px solid #dfe3e8">` +
          `<a href="${esc(safeUrl(src))}" target="_blank" rel="noopener" style="font:600 15px system-ui,sans-serif;color:#2563eb;text-decoration:none">${label} ↗</a></div>`,
      );
      placeheld++;
      return;
    }
    kept++;
  });
  return { kept, removed, placeheld };
}

// ---------- 5) 清除关不掉的全屏模态 ----------
/** 实测 6/60 站的克隆挂着关不掉的全屏推广弹窗(剥 script 后关闭按钮失效)——第一印象最致命的失真。 */
function killModals($: CheerioAPI): number {
  // 选择器必须窄:`[class*="popup"]` 之类会命中 `widget-popup` 这种**正常内容区块**
  // (实测某个基准站点因此被删掉整块内容)。只处理"真·全屏遮罩":
  // 内联 style 明确写了 position:fixed + 铺满视口/高 z-index,才认定是关不掉的弹窗。
  const CANDIDATE =
    '[class*="modal"],[class*="popup"],[class*="lightbox"],[id*="modal"],[id*="popup"],' +
    '[class*="newsletter-pop"],[class*="exit-intent"],[role="dialog"],[aria-modal="true"]';
  let n = 0;
  $(CANDIDATE).each((_, el) => {
    const $m = $(el);
    if ($m.closest('.sf-nav').length) return;
    const style = ($m.attr('style') || '').toLowerCase().replace(/\s+/g, '');
    const cls = ($m.attr('class') || '').toLowerCase();

    // 显式隐藏的不动(它本来就不显示,删了反而可能影响脚本外的样式计算)
    if (/display:none|visibility:hidden/.test(style) || /\bhidden\b|\bis-closed\b|\bmodal-hidden\b/.test(cls)) return;

    // 判定"真·全屏遮罩":必须内联写死 position:fixed(克隆件已剥 JS,只有内联样式可信)
    const isFixed = /position:fixed/.test(style);
    if (!isFixed) return;
    // 且需覆盖视口:四边贴边 或 宽高 100% 或 极高 z-index
    const coversViewport =
      /(^|;)(top:0|left:0|right:0|bottom:0|inset:0)/.test(style) ||
      /width:100(vw|%)/.test(style) ||
      /height:100(vh|%)/.test(style);
    const zIndex = Number((style.match(/z-index:(\d+)/) || [])[1] || 0);
    if (!coversViewport && zIndex < 1000) return;
    // aria-modal / role=dialog 是强信号,其余要求 class 里确有 modal/popup 语义
    const strong = $m.attr('aria-modal') === 'true' || $m.attr('role') === 'dialog';
    if (!strong && !/modal|popup|lightbox|newsletter|exit-intent/.test(cls)) return;

    $m.remove();
    n++;
  });
  return n;
}

// ---------- 6) head 修复(SEO 遗留) ----------
/** 实测:JSON-LD 0/60(剥 script 时被一并删光)、canonical 指旧域 51/60、og:url 44/60。 */
function patchHead($: CheerioAPI, slots: Slot[], opts: SlotRenderOpts): void {
  const $head = $('head');
  $('link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"], meta[name="generator"]').remove();

  const byRole = (r: string) => slots.find((s) => s.role === r)?.v || '';
  const title = slots.find((s) => s.id === 'head:title')?.v || $('title').first().text().trim();
  const desc = slots.find((s) => s.id === 'head:description')?.v || '';
  const brand = byRole('brand') || title.split(/[|\-–—]/)[0].trim();

  const base = (opts.baseUrl || '').replace(/\/+$/, '');
  const pageUrl = base ? base + '/' : '';

  if (pageUrl) {
    $head.append(`<link rel="canonical" href="${esc(pageUrl)}">`);
    $head.append(`<meta property="og:url" content="${esc(pageUrl)}">`);
  }
  $head.append('<meta property="og:type" content="website">');
  if (title) $head.append(`<meta property="og:title" content="${esc(title)}">`);
  if (desc) $head.append(`<meta property="og:description" content="${esc(desc)}">`);

  // 未签约/旧站未下线 → noindex,防与客户旧站构成重复内容互相稀释
  if (opts.indexable !== true) {
    $('meta[name="robots"]').remove();
    $head.append('<meta name="robots" content="noindex,nofollow">');
  }

  // 重新注入 LocalBusiness JSON-LD(原站的被剥 script 时删光了,这是纯增值)
  const ld: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'LocalBusiness', name: brand || title };
  if (desc) ld.description = desc.slice(0, 300);
  if (pageUrl) ld.url = pageUrl;
  const phone = byRole('phone');
  const email = byRole('email');
  const address = byRole('address');
  const hours = byRole('hours');
  if (phone) ld.telephone = phone;
  if (email) ld.email = email;
  if (address) ld.address = { '@type': 'PostalAddress', streetAddress: address };
  if (hours) ld.openingHours = hours;
  $head.append(`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`);

  // viewport 必须有(移动端修复的前提)
  if (!$('meta[name="viewport"]').length) {
    $head.prepend('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
}

// ---------- 7) 零 JS 移动导航 + 移动端溢出兜底 ----------
/** 实测 21/60 站移动端不可用:12 站横向溢出(Wix 类靠 JS 做响应式,剥 script 后媒体查询为 0)、
 *  9 站汉堡点不开。原站菜单结构高度异质(仅 32% 可识别),不还原、改为注入我们自己的零 JS 等价物。
 *  桌面端完全不渲染 → 桌面像素零影响(硬断言)。 */
function injectMobileNav($: CheerioAPI, primary: string): number {
  const seen = new Set<string>();
  const links: { href: string; text: string }[] = [];
  const collect = (sel: string) =>
    $(sel).each((_, el) => {
      const $a = $(el);
      const href = ($a.attr('href') || '').trim();
      const text = $a.text().replace(/\s+/g, ' ').trim();
      if (!href || !text || text.length > 28) return;
      if (/^(javascript:|tel:|mailto:|#$)/i.test(href)) return;
      if (/^[\d\s()+.-]+$/.test(text) || /@/.test(text)) return; // 电话/邮箱不是导航项
      const k = text.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      links.push({ href, text });
    });
  collect('nav a[href]');
  if (links.length < 3) collect('header a[href]');
  const nav = links.slice(0, 8);
  if (!nav.length) return 0;

  // 隐藏原站那个点不动的死开关;:not() 排除我们自己(否则 aria-label*=menu 会误伤自身)
  const DEAD = [
    '[class*="hamburger"]', '[class*="menu-toggle"]', '[class*="nav-toggle"]',
    '[class*="navbar-toggle"]', '[class*="burger"]', '[class*="menu-btn"]',
    '[aria-label*="menu" i]',
  ]
    .map((s) => `${s}:not(.sf-nav):not(.sf-nav *)`)
    .join(',');

  const css = `
@media (max-width:820px){
  ${DEAD}{display:none!important}
  /* 真修复:超宽媒体元素约束到视口内(它们能自适应缩放,不丢内容) */
  img,video,table,iframe,embed,object{max-width:100%!important;height:auto!important}
  /* 刻意不做全局横向裁剪兜底:实测那只是把溢出内容藏起来(文字右半截用户根本看不到),
     还会骗过移动端闸门让坏站通过。靠 JS 做响应式的站(Wix 类,@media max-width 规则数=0)
     没有移动版 DOM,CSS 救不回来,应由闸门拦下并路由到 forge 轨。 */
  .sf-nav{display:block!important;position:fixed;top:10px;right:10px;z-index:2147483000;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .sf-nav>summary{list-style:none;cursor:pointer;width:46px;height:46px;border-radius:10px;background:${primary};color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1;box-shadow:0 4px 14px rgba(0,0,0,.25);user-select:none}
  .sf-nav>summary::-webkit-details-marker{display:none}
  .sf-nav[open]>summary{background:#111}
  .sf-nav[open]>div{position:fixed;top:66px;right:10px;left:10px;background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.3);padding:10px;display:grid;gap:2px;max-height:72vh;overflow:auto}
  .sf-nav[open]>div a{display:block;padding:14px 16px;text-decoration:none;color:#111827;font-size:17px;font-weight:600;border-radius:10px;border-bottom:1px solid #f1f2f4}
  .sf-nav[open]>div a:last-child{border-bottom:none}
}
@media (min-width:821px){.sf-nav{display:none!important}}
`;
  $('head').append(`<style data-sf="mobile-nav">${css}</style>`);
  $('body').prepend(
    `<details class="sf-nav"><summary aria-label="Menu">☰</summary><div>` +
      nav.map((l) => `<a href="${esc(safeUrl(l.href))}">${esc(l.text)}</a>`).join('') +
      `</div></details>`,
  );
  return nav.length;
}

// ---------- 主函数 ----------

export interface RenderStats {
  slotsApplied: number;
  linksFixed: number;
  formsAdopted: number;
  iframes: { kept: number; removed: number; placeheld: number };
  modalsRemoved: number;
  navLinks: number;
}

export function renderSlots(skeleton: string, doc: SlotDoc, opts: SlotRenderOpts = {}): { html: string; stats: RenderStats } {
  const $ = load(skeleton);

  const slotsApplied = backfill($, doc.slots);

  let sourceHost = opts.sourceHost;
  if (!sourceHost) {
    try {
      sourceHost = new URL(doc.finalUrl || doc.sourceUrl).hostname;
    } catch {
      /* ignore */
    }
  }
  const st = opts.steps || {};
  const on = (k: keyof NonNullable<SlotRenderOpts['steps']>) => st[k] !== false;

  const linksFixed = on('links') ? fixLinks($, sourceHost) : 0;
  const formsAdopted = on('forms') && opts.formAction ? adoptForms($, opts.formAction) : 0;
  const iframes = on('iframes') ? triageIframes($, opts.staticizeEmbeds === true) : { kept: 0, removed: 0, placeheld: 0 };
  const modalsRemoved = on('modals') ? killModals($) : 0;
  if (on('head')) patchHead($, doc.slots, opts);
  const navLinks = opts.mobileNav === true ? injectMobileNav($, opts.primaryColor || '#111827') : 0;

  return {
    html: $.html(),
    stats: { slotsApplied, linksFixed, formsAdopted, iframes, modalsRemoved, navLinks },
  };
}
