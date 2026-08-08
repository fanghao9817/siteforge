import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VIEWPORT, FREEZE_CSS } from './capture.js';
import { launchBrowser } from './browser.js';

export interface ScoreResult {
  score: number; // 0..1 综合(对齐像素准确率 × 高度覆盖)
  pixelAccuracy: number; // 严格逐像素(pixelmatch)——对位移零容忍,仅供参考
  alignedAccuracy: number; // 分带垂直对齐后的像素准确率(容忍累积位移,反映真实视觉保真)
  heightCoverage: number; // min(h)/max(h),惩罚长度不符
  diffPixels: number;
  refHeight: number;
  cloneHeight: number;
  width: number;
}

function toGray(p: PNG, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (p.width * y + x) << 2;
      g[y * w + x] = (p.data[i] * 77 + p.data[i + 1] * 150 + p.data[i + 2] * 29) >> 8;
    }
  }
  return g;
}

/**
 * 分带垂直对齐 diff:把参考图切成横条,每条用灰度 SAD 在克隆图里 ±D 找最佳垂直偏移,
 * 再对该偏移下的两条用 pixelmatch 精确比(pixelmatch 正确处理抗锯齿+色差,不会误伤干净页面)。
 * 这样"内容一致、只是整体上/下平移"不被冤判成全不同,但缺图/错色/错位仍如实计入。
 */
function alignedDiff(a: PNG, b: PNG, w: number, h: number): number {
  const ga = toGray(a, w, h);
  const gb = toGray(b, w, h);
  const BAND = 100;
  const D = 50; // 最大容忍位移(px)
  const STEP = 4; // 灰度搜索步长
  const rowBytes = w * 4;
  const scratch = new Uint8Array(BAND * rowBytes);
  let diff = 0;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const y1 = Math.min(y0 + BAND, h);
    const bh = y1 - y0;
    // 1) 灰度 SAD 找最佳偏移(便宜、抗噪够用)
    let bestD = 0;
    let bestSad = Infinity;
    for (let d = -D; d <= D; d += STEP) {
      let sad = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 2) {
        const cy = y + d;
        if (cy < 0 || cy >= h) {
          sad += 255 * ((w / 3) | 0);
          n += (w / 3) | 0;
          continue;
        }
        for (let x = 0; x < w; x += 3) {
          sad += Math.abs(ga[y * w + x] - gb[cy * w + x]);
          n++;
        }
      }
      sad /= Math.max(1, n);
      sad += Math.abs(d) * 0.04; // 偏向零位移:平坦条带平局时 d=0 胜,只有明显更优的位移才 override
      if (sad < bestSad) {
        bestSad = sad;
        bestD = d;
      }
    }
    // 2) 用 pixelmatch 精确比这一条。对齐必须"只帮忙不倒扣":同时算 d=0 与最佳偏移,取较小 diff。
    //    (近乎相同的内容上,灰度搜索可能被噪声带偏到错误偏移;取 min 保证干净页面锁定在 px 分)
    const aBand = a.data.subarray(y0 * rowBytes, y1 * rowBytes);
    const out = scratch.subarray(0, bh * rowBytes);
    let bandDiff = pixelmatch(aBand, b.data.subarray(y0 * rowBytes, y1 * rowBytes), out, w, bh, { threshold: 0.1, includeAA: false });
    const cy0 = y0 + bestD;
    if (bestD !== 0 && cy0 >= 0 && cy0 + bh <= h) {
      const shifted = pixelmatch(aBand, b.data.subarray(cy0 * rowBytes, (cy0 + bh) * rowBytes), out, w, bh, { threshold: 0.1, includeAA: false });
      if (shifted < bandDiff) bandDiff = shifted;
    }
    diff += bandDiff;
  }
  return diff;
}

function crop(src: PNG, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (src.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/**
 * 对照回归:两个本地 HTML 文件互比(而非跟 reference.png 比)。
 *
 * 为什么必须这样比:实测同一个**未改动**的克隆文件 20 分钟后重截,分数可差 7 个百分点
 * (残留远程 iframe + 数百条 @font-face 的加载竞速导致渲染非确定性)。
 * 直接跟 reference.png 比会把渲染噪声算到"改造"头上。
 * 所以判断"槽位标注/回填掉了多少分",唯一正确的基准是同一时刻重截的未改动版本。
 */
export async function scoreAgainst(fileA: string, fileB: string, width = VIEWPORT.width): Promise<{ score: number; diffPixels: number; sizeMatch: boolean; hA: number; hB: number }> {
  const browser = await launchBrowser(['--hide-scrollbars']);
  const shots: PNG[] = [];
  try {
    const ctx = await browser.newContext({ viewport: { width, height: VIEWPORT.height }, deviceScaleFactor: 1 });
    for (const f of [fileA, fileB]) {
      const page = await ctx.newPage();
      await page.goto(pathToFileURL(f).href, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);
      const buf = await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 30000 });
      shots.push(PNG.sync.read(Buffer.from(buf)));
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const [a, b] = shots;
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const ca = a.width === w && a.height === h ? a : crop(a, w, h);
  const cb = b.width === w && b.height === h ? b : crop(b, w, h);
  const out = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(ca.data, cb.data, out.data, w, h, { threshold: 0.1, includeAA: false });
  return {
    score: 1 - diffPixels / (w * h),
    diffPixels,
    sizeMatch: a.width === b.width && a.height === b.height,
    hA: a.height,
    hB: b.height,
  };
}

/** 渲染克隆站整页截图,与 reference.png 做像素 diff。写出 clone.png / diff.png。 */
export async function scoreClone(outDir: string): Promise<ScoreResult> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const fileUrl = pathToFileURL(join(outDir, 'index.html')).href;
    await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(async () => {
      await page.goto(fileUrl, { waitUntil: 'load', timeout: 30000 });
    });
    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    // 护栏:若克隆异常高(某元素没 JS 时撑爆),fullPage 截图会卡死。超过阈值就裁到上限——
    // 分数会因高度不符自然变低(如实反映缺陷),但绝不拖挂管线。
    const docH = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
    const MAX_H = 60000;
    const shotOpts: any = { path: join(outDir, 'clone.png'), animations: 'disabled', timeout: 40000 };
    if (docH > MAX_H) shotOpts.clip = { x: 0, y: 0, width: VIEWPORT.width, height: MAX_H };
    else shotOpts.fullPage = true;
    try {
      await page.screenshot(shotOpts);
    } catch {
      await page.addStyleTag({ content: '*{font-family:Arial,Helvetica,sans-serif!important}' }).catch(() => {});
      await page.screenshot({ ...shotOpts, timeout: 20000 });
    }
    await browser.close();

    const ref = PNG.sync.read(await readFile(join(outDir, 'reference.png')));
    const clone = PNG.sync.read(await readFile(join(outDir, 'clone.png')));
    const w = Math.min(ref.width, clone.width);
    const h = Math.min(ref.height, clone.height);
    const a = ref.width === w && ref.height === h ? ref : crop(ref, w, h);
    const b = clone.width === w && clone.height === h ? clone : crop(clone, w, h);

    const diff = new PNG({ width: w, height: h });
    const diffPixels = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1, includeAA: false });
    await writeFile(join(outDir, 'diff.png'), PNG.sync.write(diff));

    const pixelAccuracy = 1 - diffPixels / (w * h);
    const alignedAccuracy = 1 - alignedDiff(a, b, w, h) / (w * h);
    const heightCoverage = Math.min(ref.height, clone.height) / Math.max(ref.height, clone.height);
    const score = alignedAccuracy * heightCoverage;
    return {
      score,
      pixelAccuracy,
      alignedAccuracy,
      heightCoverage,
      diffPixels,
      refHeight: ref.height,
      cloneHeight: clone.height,
      width: w,
    };
  } finally {
    if (browser.isConnected()) await browser.close();
  }
}
