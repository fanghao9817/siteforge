// 输入安全共享模块:slug/tag 白名单、URL SSRF 底线。CLI 与后管统一走这里。

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** 校验 slug(站点目录名),不合法直接抛——防路径穿越写出产物根之外。 */
export function assertSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`非法 slug「${slug}」:只允许小写字母/数字/连字符(1~64 位,连字符不打头)`);
  }
  return slug;
}

/** 校验跑批 tag(runs/ 子目录名)。 */
export function assertTag(tag: string): string {
  if (!TAG_RE.test(tag)) {
    throw new Error(`非法 tag「${tag}」:只允许字母/数字/下划线/连字符(1~64 位)`);
  }
  return tag;
}

/**
 * SSRF 底线:仅 http/https,拒绝环回/私网/链路本地/云元数据目标。
 * 返回 null = 允许;否则返回拒绝原因。开发/测试设 SF_ALLOW_PRIVATE=1 放行。
 * 注:这是字面量层防护,DNS 重绑定需上游网络隔离(渲染机独立网段)兜底。
 */
export function urlAllowed(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '不是合法 URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '仅支持 http/https';
  if (process.env.SF_ALLOW_PRIVATE === '1') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local') || h.endsWith('.internal')) return '禁止内网地址';
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0)
      return '禁止内网/保留地址';
  }
  if (h.includes(':') || h.startsWith('[')) return '禁止 IPv6 直连';
  return null;
}

/** 数值环境变量:非法/NaN/非正 → 用默认值,绝不静默变成 0 或 NaN。 */
export function envNum(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`⚠️  环境变量 ${name}="${raw}" 不是正数,回退默认 ${def}`);
    return def;
  }
  return n;
}
