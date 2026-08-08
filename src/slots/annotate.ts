import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { createHash } from 'node:crypto';
import type { Slot, SlotAnchor, SlotDoc, SlotGroup, SlotRole, LinkKind } from './types.js';

/**
 * 槽位标注:把克隆 HTML 冻结成「骨架 + 槽位表」。
 *
 * 关键设计(均有实测依据):
 * 1. **不 wrap <span>**:13% 的文本处在混合内容里(`<p>电话 <a>604-x</a> 或邮件</p>`),
 *    包 span 会打破 `p > a:first-child` / `:first-of-type` 之类选择器 → 掉样式。
 *    改为按 childNode 索引寻址(`e17#2`),对 DOM 结构零改动。
 * 2. **重锚指纹用 sig+ordinal**:tag + 过滤后稳定 class + 3 级祖先签名 + 同签名序号。
 *    实测 round4→round5 两次真实独立抓取命中 99.89%;CSS 路径(nth-of-type 链)只有 ~52%,不可用。
 * 3. 标注只加属性、不动渲染树 → 桌面像素零损耗(实测 ≥0.999)。
 */

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'path', 'head', 'meta', 'link', 'title', 'br', 'hr']);

/** 过滤动态/哈希/状态类名,只留稳定的语义类名(重锚指纹要跨抓取稳定)。 */
function stableClasses(cls: string): string {
  return (cls || '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((c) => c.length <= 40)
    .filter((c) => !/^(is-|has-|active|open|show|hidden|selected|current|animated|aos-|jsx-|css-|sc-|_)/i.test(c))
    .filter((c) => !/\d{4,}/.test(c)) // elementor-element-3f8a91c 之类
    .filter((c) => !/^[a-z]+-[0-9a-f]{6,}$/i.test(c))
    .filter((c) => !/^data-v-/.test(c))
    .sort()
    .slice(0, 4)
    .join('.');
}

const shortHash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);

/** 元素签名:tag.稳定类名 */
function sigOf($: CheerioAPI, el: Element): string {
  return `${el.tagName}.${stableClasses($(el).attr('class') || '')}`;
}

/** 3 级祖先签名 */
function ancestorSig($: CheerioAPI, el: Element): string {
  const parts: string[] = [];
  let cur: any = el.parent;
  for (let i = 0; i < 3 && cur && cur.tagName; i++) {
    parts.unshift(sigOf($, cur as Element));
    cur = cur.parent;
  }
  return parts.join('>');
}

/** 判断元素落在页面的哪个区域(用于后管分组折叠) */
function groupOf($: CheerioAPI, el: Element): SlotGroup {
  const $el = $(el);
  if ($el.closest('header, [role=banner]').length) return 'header';
  if ($el.closest('footer, [role=contentinfo]').length) return 'footer';
  const cls = ($el.closest('[class]').attr('class') || '').toLowerCase();
  if (/hero|banner|masthead|jumbotron|slider/.test(cls)) return 'hero';
  return 'main';
}

// ---- 语义探测(联系信息定位不能只靠 tel: 链接:实测仅 41/60 站有) ----
const RE_PHONE = /(?<!\d)(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/;
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RE_HOURS = /(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?[^\n]{0,12}?(?:closed|\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s*[-–—to]{1,3}\s*\d{1,2})/i;
const RE_ADDR = /\b\d{1,6}\s+[A-Za-z][A-Za-z.'-]+\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|hwy|highway|lane|ln|court|ct|place|pl|unit|suite|ste)\b/i;

/** 从原值抽出分隔符模板:"(604) 555-0188" → "(NNN) NNN-NNNN"。新值按同模板重排 → 字符宽度不变、零位移。 */
function digitFormat(s: string): string | undefined {
  if (!/\d/.test(s)) return undefined;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 11) return undefined;
  return s.replace(/\d/g, 'N');
}

function detectRole(text: string, tag: string): SlotRole | undefined {
  if (RE_PHONE.test(text)) return 'phone';
  if (RE_EMAIL.test(text)) return 'email';
  if (RE_HOURS.test(text)) return 'hours';
  if (RE_ADDR.test(text)) return 'address';
  if (/^h[1-3]$/.test(tag)) return 'heading';
  return undefined;
}

function linkKindOf(href: string, sourceHost: string): LinkKind {
  const h = href.trim();
  if (!h || h === '#' || /^javascript:/i.test(h)) return 'dead';
  if (/^tel:/i.test(h)) return 'tel';
  if (/^mailto:/i.test(h)) return 'mailto';
  if (h.startsWith('#')) return 'anchor';
  if (/^https?:\/\//i.test(h)) {
    try {
      const host = new URL(h).hostname.replace(/^www\./, '');
      return host === sourceHost.replace(/^www\./, '') ? 'internal' : 'external';
    } catch {
      return 'external';
    }
  }
  return 'internal';
}

export interface AnnotateResult {
  skeleton: string;
  doc: SlotDoc;
}

export interface AnnotateInput {
  html: string;
  slug: string;
  sourceUrl: string;
  finalUrl: string;
  capturedAt: string;
}

/**
 * 把 JS 挂件塞在 <template> 里的内容提升为真实 DOM。
 *
 * 动机(实测 aplusglass.ca):Google 评论走 Trustindex,渲染后的评论 HTML 躺在
 * `<template id="trustindex-google-widget-html">` 里 —— 浏览器**不渲染** template 内容,
 * 要靠挂件的 loader.js 克隆插入,而那段 JS 被 capture 剥掉了 → 评论整块消失。
 * 提升后它变成静态内容,既能显示,又会被下面的槽位标注收进可编辑范围。
 *
 * 保守判据:只提升"有实质文本 且 父容器当前是空的"——父容器已有内容说明 JS 跑过并插入了,
 * 再提升会出现重复;交互用的小模板(<80 字)也不动。
 */
function liftWidgetTemplates($: CheerioAPI): number {
  let n = 0;
  $('template').each((_, el) => {
    const $t = $(el);
    const inner = $t.html() || '';
    if (!inner) return;
    const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 80) return; // 交互模板/占位,不是内容
    const $p = $t.parent();
    const siblingText = $p
      .contents()
      .not($t as any)
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    if (siblingText.length > 40) return; // 容器已有内容(JS 插过),不重复
    $t.replaceWith(inner);
    n++;
  });
  return n;
}

/**
 * 挂件静态化:把只有 JS 才能"点亮"的自定义元素与懒加载属性转成真实 HTML。
 *
 * 实测 Trustindex(Google 评论)有两层依赖 JS:
 *   ① 内容藏在 <template> 里(由 liftWidgetTemplates 提升)
 *   ② 图片是自定义元素 `<trustindex-image data-imgurl="...">` —— JS 才把它变成 <img>,
 *      剥了 JS 就没有星星、头像、平台图标
 * 这里处理 ②:自定义元素 → 真 <img>;顺带把常见懒加载属性落成 src。
 */
function staticizeWidgetImages($: CheerioAPI): number {
  let n = 0;
  // 形如 <trustindex-image data-imgurl> / <xxx-image data-imgurl> 的自定义元素
  $('[data-imgurl]').each((_, el) => {
    const $e = $(el);
    const src = ($e.attr('data-imgurl') || '').trim();
    if (!src || /^javascript:/i.test(src)) return;
    const img = $('<img>')
      .attr('src', src)
      .attr('alt', $e.attr('alt') || '')
      .attr('loading', 'lazy');
    const w = $e.attr('width');
    const h = $e.attr('height');
    if (w) img.attr('width', w);
    if (h) img.attr('height', h);
    const cls = $e.attr('class');
    if (cls) img.attr('class', cls);
    $e.replaceWith(img);
    n++;
  });
  return n;
}

/**
 * 轮播静态化:把各家 JS 轮播库的"轨道"转成**零 JS 的 CSS scroll-snap 轮播**。
 *
 * 为什么要做:实测 68%(41/60)的 SMB 站有轮播 —— 评价墙、作品集、合作品牌、服务卡。
 * 剥 script 后这些轨道要么塌成一列裸内容,要么卡在 translateX 的某一帧只剩半张卡。
 *
 * 为什么选 scroll-snap(而不是注入轮播 JS):
 *   · 产品是零客户端 JS 的静态站(预览 CSP 就是 script-src 'none'),不能引库
 *   · 移动端是原生手势滑动,体验比多数 JS 轮播还顺
 *   · 所有卡片都留在 DOM 里 → 对 SEO 与读屏友好(JS 轮播常把非当前帧藏起来)
 *   · 转换失败的最坏情况只是"横向可滚的列表",不会崩版
 */
const CAROUSEL_TRACKS = [
  '.ti-reviews-container-wrapper', // Trustindex(Google 评价)
  '.swiper-wrapper', // Swiper(Elementor/Wix/多数现代站)
  '.slick-track', // Slick(WordPress 老站常见)
  '.owl-stage', // Owl Carousel
  '.glide__slides', // Glide
  '.splide__list', // Splide
  '.flickity-slider', // Flickity
  '.tns-inner', // Tiny Slider
  '.elementor-swiper-wrapper', // Elementor 自带
  '.wp-block-gallery.is-type-slider', // WP 区块轮播
  '[class*="carousel-track"]',
  '[class*="slider-track"]',
  '[class*="slides-container"]',
].join(',');

/** 轮播控件/指示器:它们全靠 JS 工作,静态站里是死按钮,一律隐藏 */
const CAROUSEL_CONTROLS = [
  '.ti-controls', '.ti-next', '.ti-prev', '.ti-dots',
  '.swiper-button-next', '.swiper-button-prev', '.swiper-pagination', '.swiper-scrollbar',
  '.slick-arrow', '.slick-dots', '.slick-prev', '.slick-next',
  '.owl-nav', '.owl-dots',
  '.glide__arrows', '.glide__bullets',
  '.splide__arrows', '.splide__pagination',
  '.flickity-button', '.flickity-page-dots',
  '.tns-nav', '.tns-controls',
  '.elementor-swiper-button',
  '[class*="carousel-control"]', '[class*="slider-arrow"]', '[class*="slider-dots"]',
].join(',');

/**
 * 把命中的轨道转成 scroll-snap 轮播。
 * 关键是清掉 JS 留下的**内联定位残留**(transform/width/left/position),
 * 否则轨道会卡在被剥离那一刻的帧上。
 */
function staticizeCarousels($: CheerioAPI): number {
  let n = 0;
  $(CAROUSEL_TRACKS).each((_, el) => {
    const $track = $(el);
    if ($track.hasClass('sf-carousel')) return;
    const kids = $track.children();
    if (kids.length < 2) return; // 单张不算轮播
    $track.addClass('sf-carousel');
    // 清掉 JS 留下的内联位移/宽度(它们会把轨道钉死在某一帧)
    const clean = (v: string | undefined) =>
      (v || '')
        .replace(/(^|;)\s*(transform|width|left|top|position|transition|translate)\s*:[^;]*/gi, '')
        .replace(/^;+|;+$/g, '');
    $track.attr('style', clean($track.attr('style')) || null);
    kids.each((__, k) => {
      const $k = $(k);
      $k.addClass('sf-slide');
      $k.attr('style', clean($k.attr('style')) || null);
      // aria-hidden 是 JS 轮播用来藏非当前帧的,静态化后所有帧都可见
      $k.removeAttr('aria-hidden');
    });
    n++;
  });
  // 死控件隐藏(不删:留着 DOM 结构,避免破坏原站布局盒模型)
  $(CAROUSEL_CONTROLS).addClass('sf-dead-control');
  return n;
}

/**
 * 挂件与轮播的静态化样式(原站样式随 JS 一起被剥离时补上)。
 * 只在真的做了提升/转换时才注入,不给无挂件的站塞无用 CSS。
 */
const WIDGET_CSS = `
/* ===== SiteForge:零 JS 轮播(CSS scroll-snap) ===== */
.sf-carousel{display:flex!important;flex-wrap:nowrap!important;overflow-x:auto;overflow-y:hidden;
  scroll-snap-type:x mandatory;scroll-behavior:smooth;gap:18px;padding:4px 2px 14px;
  -webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;
  transform:none!important;width:auto!important;left:auto!important;position:static!important}
.sf-carousel{align-items:stretch}
.sf-carousel>.sf-slide{flex:0 0 auto!important;width:min(360px,84vw)!important;max-width:none!important;
  scroll-snap-align:start;transform:none!important;position:relative!important;left:auto!important;
  top:auto!important;opacity:1!important;visibility:visible!important;margin:0!important;height:auto!important}
/* 滚动条做成细提示条,暗示"可横向滑动" */
.sf-carousel{scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}
.sf-carousel::-webkit-scrollbar{height:8px}
.sf-carousel::-webkit-scrollbar-track{background:rgba(0,0,0,.05);border-radius:99px}
.sf-carousel::-webkit-scrollbar-thumb{background:rgba(0,0,0,.22);border-radius:99px}
.sf-carousel::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.35)}
/* 轮播控件全靠 JS,静态站里是死按钮 */
.sf-dead-control{display:none!important}

/* ===== 第三方评论挂件(Trustindex 等)的静态化样式 ===== */
.ti-widget{display:block;max-width:1180px;margin:0 auto;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ti-widget .ti-header-grid,.ti-widget .ti-rating-text,.ti-widget .ti-footer{text-align:center;margin-bottom:18px}
.ti-widget .ti-review-item{background:#fff;border:1px solid #e6e8eb;border-radius:12px;
  box-shadow:0 2px 10px rgba(16,24,40,.06);padding:18px;display:flex;flex-direction:column}
.ti-widget .ti-inner{display:block}
.ti-widget .ti-review-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.ti-widget .ti-profile-img img{width:40px;height:40px;border-radius:50%;object-fit:cover}
.ti-widget .ti-platform-icon img{width:20px;height:20px}
.ti-widget .ti-name{font-weight:700;font-size:15px;color:#111827}
.ti-widget .ti-date{font-size:12px;color:#6b7280}
.ti-widget .ti-stars{display:flex;gap:2px;margin:6px 0 10px}
.ti-widget .ti-stars img,.ti-widget img.ti-star{width:17px;height:17px}
.ti-widget .ti-review-content{font-size:14px;line-height:1.6;color:#374151;
  display:-webkit-box;-webkit-line-clamp:7;-webkit-box-orient:vertical;overflow:hidden}
.ti-widget .ti-tooltip,.ti-widget .ti-verified-platform,.ti-widget .ti-read-more{display:none!important}
`;

export function annotate(input: AnnotateInput): AnnotateResult {
  const { html, slug, sourceUrl, finalUrl, capturedAt } = input;
  const $ = load(html);
  // 先救回被 <template> 藏起来的挂件内容(Google 评论等),再做槽位标注
  const lifted = liftWidgetTemplates($);
  const imged = staticizeWidgetImages($);
  const carousels = staticizeCarousels($);
  if (lifted || imged || carousels) {
    // 只有真的提升了挂件才注入样式,避免给无挂件的站塞无用 CSS
    $('head').append(`<style data-sf="widget-static">${WIDGET_CSS}</style>`);
  }
  let sourceHost = '';
  try {
    sourceHost = new URL(finalUrl || sourceUrl).hostname;
  } catch {
    /* ignore */
  }

  const slots: Slot[] = [];
  // 同签名计数器 → sigOrd
  const sigCount = new Map<string, number>();
  let docOrd = 0;
  let elSeq = 0;

  const anchorFor = (el: Element, origText: string): SlotAnchor => {
    const sig = sigOf($, el);
    const anc = ancestorSig($, el);
    const key = `${sig}|${anc}`;
    const n = (sigCount.get(key) || 0) + 1;
    sigCount.set(key, n);
    return {
      tag: el.tagName,
      cls: stableClasses($(el).attr('class') || ''),
      anc,
      sigOrd: n,
      textHash: shortHash(origText.replace(/\s+/g, ' ').trim().slice(0, 120)),
      docOrd: docOrd++,
    };
  };

  // ---- 1) 文本槽位:按 childNode 索引寻址,不 wrap ----
  $('body *').each((_, node) => {
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    const $el = $(el);
    const children = $el.contents().toArray();
    let elId: string | null = null;
    children.forEach((child: any, idx: number) => {
      if (child.type !== 'text') return;
      const raw: string = child.data || '';
      const trimmed = raw.trim();
      if (trimmed.length < 2 || trimmed.length > 800) return;
      if (!/[a-zA-Z0-9一-龥]/.test(trimmed)) return; // 纯符号/空白不作槽位
      if (!elId) {
        elId = `e${elSeq++}`;
        $el.attr('data-sf-el', elId);
      }
      slots.push({
        id: `${elId}#${idx}`,
        type: 'text',
        v: trimmed,
        orig: trimmed,
        group: groupOf($, el),
        role: detectRole(trimmed, el.tagName),
        fmt: digitFormat(trimmed),
        anchor: anchorFor(el, trimmed),
      });
    });
  });

  // ---- 2) 图片槽位 ----
  $('img').each((i, node) => {
    const el = node as Element;
    const $el = $(el);
    const src = $el.attr('src') || '';
    if (!src) return;
    const id = `i${i}@src`;
    $el.attr('data-sf-el', id);
    slots.push({
      id,
      type: 'image',
      v: src,
      orig: src,
      alt: $el.attr('alt') || '',
      group: groupOf($, el),
      anchor: anchorFor(el, src),
    });
  });

  // ---- 3) 链接槽位 ----
  $('a[href]').each((i, node) => {
    const el = node as Element;
    const $el = $(el);
    const href = $el.attr('href') || '';
    const id = `a${i}@href`;
    $el.attr('data-sf-link', id);
    slots.push({
      id,
      type: 'link',
      v: href,
      orig: href,
      group: groupOf($, el),
      linkKind: linkKindOf(href, sourceHost),
      anchor: anchorFor(el, href),
    });
  });

  // ---- 4) head 槽位(title / description) ----
  const title = $('title').first().text().trim();
  if (title) {
    slots.push({
      id: 'head:title',
      type: 'head',
      v: title,
      orig: title,
      group: 'head',
      anchor: { tag: 'title', cls: '', anc: 'head', sigOrd: 1, textHash: shortHash(title), docOrd: docOrd++ },
    });
  }
  const desc = $('meta[name="description"]').attr('content') || '';
  if (desc) {
    slots.push({
      id: 'head:description',
      type: 'head',
      v: desc,
      orig: desc,
      group: 'head',
      anchor: { tag: 'meta', cls: '', anc: 'head', sigOrd: 1, textHash: shortHash(desc), docOrd: docOrd++ },
    });
  }

  return {
    skeleton: $.html(),
    doc: { v: 1, slug, sourceUrl, finalUrl, capturedAt, slots },
  };
}
