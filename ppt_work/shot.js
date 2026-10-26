// 采集美团助手真实界面截图，作为答辩PPT的 L1 主视觉素材
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'assets');
const BASE = 'http://localhost:3000/meituan-agent.html';

const SHOTS = [
  { id: 'dash', name: 'ui_dash', wait: 1200 },
  { id: 'clinic-collect', name: 'ui_clinic', wait: 1200 },
  { id: 'comp', name: 'ui_comp', wait: 900 },
  { id: 'copy', name: 'ui_copy', wait: 900 },
  { id: 'img', name: 'ui_img', wait: 900 },
  { id: 'review', name: 'ui_review', wait: 900 },
  { id: 'meituan-ops', name: 'ui_ops', wait: 900 },
  { id: 'script', name: 'ui_script', wait: 900 },
  { id: 'img-diagnosis', name: 'ui_imgdiag', wait: 900 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  for (const s of SHOTS) {
    try {
      await page.evaluate((id) => { if (window.switchPage) window.switchPage(id); }, s.id);
      await page.waitForTimeout(s.wait);
      const file = path.join(OUT, s.name + '.png');
      await page.screenshot({ path: file });
      console.log('OK', s.name);
    } catch (e) {
      console.log('FAIL', s.name, e.message);
    }
  }

  // 移动端门诊采集页
  try {
    await page.setViewportSize({ width: 414, height: 896 });
    await page.evaluate(() => { if (window.switchPage) window.switchPage('clinic-collect'); });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'ui_clinic_mobile.png') });
    console.log('OK ui_clinic_mobile');
  } catch (e) { console.log('FAIL mobile', e.message); }

  await browser.close();
  console.log('DONE');
})();
