import type { RawCapture, Theme, RGB, ColorStat } from '../types.js';

// ---- 颜色工具 ----
const hex = ([r, g, b]: RGB) =>
  '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');

/** 简易亮度 0(黑)~1(白)(排序/粗分类用)。 */
function luminance([r, g, b]: RGB): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** WCAG 相对亮度(sRGB 线性化,对比度计算用)。 */
function relLum([r, g, b]: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度 1~21。 */
function contrast(a: RGB, b: RGB): number {
  const l1 = relLum(a);
  const l2 = relLum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** 饱和度 0~1(HSL 口径)。灰/黑/白 ≈ 0,鲜艳色 → 高。 */
function saturation([r, g, b]: RGB): number {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  if (mx === mn) return 0;
  const l = (mx + mn) / 2;
  return l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
const darken = (c: RGB, t = 0.15): RGB => mix(c, [0, 0, 0], t);
const lighten = (c: RGB, t = 0.15): RGB => mix(c, [255, 255, 255], t);

/** 把 fg 朝 target 推,直到与 bg 对比度达标(或推满)。 */
function ensureContrast(fg: RGB, bg: RGB, target: RGB, min: number): RGB {
  let out = fg;
  for (let t = 0; t <= 1.001 && contrast(out, bg) < min; t += 0.08) {
    out = mix(fg, target, t);
  }
  return out;
}

/** 在某背景上挑黑字还是白字:按真实对比度取高者。 */
function onColor(bg: RGB): string {
  const dark: RGB = [22, 24, 29];
  const light: RGB = [255, 255, 255];
  return contrast(light, bg) >= contrast(dark, bg) ? '#ffffff' : '#16181d';
}

/**
 * 从抓到的色板推导品牌套色 token。
 * 主色 = 强调色里"够鲜艳、不太亮不太暗、权重高"者;低饱和(黑白灰)品牌回退中亮度高权重强调色,不再硬套蓝。
 * 深色站(主背景亮度<0.35)保持深色主题;正文/次要文字强制满足 WCAG 对比度(正文≥4.5,次要≥3)。
 */
export function buildTheme(cap: RawCapture): Theme {
  const score = (s: ColorStat) => {
    const sat = saturation(s.c);
    const lum = luminance(s.c);
    // 鲜艳优先,排掉接近黑/白的;权重开根号压制超大面积块的统治
    const midness = 1 - Math.abs(lum - 0.5) * 1.4;
    return sat * Math.max(0.05, midness) * Math.sqrt(Math.max(1, s.w));
  };

  const accentRanked = [...cap.accents].filter((s) => saturation(s.c) > 0.18).sort((a, b) => score(b) - score(a));
  const bgRanked = [...cap.backgrounds].sort((a, b) => b.w - a.w);

  // 主色候选链:最佳鲜艳强调色 → 黑白灰品牌:中亮度高权重强调色 → 够艳的背景 → 稳重蓝
  const monoAccent = [...cap.accents]
    .filter((s) => {
      const l = luminance(s.c);
      return l > 0.12 && l < 0.72;
    })
    .sort((a, b) => b.w - a.w)[0]?.c;
  const primary: RGB =
    accentRanked[0]?.c ??
    monoAccent ??
    [...cap.backgrounds].filter((s) => saturation(s.c) > 0.25).sort((a, b) => score(b) - score(a))[0]?.c ??
    [37, 99, 235];

  // 深色站检测:以页面真实背景(body/html)为准,不被大 hero/footer 区块的面积权重误导。
  // 无 pageBg 时退回"权重最高背景",但要求它明确偏暗才认定深色站。
  const pageBg = cap.pageBg;
  const darkSite = pageBg ? luminance(pageBg) < 0.3 : !!bgRanked[0] && luminance(bgRanked[0].c) < 0.22;

  let bg: RGB;
  let text: RGB;
  let surface: RGB;
  if (darkSite) {
    bg = pageBg ?? bgRanked[0]!.c;
    text = [...cap.texts].filter((s) => luminance(s.c) > 0.6).sort((a, b) => b.w - a.w)[0]?.c ?? [240, 242, 246];
    text = ensureContrast(text, bg, [255, 255, 255], 4.5);
    surface = lighten(bg, 0.07);
  } else {
    // 浅色站:优先页面真实浅背景;否则权重最高的浅背景;兜底纯白
    bg = (pageBg && luminance(pageBg) > 0.85 ? pageBg : undefined) ?? bgRanked.find((s) => luminance(s.c) > 0.85)?.c ?? [255, 255, 255];
    text = [...cap.texts].filter((s) => luminance(s.c) < 0.45).sort((a, b) => b.w - a.w)[0]?.c ?? [26, 28, 33];
    text = ensureContrast(text, bg, [0, 0, 0], 4.5);
    surface = luminance(bg) > 0.92 ? [247, 248, 250] : lighten(bg, 0.04);
  }

  const textMuted = ensureContrast(mix(text, bg, 0.42), bg, text, 3);

  const colors = {
    primary: hex(primary),
    primaryDark: hex(darken(primary, 0.16)),
    onPrimary: onColor(primary),
    bg: hex(bg),
    surface: hex(surface),
    text: hex(text),
    textMuted: hex(textMuted),
    border: hex(mix(text, bg, 0.82)),
  };

  return {
    colors,
    fonts: { heading: cleanFont(cap.headingFont, true), body: cleanFont(cap.bodyFont, false) },
    source: {
      accents: (accentRanked.length ? accentRanked : [...cap.accents].sort((a, b) => b.w - a.w)).slice(0, 6).map((s) => hex(s.c)),
      backgrounds: bgRanked.slice(0, 6).map((s) => hex(s.c)),
    },
  };
}

/** 把 computed font-family 收成"首选族 + 合理兜底栈";过滤系统占位与危险字符(防 CSS 注入)。 */
function cleanFont(family: string, heading: boolean): string {
  const first = (family || '')
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '')
    // 族名只保留字母/数字/空格/连字符:被抓站的字体串是不可信输入,不能让 }{;/* 之类进 CSS
    .replace(/[^\w \-]/g, '')
    .slice(0, 64);
  const fallback = heading
    ? `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
    : `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  if (!first || /^(inherit|initial|unset|-apple-system|system-ui|sans-serif|serif)$/i.test(first)) {
    return fallback;
  }
  const needsQuote = /\s/.test(first);
  return `${needsQuote ? `"${first}"` : first}, ${fallback}`;
}

/** 取首选字体族名(不含引号与兜底栈);系统字体返回 null。Google Fonts 注入用。 */
export function primaryFamily(stack: string): string | null {
  const first = (stack || '').split(',')[0]?.trim().replace(/^["']|["']$/g, '');
  if (!first || /^(system-ui|-apple-system|sans-serif|serif|monospace|Segoe UI|Roboto|Helvetica|Arial|Georgia|Times.*|Courier.*|Verdana|Tahoma)$/i.test(first)) {
    return null;
  }
  return first;
}
