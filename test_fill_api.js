/** 后端接口回归：未开通排除 / 填报链接 / 提交回写 / 设经理 / 设状态 */
const fs = require('fs');
const http = require('http');

function req(method, p, obj) {
  return new Promise((resolve) => {
    const body = obj ? JSON.stringify(obj) : null;
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const q = http.request({ hostname: 'localhost', port: 3000, path: p, method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) { j = { raw: d.substring(0, 200) }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    q.on('error', e => resolve({ status: 0, body: { error: e.message } }));
    if (body) q.write(body);
    q.end();
  });
}
const post = (p, o) => req('POST', p, o);
const get = p => req('GET', p);

(async () => {
const path = require('path');
const XLSX_PATH = path.join(__dirname, 'test_fixtures', 'monthly_sample.xlsx');
  const b64 = fs.readFileSync(XLSX_PATH).toString('base64');

  console.log('=== 1. 导入 ===');
  const r1 = await post('/api/monthly-import', { month: '2026-08', fileName: '8月集团门诊后台得分和星级分析.xlsx', fileBase64: b64 });
  const j = r1.body;
  if (!j.ok) { console.log('FAIL', JSON.stringify(j).substring(0, 300)); return; }
  console.log('KPI:', JSON.stringify({
    storeCount: j.kpi.storeCount, totalStores: j.kpi.totalStores,
    excluded: j.kpi.excludedCount, unopened: j.kpi.unopenedCount, suspect: j.kpi.suspectCount,
    pendingStores: j.kpi.pendingStores, pendingFieldCount: j.kpi.pendingFieldCount,
    regionCount: j.kpi.regionCount, avgOpsScore: j.kpi.avgOpsScore
  }));
  console.log('stores 总数:', j.stores.length, '| excluded:', j.stores.filter(s => s.excluded).length);
  console.log('疑似未开通样例:', JSON.stringify(j.stores.filter(s => s.excluded).slice(0, 3).map(s => [s.storeName, s.city, s.status])));
  console.log('待补录(active):', j.pendingList.length);
  const insRegion = j.insights.find(i => i.text.indexOf('省区覆盖率') >= 0);
  console.log('省区洞察:', insRegion ? insRegion.text : '(无)');
  const insExcl = j.insights.find(i => i.text.indexOf('未开通') >= 0);
  console.log('排除洞察:', insExcl ? insExcl.text : '(无)');

  console.log('\n=== 2. 生成填报链接 ===');
  const r2 = await post('/api/monthly-fill-link', { month: '2026-08' });
  console.log('status', r2.status, JSON.stringify(r2.body).substring(0, 200));
  const token = r2.body.token;

  console.log('\n=== 3. 取填报表单 ===');
  const r3 = await get('/api/monthly-fill-form?token=' + token);
  const form = r3.body;
  console.log('待填:', form.totalPending, '| 省区选项', form.regions.length, '| 经理选项', form.managers.length);
  console.log('样例:', JSON.stringify(form.stores[0]));
  const withSug = form.stores.filter(s => s.suggestions && s.suggestions.region).length;
  console.log('带省区推荐的门店:', withSug);

  console.log('\n=== 4. 无效 token ===');
  const r4 = await get('/api/monthly-fill-form?token=notexistasdf');
  console.log('status', r4.status, JSON.stringify(r4.body));

  console.log('\n=== 5. 设置省区负责人 ===');
  const regions = Array.from(new Set(j.pendingList.map(p => p.region).filter(Boolean))).slice(0, 3);
  const mm = {};
  regions.forEach((rg, i) => mm[rg] = '经理' + String.fromCharCode(65 + i));
  const r5 = await post('/api/monthly-set-manager', { month: '2026-08', managerMap: mm });
  console.log('映射:', JSON.stringify(mm));
  console.log('status', r5.status, '| managers:', JSON.stringify(r5.body.managers || []));
  console.log('pendingByManager:', JSON.stringify(r5.body.pendingByManager || {}));

  console.log('\n=== 6. 外部填报提交 ===');
  const before = r5.body.kpi.pendingFieldCount;
  const target = (r5.body.pendingList || []).filter(p => p.manager).slice(0, 2);
  const fills = target.map((p, i) => {
    const f = { storeName: p.storeName };
    p.missing.forEach(m => {
      if (m.key === 'region') f.region = '测试省区' + (i + 1);
      if (m.key === 'meituanStar') f.meituanStar = 4.5;
      if (m.key === 'dianpingStar') f.dianpingStar = 0;
      if (m.key === 'opsScore') f.opsScore = 88;
    });
    return f;
  });
  console.log('提交内容:', JSON.stringify(fills));
  const r6 = await post('/api/monthly-fill-submit', { token, fills });
  console.log('status', r6.status, JSON.stringify(r6.body));
  console.log('待补录字段:', before, '→', r6.body.remaining !== undefined ? '(pendingStores ' + r6.body.remaining + ')' : '?');

  const after = await get('/api/monthly-fill-form?token=' + token);
  console.log('提交后表单待填:', after.body.totalPending);

  console.log('\n=== 7. 标记门店为未开通 ===');
  const victim = (after.body.stores || [])[0];
  const r7 = await post('/api/monthly-set-status', { month: '2026-08', storeNames: [victim.storeName], status: 'unopened' });
  console.log('标记:', victim.storeName);
  console.log('status', r7.status, '| changed', r7.body.changed, '| excluded 总数', r7.body.kpi ? r7.body.kpi.excludedCount : '?', '| 待补录门店', r7.body.kpi ? r7.body.kpi.pendingStores : '?');
  const after2 = await get('/api/monthly-fill-form?token=' + token);
  console.log('标记后表单待填:', after2.body.totalPending, '（应比之前少 1）');
  const stillThere = (after2.body.stores || []).some(s => s.storeName === victim.storeName);
  console.log('该门店是否仍在表单中:', stillThere, '（应为 false）');

  console.log('\n=== 8. 改回已开通 ===');
  const r8 = await post('/api/monthly-set-status', { month: '2026-08', storeNames: [victim.storeName], status: 'active' });
  console.log('status', r8.status, '| excluded', r8.body.kpi ? r8.body.kpi.excludedCount : '?');
})().catch(e => console.log('ERROR', e.message));
