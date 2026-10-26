const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:3000/meituan-agent.html', { waitUntil: 'networkidle' });
  await page.evaluate(() => switchPage('img'));
  await page.waitForTimeout(400);
  const styles = await page.$$eval('#styleGrid .style-card', els => els.map(e => e.querySelector('.style-name').textContent));
  const sub = await page.textContent('#page-img .page-sub');
  await page.screenshot({ path: 'test_shots/img_style_4types.png' });
  // 点击生成（真实调用约2分钟，这里只验证按钮与网格初始状态，不实际点击生成）
  const gridCols = await page.$eval('#genGrid', e => getComputedStyle(e).gridTemplateColumns);
  console.log('风格列表:', JSON.stringify(styles));
  console.log('页面副标题:', sub);
  console.log('结果网格列数:', gridCols.split(' ').length);
  console.log('控制台错误:', errors.length ? JSON.stringify(errors.slice(0,5)) : '无');
  await browser.close();
})();
