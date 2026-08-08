import { load } from 'cheerio';
import type { GateResult } from '../slots/types.js';

/**
 * 捕获闸门:拦住"抓取失败却拿高分"的灾难交付。
 *
 * 实测动机:round5 里某个基准站点的捕获是一个 2157 字节的 Cloudflare
 * "Checking your browser..." 挑战页 —— 0 个资源、0 张图、参考图高 900px,
 * 但因为"克隆件与参考图都是同一张白屏"而拿到 score 1.0000 并计入 captured 60/60。
 * 把这种页面配上指向客户新域的 canonical 发出去是不可逆事故。
 *
 * 判据全是纯文本统计,零成本。
 */

const BLOCK_TITLE =
  /checking your browser|just a moment|attention required|access denied|captcha|403 forbidden|are you a human|verify you are human|请稍候|安全检查/i;

const BLOCK_BODY =
  /enable javascript to continue|ddos protection by|cloudflare ray id|performance & security by cloudflare|请开启 ?javascript/i;

export interface GateInput {
  html: string;
  assetsOk?: number;
  refHeight?: number;
}

export function gateCapture(input: GateInput): GateResult {
  const { html, assetsOk = 0, refHeight = 0 } = input;
  const $ = load(html);
  const title = ($('title').first().text() || '').trim().slice(0, 120);

  // 可见文字:去掉脚本/样式/隐藏内容后的正文量
  $('script, style, noscript, template').remove();
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim();
  const visibleTextLen = visibleText.length;

  const imgCount = $('img').length;
  let bgImageCount = $('[style*="url("]').length;
  $('style').each(() => {}); // style 已被移除,背景图统计走原始 html
  bgImageCount += (html.match(/background(?:-image)?\s*:[^;}]*url\(/gi) || []).length;

  const stats = { visibleTextLen, imgCount, bgImageCount, assetsOk, title };

  // 判据(任一命中即判失败)
  if (BLOCK_TITLE.test(title)) {
    return { ok: false, reason: `疑似拦截/挑战页(标题:「${title}」)`, stats };
  }
  if (BLOCK_BODY.test(visibleText.slice(0, 3000))) {
    return { ok: false, reason: '正文命中人机验证/DDoS 防护特征', stats };
  }
  // 阈值 250:实测真拦截页仅 57 字,而最小的正常 SMB 站有 598 字 —— 留足余量不误伤小站。
  // 拦截页主要靠 title/正文特征词判据兜住,不依赖字数。
  if (visibleTextLen < 250) {
    return { ok: false, reason: `可见文字仅 ${visibleTextLen} 字(阈值 250),疑似空白页或抓取失败`, stats };
  }
  if (assetsOk === 0) {
    return { ok: false, reason: '未落地任何资源(assetsOk=0),疑似抓取失败', stats };
  }
  if (imgCount === 0 && bgImageCount === 0) {
    return { ok: false, reason: '页面无任何图片与背景图,疑似空壳页', stats };
  }
  if (refHeight > 0 && refHeight < 1200) {
    return { ok: false, reason: `参考图高度仅 ${refHeight}px(阈值 1200),疑似未渲染完整`, stats };
  }

  return { ok: true, stats };
}
