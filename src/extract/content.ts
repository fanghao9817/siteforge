import type { RawCapture, Content } from '../types.js';
import { extractContacts } from './contacts.js';

// 导航/通用词:不该被当成"服务项"
const GENERIC =
  /^(home|welcome|about|about us|our story|who we are|contact|contact us|menu|services|our services|what we do|gallery|portfolio|blog|news|faq|faqs|reviews|testimonials|login|sign in|sign up|book|book now|book online|get a quote|request a quote|free quote|search|privacy|privacy policy|terms|terms of service|cookie policy|cookies?|sitemap|careers|newsletter|subscribe|follow us|social|hours|opening hours|location|locations|find us|copyright.*|首页|关于|关于我们|联系|联系我们|服务|我们的服务|新闻|博客)$/i;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const key = (s: string) => norm(s).toLowerCase();
const squash = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

function brandFromTitle(title: string, host: string): string {
  // 标题常是 "Home - Brand" / "Brand | Tagline"。只按 | · • 与「两侧带空格的连字符」切,
  // 不再按裸连字符切(K-OAK、E-Z 这类品牌名会被拦腰砍断)。
  const segs = title
    .split(/\s*[|•·]\s*|\s+[-–—]\s+|\s*:\s+/)
    .map(norm)
    .filter(Boolean)
    .filter((s) => !/^(home|welcome|official site|official website|官网|首页)$/i.test(s));

  const hostKey = host.replace(/^www\./, '').split('.')[0]?.replace(/[^a-z0-9]/gi, '').toLowerCase() || '';
  // 1) 优先与域名相互印证的段(letters 互含):Brand 与 host 常同源
  const hostHit = segs.find((s) => {
    const q = squash(s);
    if (!q) return false;
    return (hostKey.length >= 4 && q.includes(hostKey)) || (q.length >= 4 && hostKey.includes(q));
  });
  if (hostHit && hostHit.length <= 48) return hostHit;
  // 2) 否则取文档顺序里第一段像品牌名的(标题通常品牌在前;"取最短段"会把地名/口号误当品牌)
  const first = segs.find((s) => s.length >= 2 && s.length <= 48 && !GENERIC.test(s));
  if (first) return first;
  const h = host.replace(/^www\./, '').split('.')[0];
  return h ? h.charAt(0).toUpperCase() + h.slice(1) : 'Your Business';
}

/**
 * 从渲染后的素材启发式拼一版内容(确定性,不调 LLM;LLM 精修留给下一里程碑)。
 * sections(标题→紧随段落)用于服务卡描述与 about 精准定位。
 */
export function buildContent(cap: RawCapture, host: string): Content {
  const brandName = brandFromTitle(cap.title, host);
  const tagline = (cap.description || cap.headings.find((h) => key(h) !== key(brandName)) || '').slice(0, 140);

  const sections = cap.sections || [];
  const sectionByHeading = new Map<string, string>();
  for (const s of sections) sectionByHeading.set(key(s.h), s.p);

  // about:优先"about/our story"类标题下的段落;否则最早的较长正文
  const aboutSec = sections.find((s) => /\b(about|story|who we are|mission)\b|关于/i.test(s.h));
  const about = aboutSec?.p || cap.paragraphs.find((p) => p.length > 80) || cap.paragraphs[0] || '';

  // services:取像"服务名"的标题(短、非通用、非品牌名、去重),描述用它紧随的段落
  const mainTitle = key(cap.headings[0] || '');
  const seen = new Set<string>();
  const services: { title: string; description: string }[] = [];
  for (const h of cap.headings) {
    const t = norm(h);
    const k = key(t);
    if (t.length < 2 || t.length > 48 || GENERIC.test(t) || seen.has(k)) continue;
    if (k === mainTitle || k === key(brandName)) continue; // 页面主标题/品牌名不是服务
    if (/\?$/.test(t) || /^\$|\d+\s*(?:\$|off|%)/i.test(t)) continue; // FAQ 问句/价格促销不是服务
    seen.add(k);
    services.push({ title: t, description: (sectionByHeading.get(k) || '').slice(0, 200) });
    if (services.length >= 8) break;
  }

  const contacts = extractContacts(cap.fullText, cap.html, host);

  const lang = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(cap.lang || '') ? cap.lang : undefined;

  return {
    brandName,
    tagline,
    about: about.slice(0, 600),
    services,
    contacts,
    logo: cap.logo,
    hero: cap.hero,
    sourceUrl: cap.url,
    generatedAt: new Date().toISOString(),
    ...(lang ? { lang } : {}),
  };
}
