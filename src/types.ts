// SiteForge 共享类型。管线:RawCapture(渲染抓取)→ Theme(品牌套色) + Content(内容)。

export type RGB = [number, number, number];

export interface ColorStat {
  c: RGB;
  w: number; // 权重(背景按面积、文字按字数、强调色按面积)
}

/** 无头渲染后从页面里抓到的原始素材(浏览器上下文内提取,JS 已执行)。 */
export interface RawCapture {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  fullText: string;
  html: string;
  backgrounds: ColorStat[];
  texts: ColorStat[];
  accents: ColorStat[]; // 来自链接/按钮/导航/标题——品牌色的主要信号
  headingFont: string;
  bodyFont: string;
  logo: string | null;
  hero: string | null;
  headings: string[];
  paragraphs: string[];
  /** 源站 <html lang>(可能为空串)。 */
  lang: string;
  /** 页面真实背景色(body→html 首个非透明背景);判浅/深色站,不受大 hero 面积干扰。 */
  pageBg: RGB | null;
  /** 标题→紧随段落 配对,用于服务卡描述与 about 精准定位。 */
  sections: { h: string; p: string }[];
}

/** 品牌套色 token —— 模板用 CSS 变量吃它,实现"同一套模板按品牌换肤"。 */
export interface Theme {
  colors: {
    primary: string;
    primaryDark: string;
    onPrimary: string;
    bg: string;
    surface: string;
    text: string;
    textMuted: string;
    border: string;
  };
  fonts: {
    heading: string;
    body: string;
  };
  source: {
    accents: string[]; // 调试用:抓到的候选强调色
    backgrounds: string[];
  };
}

export interface Contacts {
  phone: string;
  email: string;
  address: string;
  hours: string;
}

export interface Content {
  brandName: string;
  tagline: string;
  about: string;
  services: { title: string; description: string }[];
  contacts: Contacts;
  logo: string | null; // 落地后的相对路径 assets/...
  hero: string | null;
  sourceUrl: string;
  generatedAt: string;
  /** BCP-47 语言标签,继承自源站;缺省按 en 处理。 */
  lang?: string;
}
