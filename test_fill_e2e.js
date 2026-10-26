/**
 * 真实联调：主应用 → 生成填报链接 → 外部填报页(真实接口) → 回写 → 主应用刷新
 * 用法: node test_fill_e2e.js
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

const OUT = path.join(__dirname, 'test_shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
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
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d.substring(0, 200) }); } });
    });
    q.on('error', e => resolve({ error: e.message }));
    if (body) q.write(body);
    q.end();
  });
}

async function shot(pg, name, opts) {
  try {
    await pg.screenshot(Object.assign({ path: path.join(OUT, name + '.png'), animations: 'disabled', timeout: 8000 }, opts || {}));
  } catch (e) {
    console.log('  [截图失败] ' + name + ': ' + e.message.split('\n')[0]);
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  const watch = (pg, tag) => {
    pg.on('console', m => { if (m.type() === 'error') errors.push(tag + ' CONSOLE: ' + m.text()); });
    pg.on('pageerror', e => errors.push(tag + ' PAGEERROR: ' + e.message));
  };

  // ---------- 0. 准备数据 ----------
  const b64 = fs.readFileSync(FIXTURE).toString('base64');
  const imp = await req('POST', '/api/monthly-import', { month: '2026-08', fileName: '8月集团门诊后台得分和星级分析.xlsx', fileBase64: b64 });
  console.log('导入:', imp.ok, '| 排除', imp.kpi.excludedCount, '| 待补录门店', imp.kpi.pendingStores, '| 字段', imp.kpi.pendingFieldCount);
  const mm = { '湖南省区': '蔡文鸿', '山东省区': '熊嘉明', '浙江省区': '谢京宏' };
  const withMgr = await req('POST', '/api/monthly-set-manager', { month: '2026-08', managerMap: mm });
  console.log('设经理:', JSON.stringify(withMgr.managers), '| pendingByManager', JSON.stringify(withMgr.pendingByManager));

  // ---------- 1. 主应用：打开月度导入并上传 ----------
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  watch(page, 'MAIN');
  await page.goto(BASE + '/meituan-agent.html', { waitUntil: 'networkidle' });
  await page.click('.s-item[data-page="monthly-import"]');
  await page.waitForTimeout(300);
  await page.selectOption('#mi-month', '2026-08');
  await page.setInputFiles('#mi-file', FIXTURE);
  await page.waitForSelector('#mi-result', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(800);

  const kpi = await page.$$eval('.mi-kpi-card', els => els.map(e => e.innerText.replace(/\n/g, ' | ')));
  console.log('\n--- 主应用 KPI ---');
  kpi.forEach(k => console.log('  ' + k));

  const excl = await page.$eval('#mi-excl-note', e => e.innerText.replace(/\n/g, ' '));
  console.log('排除提示:', excl);
  const badge = await page.$eval('#mi-pending-badge', e => e.innerText);
  console.log('待补录徽标:', badge, '(应为 30 或更少)');

  // 门店明细：未开通筛选 + 状态标签
  await page.click('.mi-tab[data-mi="stores"]');
  await page.waitForTimeout(300);
  await page.selectOption('#mi-filter', 'unopened');
  await page.waitForTimeout(300);
  console.log('\n门店明细[未开通筛选]:', await page.$eval('#mi-store-count', e => e.innerText));
  const firstUnopened = await page.$eval('#mi-stores tbody tr', e => e.innerText.replace(/\t/g, ' | '));
  console.log('  首行:', firstUnopened.substring(0, 120));
  await shot(page, 'k_unopened_filter');
  await page.selectOption('#mi-filter', 'all');
  await page.waitForTimeout(200);

  // 待补录：经理/省区筛选
  await page.click('.mi-tab[data-mi="pending"]');
  await page.waitForTimeout(400);
  const mgrOpts = await page.$$eval('#mi-pm-mgr option', els => els.map(e => e.innerText));
  const regOpts = await page.$$eval('#mi-pm-region option', els => els.map(e => e.innerText));
  console.log('\n待补录-经理下拉:', JSON.stringify(mgrOpts));
  console.log('待补录-省区下拉(前5):', JSON.stringify(regOpts.slice(0, 5)));
  const cntAll = await page.$eval('#mi-pm-count', e => e.innerText);
  if (mgrOpts.length > 1) { await page.selectOption('#mi-pm-mgr', { index: 1 }); } else { console.log('  [警告] 经理下拉为空，未做筛选测试'); }
  await page.waitForTimeout(400);
  const cntMgr = await page.$eval('#mi-pm-count', e => e.innerText);
  console.log('筛选前:', cntAll, '| 选第一个经理后:', cntMgr);
  await page.selectOption('#mi-pm-mgr', '');
  await page.waitForTimeout(300);
  await shot(page, 'l_pending_filter');

  // 省区负责人设置
  await page.click('button:has-text("省区负责人设置")');
  await page.waitForTimeout(300);
  const mgrRows = await page.$$eval('#mi-mgr-editor .mi-mgr-row', els => els.length);
  console.log('省区负责人编辑行数:', mgrRows);
  await shot(page, 'm_mgr_editor');
  await page.click('button:has-text("收起")');

  // ---------- 2. 生成填报链接 ----------
  await page.click('button:has-text("生成填报链接")');
  await page.waitForTimeout(900);
  const modalVis = await page.$eval('#mi-link-modal', e => e.classList.contains('show'));
  const linkUrl = await page.$eval('#mi-link-url', e => e.value);
  const chips = await page.$$eval('#mi-link-chips .mi-chip', els => els.map(e => e.innerText));
  console.log('\n弹窗可见:', modalVis);
  console.log('链接:', linkUrl);
  console.log('分发选项:', JSON.stringify(chips));
  await shot(page, 'n_link_modal');

  // 点一个经理专属链接
  const mgrChipIdx = chips.findIndex(c => c.indexOf('经理 ·') >= 0);
  let mgrLink = linkUrl, mgrName = '';
  if (mgrChipIdx >= 0) {
    await page.click(`#mi-link-chips .mi-chip:nth-child(${mgrChipIdx + 1})`);
    await page.waitForTimeout(200);
    mgrLink = await page.$eval('#mi-link-url', e => e.value);
    mgrName = chips[mgrChipIdx].replace('经理 · ', '').replace(/（\d+）$/, '');
    console.log('经理专属链接:', mgrLink, '| 经理:', mgrName);
  }
  await page.click('#mi-link-modal button:has-text("关闭")');

  // ---------- 3. 外部填报页（真实接口） ----------
  const fill = await browser.newPage({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
  watch(fill, 'FILL');
  await fill.goto(linkUrl, { waitUntil: 'networkidle' });
  await fill.waitForTimeout(1200);

  const titleOk = await fill.$$eval('h1', els => els.map(e => e.innerText).join('|')).catch(() => '');
  const subText = await fill.evaluate(() => {
    const b = document.body.innerText;
    const m = b.match(/2026-08[^\n]*/);
    return m ? m[0] : b.substring(0, 80);
  });
  console.log('\n--- 填报页 ---');
  console.log('标题:', titleOk, '| 副标题:', subText);
  const cardCount = await fill.evaluate(() => document.querySelectorAll('input[type="number"], input[type="text"]').length);
  console.log('输入控件数:', cardCount);
  await shot(fill, 'o_fill_page');

  // 记录服务端当前待填
  const formApi = await req('GET', '/api/monthly-fill-form?token=' + new URL(linkUrl).searchParams.get('t'));
  console.log('接口待填:', formApi.totalPending, '| 首店:', formApi.stores[0] && formApi.stores[0].storeName);

  // 在页面上填第一个 经营评分/星级 输入框
  const filled = await fill.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="number"]'));
    if (!inputs.length) return { ok: false };
    const el = inputs[0];
    const max = Number(el.getAttribute('max') || 5);
    el.value = String(max >= 100 ? 96 : 4.6);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const store = el.closest('[data-store]') || el.closest('.card');
    return { ok: true, val: el.value, store: store ? store.innerText.split('\n')[0] : '?' };
  });
  console.log('已填:', JSON.stringify(filled));
  await fill.waitForTimeout(400);

  const submitBtn = await fill.$('button');
  const btnTexts = await fill.$$eval('button', els => els.map(e => e.innerText));
  console.log('按钮:', JSON.stringify(btnTexts));
  const submit = await fill.$('button:has-text("提交")');
  if (submit) {
    await submit.click();
    await fill.waitForTimeout(1800);
    const toast = await fill.evaluate(() => {
      const t = document.querySelector('.toast, #toast, [class*=toast]');
      return t ? t.innerText : (document.body.innerText.match(/已保存[^\n]*/) || [''])[0];
    });
    console.log('提交后提示:', toast);
  } else {
    console.log('未找到提交按钮，跳过点击');
  }
  await shot(fill, 'p_fill_after_submit');

  // ---------- 4. 校验回写 ----------
  const token = new URL(linkUrl).searchParams.get('t');
  const formAfter = await req('GET', '/api/monthly-fill-form?token=' + token);
  console.log('\n--- 回写校验 ---');
  console.log('提交前待填:', formApi.totalPending, '→ 提交后待填:', formAfter.totalPending);

  // ---------- 5. 主应用刷新看数据 ----------
  const page2 = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  watch(page2, 'MAIN2');
  await page2.goto(BASE + '/meituan-agent.html', { waitUntil: 'networkidle' });
  await page2.click('.s-item[data-page="monthly-import"]');
  await page2.waitForTimeout(400);
  await page2.selectOption('#mi-history', '2026-08');
  await page2.waitForTimeout(1200);
  const kpi2 = await page2.$$eval('.mi-kpi-card', els => els.map(e => e.innerText.replace(/\n/g, ' | ')));
  console.log('\n--- 刷新后 KPI（应比导入时少若干待补录）---');
  kpi2.forEach(k => console.log('  ' + k));

  console.log('\n--- 控制台错误 ---');
  console.log(errors.length ? errors.join('\n') : '(无)');
  await browser.close();
})().catch(e => { console.log('FATAL', e.message, e.stack && e.stack.substring(0, 400)); });
