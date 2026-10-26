/**
 * 月度数据导入模块 - 端到端回归测试
 * 用法: node test_monthly.js
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const XLSX_PATH = 'E:/桌面转移/8月集团门诊后台得分和星级分析.xlsx';
const OUT = path.join(__dirname, 'test_shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:3000/meituan-agent.html', { waitUntil: 'networkidle' });

  // 1. 进入页面
  await page.click('.s-item[data-page="monthly-import"]');
  await page.waitForTimeout(400);
  const monthVal = await page.$eval('#mi-month', el => el.value);
  console.log('OK 进入页面 · 默认月份 =', monthVal);
  await page.screenshot({ path: path.join(OUT, '01_empty.png') });

  // 2. 上传 Excel
  await page.setInputFiles('#mi-file', XLSX_PATH);
  await page.waitForSelector('#mi-result', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(600);

  const kpi = await page.$$eval('.mi-kpi-card', els => els.map(e => e.innerText.replace(/\n/g, ' | ')));
  console.log('\n--- KPI ---');
  kpi.forEach(k => console.log('  ' + k));

  const srcNote = await page.$eval('#mi-source-note', e => e.innerText);
  console.log('\n字段识别:', srcNote);
  const mapRows = await page.$$eval('#mi-mapping .mi-map-row', els => els.map(e => e.innerText.replace(/\n/g, ' ')));
  mapRows.forEach(r => console.log('  ' + r));
  const warn = await page.$eval('#mi-warn', e => e.style.display === 'none' ? '(无)' : e.innerText);
  console.log('警告:', warn);

  const ins = await page.$$eval('.mi-insight', els => els.map(e => e.innerText.replace(/\n/g, ' ')));
  console.log('\n--- 洞察 ' + ins.length + ' 条 ---');
  ins.forEach(i => console.log('  ' + i));

  const starDist = await page.$$eval('#mi-star-dist .mi-dist-row', els => els.map(e => e.innerText.replace(/\n/g, ' ')));
  console.log('\n星级分布:', JSON.stringify(starDist));
  const scoreDist = await page.$$eval('#mi-score-dist .mi-dist-row', els => els.map(e => e.innerText.replace(/\n/g, ' ')));
  console.log('评分分布:', JSON.stringify(scoreDist));
  const topRows = await page.$$eval('#mi-top tbody tr', els => els.length);
  const bottomRows = await page.$$eval('#mi-bottom tbody tr', els => els.length);
  console.log('TOP表行数', topRows, '| BOTTOM表行数', bottomRows);
  await page.screenshot({ path: path.join(OUT, '02_overview.png'), fullPage: true });

  // 3. 门店明细
  await page.click('.mi-tab[data-mi="stores"]');
  await page.waitForTimeout(300);
  const storeCount = await page.$eval('#mi-store-count', e => e.innerText);
  const storeRows = await page.$$eval('#mi-stores tbody tr', els => els.length);
  console.log('\n门店明细:', storeCount, '| 渲染行数', storeRows);
  // 搜索
  await page.fill('#mi-search', '临沂');
  await page.waitForTimeout(300);
  console.log('搜索「临沂」→', await page.$eval('#mi-store-count', e => e.innerText));
  await page.fill('#mi-search', '');
  // 筛选：经营评分<70
  await page.selectOption('#mi-filter', 'low');
  await page.waitForTimeout(300);
  console.log('筛选 评分<70 →', await page.$eval('#mi-store-count', e => e.innerText));
  const firstLow = await page.$eval('#mi-stores tbody tr', e => e.innerText.replace(/\t/g, ' | '));
  console.log('  首行:', firstLow);
  await page.selectOption('#mi-filter', 'all');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '03_stores.png'), fullPage: true });

  // 4. 待补录
  await page.click('.mi-tab[data-mi="pending"]');
  await page.waitForTimeout(300);
  const badgeBefore = await page.$eval('#mi-pending-badge', e => e.innerText);
  const pendItems = await page.$$eval('.mi-pend-item', els => els.length);
  const sugCount = await page.$$eval('.mi-sug', els => els.length);
  console.log('\n待补录: 徽标', badgeBefore, '| 门店', pendItems, '| 可推荐项', sugCount);
  const firstPend = await page.$eval('.mi-pend-item', e => e.innerText.replace(/\n/g, ' | '));
  console.log('  首条:', firstPend);
  await page.screenshot({ path: path.join(OUT, '04_pending.png'), fullPage: true });

  // 4.1 一键接受省区推荐
  await page.click('button:has-text("接受全部省区推荐")');
  await page.waitForTimeout(800);
  const toast1 = await page.$$eval('.toast, #toast', els => els.map(e => e.innerText).join(' / ')).catch(() => '');
  const badgeMid = await page.$eval('#mi-pending-badge', e => e.innerText);
  console.log('接受推荐后 → toast:', toast1 || '(未捕获)', '| 徽标:', badgeMid);

  // 4.2 手动填一个门店级指标
  const firstInput = await page.$('#mi-pending-list input');
  if (firstInput) {
    const inputId = await firstInput.getAttribute('id');
    await firstInput.fill('88');
    await firstInput.dispatchEvent('change');
    await page.waitForTimeout(400);
    const badgeAfter = await page.$eval('#mi-pending-badge', e => e.innerText);
    console.log('手动填', inputId, '= 88 → 徽标:', badgeAfter);
  }

  // 4.3 保存并重新分析
  await page.click('button:has-text("保存并重新分析")');
  await page.waitForTimeout(2500);
  const badgeSaved = await page.$eval('#mi-pending-badge', e => e.innerText);
  const kpiAfter = await page.$$eval('.mi-kpi-card', els => els.map(e => e.innerText.replace(/\n/g, ' | ')));
  console.log('\n--- 保存后 KPI ---');
  kpiAfter.forEach(k => console.log('  ' + k));
  console.log('保存后待补录徽标:', badgeSaved);

  // 5. 省区对标
  await page.click('.mi-tab[data-mi="region"]');
  await page.waitForTimeout(300);
  const regionRows = await page.$$eval('#mi-region tbody tr', els => els.length);
  const regionTop = await page.$$eval('#mi-region tbody tr', els => els.slice(0, 3).map(e => e.innerText.replace(/\t/g, ' | ')));
  console.log('\n省区对标: 行数', regionRows);
  regionTop.forEach(r => console.log('  ' + r));
  await page.screenshot({ path: path.join(OUT, '05_region.png'), fullPage: true });

  // 6. 差评明细
  await page.click('.mi-tab[data-mi="reviews"]');
  await page.waitForTimeout(300);
  const revRows = await page.$$eval('#mi-reviews tbody tr', els => els.length);
  console.log('\n差评明细: 行数', revRows);
  const rev0 = await page.$eval('#mi-reviews tbody tr', e => e.innerText.replace(/\t/g, ' | ').substring(0, 120));
  console.log('  首条:', rev0);
  await page.screenshot({ path: path.join(OUT, '06_reviews.png'), fullPage: true });

  // 6.1 转入评价管理
  await page.click('#mi-reviews tbody tr:first-child button');
  await page.waitForTimeout(600);
  const rvVal = await page.$eval('#rvAssistText', e => e.value).catch(() => '');
  const pageActive = await page.$eval('.page.active', e => e.id);
  console.log('转入评价管理 → 当前页面:', pageActive, '| textarea:', rvVal.substring(0, 60) + '…');

  // 7. 历史月份
  await page.click('.s-item[data-page="monthly-import"]');
  await page.waitForTimeout(400);
  const histOpts = await page.$$eval('#mi-history option', els => els.map(e => e.innerText));
  console.log('\n历史下拉:', JSON.stringify(histOpts));

  // 8. 模板下载响应码
  const tplResp = await page.evaluate(async () => {
    const r = await fetch('/api/monthly-template');
    return { status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
  });
  console.log('模板下载:', JSON.stringify(tplResp));

  // 9. 移动端
  const mob = await browser.newPage({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
  await mob.goto('http://localhost:3000/meituan-agent.html', { waitUntil: 'networkidle' });
  await mob.evaluate(() => switchPage('monthly-import'));
  await mob.waitForTimeout(500);
  await mob.screenshot({ path: path.join(OUT, '07_mobile.png'), fullPage: true });
  console.log('移动端截图完成');

  console.log('\n--- 控制台错误 ---');
  console.log(errors.length ? errors.join('\n') : '(无)');

  await browser.close();
})();
