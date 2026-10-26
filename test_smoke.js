/** 主应用月度模块冒烟 + 最终截图 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, 'test_fixtures', 'monthly_sample.xlsx');
const OUT = path.join(__dirname, 'test_shots');

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:3000/meituan-agent.html', { waitUntil: 'networkidle' });
  await page.click('.s-item[data-page="monthly-import"]');
  await page.waitForTimeout(300);
  await page.selectOption('#mi-month', '2026-08');
  await page.setInputFiles('#mi-file', FIXTURE);
  await page.waitForSelector('#mi-result', { state: 'visible', timeout: 30000 });
  await page.waitForTimeout(900);

  const mapRows = await page.$$eval('#mi-mapping .mi-map-row', els => els.map(e => e.innerText.replace(/\n/g, ' ')));
  console.log('映射表:');
  mapRows.forEach(r => console.log('  ' + r));

  const kpi = await page.$$eval('.mi-kpi-card', els => els.map(e => e.innerText.replace(/\n/g, ' | ')));
  console.log('\nKPI:');
  kpi.forEach(k => console.log('  ' + k));

  // 待补录 + 排除提示
  await page.click('.mi-tab[data-mi="pending"]');
  await page.waitForTimeout(500);
  const shot = async (sel, name) => {
    try {
      const el = await page.$(sel);
      await el.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await el.screenshot({ path: path.join(OUT, name + '.png'), animations: 'disabled', timeout: 8000 });
      console.log('shot', name);
    } catch (e) { console.log('shot fail', name, e.message.split('\n')[0]); }
  };
  await shot('#mi-panel-pending .card', 'r_final_pending');

  await page.click('.mi-tab[data-mi="stores"]');
  await page.waitForTimeout(300);
  await page.selectOption('#mi-filter', 'unopened');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 's_final_unopened.png'), animations: 'disabled', timeout: 8000 }).catch(() => {});

  console.log('\n控制台错误:', errors.length ? errors.join(' | ') : '(无)');
  await browser.close();
})();
