/**
 * fill.html 前端验证脚本
 * - 自建临时静态服务器提供 fill.html（避免依赖尚未启动的 3000 端口）
 * - 用 page.route 拦截并 mock 两个接口
 * - 覆盖 6 项验证并截图到 test_shots/fill_*.png
 */
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'test_shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const PORT = 3999;
const TOKEN = 'tok_test_2026';
const URL_PAGE = `http://127.0.0.1:${PORT}/fill.html?t=${TOKEN}`;

/* ---------------- mock 数据 ---------------- */
function baseForm() {
  return {
    ok: true,
    month: '2026-08',
    fileName: '8月集团门诊后台得分和星级分析.xlsx',
    totalPending: 8,
    stores: [
      {
        storeName: '常德爱尔眼科西街门诊', city: '常德市', region: null, manager: '张三',
        meituanStar: null, dianpingStar: 0, opsScore: 64,
        missing: ['region', 'meituanStar'],
        suggestions: { region: { value: '湖南省区', from: '常德市同城 2 家门店', confidence: 100 } }
      },
      {
        storeName: '长沙爱尔眼科门诊', city: '长沙市', region: '湖南省区', manager: '李四',
        meituanStar: 4.6, dianpingStar: null, opsScore: 88,
        missing: ['dianpingStar'], suggestions: {}
      },
      {
        storeName: '济南爱尔眼科门诊', city: '济南市', region: '山东省区', manager: '张三',
        meituanStar: 4.1, dianpingStar: 4.3, opsScore: null,
        missing: ['opsScore'], suggestions: {}
      },
      {
        storeName: '潍坊爱尔眼科门诊', city: '潍坊市', region: null, manager: '李四',
        meituanStar: 3.8, dianpingStar: 3.9, opsScore: null,
        missing: ['region', 'opsScore'], suggestions: {}
      },
      {
        storeName: '青岛爱尔眼科门诊', city: '青岛市', region: '山东省区', manager: '张三',
        meituanStar: null, dianpingStar: 4.4, opsScore: 91,
        missing: ['meituanStar'], suggestions: {}
      },
      {
        storeName: '株洲爱尔眼科门诊', city: '株洲市', region: null, manager: '李四',
        meituanStar: null, dianpingStar: null, opsScore: null,
        missing: ['region', 'dianpingStar', 'opsScore'], suggestions: {}
      },
      {
        storeName: '烟台爱尔眼科门诊', city: '烟台市', region: '山东省区', manager: '张三',
        meituanStar: 4.0, dianpingStar: null, opsScore: 77,
        missing: ['dianpingStar'], suggestions: {}
      },
      {
        storeName: '岳阳爱尔眼科门诊', city: '岳阳市', region: '湖南省区', manager: '李四',
        meituanStar: null, dianpingStar: 4.2, opsScore: 83,
        missing: ['meituanStar'], suggestions: {}
      }
    ],
    regions: ['湖南省区', '山东省区'],
    managers: ['张三', '李四']
  };
}

/* 提交成功后服务端返回的快照：去掉本次填满的三家 */
const FILLED = ['常德爱尔眼科西街门诊', '长沙爱尔眼科门诊', '潍坊爱尔眼科门诊'];
function afterSubmitForm() {
  const f = baseForm();
  f.stores = f.stores.filter(s => FILLED.indexOf(s.storeName) === -1);
  f.totalPending = f.stores.length;
  return f;
}

/* ---------------- 静态服务器 ---------------- */
function startStatic() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(p).toLowerCase();
      const type = ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(buf);
    });
  });
  return new Promise(r => server.listen(PORT, '127.0.0.1', () => r(server)));
}

/* ---------------- 断言工具 ---------------- */
const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''));
}

(async () => {
  const server = await startStatic();
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--no-proxy-server', '--proxy-bypass-list=*']
  });

  let phase = 1;          // 1=初始表单；2=提交后表单
  let submitCalls = 0;
  let lastSubmitBody = null;

  const ctx = await browser.newContext({
    viewport: { width: 375, height: 780 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });
  const page = await ctx.newPage();

  await page.route('**/api/monthly-fill-form*', async route => {
    const body = phase === 1 ? baseForm() : afterSubmitForm();
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
  });
  await page.route('**/api/monthly-fill-submit', async route => {
    submitCalls++;
    lastSubmitBody = JSON.parse(route.request().postData() || '{}');
    phase = 2;
    await new Promise(r => setTimeout(r, 600)); /* 留出"提交中…"状态以便断言 */
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        ok: true, saved: 3, remaining: 5, storeCount: 215,
        message: '已保存 3 家门店，还剩 5 家待填'
      })
    });
  });

  page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  /* ---------- 1. 375px 渲染与横向滚动 ---------- */
  await page.goto(URL_PAGE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card');
  await page.waitForTimeout(250);

  const metrics = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    bw: document.body.scrollWidth,
    cards: document.querySelectorAll('.card').length,
    sub: document.getElementById('hd-sub').textContent.trim(),
    count: document.getElementById('f-count').textContent.trim(),
    sticky: getComputedStyle(document.getElementById('filters')).position
  }));
  ok('1a 无横向滚动条(375px)', metrics.sw <= metrics.iw + 1 && metrics.bw <= metrics.iw + 1,
    `scrollWidth=${metrics.sw} innerWidth=${metrics.iw}`);
  ok('1b 卡片全部渲染', metrics.cards === 8, `cards=${metrics.cards}`);
  ok('1c 副标题格式', /^2026-08 · 待填 8 家$/.test(metrics.sub), metrics.sub);
  ok('1d 筛选区吸顶', metrics.sticky === 'sticky', metrics.sticky);
  await page.screenshot({ path: path.join(OUT, 'fill_01_mobile_top.png') });
  await page.screenshot({ path: path.join(OUT, 'fill_01b_mobile_full.png'), fullPage: true });

  /* ---------- 2. 筛选下拉过滤 ---------- */
  await page.selectOption('#f-region', '湖南省区');
  await page.waitForTimeout(200);
  const r1 = await page.evaluate(() => ({
    count: document.getElementById('f-count').textContent.trim(),
    names: Array.from(document.querySelectorAll('.store-name')).map(n => n.textContent.trim())
  }));
  ok('2a 省区筛选=湖南省区 → 3 家', r1.count === '3 家' && r1.names.length === 3, r1.names.join(' / '));

  await page.selectOption('#f-manager', '张三');
  await page.waitForTimeout(200);
  const r2 = await page.evaluate(() => ({
    count: document.getElementById('f-count').textContent.trim(),
    names: Array.from(document.querySelectorAll('.store-name')).map(n => n.textContent.trim())
  }));
  ok('2b 叠加经理筛选=张三 → 1 家', r2.count === '1 家' && r2.names[0] === '常德爱尔眼科西街门诊', r2.count);
  await page.screenshot({ path: path.join(OUT, 'fill_02_filtered.png') });

  await page.selectOption('#f-region', '');
  await page.selectOption('#f-manager', '');
  await page.fill('#f-search', '潍坊');
  await page.waitForTimeout(300);
  const r3 = await page.evaluate(() => ({
    count: document.getElementById('f-count').textContent.trim(),
    names: Array.from(document.querySelectorAll('.store-name')).map(n => n.textContent.trim())
  }));
  ok('2c 关键词搜索=潍坊 → 1 家', r3.count === '1 家' && r3.names[0] === '潍坊爱尔眼科门诊', r3.names.join('/'));

  await page.fill('#f-search', '');
  await page.waitForTimeout(300);
  const r4 = await page.evaluate(() => document.getElementById('f-count').textContent.trim());
  ok('2d 清空筛选恢复 8 家', r4 === '8 家', r4);

  /* ---------- 3. 推荐条点击填入省区 ---------- */
  await page.click('.rec[data-rec="常德爱尔眼科西街门诊"]');
  await page.waitForTimeout(250);
  const recState = await page.evaluate(() => {
    const input = document.querySelector('.inp[data-store="常德爱尔眼科西街门诊"][data-field="region"]');
    const rec = document.querySelector('.rec[data-rec="常德爱尔眼科西街门诊"]');
    return {
      val: input.value,
      used: rec.classList.contains('used'),
      mark: rec.querySelector('.rec-mark').textContent.trim(),
      barN: document.getElementById('bar-n').textContent.trim(),
      btn: document.getElementById('btn-submit').textContent.trim()
    };
  });
  ok('3 推荐条填入省区', recState.val === '湖南省区' && recState.used && recState.mark === '已填入',
    `value=${recState.val} mark=${recState.mark}`);
  ok('3b 底部计数联动', recState.barN === '1' && recState.btn === '提交 1 家', `${recState.btn}`);
  await page.screenshot({ path: path.join(OUT, 'fill_03_rec_filled.png') });

  /* ---------- 4. 输入值刷新后仍在（localStorage） ---------- */
  await page.fill('.inp[data-store="常德爱尔眼科西街门诊"][data-field="meituanStar"]', '4.2');
  await page.fill('.inp[data-store="潍坊爱尔眼科门诊"][data-field="opsScore"]', '96');
  await page.waitForTimeout(200);
  const draftRaw = await page.evaluate(k => localStorage.getItem(k), 'mi_fill_draft_' + TOKEN);
  ok('4a 草稿写入 localStorage', !!draftRaw && draftRaw.indexOf('4.2') > -1, draftRaw);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.card');
  await page.waitForTimeout(300);
  const afterReload = await page.evaluate(() => {
    const a = document.querySelector('.inp[data-store="常德爱尔眼科西街门诊"][data-field="meituanStar"]');
    const b = document.querySelector('.inp[data-store="潍坊爱尔眼科门诊"][data-field="opsScore"]');
    const c = document.querySelector('.inp[data-store="常德爱尔眼科西街门诊"][data-field="region"]');
    return {
      star: a ? a.value : null, score: b ? b.value : null, region: c ? c.value : null,
      barN: document.getElementById('bar-n').textContent.trim()
    };
  });
  ok('4b 刷新后草稿恢复', afterReload.star === '4.2' && afterReload.score === '96' && afterReload.region === '湖南省区',
    `star=${afterReload.star} score=${afterReload.score} region=${afterReload.region}`);
  await page.screenshot({ path: path.join(OUT, 'fill_04_draft_restored.png') });

  /* ---------- 5. 非法星级被拦截 ---------- */
  const before = submitCalls;
  await page.fill('.inp[data-store="长沙爱尔眼科门诊"][data-field="dianpingStar"]', '8');
  await page.waitForTimeout(150);
  await page.click('#btn-submit');
  await page.waitForTimeout(500);
  const invalid = await page.evaluate(() => {
    const input = document.querySelector('.inp[data-store="长沙爱尔眼科门诊"][data-field="dianpingStar"]');
    const box = input.parentNode.querySelector('.err-msg');
    const t = document.getElementById('toast');
    return {
      cls: input.classList.contains('invalid'),
      msg: box && !box.hidden ? box.textContent.trim() : '',
      toast: t.className.indexOf('show') > -1 ? t.textContent.trim() : ''
    };
  });
  ok('5a 星级 8 标红并提示', invalid.cls && /0~5/.test(invalid.msg), `msg=${invalid.msg}`);
  ok('5b 未发起提交请求', submitCalls === before, `submitCalls=${submitCalls}`);
  ok('5c 顶部提示校验失败', /修正/.test(invalid.toast), invalid.toast || '(无 toast)');
  await page.screenshot({ path: path.join(OUT, 'fill_05_invalid_star.png') });

  /* 修正为合法值，验证标红消失 */
  await page.fill('.inp[data-store="长沙爱尔眼科门诊"][data-field="dianpingStar"]', '4.5');
  await page.waitForTimeout(200);
  const cleared = await page.evaluate(() => {
    const input = document.querySelector('.inp[data-store="长沙爱尔眼科门诊"][data-field="dianpingStar"]');
    return !input.classList.contains('invalid');
  });
  ok('5d 修正后标红消失', cleared);

  /* ---------- 6. 提交成功 + 列表刷新 ---------- */
  const cnt = await page.evaluate(() => document.querySelectorAll('.card').length);
  await page.click('#btn-submit');
  await page.waitForTimeout(180);
  const submittingText = await page.evaluate(() => ({
    txt: document.getElementById('btn-submit').textContent.trim(),
    dis: document.getElementById('btn-submit').disabled
  }));
  await page.waitForTimeout(1200);
  const done = await page.evaluate(() => ({
    toast: (() => { const t = document.getElementById('toast'); return t.className.indexOf('show') > -1 ? t.textContent.trim() : ''; })(),
    sub: document.getElementById('hd-sub').textContent.trim(),
    cards: Array.from(document.querySelectorAll('.store-name')).map(n => n.textContent.trim()),
    count: document.getElementById('f-count').textContent.trim(),
    draft: localStorage.getItem('mi_fill_draft_' + 'tok_test_2026'),
    barN: document.getElementById('bar-n').textContent.trim()
  }));
  const sent = lastSubmitBody || {};
  const sentNames = (sent.fills || []).map(f => f.storeName);
  ok('6a 提交请求体正确', sent.token === TOKEN && sentNames.length === 3 &&
    sentNames[0] === '常德爱尔眼科西街门诊' && sentNames[1] === '长沙爱尔眼科门诊' && sentNames[2] === '潍坊爱尔眼科门诊',
    JSON.stringify(sent.fills));
  ok('6b 只提交已填写字段', (() => {
    const a = (sent.fills || [])[0] || {};
    const keysA = Object.keys(a).sort().join(',');
    const b = (sent.fills || [])[1] || {};
    const keysB = Object.keys(b).sort().join(',');
    const c = (sent.fills || [])[2] || {};
    const keysC = Object.keys(c).sort().join(',');
    return keysA === 'meituanStar,region,storeName' && keysB === 'dianpingStar,storeName' && keysC === 'opsScore,storeName';
  })(), JSON.stringify(sent.fills));
  ok('6c 提交中按钮置灰文案', submittingText.dis === true && submittingText.txt === '提交中…', submittingText.txt);
  ok('6d 成功提示 message', done.toast === '已保存 3 家门店，还剩 5 家待填', done.toast);
  ok('6e 列表已刷新（已填满门店消失）', done.cards.length === cnt - 3 && done.cards.indexOf('常德爱尔眼科西街门诊') === -1,
    `before=${cnt} after=${done.cards.length}`);
  ok('6f 待填数量同步', done.sub === '2026-08 · 待填 5 家' && done.count === '5 家', done.sub);
  ok('6g 提交后清空草稿', done.draft === null, String(done.draft));
  await page.screenshot({ path: path.join(OUT, 'fill_06_submit_success.png') });

  /* ---------- 附加：token 失效错误页 ---------- */
  const ctx2 = await browser.newContext({ viewport: { width: 375, height: 780 }, deviceScaleFactor: 2 });
  const p2 = await ctx2.newPage();
  await p2.route('**/api/monthly-fill-form*', route => route.fulfill({
    status: 404, contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ ok: false, error: 'token invalid or expired' })
  }));
  await p2.goto(URL_PAGE, { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.errpage');
  const errTxt = await p2.evaluate(() => document.querySelector('.errpage').innerText.replace(/\n+/g, ' | '));
  ok('7 token 失效错误页', /链接已失效/.test(errTxt) && /重新获取填报链接/.test(errTxt), errTxt);
  await p2.screenshot({ path: path.join(OUT, 'fill_07_token_invalid.png') });

  /* ---------- 附加：桌面端 1440px ---------- */
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p3 = await ctx3.newPage();
  await p3.route('**/api/monthly-fill-form*', route => route.fulfill({
    status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(baseForm())
  }));
  await p3.goto(URL_PAGE, { waitUntil: 'networkidle' });
  await p3.waitForSelector('.card');
  await p3.waitForTimeout(200);
  const desk = await p3.evaluate(() => {
    const w = document.querySelector('.wrap').getBoundingClientRect();
    return { width: Math.round(w.width), left: Math.round(w.left), sw: document.documentElement.scrollWidth, iw: window.innerWidth };
  });
  ok('8 桌面端居中且不超宽', desk.width <= 720 && desk.sw <= desk.iw + 1, JSON.stringify(desk));
  await p3.screenshot({ path: path.join(OUT, 'fill_08_desktop.png') });

  await browser.close();
  server.close();

  const fail = results.filter(r => !r.pass);
  console.log('\n==== 汇总: ' + (results.length - fail.length) + '/' + results.length + ' 通过 ====');
  if (fail.length) { fail.forEach(f => console.log('FAILED: ' + f.name + ' -> ' + f.detail)); process.exitCode = 1; }
})().catch(e => { console.error('脚本异常:', e); process.exitCode = 1; });
