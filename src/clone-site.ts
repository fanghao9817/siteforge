import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSite } from './capture.js';
import { gateCapture } from './clone/gate.js';
import { annotate } from './slots/annotate.js';
import { renderSlots } from './slots/render.js';
import { assertSlug, urlAllowed } from './safe.js';
import type { SlotDoc } from './slots/types.js';

/**
 * 复刻轨 CLI:URL → 像素克隆 → 捕获闸门 → 槽位化 → 可编辑的发布站。
 *
 * 与 forge 轨(src/index.ts)并列。产物结构:
 *   sites/<slug>/
 *     index.html      发布物(骨架 + 槽位回填 + 后处理)
 *     skeleton.html   冻结骨架(带 data-sf-el 锚点,永不手改)
 *     slots.json      槽位表(后管唯一编辑面)
 *     site.json       track:'clone' + baseUrl/formEnabled/indexable...
 *     assets/         capture 本地化的资产
 *     reference.png   原站参考图(保真度回归基线)
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_ROOT = join(__dirname, '..', 'sites');

function slugify(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  } catch {
    return 'site';
  }
}

export interface CloneSiteResult {
  slug: string;
  dir: string;
  slots: number;
  gate: { ok: boolean; reason?: string };
  stats?: Record<string, unknown>;
}

export async function cloneSite(url: string, slug: string): Promise<CloneSiteResult> {
  const dir = join(SITES_ROOT, slug);
  // 抓到临时目录,过闸门后才落到正式目录 —— 避免失败的抓取污染站点列表
  const tmp = join(SITES_ROOT, `.tmp-${slug}-${Date.now()}`);
  await mkdir(SITES_ROOT, { recursive: true });

  console.log(`\n🔭 克隆 ${url} …(无头渲染 + 资源本地化)`);
  const meta = await captureSite(url, tmp);

  const html = await readFile(join(tmp, 'index.html'), 'utf8');
  const gate = gateCapture({ html, assetsOk: meta.assetsOk, refHeight: meta.fullHeight });
  if (!gate.ok) {
    await rm(tmp, { recursive: true, force: true });
    console.error(`\n❌ 捕获闸门拦截:${gate.reason}`);
    console.error(`   诊断:可见文字 ${gate.stats.visibleTextLen} 字 · 图 ${gate.stats.imgCount} · 资源 ${gate.stats.assetsOk} · 标题「${gate.stats.title}」`);
    console.error(`   → 该站不适合复刻轨(可能被反爬拦截),建议改用 forge 轨:npm run forge -- ${url}`);
    return { slug, dir, slots: 0, gate };
  }

  // 槽位化:冻结骨架 + 抽出可编辑槽位
  const { skeleton, doc } = annotate({
    html,
    slug,
    sourceUrl: url,
    finalUrl: meta.finalUrl,
    capturedAt: new Date().toISOString(),
  });

  // 首次渲染发布物(未设域名 → noindex;表单未开 → 不接管)
  const { html: out, stats } = renderSlots(skeleton, doc, { mobileNav: true, indexable: false });

  // 落地:替换正式目录
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  await writeFile(join(dir, 'skeleton.html'), skeleton, 'utf8');
  await writeFile(join(dir, 'slots.json'), JSON.stringify(doc, null, 1), 'utf8');
  await writeFile(join(dir, 'index.html'), out, 'utf8');
  await writeFile(
    join(dir, 'site.json'),
    JSON.stringify({ track: 'clone', baseUrl: '', formEnabled: false, indexable: false, notes: '', leadsSeenAt: '', sourceUrl: url, finalUrl: meta.finalUrl }, null, 2),
    'utf8',
  );

  const byType = doc.slots.reduce<Record<string, number>>((a, s) => ((a[s.type] = (a[s.type] || 0) + 1), a), {});
  const byRole = doc.slots.filter((s) => s.role).reduce<Record<string, number>>((a, s) => ((a[s.role!] = (a[s.role!] || 0) + 1), a), {});

  console.log(`\n✅ 复刻完成 → sites/${slug}/`);
  console.log(`   资源 ${meta.assetsOk} 个(失败 ${meta.assetsFail}) · 页高 ${meta.fullHeight}px`);
  console.log(`   槽位 ${doc.slots.length} 个 ${JSON.stringify(byType)}`);
  console.log(`   语义识别 ${JSON.stringify(byRole)}`);
  console.log(`   后处理 链接改写${stats.linksFixed} · iframe保留${stats.iframes.kept}/清${stats.iframes.removed} · 模态清${stats.modalsRemoved} · 移动导航${stats.navLinks}项`);
  console.log(`\n👉 管理与预览: npm run admin → http://<机器IP>:5179/#/site/${slug}`);
  console.log(`   ⚠️ 默认 noindex:确认客户已签约、旧站已 301 到新域后,再在后管开启收录\n`);

  return { slug, dir, slots: doc.slots.length, gate, stats: stats as unknown as Record<string, unknown> };
}

/** 后管/CLI 复用:读回骨架与槽位,按当前设置重渲染发布物。 */
export async function rebuildClone(dir: string, opts: { baseUrl?: string; formAction?: string; indexable?: boolean; primaryColor?: string }): Promise<{ ok: true; stats: unknown } | { ok: false; err: string }> {
  let skeleton: string;
  let doc: SlotDoc;
  try {
    skeleton = await readFile(join(dir, 'skeleton.html'), 'utf8');
    doc = JSON.parse(await readFile(join(dir, 'slots.json'), 'utf8'));
  } catch {
    return { ok: false, err: '复刻站数据不完整(缺 skeleton.html 或 slots.json)' };
  }
  const { html, stats } = renderSlots(skeleton, doc, { ...opts, mobileNav: true });
  await writeFile(join(dir, 'index.html'), html, 'utf8');
  return { ok: true, stats };
}

async function main() {
  const url = process.argv[2];
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('用法: npm run clone-site -- <https://客户网址> [slug]');
    console.error('  产出可编辑的复刻站到 sites/<slug>/,与 forge 轨并列。');
    process.exit(1);
  }
  const urlErr = urlAllowed(url);
  if (urlErr) {
    console.error(`❌ URL 被拒:${urlErr}(开发环境可设 SF_ALLOW_PRIVATE=1)`);
    process.exit(1);
  }
  const slug = assertSlug(process.argv[3] || slugify(url));
  const r = await cloneSite(url, slug);
  if (!r.gate.ok) process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('clone-site.js')) {
  main().catch((e) => {
    console.error('❌ 复刻失败:', e?.message || e);
    process.exit(1);
  });
}
