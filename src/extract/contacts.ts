import type { Contacts } from '../types.js';

// 确定性联系信息提取。渲染后的 fullText 里,JS 注入的电话/地址/邮箱已经可见。
const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 前后设数字边界:不吞长数字串(订单号/年份序列)的中段
const RE_PHONE = /(?<!\d)(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/;
const RE_POSTAL_CA = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ \t]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;
// 美国:州缩写 + zip 联合锚定(单独 5 位数误报太高)
const RE_ZIP_US = /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)[,.]?\s+\d{5}(?:-\d{4})?\b/;
// 营业时间:星期(可含 -Fri 区间与 closed) + 起止时刻对(支持 9:00 / 9.00 / 9am / 9 pm)。
// 匹配到"闭店时刻"即收尾,不会贪婪吞进下一天;全局收集多行。
const RE_HOURS =
  /(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?(?:\s*[-–—]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?)?[^\n]{0,12}?(?:closed|\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\s*[-–—to]{1,3}\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/gi;
const EMAIL_NOISE = /(sentry|wixpress|example\.|godaddy|\.png|\.jpg|your@|email@|@2x|@sentry|domain\.com)/i;

export function extractContacts(text: string, html: string, host: string): Contacts {
  const out: Contacts = { phone: '', email: '', address: '', hours: '' };
  const hostKey = host.replace(/^www\./, '').split('.')[0]?.toLowerCase() || '';

  // 邮箱:排噪声,优先同域
  const emails = [...`${html}\n${text}`.matchAll(RE_EMAIL)].map((m) => m[0]).filter((e) => !EMAIL_NOISE.test(e));
  if (emails.length) {
    const same = emails.find((e) => hostKey && e.toLowerCase().includes(hostKey));
    out.email = same || emails[0];
  }

  // 电话:优先 tel: 链接,再退到正文正则
  const tel = html.match(/tel:\+?([0-9\-.\s()]{7,})/i);
  if (tel) {
    const d = tel[1].replace(/\D/g, '');
    if (d.length >= 10 && d.length <= 11) {
      const t = d.slice(-10);
      out.phone = `${t.slice(0, 3)}-${t.slice(3, 6)}-${t.slice(6)}`;
    }
  }
  if (!out.phone) {
    const m = text.match(RE_PHONE);
    if (m) out.phone = m[0].trim();
  }

  // 地址:邮编锚定(加拿大邮编 或 美国州+zip),向前开窗;
  // 先从窗口剔除邮箱/电话碎片,再取"离锚点最近的街号+街名"起点——避免电话尾数冒充街号。
  const pm = text.match(RE_POSTAL_CA) || text.match(RE_ZIP_US);
  if (pm && pm.index !== undefined) {
    let win = text.slice(Math.max(0, pm.index - 100), pm.index + pm[0].length).replace(/\s+/g, ' ').trim();
    win = win.replace(RE_EMAIL, ' ').replace(/(?:e-?mail|email|phone|tel|fax)\s*:?/gi, ' ');
    win = win.replace(new RegExp(RE_PHONE.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
    const starts = [...win.matchAll(/\b\d{1,6}\s+[A-Za-z][A-Za-z.'-]+/g)];
    const sm = starts.length ? starts[starts.length - 1] : null;
    // 取最后一个街号起点(离邮编最近);但若它把窗口切得太短(<15 字),退回整个清理后的窗口
    const cand = sm && sm.index !== undefined ? win.slice(sm.index) : win;
    out.address = (cand.length >= 15 ? cand : win).slice(0, 120).replace(/^[\s,;|·]+|[\s,;|·]+$/g, '');
  }

  // 营业时间:全局收集(最多 4 行拼接),覆盖"每天一行"的时间表
  const hm = [...text.matchAll(RE_HOURS)].map((m) => m[0].replace(/\s+/g, ' ').trim());
  if (hm.length) {
    const uniq = [...new Set(hm)].slice(0, 4);
    out.hours = uniq.join(' · ').slice(0, 160);
  }

  return out;
}
