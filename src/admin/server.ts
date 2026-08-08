import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, readdir, rename, stat, appendFile } from 'node:fs/promises';
import { join, normalize, sep, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renderPage } from '../ssg.js';
import { buildSitemap, buildRobots } from '../seo.js';
import { SLUG_RE, TAG_RE, urlAllowed, envNum } from '../safe.js';
import { rebuildClone } from '../clone-site.js';
import type { SlotDoc } from '../slots/types.js';
import type { Content, Theme } from '../types.js';

/**
 * SiteForge 后管服务:站点列表/内容与主题编辑/秒级重渲染/从 URL 新建(异步任务)/
 * 询盘收件箱/跑批报告/审计日志。零新增依赖,文件系统即数据库(sites/<slug>/*.json)。
 *
 * 鉴权:设 SF_ADMIN_TOKEN 后,/api/* 需 Bearer token(询盘提交端点除外,它面向公网表单)。
 * 预览静态文件(/sites、/runs-files)带 CSP sandbox,阻止预览内容执行脚本。
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..'); // dist/admin → 项目根
const SITES = join(ROOT, 'sites');
const RUNS = join(ROOT, 'runs');
const TRASH = join(SITES, '.trash');
const AUDIT_FILE = join(SITES, '.audit.jsonl');
const UI_FILE = join(ROOT, 'admin-ui', 'index.html');

const PORT = envNum('SF_ADMIN_PORT', 5179); // 非法值不再退化成随机端口/NaN
const TOKEN = process.env.SF_ADMIN_TOKEN || '';
// 默认只绑回环:无 token 时不该把能驱动渲染器/读写站点的后台暴露到网卡。
// 要对外服务请显式设 SF_ADMIN_HOST=0.0.0.0(并务必同时设 SF_ADMIN_TOKEN)。
const HOST = process.env.SF_ADMIN_HOST || '127.0.0.1';
const JOB_TIMEOUT = envNum('SF_JOB_TIMEOUT', 240000); // NaN 会让任务一 spawn 就被超时击杀

// ---------- 小工具 ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!done) resolve(null); });
  });
}

async function readJsonBody(req: IncomingMessage, limit = 512 * 1024): Promise<any | null> {
  const buf = await readBody(req, limit);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function audit(action: string, slug: string, detail = ''): Promise<void> {
  try {
    await mkdir(SITES, { recursive: true });
    await appendFile(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), action, slug, detail }) + '\n', 'utf8');
  } catch {
    /* 审计失败不影响主流程 */
  }
}

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------- 内容/主题/站点元数据校验 ----------

function sanitizeContent(raw: any, prev: Content | null): Content | { err: string } {
  if (!raw || typeof raw !== 'object') return { err: 'content 必须是对象' };
  const brandName = s(raw.brandName, 80);
  if (!brandName) return { err: 'brandName 必填' };
  // 必须是 assets/ 下的图片文件名(字母数字打头 + 图片扩展名);显式拒 '..' 与点开头,防引用到目录/dotfile
  const assetRe = /^assets\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,110}\.(png|jpe?g|webp|gif|svg|avif|ico)$/i;
  const img = (v: unknown): string | null =>
    typeof v === 'string' && assetRe.test(v) && !v.includes('..') ? v : null;
  const servicesIn = Array.isArray(raw.services) ? raw.services.slice(0, 20) : [];
  const services = servicesIn
    .map((x: any) => ({ title: s(x?.title, 80), description: s(x?.description, 400) }))
    .filter((x: { title: string }) => x.title.length > 0);
  const c = raw.contacts || {};
  return {
    brandName,
    tagline: s(raw.tagline, 200),
    about: s(raw.about, 2000),
    services,
    contacts: { phone: s(c.phone, 40), email: s(c.email, 120), address: s(c.address, 200), hours: s(c.hours, 160) },
    logo: img(raw.logo),
    hero: img(raw.hero),
    sourceUrl: s(raw.sourceUrl, 500) || prev?.sourceUrl || '',
    generatedAt: prev?.generatedAt || new Date().toISOString(),
    ...(typeof raw.lang === 'string' && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(raw.lang) ? { lang: raw.lang } : prev?.lang ? { lang: prev.lang } : {}),
  };
}

function sanitizeTheme(raw: any, prev: Theme | null): Theme | { err: string } {
  if (!raw || typeof raw !== 'object') return { err: 'theme 必须是对象' };
  const hexRe = /^#[0-9a-fA-F]{6}$/;
  const cIn = raw.colors || {};
  const keys = ['primary', 'primaryDark', 'onPrimary', 'bg', 'surface', 'text', 'textMuted', 'border'] as const;
  const colors = {} as Theme['colors'];
  for (const k of keys) {
    const v = typeof cIn[k] === 'string' ? cIn[k].trim() : '';
    if (!hexRe.test(v)) return { err: `颜色 ${k} 必须是 #rrggbb 格式` };
    (colors as Record<string, string>)[k] = v.toLowerCase();
  }
  const fontRe = /^[\w\s,"'-]{1,200}$/;
  const fIn = raw.fonts || {};
  const heading = s(fIn.heading, 200);
  const body = s(fIn.body, 200);
  if (!fontRe.test(heading) || !fontRe.test(body)) return { err: '字体串含非法字符' };
  const hexArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string' && hexRe.test(x)).slice(0, 12) : [];
  return {
    colors,
    fonts: { heading, body },
    source: raw.source ? { accents: hexArr(raw.source.accents), backgrounds: hexArr(raw.source.backgrounds) } : prev?.source || { accents: [], backgrounds: [] },
  };
}

export type SiteTrack = 'forge' | 'clone';

export interface SiteMeta {
  /** 渲染轨:'clone'=复刻(骨架+槽位) / 'forge'=重塑(自有模板)。决定 rebuildSite 走哪条路径。 */
  track: SiteTrack;
  baseUrl: string; // 正式域名,如 https://example.com — 重建时用于 canonical/og:url/sitemap
  formEnabled: boolean; // 生成站是否带询盘表单
  /** 允许被搜索引擎收录。默认 false —— 客户旧站未下线时,复刻站与旧站逐字重复会互相稀释。
   *  必须在「客户已签约 + 旧站已 301 到新域」后由运营手动打开。 */
  indexable: boolean;
  notes: string; // 运营备注
  leadsSeenAt: string; // 询盘"已读"水位
}

const DEFAULT_META: SiteMeta = { track: 'forge', baseUrl: '', formEnabled: false, indexable: false, notes: '', leadsSeenAt: '' };

function sanitizeMeta(raw: any, prev: SiteMeta | null): SiteMeta | { err: string } {
  if (!raw || typeof raw !== 'object') return { err: 'meta 必须是对象' };
  let baseUrl = s(raw.baseUrl, 300).replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\/[^\s/]+\S*$/.test(baseUrl)) return { err: 'baseUrl 必须是 http(s) URL' };
  // track 不可由前端随意改写(它由建站方式决定);以既有值为准
  const track: SiteTrack = prev?.track === 'clone' || raw.track === 'clone' ? 'clone' : 'forge';
  return {
    track,
    baseUrl,
    formEnabled: raw.formEnabled === true,
    indexable: raw.indexable === true,
    notes: s(raw.notes, 2000),
    leadsSeenAt: s(raw.leadsSeenAt, 40) || prev?.leadsSeenAt || '',
  };
}

// ---------- 站点数据读写 ----------

async function readJsonFile<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

const siteDir = (slug: string) => join(SITES, slug);

/** 站点元数据(两轨共用)。复刻站没有 content/theme.json,所以单独读。 */
async function loadMeta(slug: string): Promise<SiteMeta> {
  const m = await readJsonFile<Partial<SiteMeta>>(join(siteDir(slug), 'site.json'));
  return { ...DEFAULT_META, ...(m || {}) };
}

/** forge 轨数据;复刻站返回 null(它的编辑面是 slots.json)。 */
async function loadSite(slug: string): Promise<{ content: Content; theme: Theme; meta: SiteMeta } | null> {
  const dir = siteDir(slug);
  const content = await readJsonFile<Content>(join(dir, 'content.json'));
  const theme = await readJsonFile<Theme>(join(dir, 'theme.json'));
  if (!content || !theme) return null;
  return { content, theme, meta: await loadMeta(slug) };
}

/** 复刻轨数据:冻结骨架 + 槽位表。 */
async function loadClone(slug: string): Promise<{ doc: SlotDoc; meta: SiteMeta } | null> {
  const doc = await readJsonFile<SlotDoc>(join(siteDir(slug), 'slots.json'));
  if (!doc || !Array.isArray(doc.slots)) return null;
  return { doc, meta: await loadMeta(slug) };
}

/**
 * 重建发布物。按 site.json.track 分派:
 *   clone → renderSlots(skeleton, slots)   复刻:客户原站骨架
 *   forge → renderPage(content, theme)     重塑:我们的模板
 * 两条路径同语义(纯函数、秒级),后管其余部分零差异。
 */
async function rebuildSite(slug: string): Promise<{ ok: true } | { ok: false; err: string }> {
  const dir = siteDir(slug);
  const meta = await loadMeta(slug);
  const formAction = meta.formEnabled ? `${process.env.SF_PUBLIC_ORIGIN || ''}/api/leads/${slug}` : undefined;

  if (meta.track === 'clone') {
    const r = await rebuildClone(dir, {
      baseUrl: meta.baseUrl || undefined,
      formAction,
      indexable: meta.indexable,
    });
    if (!r.ok) return r;
  } else {
    const data = await loadSite(slug);
    if (!data) return { ok: false, err: '站点数据不完整(缺 content.json 或 theme.json)' };
    const html = renderPage(data.content, data.theme, { formAction, baseUrl: meta.baseUrl || undefined });
    await writeFile(join(dir, 'index.html'), html, 'utf8');
  }

  // 设了正式域名 → 一并产出 sitemap.xml / robots.txt(发布包三件套)
  if (meta.baseUrl) {
    await writeFile(join(dir, 'sitemap.xml'), buildSitemap(meta.baseUrl, new Date().toISOString()), 'utf8');
    // 未开放收录时 robots 全站 Disallow,防与客户旧站构成重复内容
    const robots = meta.indexable ? buildRobots(meta.baseUrl) : `User-agent: *\nDisallow: /\n`;
    await writeFile(join(dir, 'robots.txt'), robots, 'utf8');
  }
  return { ok: true };
}

function seoCheck(html: string): Record<string, unknown> {
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    visibleTextLen: visible.length,
    hasJsonLd: html.includes('application/ld+json'),
    hasH1: /<h1[\s>]/.test(html),
    hasDescription: /<meta name="description"/.test(html),
    hasOgImage: /<meta property="og:image"/.test(html),
    hasCanonical: /<link rel="canonical"/.test(html),
    title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '',
  };
}

async function countLeads(slug: string): Promise<number> {
  try {
    const txt = await readFile(join(siteDir(slug), 'leads.jsonl'), 'utf8');
    return txt.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// ---------- 异步任务(从 URL 新建/重新抓取):单并发队列,1.9G 内存机一次只跑一个渲染 ----------

interface Job {
  id: string;
  type: 'create' | 'refetch';
  /** 建站方式:clone=复刻客户原站(骨架+槽位) / forge=用我们的模板重塑 */
  track: SiteTrack;
  slug: string;
  url: string;
  status: 'queued' | 'running' | 'done' | 'error';
  log: string;
  startedAt: string;
  endedAt?: string;
}

const jobs = new Map<string, Job>();
const jobQueue: Job[] = [];
let jobRunning = false;

function slugifyUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  } catch {
    return 'site';
  }
}

function appendLog(job: Job, text: string): void {
  job.log = (job.log + text).slice(-64 * 1024);
}

function pumpJobs(): void {
  if (jobRunning) return;
  const job = jobQueue.shift();
  if (!job) return;
  jobRunning = true;
  job.status = 'running';
  appendLog(job, `▶ ${job.type}[${job.track}] ${job.url} → sites/${job.slug}\n`);

  const entry = job.track === 'clone' ? join(ROOT, 'dist', 'clone-site.js') : join(ROOT, 'dist', 'index.js');
  const child = spawn(process.execPath, [entry, job.url, job.slug], {
    cwd: ROOT,
    detached: true, // 独立进程组:超时可整组击杀,不留 Chromium 孤儿
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const killGroup = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const timer = setTimeout(() => {
    appendLog(job, `\n⏱ 超时 ${JOB_TIMEOUT}ms,击杀进程组\n`);
    killGroup();
  }, JOB_TIMEOUT);

  child.stdout.on('data', (d: Buffer) => appendLog(job, d.toString()));
  child.stderr.on('data', (d: Buffer) => appendLog(job, d.toString()));
  child.on('close', (code) => {
    clearTimeout(timer);
    job.endedAt = new Date().toISOString();
    job.status = code === 0 ? 'done' : 'error';
    appendLog(job, code === 0 ? '\n✅ 任务完成\n' : `\n❌ 退出码 ${code}\n`);
    void audit(job.type, job.slug, `${job.url} → ${job.status}`);
    jobRunning = false;
    pumpJobs();
  });
  child.on('error', (e) => {
    clearTimeout(timer);
    job.endedAt = new Date().toISOString();
    job.status = 'error';
    appendLog(job, `\n❌ 启动失败: ${e.message}\n`);
    jobRunning = false;
    pumpJobs();
  });
}

function enqueueJob(type: Job['type'], url: string, slug: string, track: SiteTrack = 'forge'): Job {
  const job: Job = { id: randomUUID().slice(0, 8), type, track, slug, url, status: 'queued', log: '', startedAt: new Date().toISOString() };
  jobs.set(job.id, job);
  jobQueue.push(job);
  // 淘汰最旧的已完成 job(每条最多带 64KB log),长跑不会无界涨内存;在跑/排队的保留
  if (jobs.size > 100) {
    for (const [id, j] of jobs) {
      if (jobs.size <= 100) break;
      if (j.status === 'done' || j.status === 'error') jobs.delete(id);
    }
  }
  pumpJobs();
  return job;
}

// ---------- 静态文件(预览) ----------

// 预览路由不经鉴权(生成站本就要公开访问),所以只放行"可发布的网页文件":
// index.html/图片/字体/css/sitemap/robots 等。运营 sidecar(content/theme/site/capture.json、
// leads.jsonl、.audit.jsonl、.trash/)绝不能经此裸露 —— 显式拒 .json/.jsonl 与任何点开头段。
const SERVEABLE_EXT = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.avif', '.woff2', '.woff', '.ttf', '.otf', '.xml', '.txt']);
function isPubliclyServeable(relDecoded: string): boolean {
  const segs = relDecoded.split(/[\\/]/).filter(Boolean);
  if (segs.some((s) => s.startsWith('.'))) return false; // .trash / .audit.jsonl / 任何 dotfile
  const ext = extname(relDecoded).toLowerCase();
  if (ext === '.json' || ext === '.jsonl') return false; // content/theme/site/capture.json、leads/report.jsonl
  return ext === '' || SERVEABLE_EXT.has(ext); // ext==='' 交给下方 index.html 补全
}

async function serveStatic(rootDir: string, relPath: string, res: ServerResponse): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    sendJson(res, 400, { error: 'bad path' });
    return;
  }
  if (!isPubliclyServeable(decoded)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
    return;
  }
  let p = normalize(join(rootDir, decoded));
  if (p !== rootDir && !p.startsWith(rootDir + sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  try {
    const st = await stat(p);
    if (st.isDirectory()) p = join(p, 'index.html');
    const buf = await readFile(p);
    const ext = extname(p).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60',
      'x-content-type-options': 'nosniff',
      // 预览安全策略。
      // 曾用 `sandbox allow-forms allow-same-origin`,但 sandbox 会连同**子 iframe 一起**
      // 剥夺脚本能力 —— 而 Google 地图/YouTube/预约挂件的 embed 内部必须跑脚本才渲染,
      // 结果把客户站里合法的地图、视频、预约入口全打成空白框(实测 aplusglass.ca 地图消失)。
      // 改为精确策略:**顶层文档禁脚本**(克隆件已剥 <script>,这里再挡住残留的内联事件处理器),
      // 但放行 iframe —— 第三方 embed 有自己的 origin 与 CSP 上下文,不受我们这条约束。
      'content-security-policy':
        "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self' https:; frame-src https: data:;",
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 not found');
  }
}

// ---------- 路由 ----------

function authed(req: IncomingMessage, _url: URL): boolean {
  if (!TOKEN) return true;
  // 只认 Authorization 头(前端已用 Bearer);不接受 ?token= 查询串,避免 token 泄进访问日志/Referer/历史
  const got = req.headers.authorization || '';
  return got.length === `Bearer ${TOKEN}`.length && got === `Bearer ${TOKEN}`;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method || 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  // -- 公开端点:询盘提交(供已发布静态站的表单跨域 POST) --
  if (parts[1] === 'leads' && parts.length === 3) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    const slug = parts[2];
    if (!SLUG_RE.test(slug) || !(await exists(join(siteDir(slug), 'content.json')))) {
      sendJson(res, 404, { error: 'unknown site' });
      return;
    }
    const raw = await readBody(req, 10 * 1024);
    if (!raw) {
      sendJson(res, 413, { error: 'body too large' });
      return;
    }
    let body: any = {};
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (ct === 'application/json') {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = {};
      }
    } else {
      body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    }
    if (s(body._hp, 10)) {
      sendJson(res, 200, { ok: true }); // 蜜罐命中:假装成功
      return;
    }
    const lead = {
      ts: new Date().toISOString(),
      name: s(body.name, 120),
      phone: s(body.phone, 60),
      email: s(body.email, 200),
      message: s(body.message, 4000),
      ua: s(req.headers['user-agent'], 300),
    };
    if (!lead.name && !lead.phone && !lead.email && !lead.message) {
      sendJson(res, 400, { error: 'empty lead' });
      return;
    }
    // 公开端点:限单站询盘文件大小上限(约 5MB / ~1 万条),达上限拒收,防磁盘填充 DoS。
    // 生产建议在前置反代再加 IP 级限流。
    const leadsFile = join(siteDir(slug), 'leads.jsonl');
    try {
      const st = await stat(leadsFile);
      if (st.size > 5_000_000) {
        sendJson(res, 429, { error: 'inbox full' });
        return;
      }
    } catch {
      /* 尚无文件,首条 */
    }
    await appendFile(leadsFile, JSON.stringify(lead) + '\n', 'utf8');
    void audit('lead', slug, lead.name || lead.email || lead.phone);
    // 表单直接提交(非 fetch)时给一个友好回执页
    if (ct !== 'application/json') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Thank you</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h1>✅ Thank you!</h1><p>We received your message and will get back to you shortly.</p><p><a href="javascript:history.back()">← Back</a></p></div>');
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // -- 其余 /api/* 需要鉴权 --
  if (!authed(req, url)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (parts[1] === 'health') {
    sendJson(res, 200, { ok: true, sites: SITES, tokenRequired: Boolean(TOKEN) });
    return;
  }

  // GET /api/sites | POST /api/sites
  if (parts[1] === 'sites' && parts.length === 2) {
    if (method === 'GET') {
      await mkdir(SITES, { recursive: true });
      const names = (await readdir(SITES, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
      const list = [];
      for (const slug of names) {
        const meta = await loadMeta(slug);
        let mtime = '';
        try {
          mtime = (await stat(join(siteDir(slug), 'index.html'))).mtime.toISOString();
        } catch {
          /* 无 index.html 也列出 */
        }
        const base = {
          slug,
          track: meta.track,
          baseUrl: meta.baseUrl,
          indexable: meta.indexable,
          builtAt: mtime,
          leads: await countLeads(slug),
          leadsSeenAt: meta.leadsSeenAt,
        };
        if (meta.track === 'clone') {
          const c = await loadClone(slug);
          if (!c) continue;
          // 复刻站没有 theme.json;品牌名取 brand/heading 槽位或 title
          const brand =
            c.doc.slots.find((x) => x.role === 'brand')?.v ||
            c.doc.slots.find((x) => x.id === 'head:title')?.v ||
            slug;
          list.push({ ...base, brandName: brand.slice(0, 60), sourceUrl: c.doc.sourceUrl, generatedAt: c.doc.capturedAt, slots: c.doc.slots.length, colors: null });
        } else {
          const data = await loadSite(slug);
          if (!data) continue;
          list.push({ ...base, brandName: data.content.brandName, sourceUrl: data.content.sourceUrl, colors: data.theme.colors, generatedAt: data.content.generatedAt });
        }
      }
      list.sort((a, b) => (b.builtAt || '').localeCompare(a.builtAt || ''));
      sendJson(res, 200, { sites: list, jobRunning });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body) {
        sendJson(res, 400, { error: 'JSON body 解析失败' });
        return;
      }
      const rawUrl = s(body.url, 500);
      const urlErr = urlAllowed(rawUrl);
      if (urlErr) {
        sendJson(res, 400, { error: urlErr });
        return;
      }
      const slug = s(body.slug, 64) || slugifyUrl(rawUrl);
      if (!SLUG_RE.test(slug)) {
        sendJson(res, 400, { error: 'slug 只能是小写字母/数字/连字符' });
        return;
      }
      const track: SiteTrack = body.track === 'forge' ? 'forge' : 'clone'; // 默认复刻(用户诉求:复刻接受度最高)
      const job = enqueueJob('create', rawUrl, slug, track);
      sendJson(res, 202, { job: { id: job.id, slug: job.slug, track, status: job.status } });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // /api/sites/:slug[/...]
  if (parts[1] === 'sites' && parts.length >= 3) {
    const slug = parts[2];
    if (!SLUG_RE.test(slug)) {
      sendJson(res, 400, { error: '非法 slug' });
      return;
    }
    const sub = parts[3] || '';

    if (!sub && method === 'GET') {
      const meta = await loadMeta(slug);
      let seo: Record<string, unknown> | null = null;
      try {
        seo = seoCheck(await readFile(join(siteDir(slug), 'index.html'), 'utf8'));
      } catch {
        /* 未构建 */
      }
      if (meta.track === 'clone') {
        const c = await loadClone(slug);
        if (!c) {
          sendJson(res, 404, { error: '站点不存在' });
          return;
        }
        // 槽位表可能上百条,列表页只给摘要;全量走 GET /slots
        const byRole: Record<string, number> = {};
        for (const x of c.doc.slots) if (x.role) byRole[x.role] = (byRole[x.role] || 0) + 1;
        sendJson(res, 200, {
          slug,
          track: 'clone',
          meta,
          seo,
          leads: await countLeads(slug),
          clone: { sourceUrl: c.doc.sourceUrl, capturedAt: c.doc.capturedAt, total: c.doc.slots.length, byRole },
        });
        return;
      }
      const data = await loadSite(slug);
      if (!data) {
        sendJson(res, 404, { error: '站点不存在' });
        return;
      }
      sendJson(res, 200, { slug, track: 'forge', ...data, meta, seo, leads: await countLeads(slug) });
      return;
    }

    if (!sub && method === 'DELETE') {
      if (!(await exists(siteDir(slug)))) {
        sendJson(res, 404, { error: '站点不存在' });
        return;
      }
      await mkdir(TRASH, { recursive: true });
      const dest = join(TRASH, `${slug}-${Date.now()}`);
      await rename(siteDir(slug), dest);
      void audit('delete', slug, `→ ${dest}`);
      sendJson(res, 200, { ok: true, trash: dest });
      return;
    }

    if (sub === 'content' && method === 'PUT') {
      const data = await loadSite(slug);
      if (!data) {
        const m = await loadMeta(slug);
        sendJson(res, m.track === 'clone' ? 400 : 404, {
          error: m.track === 'clone' ? '复刻站的编辑面是 slots(见 PUT /slots),不是 content' : '站点不存在',
        });
        return;
      }
      const body = await readJsonBody(req);
      const clean = sanitizeContent(body, data.content);
      if ('err' in clean) {
        sendJson(res, 400, { error: clean.err });
        return;
      }
      await writeFile(join(siteDir(slug), 'content.json'), JSON.stringify(clean, null, 2), 'utf8');
      const r = await rebuildSite(slug);
      void audit('edit-content', slug);
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.err });
      return;
    }

    if (sub === 'theme' && method === 'PUT') {
      const data = await loadSite(slug);
      if (!data) {
        const m = await loadMeta(slug);
        sendJson(res, m.track === 'clone' ? 400 : 404, {
          error: m.track === 'clone' ? '复刻站的编辑面是 slots(见 PUT /slots),不是 theme' : '站点不存在',
        });
        return;
      }
      const body = await readJsonBody(req);
      const clean = sanitizeTheme(body, data.theme);
      if ('err' in clean) {
        sendJson(res, 400, { error: clean.err });
        return;
      }
      await writeFile(join(siteDir(slug), 'theme.json'), JSON.stringify(clean, null, 2), 'utf8');
      const r = await rebuildSite(slug);
      void audit('edit-theme', slug);
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.err });
      return;
    }

    if (sub === 'meta' && method === 'PUT') {
      // 两轨通用:复刻站没有 content.json,不能用 loadSite 校验存在性
      if (!(await exists(siteDir(slug)))) {
        sendJson(res, 404, { error: '站点不存在' });
        return;
      }
      const prev = await loadMeta(slug);
      const body = await readJsonBody(req);
      const clean = sanitizeMeta(body, prev);
      if ('err' in clean) {
        sendJson(res, 400, { error: clean.err });
        return;
      }
      await writeFile(join(siteDir(slug), 'site.json'), JSON.stringify(clean, null, 2), 'utf8');
      // baseUrl / formEnabled / indexable 都影响产物,保存即重建(与内容编辑一致的语义)
      const r = await rebuildSite(slug);
      void audit('edit-meta', slug);
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: (r as { err: string }).err });
      return;
    }

    if (sub === 'rebuild' && method === 'POST') {
      const r = await rebuildSite(slug);
      void audit('rebuild', slug);
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true } : { error: r.err });
      return;
    }

    if (sub === 'refetch' && method === 'POST') {
      const meta1 = await loadMeta(slug);
      let src = '';
      if (meta1.track === 'clone') {
        const c = await loadClone(slug);
        src = c?.doc.sourceUrl || '';
      } else {
        const data = await loadSite(slug);
        src = data?.content.sourceUrl || '';
      }
      if (!src) {
        sendJson(res, 404, { error: '站点不存在或无来源 URL' });
        return;
      }
      const urlErr = urlAllowed(src);
      if (urlErr) {
        sendJson(res, 400, { error: `sourceUrl 不可用: ${urlErr}` });
        return;
      }
      const job = enqueueJob('refetch', src, slug, meta1.track);
      sendJson(res, 202, { job: { id: job.id, slug: job.slug, status: job.status } });
      return;
    }

    if (sub === 'asset' && method === 'POST') {
      const meta0 = await loadMeta(slug);
      const isClone = meta0.track === 'clone';
      const data = isClone ? null : await loadSite(slug);
      if (!isClone && !data) {
        sendJson(res, 404, { error: '站点不存在' });
        return;
      }
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      if (!body) {
        sendJson(res, 400, { error: 'body 过大或解析失败(上限 12MB)' });
        return;
      }
      // 复刻站:target = 要覆写的既有资产文件(assets/<sha1>.<ext>)。
      // 同名覆写是通用解 —— 无论该图被 img src、内联 style 还是 CSS 深处引用,替换都生效。
      const target = typeof body.target === 'string' ? body.target : '';
      const kind = body.kind === 'logo' || body.kind === 'hero' ? body.kind : null;
      if (target) {
        if (!/^assets\/[0-9a-f]{8,32}\.(png|jpe?g|webp|gif|svg|avif|ico)$/i.test(target) || target.includes('..')) {
          sendJson(res, 400, { error: 'target 必须是 assets/<hash>.<ext> 形式的既有资产' });
          return;
        }
        if (!(await exists(join(siteDir(slug), target)))) {
          sendJson(res, 404, { error: '目标资产不存在' });
          return;
        }
      } else if (!kind) {
        sendJson(res, 400, { error: '需提供 kind(logo/hero) 或 target(assets/<hash>.<ext>)' });
        return;
      }
      const m = typeof body.dataUrl === 'string' ? body.dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/) : null;
      if (!m) {
        sendJson(res, 400, { error: '仅支持 png/jpeg/webp/gif 的 dataUrl(不收 svg)' });
        return;
      }
      const extMap: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
      const ext = extMap[m[1]];
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length < 64 || buf.length > 8 * 1024 * 1024) {
        sendJson(res, 400, { error: '图片大小需在 64B~8MB 之间' });
        return;
      }
      // 魔数校验:声明的 MIME 必须与真实字节头一致,防伪装成图片的任意字节落地被外部服务
      const magicOk =
        (m[1] === 'image/png' && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
        (m[1] === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
        (m[1] === 'image/gif' && buf.slice(0, 3).toString('ascii') === 'GIF') ||
        (m[1] === 'image/webp' && buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP');
      if (!magicOk) {
        sendJson(res, 400, { error: '文件字节头与声明的图片类型不符' });
        return;
      }
      await mkdir(join(siteDir(slug), 'assets'), { recursive: true });
      let rel: string;
      if (target) {
        // 同名覆写:保持文件名不变 → 所有既有引用(含 CSS 深处的 url())自动生效
        rel = target;
        await writeFile(join(siteDir(slug), rel), buf);
      } else {
        rel = `assets/${kind}${ext}`;
        await writeFile(join(siteDir(slug), rel), buf);
        if (data) {
          const content = { ...data.content, [kind!]: rel };
          await writeFile(join(siteDir(slug), 'content.json'), JSON.stringify(content, null, 2), 'utf8');
        }
      }
      const r = await rebuildSite(slug);
      void audit('upload-asset', slug, rel);
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, path: rel } : { error: (r as { err: string }).err });
      return;
    }

    // ---- 复刻轨:槽位读写(唯一编辑面;语义字段是它的投影视图,不另存一份) ----
    if (sub === 'slots' && method === 'GET') {
      const c = await loadClone(slug);
      if (!c) {
        sendJson(res, 404, { error: '不是复刻站或槽位数据缺失' });
        return;
      }
      sendJson(res, 200, { slug, total: c.doc.slots.length, slots: c.doc.slots });
      return;
    }

    if (sub === 'slots' && method === 'PUT') {
      const c = await loadClone(slug);
      if (!c) {
        sendJson(res, 404, { error: '不是复刻站或槽位数据缺失' });
        return;
      }
      const body = await readJsonBody(req, 4 * 1024 * 1024);
      const edits = body?.edits;
      if (!edits || typeof edits !== 'object') {
        sendJson(res, 400, { error: 'edits 必须是 {slotId: newValue} 对象' });
        return;
      }
      const byId = new Map(c.doc.slots.map((x) => [x.id, x]));
      let changed = 0;
      const rejected: string[] = [];
      for (const [id, valRaw] of Object.entries(edits as Record<string, unknown>)) {
        const slot = byId.get(id);
        if (!slot) {
          rejected.push(`${id}: 槽位不存在`);
          continue;
        }
        if (typeof valRaw !== 'string') {
          rejected.push(`${id}: 值必须是字符串`);
          continue;
        }
        const limit = slot.type === 'text' ? 2000 : 500;
        const val = valRaw.slice(0, limit);
        // 链接/图片:拒危险协议(与 renderSlots 的 safeUrl 同策略,双保险)
        if ((slot.type === 'link' || slot.type === 'image') && /^\s*(javascript|vbscript|file|about|blob)\s*:/i.test(val)) {
          rejected.push(`${id}: 危险协议被拒`);
          continue;
        }
        if (slot.v !== val) {
          slot.v = val;
          changed++;
        }
      }
      // 锁定标记(refetch 时不被覆盖)
      if (Array.isArray(body.lock)) {
        for (const id of body.lock.slice(0, 2000)) {
          const slot = byId.get(String(id));
          if (slot) slot.locked = true;
        }
      }
      if (Array.isArray(body.unlock)) {
        for (const id of body.unlock.slice(0, 2000)) {
          const slot = byId.get(String(id));
          if (slot) slot.locked = false;
        }
      }
      await writeFile(join(siteDir(slug), 'slots.json'), JSON.stringify(c.doc, null, 1), 'utf8');
      const r = await rebuildSite(slug);
      void audit('edit-slots', slug, `${changed} 项`);
      sendJson(res, r.ok ? 200 : 500, r.ok ? { ok: true, changed, rejected } : { error: (r as { err: string }).err });
      return;
    }

    // ---- 资产清单 + 同名覆写替换(通用图片编辑) ----
    // 实测 82% 的站背景图声明在 <style> 的 CSS 规则里,img@src 槽位点不到 hero。
    // 但 capture 把资产落成 assets/<sha1>.<ext>,所以**同名文件覆写**能让替换无条件生效,
    // 不管引用来自 img src、内联 style 还是 CSS 深处第 137 条规则。零 DOM 分析的通用解。
    if (sub === 'assets' && method === 'GET') {
      const adir = join(siteDir(slug), 'assets');
      let files: string[] = [];
      try {
        files = await readdir(adir);
      } catch {
        sendJson(res, 200, { assets: [] });
        return;
      }
      // 统计引用次数:扫 index.html 全文(覆盖 img src / 内联 style / <style> 内 url())
      let html = '';
      try {
        html = await readFile(join(siteDir(slug), 'index.html'), 'utf8');
      } catch {
        /* ignore */
      }
      const out = [];
      for (const f of files) {
        if (!/\.(png|jpe?g|webp|gif|svg|avif|ico)$/i.test(f)) continue;
        let size = 0;
        try {
          size = (await stat(join(adir, f))).size;
        } catch {
          /* ignore */
        }
        const refs = html.split(f).length - 1;
        out.push({ file: `assets/${f}`, size, refs });
      }
      out.sort((a, b) => b.size - a.size);
      sendJson(res, 200, { assets: out });
      return;
    }

    if (sub === 'leads' && method === 'GET') {
      let leads: unknown[] = [];
      try {
        leads = (await readFile(join(siteDir(slug), 'leads.jsonl'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .reverse();
      } catch {
        /* 无询盘 */
      }
      sendJson(res, 200, { leads });
      return;
    }

    sendJson(res, 404, { error: 'unknown endpoint' });
    return;
  }

  // /api/jobs
  if (parts[1] === 'jobs') {
    if (parts.length === 2) {
      sendJson(res, 200, { jobs: [...jobs.values()].map((j) => ({ ...j, log: undefined })).reverse().slice(0, 50) });
      return;
    }
    const job = jobs.get(parts[2]);
    if (!job) {
      sendJson(res, 404, { error: 'job 不存在' });
      return;
    }
    sendJson(res, 200, { job });
    return;
  }

  // /api/runs — clone 跑批报告
  if (parts[1] === 'runs') {
    if (parts.length === 2) {
      const out = [];
      try {
        const names = (await readdir(RUNS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
        for (const tag of names) {
          const rep = await readJsonFile<any>(join(RUNS, tag, 'report.json'));
          if (!rep) continue;
          let mtime = '';
          try {
            mtime = (await stat(join(RUNS, tag, 'report.json'))).mtime.toISOString();
          } catch {
            /* ignore */
          }
          out.push({ tag, mtime, total: rep.total, captured: rep.captured, failed: rep.failed, meanScore: rep.meanScore, medianScore: rep.medianScore, p10Score: rep.p10Score });
        }
      } catch {
        /* 无 runs 目录 */
      }
      out.sort((a, b) => b.mtime.localeCompare(a.mtime));
      sendJson(res, 200, { runs: out });
      return;
    }
    const tag = parts[2];
    if (!TAG_RE.test(tag)) {
      sendJson(res, 400, { error: '非法 tag' });
      return;
    }
    const rep = await readJsonFile<unknown>(join(RUNS, tag, 'report.json'));
    if (!rep) {
      sendJson(res, 404, { error: '报告不存在' });
      return;
    }
    sendJson(res, 200, { report: rep });
    return;
  }

  // /api/audit — 操作审计尾部
  if (parts[1] === 'audit') {
    let lines: unknown[] = [];
    try {
      lines = (await readFile(AUDIT_FILE, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .slice(-200)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch {
      /* 无审计文件 */
    }
    sendJson(res, 200, { audit: lines });
    return;
  }

  sendJson(res, 404, { error: 'unknown endpoint' });
}

// ---------- 服务器 ----------

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://internal');
  const p = url.pathname;
  void (async () => {
    if (p.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (p === '/' || p === '/admin' || p === '/admin/') {
      try {
        const html = await readFile(UI_FILE);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('admin-ui/index.html 缺失');
      }
      return;
    }
    if (p.startsWith('/sites/')) {
      await serveStatic(SITES, p.slice('/sites/'.length), res);
      return;
    }
    if (p.startsWith('/runs-files/')) {
      await serveStatic(RUNS, p.slice('/runs-files/'.length), res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  })().catch((e) => {
    try {
      sendJson(res, 500, { error: String(e?.message || e).slice(0, 300) });
    } catch {
      /* 响应已发出 */
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n🛠  SiteForge 后管已启动: http://${HOST === '0.0.0.0' ? '<机器IP>' : HOST}:${PORT}/`);
  console.log(`    站点根: ${SITES}`);
  console.log(`    跑批根: ${RUNS}`);
  if (!TOKEN) {
    console.log('    ⚠️  未设置 SF_ADMIN_TOKEN,后台无鉴权 —— 仅限可信内网使用!');
    console.log('       生产请: SF_ADMIN_TOKEN=<随机串> npm run admin');
  }
  console.log('');
});
