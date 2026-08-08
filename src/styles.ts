import type { Theme } from './types.js';

// 静态站的全部 CSS(内联进 <head>,零外部请求)。颜色/字体走 CSS 变量,themeVars() 按租户注入。
export const BASE_CSS = `
:root{
  --sf-primary:#2563eb; --sf-primary-dark:#1e4fd0; --sf-on-primary:#fff;
  --sf-bg:#fff; --sf-surface:#f7f8fa; --sf-text:#1a1c21; --sf-text-muted:#5b6270; --sf-border:#e4e7ec;
  --sf-font-heading:system-ui,sans-serif; --sf-font-body:system-ui,sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--sf-bg);color:var(--sf-text);font-family:var(--sf-font-body);line-height:1.6}
h1,h2,h3{font-family:var(--sf-font-heading);line-height:1.2}
img{max-width:100%;display:block}
a{color:inherit}
.sf-header{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:14px 32px;background:var(--sf-bg);border-bottom:1px solid var(--sf-border)}
.sf-brand img{max-height:48px;width:auto}
.sf-logo-text{font-family:var(--sf-font-heading);font-weight:800;font-size:22px;color:var(--sf-primary)}
.sf-nav{display:flex;align-items:center;gap:26px}
.sf-nav a{color:var(--sf-text);text-decoration:none;font-weight:600;font-size:15px}
.sf-nav a:hover{color:var(--sf-primary)}
.sf-btn{background:var(--sf-primary);color:var(--sf-on-primary)!important;padding:10px 20px;border-radius:8px;font-weight:700;text-decoration:none;transition:background .15s}
.sf-btn:hover{background:var(--sf-primary-dark)}
.sf-btn-lg{padding:15px 30px;font-size:17px;display:inline-block}
.sf-hero{position:relative;min-height:520px;display:flex;align-items:center;justify-content:center;background-size:cover;background-position:center;background-color:var(--sf-primary-dark);text-align:center}
.sf-hero-overlay{position:absolute;inset:0;background:linear-gradient(120deg,color-mix(in srgb,var(--sf-primary) 80%,#000) 30%,rgba(0,0,0,.55));opacity:.82}
.sf-hero-inner{position:relative;z-index:1;color:#fff;padding:40px 24px;max-width:820px}
.sf-hero-inner h1{font-size:clamp(34px,6vw,60px);font-weight:800;margin-bottom:16px}
.sf-hero-inner p{font-size:clamp(16px,2.4vw,21px);opacity:.95;margin-bottom:28px}
.sf-section{max-width:1120px;margin:0 auto;padding:76px 32px}
.sf-section>h2{font-size:32px;font-weight:800;text-align:center;margin-bottom:44px}
.sf-section>h2::after{content:'';display:block;width:64px;height:4px;border-radius:2px;background:var(--sf-primary);margin:14px auto 0}
.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:22px}
.sf-card{background:var(--sf-surface);border:1px solid var(--sf-border);border-radius:12px;padding:26px 24px;overflow:hidden;position:relative;transition:transform .15s,box-shadow .15s}
.sf-card:hover{transform:translateY(-3px);box-shadow:0 12px 28px rgba(0,0,0,.08)}
.sf-card-bar{position:absolute;top:0;left:0;width:100%;height:4px;background:var(--sf-primary)}
.sf-card h3{font-size:19px;font-weight:700;margin-bottom:8px;color:var(--sf-text)}
.sf-card p{color:var(--sf-text-muted);font-size:15px}
.sf-about{max-width:820px;text-align:center}
.sf-about p{color:var(--sf-text-muted);font-size:18px}
.sf-footer{background:var(--sf-primary-dark);color:#fff}
.sf-footer-inner{max-width:1120px;margin:0 auto;padding:56px 32px 28px;display:flex;flex-wrap:wrap;gap:32px;justify-content:space-between}
.sf-footer h3{font-size:24px;font-weight:800;margin-bottom:10px}
.sf-contact{list-style:none;display:grid;gap:10px}
.sf-contact li{font-size:15px;opacity:.95}
.sf-contact a{color:#fff}
.sf-madeby{border-top:1px solid rgba(255,255,255,.2);text-align:center;padding:16px;font-size:13px;color:rgba(255,255,255,.65)}
.sf-quote{max-width:640px}
.sf-form{display:grid;gap:12px;text-align:left}
.sf-form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.sf-form input,.sf-form textarea{width:100%;border:1px solid var(--sf-border);border-radius:8px;padding:11px 13px;font:inherit;background:var(--sf-bg);color:var(--sf-text)}
.sf-form input:focus,.sf-form textarea:focus{outline:2px solid var(--sf-primary);border-color:var(--sf-primary)}
.sf-form button{border:none;cursor:pointer;font:inherit;justify-self:start}
.sf-hp{position:absolute!important;left:-9999px!important;height:1px;width:1px;opacity:0}
@media (max-width:640px){.sf-form-row{grid-template-columns:1fr}}
.sf-mnav{display:none;position:relative}
.sf-mnav summary{list-style:none;cursor:pointer;font-size:20px;line-height:1;padding:6px 12px;border:1px solid var(--sf-border);border-radius:8px;color:var(--sf-text)}
.sf-mnav summary::-webkit-details-marker{display:none}
.sf-mnav[open]>div{position:absolute;right:0;top:calc(100% + 8px);background:var(--sf-bg);border:1px solid var(--sf-border);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.14);display:grid;gap:2px;padding:10px;min-width:190px;z-index:30}
.sf-mnav a{padding:9px 12px;text-decoration:none;color:var(--sf-text);font-weight:600;border-radius:6px;font-size:15px}
.sf-mnav a:hover{background:var(--sf-surface);color:var(--sf-primary)}
@media (max-width:640px){
  .sf-header{padding:12px 18px}
  .sf-nav{gap:14px}
  .sf-nav a:not(.sf-btn){display:none}
  .sf-mnav{display:block}
  .sf-hero{min-height:78svh}
  .sf-section{padding:48px 20px}
  .sf-section>h2{font-size:26px;margin-bottom:32px}
  .sf-footer-inner{padding:40px 20px 20px}
}
`;

const VAR_MAP: Record<string, string> = {
  primary: '--sf-primary', primaryDark: '--sf-primary-dark', onPrimary: '--sf-on-primary',
  bg: '--sf-bg', surface: '--sf-surface', text: '--sf-text', textMuted: '--sf-text-muted', border: '--sf-border',
};

// 颜色/字体值是不可信输入(来自被抓站或后台编辑):进 CSS 前白名单消毒,防 }{;</style> 注入
const safeColor = (v: string) => (/^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '');
const safeFont = (v: string) => String(v || '').replace(/[^\w \-,"']/g, '').slice(0, 200);

// 按租户主题生成 :root{} 变量块(排在 BASE_CSS 之后,覆盖兜底默认值)。
export function themeVars(theme: Theme): string {
  const c = theme.colors as Record<string, string>;
  const decls = Object.entries(VAR_MAP)
    .filter(([k]) => safeColor(c[k] || ''))
    .map(([k, v]) => `${v}:${safeColor(c[k])};`)
    .join('');
  return `:root{${decls}--sf-font-heading:${safeFont(theme.fonts.heading)};--sf-font-body:${safeFont(theme.fonts.body)};}`;
}
