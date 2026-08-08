import { buildContent } from '../dist/extract/content.js';
import { extractContacts } from '../dist/extract/contacts.js';
import { buildTheme } from '../dist/extract/brand.js';
import { themeVars } from '../dist/styles.js';

let pass=0, fail=0;
const ok=(n,c)=>{ (c?pass++:fail++); console.log((c?'✅':'❌')+' '+n); };

// -- 品牌名:词内连字符 & SEO 多段标题 --
const mkCap = (title, host='x.com') => ({ url:'https://'+host, title, description:'', headings:[], paragraphs:[], sections:[], fullText:'', html:'', lang:'', pageBg:[255,255,255], logo:null, hero:null, backgrounds:[], texts:[], accents:[], headingFont:'', bodyFont:'' });
ok("K-OAK 词内连字符不被劈", buildContent(mkCap('Lawn Care | Burnaby | K-OAK Landscape','k-oak.example'),'k-oak.example').brandName.includes('K-OAK'));
ok("host 印证段优先于最短段", buildContent(mkCap('Plumber Vancouver | Hillcrest Plumbing','hillcrestplumbing.ca'),'hillcrestplumbing.ca').brandName.toLowerCase().includes('hillcrest'));
ok("裸连字符品牌 Take-Out 保留", buildContent(mkCap('Take-Out Kitchen','takeoutkitchen.com'),'takeoutkitchen.com').brandName==='Take-Out Kitchen');

// -- 地址污染:电话碎片不该冒充街号 --
const c1 = extractContacts('Phone: 604-555-0188 Email: hi@x.ca 4567 Oak Street, Vancouver, BC V6H 2K9','','x.ca');
ok("地址从街号起,不吞电话碎片", c1.address.startsWith('4567 Oak'));
ok("地址不含 Email 字样", !/email/i.test(c1.address));
// -- 美国地址锚定 --
const c2 = extractContacts('Visit us at 88 Elm Ave, Springfield, IL 62704 today','','x.com');
ok("美国 州+zip 锚定地址", c2.address.includes('Elm Ave'));
// -- 多行营业时间 --
const c3 = extractContacts('Mon 9:00-17:00 Tue 9:00-17:00 Sat 10am-2pm','','x.com');
ok("多行营业时间合并(≥2 段)", (c3.hours.match(/·/g)||[]).length>=1);
ok("营业时间支持 am/pm", /2pm|2 pm/i.test(c3.hours));

// -- 字体 XSS 消毒 --
const evilCap = mkCap('Evil');
evilCap.headingFont = '</style><script>alert(1)</script>, sans-serif';
evilCap.bodyFont = 'x;}body{display:none}';
const t = buildTheme(evilCap);
const css = themeVars(t);
ok("themeVars 输出无 </style>", !/<\/style>/i.test(css));
ok("themeVars 输出无 <script", !/<script/i.test(css));
ok("themeVars 输出无裸 } 注入", !css.includes('}body{'));

// -- 颜色对比度:浅色主色不产生不可读正文 --
const lightCap = mkCap('Bright');
lightCap.accents=[{c:[255,215,0],w:5000}]; // 亮黄
lightCap.backgrounds=[{c:[255,255,255],w:20000}];
lightCap.texts=[{c:[200,200,200],w:3000}]; // 浅灰文字(对比不足)
const lt = buildTheme(lightCap);
// text 应被推深到与白底对比≥4.5
const relLum=([r,g,b])=>{const f=v=>{const s=v/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4)};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)};
const hx=h=>[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];
const ctr=(a,b)=>{const l1=relLum(a),l2=relLum(b);const[hi,lo]=l1>l2?[l1,l2]:[l2,l1];return (hi+0.05)/(lo+0.05)};
ok("正文对白底对比度≥4.5", ctr(hx(lt.colors.text),hx(lt.colors.bg))>=4.5);

console.log(`\n== 单元: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail?1:0);
