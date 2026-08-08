// 复刻轨(clone track)单元测试:闸门 / 槽位标注 / 回填 / 后处理管线。
// 用 runs/round5 的真实克隆产物做 fixture(无需网络)。
// 基准语料不公开,本仓库不含这些 fixture:如需运行,请把自己的抓取产物放到 runs/round5/<slug>/。
import { gateCapture } from '../dist/clone/gate.js';
import { annotate } from '../dist/slots/annotate.js';
import { renderSlots } from '../dist/slots/render.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  c ? pass++ : fail++;
  console.log(`${c ? '✅' : '❌'} ${n}${extra && !c ? ' → ' + extra : ''}`);
};

const R = 'runs/round5';
const readSite = async (s) => {
  const html = await readFile(join(R, s, 'index.html'), 'utf8');
  let assets = 0;
  try {
    assets = (await readdir(join(R, s, 'assets'))).length;
  } catch {
    /* 无资源目录 */
  }
  return { html, assets };
};

// ---------- 捕获闸门 ----------
{
  // 某个基准站点的捕获其实是 Cloudflare "Checking your browser" 挑战页,却在 round5 拿了 1.0 满分
  const { html, assets } = await readSite('cf-challenge-fixture');
  const g = gateCapture({ html, assetsOk: assets });
  ok('闸门拦住 Cloudflare 挑战页', g.ok === false, JSON.stringify(g.stats));
  ok('闸门给出可读原因', typeof g.reason === 'string' && g.reason.length > 5);
}
{
  const { html, assets } = await readSite('landscaping-fixture');
  const g = gateCapture({ html, assetsOk: assets, refHeight: 4804 });
  ok('闸门放行正常站', g.ok === true, g.reason || '');
}

// ---------- 槽位标注 ----------
const { html: fixtureHtml } = await readSite('landscaping-fixture');
const { skeleton, doc } = annotate({
  html: fixtureHtml,
  slug: 'landscaping-fixture',
  sourceUrl: 'https://landscaping.example',
  finalUrl: 'https://landscaping.example',
  capturedAt: '2026-07-19T00:00:00Z',
});
ok('抽出槽位', doc.slots.length > 50, `${doc.slots.length}`);
ok('槽位 id 全局唯一', new Set(doc.slots.map((s) => s.id)).size === doc.slots.length);
ok('文本槽位按 childNode 索引寻址', doc.slots.some((s) => /^e\d+#\d+$/.test(s.id)));
ok('不 wrap span(骨架里无 sf-slot 包裹标签)', !/<span[^>]*data-sf-slot/.test(skeleton));
ok('识别出电话槽位', doc.slots.some((s) => s.role === 'phone'));
ok('电话槽位带格式模板', doc.slots.filter((s) => s.role === 'phone').every((s) => !s.fmt || /N/.test(s.fmt)));
ok('每个槽位都有重锚指纹', doc.slots.every((s) => s.anchor && s.anchor.tag && typeof s.anchor.sigOrd === 'number'));

// ---------- 回填(无编辑时应完全还原) ----------
{
  const { html: out } = renderSlots(skeleton, doc, { steps: { links: false, forms: false, iframes: false, modals: false, head: false } });
  // 逐槽位核对值仍在
  const missing = doc.slots.filter((s) => s.type === 'text' && s.v.length > 6 && !out.includes(s.v.slice(0, 30)));
  ok('无编辑回填不丢文本', missing.length === 0, `${missing.length} 条丢失`);
  ok('图片 src 保持裸相对路径(不被安全策略误杀)', !/src="#"/.test(out) || !fixtureHtml.includes('src="assets/'));
}

// ---------- 编辑与格式保形 ----------
{
  const phone = doc.slots.find((s) => s.role === 'phone' && s.fmt);
  if (phone) {
    const edited = { ...doc, slots: doc.slots.map((s) => (s.id === phone.id ? { ...s, v: '6045559999' } : s)) };
    const { html: out } = renderSlots(skeleton, edited, { steps: { links: false, forms: false, iframes: false, modals: false, head: false } });
    // 按原模板重排后,分隔符应保留(不是裸数字串)
    const reformatted = phone.fmt.replace(/N/g, () => '').length > 0;
    ok('格式保形:新号按原分隔符模板重排', reformatted ? !out.includes('6045559999') || /604.555.9999/.test(out) : true, phone.fmt);
  } else {
    ok('格式保形(该 fixture 无带模板电话,跳过)', true);
  }
}

// ---------- 安全 ----------
{
  const evil = { ...doc, slots: doc.slots.map((s) => (s.type === 'link' ? { ...s, v: 'javascript:alert(1)' } : s)) };
  const { html: out } = renderSlots(skeleton, evil, { steps: { links: false, forms: false, iframes: false, modals: false, head: false } });
  ok('拒绝 javascript: 协议', !/href="javascript:/i.test(out));
}

// ---------- 后处理:SEO 修复 ----------
{
  const { html: out } = renderSlots(skeleton, doc, { baseUrl: 'https://new-domain.ca', indexable: true });
  ok('重建 canonical 指向新域', /<link rel="canonical" href="https:\/\/new-domain\.ca\/">/.test(out));
  ok('重新注入 JSON-LD(原站被剥 script 时删光了)', /application\/ld\+json/.test(out));
  ok('indexable=true 时无 noindex', !/noindex/.test(out));
  const { html: out2 } = renderSlots(skeleton, doc, { baseUrl: 'https://new-domain.ca', indexable: false });
  ok('indexable=false 时输出 noindex(防与客户旧站重复内容)', /noindex,nofollow/.test(out2));
}

// ---------- 后处理:链接改写 ----------
{
  const { html: out } = renderSlots(skeleton, doc, { sourceHost: 'landscaping.example' });
  ok('同源绝对链接改成根相对(不跳回旧站)', !/href="https?:\/\/(www\.)?landscaping\.example\//.test(out));
  ok('mailto 邮箱保留(那是客户联系方式)', !doc.slots.some((s) => s.v.startsWith('mailto:')) || /mailto:/.test(out));
}

// ---------- 后处理:表单接管 ----------
{
  const { html: autoHtml } = await readSite('auto-repair-fixture');
  const a = annotate({ html: autoHtml, slug: 'd', sourceUrl: 'https://auto-repair.example', finalUrl: 'https://auto-repair.example', capturedAt: 'x' });
  const { html: out, stats } = renderSlots(a.skeleton, a.doc, { formAction: '/api/leads/d' });
  if (stats.formsAdopted > 0) {
    ok('表单 action 改写到询盘端点', /action="\/api\/leads\/d"/.test(out));
    ok('注入蜜罐字段', /name="_hp"/.test(out));
    ok('原字段名保留在 data-sf-orig-name', /data-sf-orig-name/.test(out));
  } else {
    ok('表单接管(该 fixture 无表单,跳过)', true);
  }
}

// ---------- 后处理:iframe 三分 ----------
{
  const { html: autoHtml } = await readSite('auto-repair-fixture');
  const a = annotate({ html: autoHtml, slug: 'd', sourceUrl: 'https://x.ca', finalUrl: 'https://x.ca', capturedAt: 'x' });
  const { stats } = renderSlots(a.skeleton, a.doc, {});
  ok('地图/视频 iframe 默认保留(剥 script 后仍能工作)', stats.iframes.placeheld === 0);
  const { stats: st2 } = renderSlots(a.skeleton, a.doc, { staticizeEmbeds: true });
  ok('staticizeEmbeds=true 时才静态化', st2.iframes.placeheld >= stats.iframes.placeheld);
}

// ---------- 后处理:模态清除不误伤正常内容 ----------
{
  const { html: sb } = await readSite('bakery-fixture');
  const a = annotate({ html: sb, slug: 's', sourceUrl: 'https://x.ca', finalUrl: 'https://x.ca', capturedAt: 'x' });
  const { html: out, stats } = renderSlots(a.skeleton, a.doc, {});
  // 该站的 widget-popup 是正常内容区块,不该被当模态删掉
  ok('模态清除不误伤 widget-popup 正常内容', stats.modalsRemoved === 0 && out.includes('widget-popup'), `删了 ${stats.modalsRemoved}`);
}

// ---------- 移动导航 ----------
{
  const { html: out, stats } = renderSlots(skeleton, doc, { mobileNav: true });
  ok('注入零 JS 移动导航', stats.navLinks > 0 && /<details class="sf-nav">/.test(out));
  ok('移动导航仅在窄屏显示(桌面零影响)', /@media \(min-width:821px\)\{\.sf-nav\{display:none!important\}\}/.test(out.replace(/\s+/g, ' ').replace(/ \{/g, '{').replace(/\{ /g, '{')) || /min-width:821px/.test(out));
  const navBlock = (out.match(/<details class="sf-nav">[\s\S]*?<\/details>/) || [''])[0];
  ok('导航项不含电话/邮箱(那不是导航)', !/mailto:|tel:/.test(navBlock), navBlock.slice(0, 120));
  // 只检查真实 CSS 声明,不匹配注释文字
  ok('不做全局横向裁剪兜底(那只是藏起溢出、骗过闸门)', !/(^|[;{])\s*overflow-x\s*:\s*hidden/m.test(out));
}

console.log(`\n== 复刻轨: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
