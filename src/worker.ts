import { captureSite } from './capture.js';
import { scoreClone } from './score.js';

// 单站 worker:被 clone-loop 以子进程方式调用,capture + score 一个 URL。
// 进程隔离的意义:任何单站的崩溃/卡死/OOM 都只死这个子进程,不拖垮整批。
const url = process.argv[2];
const outDir = process.argv[3];

(async () => {
  const cap = await captureSite(url, outDir);
  const s = await scoreClone(outDir);
  process.stdout.write(
    '\n__SF_RESULT__' +
      JSON.stringify({ ok: true, assetsOk: cap.assetsOk, assetsFail: cap.assetsFail, ...s }) +
      '\n',
  );
})().catch((e) => {
  // 错误别截太短:Playwright 的修复提示(如 npx playwright install)在消息尾部
  process.stdout.write('\n__SF_RESULT__' + JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 2000) }) + '\n');
  process.exit(1);
});
