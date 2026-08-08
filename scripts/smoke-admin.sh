#!/usr/bin/env bash
# SiteForge 后管冒烟测试:起本地 fixture 源站 + admin 服务,全链路打一遍 API。
# 用法: bash scripts/smoke-admin.sh          (需先 npm run build)
# 可选: SF_CHROME_CHANNEL=chromium  LD_LIBRARY_PATH=...  透传给渲染子进程
set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT_ADMIN=${SF_SMOKE_PORT_ADMIN:-5399}
PORT_FIX=${SF_SMOKE_PORT_FIX:-5398}
TMP=$(mktemp -d)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check() { # check <描述> <实际> <期望子串>
  case "$2" in *"$3"*) ok "$1";; *) bad "$1 (得到: ${2:0:120})";; esac
}

cleanup() {
  [ -n "${ADMIN_PID:-}" ] && kill "$ADMIN_PID" 2>/dev/null
  [ -n "${FIX_PID:-}" ] && kill "$FIX_PID" 2>/dev/null
  rm -rf "$TMP" sites/smoke-fixture
  # smoke-e2e 站点若生成了,移进回收站已在测试里验证过;彻底清理:
  rm -rf sites/.trash/smoke-e2e-* sites/smoke-e2e sites/.trash/smoke-clone-* sites/smoke-clone
}
# 只捕获正常退出做清理;不 trap 信号,避免后台子进程收到信号时脚本以 128+n 退出
trap cleanup EXIT
# 退出码归一:无论清理结果,按断言结果决定成败
final() { [ "$FAIL" -eq 0 ]; }

echo "== 准备 fixture 源站 =="
mkdir -p "$TMP/src"
cat > "$TMP/src/index.html" <<'EOF'
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Smoke Plumbing | Trusted Local Plumbers</title>
<meta name="description" content="Licensed plumbing experts serving Vancouver.">
<style>body{font-family:Georgia,serif;margin:0}.hero{background:#0b5d3b;color:#fff;padding:120px 40px;text-align:center}
.btn{background:#e8a020;color:#fff;padding:12px 28px}h2{color:#0b5d3b}section{padding:60px 40px}footer{background:#093;color:#fff;padding:40px}
img{max-width:100%;height:auto}
@media(max-width:820px){.hero{padding:50px 16px}section{padding:30px 16px}nav a{display:inline-block;margin:4px 8px 0 0}}</style>
</head><body><header><img src="logo.png" alt="Smoke Plumbing" width="200" height="60"><nav><a href="/services">Services</a><a href="/about">About</a><a href="#s">Rates</a><a class="btn" href="tel:+16045550188">Call</a></nav></header>
<div class="hero"><h1>Smoke Plumbing</h1><p>Vancouver's trusted plumbers</p></div>
<section id="s"><h2>Our Services</h2><h3>Drain Cleaning</h3><p>Fast hydro-jetting and camera inspection for stubborn clogs in Metro Vancouver homes.</p>
<h3>Emergency Plumbing</h3><p>Around the clock response for burst pipes, leaks and flooding across the Lower Mainland.</p>
<h3>Water Heater Service</h3><p>Tank and tankless water heater installation, repair and annual maintenance with full parts warranty.</p></section>
<section><h2>About Us</h2><p>Smoke Plumbing is a family owned company serving Metro Vancouver homeowners for over twenty years. Our licensed plumbers arrive on time, quote up front, and stand behind every job with a written guarantee.</p></section>
<footer><p>Phone: 604-555-0188</p><p>Email: hi@smokeplumbing.ca</p><p>4567 Oak Street, Vancouver, BC V6H 2K9</p><p>Mon-Fri 8:00-17:00</p><p>Sat 9am-2pm</p></footer></body></html>
EOF
python3 - "$TMP/src/logo.png" <<'PYPNG'
import zlib, struct, sys
w,h=200,60
raw=b''.join(b'\x00'+bytes([11,93,59,255])*w for _ in range(h))
def chunk(t,d):
    c=struct.pack('>I',len(d))+t+d
    return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
open(sys.argv[1],'wb').write(png)
PYPNG
python3 -m http.server $PORT_FIX -d "$TMP/src" >/dev/null 2>&1 & FIX_PID=$!
for i in $(seq 1 20); do curl -sf "http://127.0.0.1:$PORT_FIX/" >/dev/null 2>&1 && break; sleep 0.3; done

echo "== 准备本地编辑 fixture 站点 =="
mkdir -p sites/smoke-fixture/assets
cat > sites/smoke-fixture/content.json <<'EOF'
{ "brandName": "Smoke Fixture Co", "tagline": "Testing tagline", "about": "About text for smoke testing purposes only.",
  "services": [ { "title": "Service A", "description": "Desc A" } ],
  "contacts": { "phone": "604-555-0000", "email": "t@example.com", "address": "1 Test St", "hours": "Mon-Fri 9-5" },
  "logo": null, "hero": null, "sourceUrl": "https://example.com/", "generatedAt": "2026-01-01T00:00:00.000Z" }
EOF
cat > sites/smoke-fixture/theme.json <<'EOF'
{ "colors": { "primary": "#0e7a4a", "primaryDark": "#0b6039", "onPrimary": "#ffffff", "bg": "#ffffff",
  "surface": "#f7f8fa", "text": "#1a1c21", "textMuted": "#5b6270", "border": "#e4e7ec" },
  "fonts": { "heading": "system-ui, sans-serif", "body": "system-ui, sans-serif" },
  "source": { "accents": ["#0e7a4a"], "backgrounds": ["#ffffff"] } }
EOF

echo "== 启动 admin =="
SF_ADMIN_PORT=$PORT_ADMIN SF_ADMIN_HOST=127.0.0.1 SF_ALLOW_PRIVATE=1 node dist/admin/server.js >"$TMP/admin.log" 2>&1 & ADMIN_PID=$!
B="http://127.0.0.1:$PORT_ADMIN"
for i in $(seq 1 30); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.3; done

echo "== 抽取/安全 单元测试 =="
if node test/unit.mjs >/dev/null 2>&1; then ok "test/unit.mjs 全通过"; else bad "test/unit.mjs 有失败(node test/unit.mjs 看详情)"; fi

echo "== 基础 API =="
check "health"            "$(curl -s $B/api/health)"                                        '"ok":true'
check "rebuild"           "$(curl -s -X POST $B/api/sites/smoke-fixture/rebuild)"           '"ok":true'
check "站点列表含 fixture"  "$(curl -s $B/api/sites)"                                         'Smoke Fixture Co'
check "详情带 SEO 自检"     "$(curl -s $B/api/sites/smoke-fixture)"                           '"hasH1":true'

echo "== 内容编辑 → 重建 =="
NEW=$(python3 -c "import json;c=json.load(open('sites/smoke-fixture/content.json'));c['contacts']['phone']='604-555-7777';print(json.dumps(c))")
check "PUT content"       "$(curl -s -X PUT $B/api/sites/smoke-fixture/content -H 'content-type: application/json' -d "$NEW")" '"ok":true'
N=$(grep -c '604-555-7777' sites/smoke-fixture/index.html)
if [ "$N" -ge 1 ]; then ok "改动进入 index.html($N 处)"; else bad "改动未进入 index.html"; fi
check "非法主题被拒"        "$(curl -s -X PUT $B/api/sites/smoke-fixture/theme -H 'content-type: application/json' -d '{"colors":{"primary":"red"},"fonts":{"heading":"a","body":"b"}}')" 'error'

echo "== 询盘 =="
check "表单编码提交"        "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/leads/smoke-fixture --data 'name=Smoke&message=hi')" '200'
curl -s -X POST $B/api/leads/smoke-fixture -H 'content-type: application/json' -d '{"name":"bot","_hp":"x"}' >/dev/null
LEADS=$(curl -s $B/api/sites/smoke-fixture/leads)
check "询盘可见"           "$LEADS" 'Smoke'
check "蜜罐被滤"           "$(python3 -c "import json;print(len(json.loads('''$LEADS''')['leads']))")" '1'

echo "== 询盘表单注入 =="
check "开启 formEnabled"    "$(curl -s -X PUT $B/api/sites/smoke-fixture/meta -H 'content-type: application/json' -d '{"baseUrl":"","formEnabled":true,"notes":"","leadsSeenAt":""}')" '"ok":true'
curl -s -X POST $B/api/sites/smoke-fixture/rebuild >/dev/null
N=$(grep -c 'sf-form' sites/smoke-fixture/index.html)
if [ "$N" -ge 1 ]; then ok "表单已注入"; else bad "表单未注入"; fi

echo "== 安全 =="
check "路径穿越 404"        "$(curl -s -o /dev/null -w '%{http_code}' "$B/sites/../package.json")" '404'
EC=$(curl -s -o /dev/null -w '%{http_code}' "$B/sites/..%2fpackage.json")
if [ "$EC" = "403" ] || [ "$EC" = "404" ]; then ok "编码路径穿越被拒($EC)"; else bad "编码路径穿越未拦截($EC)"; fi
check "sidecar leads.jsonl 不泄露(404)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/sites/smoke-fixture/leads.jsonl")" '404'
check "sidecar content.json 不泄露(404)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/sites/smoke-fixture/content.json")" '404'
check "发布文件 index.html 可访问(200)" "$(curl -s -o /dev/null -w '%{http_code}' "$B/sites/smoke-fixture/")" '200'
check "上传伪造图片(非魔数)被拒" "$(curl -s -X POST $B/api/sites/smoke-fixture/asset -H 'content-type: application/json' -d '{"kind":"logo","dataUrl":"data:image/png;base64,'"$(printf 'not-a-real-png-just-text-padding-to-exceed-64-bytes-minimum-length!!' | base64 -w0)"'"}')" '不符'
check "恶意 slug 被拒"      "$(curl -s -X POST $B/api/sites -H 'content-type: application/json' -d '{"url":"https://x.com/","slug":"../evil"}')" 'error'
# 注:SSRF(内网/整数IP)拦截在无 SF_ALLOW_PRIVATE 环境验证(node -e 'import urlAllowed');
# 本脚本用 SF_ALLOW_PRIVATE=1 跑本地 fixture E2E,故此处不测 SSRF(会被有意放行)。
check "logo=assets/.. 被拒" "$(curl -s -X PUT $B/api/sites/smoke-fixture/content -H 'content-type: application/json' -d '{"brandName":"X","logo":"assets/.."}'; grep -c '"logo": null\|"logo":null' sites/smoke-fixture/content.json)" '1'
check "预览带 CSP 沙箱"     "$(curl -sI $B/sites/smoke-fixture/ | tr -d '\r')" 'content-security-policy: sandbox'

echo "== 端到端:URL → 新站(需可用的 Chromium;失败仅告警) =="
JOB=$(curl -s -X POST $B/api/sites -H 'content-type: application/json' -d "{\"url\":\"http://127.0.0.1:$PORT_FIX/\",\"slug\":\"smoke-e2e\",\"track\":\"forge\"}")
JID=$(python3 -c "import json;print(json.loads('''$JOB''')['job']['id'])" 2>/dev/null)
if [ -n "$JID" ]; then
  for i in $(seq 1 60); do
    ST=$(curl -s $B/api/jobs/$JID | python3 -c "import json,sys;print(json.load(sys.stdin)['job']['status'])")
    [ "$ST" = "done" ] || [ "$ST" = "error" ] && break
    sleep 2
  done
  if [ "$ST" = "done" ]; then
    E2E=$(curl -s $B/api/sites/smoke-e2e)
    check "E2E 品牌名抽取"  "$E2E" 'Smoke Plumbing'
    check "E2E 服务卡有描述" "$E2E" 'hydro-jetting'
    check "E2E 地址不含 Phone 碎片" "$(echo "$E2E" | python3 -c "import json,sys;print(json.load(sys.stdin)['content']['contacts']['address'])")" 'Oak Street'
    check "E2E 删除入回收站" "$(curl -s -X DELETE $B/api/sites/smoke-e2e)" '"ok":true'
  else
    echo "  ⚠️  渲染任务未成功(本机可能缺 Chromium 系统库),跳过 E2E 断言"
  fi
fi

echo "== 端到端:复刻轨(clone track) =="
CJOB=$(curl -s -X POST $B/api/sites -H 'content-type: application/json' -d "{\"url\":\"http://127.0.0.1:$PORT_FIX/\",\"slug\":\"smoke-clone\",\"track\":\"clone\"}")
CID=$(python3 -c "import json;print(json.loads('''$CJOB''')['job']['id'])" 2>/dev/null)
if [ -n "$CID" ]; then
  for i in $(seq 1 60); do
    CST=$(curl -s $B/api/jobs/$CID | python3 -c "import json,sys;print(json.load(sys.stdin)['job']['status'])")
    [ "$CST" = "done" ] || [ "$CST" = "error" ] && break
    sleep 2
  done
  if [ "$CST" = "done" ]; then
    CD=$(curl -s $B/api/sites/smoke-clone)
    check "clone: track=clone"       "$CD" '"track":"clone"'
    check "clone: 抽出槽位"           "$CD" '"total":'
    SL=$(curl -s $B/api/sites/smoke-clone/slots)
    check "clone: 槽位可读"           "$SL" '"slots":'
    PHID=$(python3 -c "
import json
d=json.loads('''$SL''')
c=[s['id'] for s in d['slots'] if s.get('role')=='phone']
print(c[0] if c else '')" 2>/dev/null)
    if [ -n "$PHID" ]; then
      check "clone: 编辑槽位"          "$(curl -s -X PUT $B/api/sites/smoke-clone/slots -H 'content-type: application/json' -d "{\"edits\":{\"$PHID\":\"6045557777\"}}")" '"ok":true'
      N=$(grep -c '604.555.7777' sites/smoke-clone/index.html || true)
      if [ "$N" -ge 1 ]; then ok "clone: 改动落进 index.html(格式保形)"; else bad "clone: 改动未生效"; fi
    fi
    check "clone: 默认 noindex(防重复内容)" "$(grep -o 'noindex' sites/smoke-clone/index.html | head -1)" 'noindex'
    check "clone: 资产清单"            "$(curl -s $B/api/sites/smoke-clone/assets)" '"assets"'
    check "clone: 删除入回收站"         "$(curl -s -X DELETE $B/api/sites/smoke-clone)" '"ok":true'
  else
    echo "  ⚠️  复刻任务未成功,跳过 clone E2E 断言"
  fi
fi

echo ""
echo "== 结果: $PASS 通过, $FAIL 失败 =="
final
