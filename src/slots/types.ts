// 复刻轨(clone track)的槽位类型。
// 核心思路:把克隆 DOM 当"别人写的模板"——冻结成 skeleton.html(带 data-sf-el 锚点),
// 可编辑内容抽成 slots.json,renderSlots() 纯函数把值回填回骨架。
// 与 forge 轨的 renderPage(content, theme) 对称;后管按 site.json.track 分派。

export type SlotType = 'text' | 'image' | 'link' | 'head';

export type SlotGroup = 'header' | 'hero' | 'main' | 'footer' | 'head';

/** 语义角色:由探测器识别,用于后管"联系信息"等聚合视图(投影,不另存一份数据)。 */
export type SlotRole = 'brand' | 'phone' | 'email' | 'address' | 'hours' | 'nav' | 'cta' | 'heading' | 'body';

export type LinkKind = 'internal' | 'external' | 'tel' | 'mailto' | 'anchor' | 'dead';

/**
 * 重抓(refetch)时用于把旧槽位的编辑值重新对上新骨架的指纹。
 * 实测:sig(tag+稳定class+3级祖先) + 同签名序号 在 round4→round5 两次真实独立抓取上命中 99.89%;
 * 而 CSS 路径(nth-of-type 链)在内容变动时只有 ~52%,不可用。
 */
export interface SlotAnchor {
  tag: string;
  /** 过滤掉动态/哈希类名后的稳定 class 串 */
  cls: string;
  /** 3 级祖先签名(tag.cls>tag.cls>tag.cls) */
  anc: string;
  /** 同签名元素中的序号 */
  sigOrd: number;
  /** 原始文本的短哈希(兜底匹配用) */
  textHash: string;
  /** 文档序(兜底打分用) */
  docOrd: number;
}

export interface Slot {
  /** 'e17#2'=元素 e17 的第 2 个 childNode(文本);'i3@src';'a12@href';'head:title' */
  id: string;
  type: SlotType;
  /** 当前值(唯一可写字段) */
  v: string;
  /** 抓取时的原始值(用于 diff、格式保形、重锚指纹) */
  orig: string;
  /** image 的 alt */
  alt?: string;
  group: SlotGroup;
  role?: SlotRole;
  linkKind?: LinkKind;
  /** 分隔符模板(如 "(NNN) NNN-NNNN"):按同模板重排新值 → 字符宽度不变 → 零换行零位移 */
  fmt?: string;
  /** 运营锁定:refetch 永不覆盖 */
  locked?: boolean;
  anchor: SlotAnchor;
}

export interface SlotDoc {
  v: 1;
  slug: string;
  sourceUrl: string;
  finalUrl: string;
  capturedAt: string;
  slots: Slot[];
}

/** renderSlots 的后处理开关。每一项都可独立关闭,便于定位问题。 */
export interface SlotRenderOpts {
  /** 站点正式域名:有它才产出 canonical/og:url/绝对 og:image */
  baseUrl?: string;
  /** 询盘表单提交地址;传入则接管页面上所有表单 */
  formAction?: string;
  /** 源站 host:用于把残留的绝对内链改写成根相对(防跳回旧站) */
  sourceHost?: string;
  /** 注入零 JS 移动导航(原站汉堡菜单剥 script 后普遍点不开) */
  mobileNav?: boolean;
  /** 未签约/旧站未下线时:noindex,防与客户旧站构成重复内容互相稀释 */
  indexable?: boolean;
  /** 把地图/视频 iframe 换成静态占位(默认 false:实测它们剥 script 后仍能工作,
   *  静态化会损失保真与功能;仅在需要极致隐私/离线时开启)。 */
  staticizeEmbeds?: boolean;
  /** 品牌主色:移动导航按钮配色 */
  primaryColor?: string;
  /** 细粒度后处理开关(默认全开,除 mobileNav 需显式开)。用于消融定位问题。 */
  steps?: {
    links?: boolean;
    forms?: boolean;
    iframes?: boolean;
    modals?: boolean;
    head?: boolean;
  };
}

/** 捕获闸门结果:拦住"抓取失败却拿高分"的灾难交付(如 Cloudflare 挑战页)。 */
export interface GateResult {
  ok: boolean;
  reason?: string;
  /** 诊断数据,便于运营判断 */
  stats: {
    visibleTextLen: number;
    imgCount: number;
    bgImageCount: number;
    assetsOk: number;
    title: string;
  };
}
