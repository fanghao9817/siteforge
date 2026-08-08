import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { assertTag, envNum } from './safe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RUNS = join(ROOT, 'runs');
const WORKER = join(__dirname, 'worker.js');
// 默认 240s:capture(45s goto + 降级重试 + 截图 40s+20s)+ score 的内部预算加起来就超 120s,
// 更小的看门狗会系统性掐死降级路径
const PER_SITE_TIMEOUT = envNum('SF_TIMEOUT', 240000);

interface CorpusSite {
  name: string;
  url: string;
  vertical: string;
  platform: string;
}

interface SiteResult {
  name: string;
  url: string;
  vertical: string;
  platform: string;
  slug: string;
  ok: boolean;
  error?: string;
  assetsOk?: number;
  assetsFail?: number;
  score?: number;
  pixelAccuracy?: number;
  alignedAccuracy?: number;
  heightCoverage?: number;
  refHeight?: number;
  cloneHeight?: number;
}

function slugify(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  } catch {
    return 'site-' + createIdish(url);
  }
}
function createIdish(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 在隔离子进程里跑单站,硬超时兜底。detached 起独立进程组,超时对**整组** SIGKILL——
 * 只杀 node 会把 Playwright 的 Chromium 进程树留成孤儿,1.9G 盒上几只就 OOM。
 */
function runWorker(url: string, outDir: string): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, url, outDir], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (r: any) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      killGroup();
      finish({ ok: false, error: `超时 ${PER_SITE_TIMEOUT}ms 被杀(整进程组)` });
    }, PER_SITE_TIMEOUT);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.length > 16 * 1024 * 1024) out = out.slice(-8 * 1024 * 1024);
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.length > 16 * 1024 * 1024) out = out.slice(-8 * 1024 * 1024);
    });
    child.on('error', (e) => finish({ ok: false, error: `worker 启动失败: ${e.message}`.slice(0, 300) }));
    child.on('close', () => {
      const m = out.match(/__SF_RESULT__(\{.*\})/);
      if (m) {
        try {
          return finish(JSON.parse(m[1]));
        } catch {
          /* fallthrough */
        }
      }
      finish({ ok: false, error: ('子进程无结果: ' + out.slice(-400)).slice(0, 500) });
    });
  });
}

async function runOne(site: CorpusSite, runDir: string, slug: string): Promise<SiteResult> {
  const outDir = join(runDir, slug);
  const base: SiteResult = { name: site.name, url: site.url, vertical: site.vertical, platform: site.platform, slug, ok: false };
  const r = await runWorker(site.url, outDir);
  if (!r.ok) return { ...base, ok: false, error: r.error };
  return {
    ...base,
    ok: true,
    assetsOk: r.assetsOk,
    assetsFail: r.assetsFail,
    score: r.score,
    pixelAccuracy: r.pixelAccuracy,
    alignedAccuracy: r.alignedAccuracy,
    heightCoverage: r.heightCoverage,
    refHeight: r.refHeight,
    cloneHeight: r.cloneHeight,
  };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npm run clone -- <path to corpus.json | https://single-url> [tag]');
    console.error('  e.g.  npm run clone -- corpus/example.json smoke');
    console.error('        npm run clone -- corpus/example.json round1');
    console.error('  env:  SF_CONCURRENCY (default 1; do not exceed 1 on a 1.9GB box)  SF_TIMEOUT (default 240000ms)');
    console.error('        SF_LIMIT (first N sites only)  SF_FREEZE (interval|all|none)');
    process.exit(1);
  }
  const tag = assertTag(process.argv[3] || 'run');
  // 1.9G 生产盒默认单并发:每个 worker 是 node+Chromium(0.5G+),并发 4 必然 swap 颠簸/OOM
  const concurrency = envNum('SF_CONCURRENCY', 1);

  let sites: CorpusSite[];
  if (/^https?:\/\//.test(arg)) {
    sites = [{ name: arg, url: arg, vertical: 'adhoc', platform: 'unknown' }];
  } else {
    const data = JSON.parse(await readFile(arg, 'utf8'));
    sites = data.sites;
    const limit = Number(process.env.SF_LIMIT || 0);
    if (Number.isFinite(limit) && limit > 0) sites = sites.slice(0, limit);
  }

  // slug 预分配 + 冲突消解:同 hostname 不同 URL 并发时,若共用 slug,
  // captureSite 开头的 rm -rf 会删掉对方正在写的产物
  const usedSlugs = new Set<string>();
  const slugs = sites.map((s) => {
    let base = slugify(s.url);
    let x = base;
    let i = 2;
    while (usedSlugs.has(x)) x = `${base}-${i++}`;
    usedSlugs.add(x);
    return x;
  });

  const runDir = join(RUNS, tag);
  await mkdir(runDir, { recursive: true });
  console.log(`\n🏭 克隆跑批:${sites.length} 站,并发 ${concurrency},单站超时 ${PER_SITE_TIMEOUT}ms → runs/${tag}/\n`);

  let done = 0;
  const results = await pool(sites, concurrency, async (site, i) => {
    const r = await runOne(site, runDir, slugs[i]);
    done++;
    const mark = r.ok
      ? `${(r.score! * 100).toFixed(1)}% (aln ${(r.alignedAccuracy! * 100).toFixed(1)} · px ${(r.pixelAccuracy! * 100).toFixed(0)} · h ${(r.heightCoverage! * 100).toFixed(0)})`
      : `❌ ${r.error}`;
    console.log(`  [${done}/${sites.length}] ${r.slug.padEnd(28)} ${mark}`);
    return r;
  });

  const ok = results.filter((r) => r.ok);
  const scores = ok.map((r) => r.score!).sort((a, b) => a - b);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const median = scores.length ? scores[Math.floor(scores.length / 2)] : 0;
  const p10 = scores.length ? scores[Math.floor(scores.length * 0.1)] : 0;

  const report = {
    tag,
    generatedAt: new Date().toISOString(),
    total: sites.length,
    captured: ok.length,
    failed: results.length - ok.length,
    meanScore: mean,
    medianScore: median,
    p10Score: p10,
    results: results.sort((a, b) => (a.score ?? -1) - (b.score ?? -1)),
  };
  await writeFile(join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n📊 汇总 (${tag}):`);
  console.log(`   捕获成功 ${ok.length}/${sites.length}  失败 ${report.failed}`);
  console.log(`   均分 ${(mean * 100).toFixed(1)}%  中位 ${(median * 100).toFixed(1)}%  p10 ${(p10 * 100).toFixed(1)}%`);
  console.log(`\n   最差 8 站(改进重点):`);
  for (const r of report.results.slice(0, 8)) {
    console.log(`     ${r.ok ? (r.score! * 100).toFixed(1) + '%' : '❌'}  ${r.slug}  ${r.ok ? '' : r.error}`);
  }
  console.log(`\n   报告: runs/${tag}/report.json(后管「跑批质量」页可视化)\n`);
}

main().catch((e) => {
  console.error('❌ 跑批失败:', e?.message || e);
  process.exit(1);
});
