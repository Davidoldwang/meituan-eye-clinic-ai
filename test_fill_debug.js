/** 填报页真实接口联调诊断：抓取 JS 异常与接口响应 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

const FIXTURE = path.join(__dirname, 'test_fixtures', 'monthly_sample.xlsx');
const BASE = 'http://localhost:3000';

function req(method, p, obj) {
  return new Promise((resolve) => {
    const body = obj ? JSON.stringify(obj) : null;
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const q = http.request({ hostname: 'localhost', port: 3000, path: p, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d.substring(0, 300) }); } });
    });
    q.on('error', e => resolve({ error: e.message }));
    if (body) q.write(body);
    q.end();
  });
}

(async () => {
  const b64 = fs.readFileSync(FIXTURE).toString('base64');
  await req('POST', '/api/monthly-import', { month: '2026-08', fileName: '8月集团门诊后台得分和星级分析.xlsx', fileBase64: b64 });
  await req('POST', '/api/monthly-set-manager', { month: '2026-08', managerMap: { '湖南省区': '蔡文鸿', '山东省区': '熊嘉明' } });
  const link = await req('POST', '/api/monthly-fill-link', { month: '2026-08' });
  console.log('link:', link.url);
  const form = await req('GET', '/api/monthly-fill-form?token=' + link.token);
  console.log('API 待填:', form.totalPending, '| managers:', JSON.stringify(form.managers), '| regions:', JSON.stringify(form.regions));
  console.log('首店 missing:', JSON.stringify(form.stores[0]));

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
  const logs = [];
  page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
  page.on('pageerror', e => logs.push('[PAGEERROR] ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  page.on('requestfailed', r => logs.push('[REQFAIL] ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));
  page.on('response', async r => {
    if (r.url().indexOf('/api/') >= 0) logs.push('[RESP] ' + r.status() + ' ' + r.url());
  });

  await page.goto(link.url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  console.log('\n=== 页面文本（前 400 字）===');
  console.log((await page.evaluate(() => document.body.innerText)).substring(0, 400));

  console.log('\n=== 控件 ===');
  console.log('number inputs:', await page.evaluate(() => document.querySelectorAll('input[type=number]').length));
  console.log('text inputs:', await page.evaluate(() => document.querySelectorAll('input[type=text]').length));
  console.log('list 子节点:', await page.evaluate(() => { const l = document.getElementById('list'); return l ? l.children.length : -1; }));

  console.log('\n=== 日志 ===');
  logs.forEach(l => console.log(l));

  // 直接调一次 fetch 看返回
  const probe = await page.evaluate(async (t) => {
    try {
      const r = await fetch('/api/monthly-fill-form?token=' + t);
      const j = await r.json();
      return { status: r.status, ok: j.ok, total: j.totalPending, keys: Object.keys(j) };
    } catch (e) { return { err: String(e) }; }
  }, link.token);
  console.log('\n=== 页面内 fetch 探测 ===');
  console.log(JSON.stringify(probe));

  await page.screenshot({ path: path.join(__dirname, 'test_shots', 'q_fill_debug.png'), animations: 'disabled', timeout: 8000 }).catch(() => {});
  await browser.close();
})().catch(e => console.log('FATAL', e.message));
