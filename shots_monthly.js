/** 月度导入页面分区截图（针对内部滚动容器） */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const XLSX_PATH = 'E:/桌面转移/8月集团门诊后台得分和星级分析.xlsx';
const OUT = path.join(__dirname, 'test_shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto('http://localhost:3000/meituan-agent.html', { waitUntil: 'networkidle' });
  await page.click('.s-item[data-page="monthly-import"]');
  await page.waitForTimeout(300);
  await page.setInputFiles('#mi-file', XLSX_PATH);
  await page.waitForSelector('#mi-result', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(800);

  const shot = async (sel, name) => {
    const el = await page.$(sel);
    if (!el) { console.log('MISS', sel); return; }
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await el.screenshot({ path: path.join(OUT, name + '.png') });
    console.log('shot', name);
  };

  await shot('.mi-kpi', 'a_kpi');
  await shot('.mi-tabs', 'b_tabs');
  await page.click('.mi-tab[data-mi="overview"]');
  await page.waitForTimeout(200);
  await shot('#mi-panel-overview .grid-2', 'c_dist');
  await shot('#mi-insights', 'd_insights');
  await shot('#mi-panel-overview .grid-2:last-child', 'e_rank');

  await page.click('.mi-tab[data-mi="stores"]');
  await page.waitForTimeout(300);
  await shot('#mi-panel-stores .card', 'f_stores');

  await page.click('.mi-tab[data-mi="pending"]');
  await page.waitForTimeout(300);
  await shot('#mi-pending-list .mi-pend-item:first-child', 'g_pending_1');
  await shot('#mi-panel-pending .card', 'h_pending_all');

  await page.click('.mi-tab[data-mi="region"]');
  await page.waitForTimeout(300);
  await shot('#mi-panel-region .card', 'i_region');

  await page.click('.mi-tab[data-mi="reviews"]');
  await page.waitForTimeout(300);
  await shot('#mi-panel-reviews .card', 'j_reviews');

  // 首页数据条
  await page.evaluate(() => switchPage('dash'));
  await page.waitForTimeout(400);
  await shot('#dash-src', 'k_dashstrip');

  // 空态
  const p2 = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  await p2.goto('http://localhost:3000/meituan-agent.html', { waitUntil: 'networkidle' });
  await p2.evaluate(() => switchPage('monthly-import'));
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: path.join(OUT, 'l_empty.png') });
  console.log('shot l_empty');

  // 移动端
  const mob = await browser.newPage({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
  await mob.goto('http://localhost:3000/meituan-agent.html', { waitUntil: 'networkidle' });
  await mob.evaluate(() => switchPage('monthly-import'));
  await mob.waitForTimeout(400);
  await mob.screenshot({ path: path.join(OUT, 'm_mobile_top.png') });
  await mob.setInputFiles('#mi-file', XLSX_PATH);
  await mob.waitForSelector('#mi-result', { state: 'visible', timeout: 30000 });
  await mob.waitForTimeout(800);
  const k = await mob.$('.mi-kpi');
  await k.scrollIntoViewIfNeeded();
  await mob.waitForTimeout(300);
  await mob.screenshot({ path: path.join(OUT, 'n_mobile_kpi.png') });
  console.log('shot mobile');

  await browser.close();
})();
