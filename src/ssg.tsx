import ReactDOMServer from 'react-dom/server';
import { Site } from './site.js';
import { buildHead } from './seo.js';
import { BASE_CSS, themeVars } from './styles.js';
import { primaryFamily } from './extract/brand.js';
import type { Content, Theme } from './types.js';

export interface RenderOpts {
  /** 询盘表单提交地址(后管 /api/leads/<slug>);不传则不渲染表单。 */
  formAction?: string;
  /** 站点正式域名;有它才产出 canonical/og:url/绝对 og:image。 */
  baseUrl?: string;
}

/**
 * 生成一个租户的**完整静态 HTML**:内容烤进 body(SSG)、SEO head + JSON-LD、样式全内联。
 * 爬虫/用户一进来就拿到完整可索引页面,零客户端 JS、零运行时 fetch。
 */
export function renderPage(content: Content, theme: Theme, opts?: RenderOpts): string {
  const body = ReactDOMServer.renderToStaticMarkup(<Site content={content} formAction={opts?.formAction} />);
  const lang = content.lang && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(content.lang) ? content.lang : 'en';
  const fontFamilies = [primaryFamily(theme.fonts.heading), primaryFamily(theme.fonts.body)]
    .filter((f): f is string => !!f)
    .filter((f, i, a) => a.indexOf(f) === i);
  return `<!doctype html>
<html lang="${lang}">
<head>
${buildHead(content, { baseUrl: opts?.baseUrl, fontFamilies })}
<style>${BASE_CSS}${themeVars(theme)}</style>
</head>
<body>
${body}
</body>
</html>
`;
}
