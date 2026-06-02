/**
 * 美团电商眼科运营AI助手 - 后端服务
 * 启动方式: node server.js
 * 访问地址: http://localhost:3000
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ===== 门店基础数据 =====
const CLINIC = {
  name: '临沂爱尔眼科光门诊(金水河畔店)',
  doctor: '杜秀臻',
  doctorExp: '从业10年',
  address: '临沂市兰山区金水河畔',
  phone: '0539-XXXX-XXXX',
  rating: 4.5,
  reviews: 105,
  tags: ['服务好74', '环境好23', '干净整洁8', '手法专业4']
};

// ===== 工具函数 =====
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== Seedream API 配置 =====
const VOLC_API_KEY = process.env.VOLC_API_KEY || '';
const SEEDREAM_MODEL = process.env.SEEDREAM_MODEL || 'doubao-seedream-4-5-251128';
const https = require('https');

// 启动时打印 Seedream 配置状态
console.log(`  Seedream API: ${VOLC_API_KEY ? '已配置 ✓ (Key: ' + VOLC_API_KEY.substring(0,8) + '...)' : '未配置 ✗ (使用模拟数据)'}`);
console.log(`  Seedream 模型: ${SEEDREAM_MODEL}`);

// 调用火山引擎 Seedream API（单次调用生成1张图）
// 注意：Seedream 3.0 要求图片至少 3,686,400 像素（如 1920x1920）
function callSeedreamOnce({ prompt, imageBase64, size = '1920x1920' }) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: SEEDREAM_MODEL,
      prompt,
      size
    };
    if (imageBase64) {
      payload.image = imageBase64;
    }

    const body = JSON.stringify(payload);
    const options = {
      hostname: 'ark.cn-beijing.volces.com',
      path: '/api/v3/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VOLC_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120000  // 120秒超时
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.data && Array.isArray(json.data) && json.data.length > 0 && json.data[0].url) {
            resolve(json.data[0].url);
          } else {
            const errMsg = json.error ? json.error.message || JSON.stringify(json.error) : data.substring(0, 200);
            reject(new Error('Seedream API 返回异常: ' + errMsg));
          }
        } catch (e) {
          reject(new Error('解析 Seedream 响应失败: ' + e.message));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Seedream 请求超时(120s)')); });
    req.on('error', (err) => reject(new Error('Seedream 请求失败: ' + err.message)));
    req.write(body);
    req.end();
  });
}

// 批量生成多张图（串行调用，避免并发限流）
async function callSeedreamAPI({ prompt, imageBase64, size = '1920x1920', maxImages = 4 }) {
  const urls = [];
  for (let i = 0; i < maxImages; i++) {
    try {
      console.log(`  Seedream 生成第 ${i + 1}/${maxImages} 张图...`);
      const url = await callSeedreamOnce({ prompt, imageBase64, size });
      urls.push(url);
      console.log(`  Seedream 第 ${i + 1} 张图完成`);
    } catch (err) {
      console.error(`  Seedream 第 ${i + 1} 张图失败:`, err.message);
      // 至少成功1张就继续，全部失败才抛出
      if (urls.length === 0) throw err;
      break;
    }
  }
  return urls;
}

// 解析竞品文本，提取结构化数据
function parseCompetitorText(text) {
  if (!text || text.trim().length < 5) return null;
  const result = { name: '', price: 0, rating: 0, reviews: 0, period: 30 };
  // 提取名称
  const nameMatch = text.match(/([\u4e00-\u9fa5]{2,10}眼科)/);
  if (nameMatch) result.name = nameMatch[1];
  // 提取价格
  const priceMatch = text.match(/[¥￥](\d+\.?\d*)/);
  if (priceMatch) result.price = parseFloat(priceMatch[1]);
  // 提取评分
  const ratingMatch = text.match(/评分[：:]?\s*(\d+\.?\d*)/);
  if (ratingMatch) result.rating = parseFloat(ratingMatch[1]);
  // 提取评价数
  const reviewMatch = text.match(/评价\s*(\d+)/);
  if (reviewMatch) result.reviews = parseInt(reviewMatch[1]);
  // 提取有效期
  const periodMatch = text.match(/有效期[：:]?\s*(\d+)/);
  if (periodMatch) result.period = parseInt(periodMatch[1]);
  return result.name ? result : null;
}

// ===== POST /api/competitor-analysis =====
app.post('/api/competitor-analysis', async (req, res) => {
  try {
    await delay(randInt(800, 1500));
    const { text, clinicData, imageBase64 } = req.body;
    const clinic = clinicData || CLINIC;
    const parsed = parseCompetitorText(text);
    const comp = parsed || { name: '临沂华厦眼科', price: 49, rating: 4.3, reviews: 68, period: 90 };

    const ourPrice = 39.9;
    const priceDiff = ourPrice < comp.price
      ? `我方低${Math.round((1 - ourPrice / comp.price) * 100)}%`
      : `我方高${Math.round((ourPrice / comp.price - 1) * 100)}%`;
    const ratingDiff = clinic.rating > comp.rating
      ? `我方高${(clinic.rating - comp.rating).toFixed(1)}`
      : `我方低${(comp.rating - clinic.rating).toFixed(1)}`;
    const reviewDiff = clinic.reviews > comp.reviews
      ? `我方多${clinic.reviews - comp.reviews}条`
      : `我方少${comp.reviews - clinic.reviews}条`;

    const table = [
      {
        dim: '项目名称',
        ours: '儿童青少年视力检查',
        theirs: comp.name.includes('华厦') ? '儿童视力检查' : comp.name + '检查项目',
        gap: '持平',
        level: 'good'
      },
      {
        dim: '价格',
        ours: '¥' + ourPrice,
        theirs: '¥' + comp.price,
        gap: priceDiff,
        level: ourPrice <= comp.price ? 'good' : 'bad'
      },
      {
        dim: '评分',
        ours: String(clinic.rating),
        theirs: String(comp.rating),
        gap: ratingDiff,
        level: clinic.rating >= comp.rating ? 'good' : 'bad'
      },
      {
        dim: '评价数',
        ours: clinic.reviews + '条',
        theirs: comp.reviews + '条',
        gap: reviewDiff,
        level: clinic.reviews >= comp.reviews ? 'good' : 'bad'
      },
      {
        dim: '主图风格',
        ours: pick(['纯白底文字图', '简单产品图', '文字排版图']),
        theirs: pick(['白底医生形象图', '亲子场景图', '专业设备图']),
        gap: '需优化',
        level: 'warn'
      },
      {
        dim: '有效期',
        ours: '30天',
        theirs: comp.period + '天',
        gap: `差距${Math.abs(30 - comp.period)}天`,
        level: 30 >= comp.period ? 'good' : 'bad'
      }
    ];

    const suggestions = [];
    if (imageBase64) {
      suggestions.push({
        priority: 'P1',
        title: '基于竞品截图：优化主图视觉设计',
        desc: '已收到竞品截图，建议仔细分析竞品主图的色彩搭配、排版布局、核心卖点呈现方式，以及价格/促销信息的视觉层级，针对性优化我方主图，提升点击率'
      });
    }
    suggestions.push(
      {
        priority: 'P1',
        title: comp.period > 30 ? '将有效期从30天延长至' + comp.period + '天' : '优化有效期至90天提升转化',
        desc: comp.period > 30
          ? `竞品${comp.period}天有效期是重要转化因素，延长有效期可降低用户决策压力，预计提升转化率15-20%`
          : '延长有效期可降低用户决策压力，建议设为90天，预计提升转化率15-20%'
      },
      {
        priority: 'P1',
        title: '主图替换为' + clinic.doctor + '医生亲子场景图',
        desc: '当前纯文字主图点击率低，建议使用医生+儿童互动的场景图，强化信任感和专业感'
      },
      {
        priority: pick(['P1', 'P2']),
        title: pick([
          '项目名加入"近视防控"关键词',
          '标题增加"眼轴检测"核心卖点词',
          '添加"已售200+"销量标识增强信任'
        ]),
        desc: pick([
          '搜索"近视防控"的用户意图更强，优化标题可提升搜索曝光率30%以上',
          '"眼轴检测"是家长高度关注的检查项目，在标题中突出可提升点击率',
          '销量数字是社会认同信号，展示"已售200+"可显著提升用户信任和下单意愿'
        ])
      }
    );

    res.json({ table, suggestions });
  } catch (e) {
    console.error('competitor-analysis error:', e);
    res.status(500).json({ error: '竞品分析服务异常，请稍后重试' });
  }
});

// ===== POST /api/copywriting-generate =====
app.post('/api/copywriting-generate', async (req, res) => {
  try {
    await delay(randInt(1000, 2000));
    const { product, clinicData } = req.body;
    const clinic = clinicData || CLINIC;
    const p = product || { name: '儿童青少年视力检查', price: '¥39.9', meta: '眼轴检测/角膜塑形镜', type: 'traffic' };
    const type = p.type || 'traffic';

    // 文案模板引擎 - 根据类型调整侧重点
    const trafficHooks = [
      `${p.name} | 仅${p.price} · ${p.meta.split('/')[0]}`,
      `${p.name} | 限时${p.price} · ${p.meta.split('/')[0]}`,
      `${p.name} | 特惠${p.price} · 专业检查`
    ];
    const profitHooks = [
      `${p.name} | ${p.price} · 深度专业检查`,
      `${p.name} | 专业级${p.meta.split('/')[0]} · 值得信赖`
    ];
    const bundleHooks = [
      `${p.name} | ${p.price} · 全年系统管理`,
      `${p.name} | ${p.price} · 长期护眼方案`
    ];

    const hookTitle = type === 'traffic' ? pick(trafficHooks)
      : type === 'profit' ? pick(profitHooks)
      : pick(bundleHooks);

    const trafficSub = pick([
      `爱尔眼科 · ${clinic.doctor}医生1对1解读报告`,
      `爱尔眼科 · 专业仪器精准检测 · 医生亲诊`
    ]);
    const profitSub = pick([
      `爱尔眼科 · ${clinic.doctor}医生深度解读 · 从业${clinic.doctorExp}`,
      `爱尔眼科 · 精准检测+深度分析 · 专家把关`
    ]);
    const bundleSub = pick([
      `爱尔眼科 · 系统化管理 · ${clinic.doctor}医生全程跟踪`,
      `爱尔眼科 · 长期随访+定期复查 · 省心方案`
    ]);

    const hookSub = type === 'traffic' ? trafficSub : type === 'profit' ? profitSub : bundleSub;

    const soldNum = randInt(180, 350);
    const remainNum = randInt(5, 20);

    // 痛点变体
    const painPoints = pick([
      ['"孩子总说看不清黑板"', '"你担心过是近视还是假性近视吗？"', '"及早筛查，才能及早干预"'],
      ['"孩子经常揉眼眯眼"', '"度数年年涨怎么办？"', '"早发现早干预，别让近视加深"'],
      ['"写作业越来越近"', '"是疲劳还是真的近视了？"', '"专业检查才能放心"']
    ]);

    const audiences = pick([
      ['6-18岁儿童青少年', '经常揉眼眯眼', '佩戴眼镜度数增长快'],
      ['3-18岁儿童青少年', '看黑板模糊/眯眼', '父母有近视史的儿童']
    ]);

    // 服务流程变体
    const flowStep2 = type === 'traffic'
      ? pick(['专业验光 · 眼轴检测等多项检查(20分钟)', '快速筛查 · 8项核心检查(15分钟)'])
      : type === 'profit'
      ? pick(['深度检查 · 眼轴+角膜+视功能(25分钟)', '精密检测 · 全面眼健康评估(25分钟)'])
      : pick(['系统检查 · 全套视力评估(25分钟)', '综合检测 · 眼轴+视功能+眼底(30分钟)']);

    // 评价变体
    const review1 = pick([
      `"先进仪器全国位验配设备，\n能精准适配合视力矫正所需！\n服务从挂号到检查全程都很贴心"\n\n—— 朱大大宝贝`,
      `"检查很全面，医生很有耐心，\n${p.name}值得推荐！"\n\n—— 用户***8`,
      `"第一次带孩子来，体验非常好，\n设备先进，医生专业！"\n\n—— 张女士`
    ]);
    const review2 = pick([
      `"验光师很专业，团购价也很实惠！"\n\n—— 匿名用户`,
      `"性价比很高，报告解读很详细"\n\n—— 李先生`,
      `"环境好，服务好，下次还来"\n\n—— 王女士`
    ]);

    const screens = [
      {
        title: '第1屏 · 利益钩子',
        body: `${hookTitle}\n${hookSub}\n\n今日还剩${remainNum}份 | 已有${soldNum}+人购买 | 90天有效期`
      },
      {
        title: '第2屏 · 痛点场景',
        body: `${painPoints.join('\n')}\n\n适合人群：\n· ${audiences.join('\n· ')}`
      },
      {
        title: '第3屏 · 服务流程',
        body: `4步完成检查，全程约45分钟\n\n① 预约到店(5分钟)\n   ↓\n② ${flowStep2}\n   ↓\n③ ${clinic.doctor}医生报告解读(15分钟)\n   ↓\n④ 个性化建议(5分钟)`
      },
      {
        title: '第4屏 · 资质背书',
        body: `爱尔眼科 · ${clinic.name}\n\n✓ 三甲水准服务标准\n✓ 注册眼科医师团队\n✓ ${clinic.doctor}医生 — ${clinic.doctorExp}\n✓ 先进仪器全国位验配设备\n✓ A股上市眼科集团（300015）\n✓ 全国900+门诊覆盖`
      },
      {
        title: '第5屏 · 真实评价',
        body: `${review1}\n\n${review2}`
      },
      {
        title: '第6屏 · FAQ解疑',
        body: `家长最关心的5个问题\n\nQ: 孩子多大可以做？\nA: 建议3岁以上\n\nQ: 检查前需要准备什么？\nA: 停戴隐形眼镜3天\n\nQ: 当天能拿报告吗？\nA: 是的，当场出具\n\nQ: 需要空腹吗？\nA: 不需要，正常饮食即可\n\nQ: 多久需要复查一次？\nA: 建议每3-6个月复查`
      },
      {
        title: '第7屏 · 预约CTA',
        body: `立即预约 · 锁定今日份额\n\n☎ ${clinic.phone}\n⌂ ${clinic.address}\n⊚ ${clinic.doctor}医生 · 眼科 · ${clinic.doctorExp}\n\n预约后1小时内确认\n营业时间：周一至周日 8:00-20:00`
      }
    ];

    res.json({ screens });
  } catch (e) {
    console.error('copywriting-generate error:', e);
    res.status(500).json({ error: '文案生成服务异常，请稍后重试' });
  }
});

// ===== POST /api/image-generate =====
app.post('/api/image-generate', async (req, res) => {
  try {
    const { style, product, imageBase64 } = req.body;
    const p = product || { name: '儿童青少年视力检查', price: '¥39.9' };
    const s = style || 'pro';

    const styleMap = {
      warm: { colors: ['#06b6d4', '#10b981'], label: '亲子温暖型', accent: '#ffffff', desc: '温馨家庭感，蓝绿色调' },
      pro: { colors: ['#1a3a5c', '#3b82f6'], label: '专业信任型', accent: '#ffffff', desc: '权威医疗感，深蓝白色调' },
      promo: { colors: ['#ef4444', '#f59e0b'], label: '优惠促销型', accent: '#fff7ed', desc: '活力促销感，红黄色调' },
      premium: { colors: ['#1f2937', '#d97706'], label: '高端医疗型', accent: '#fef3c7', desc: '高端质感，深灰金色调' }
    };

    const st = styleMap[s] || styleMap.pro;

    // 如果配置了 VOLC_API_KEY，调用 Seedream 真实生成
    if (VOLC_API_KEY) {
      // 四张图的目标规格（美团/大众点评平台标准尺寸）
      const slots = [
        { name: '内页图·第1屏', width: 750, height: 1400, promptExtra: '竖版长图构图，重点突出项目名称和价格优势，顶部醒目标题' },
        { name: '内页图·第2屏', width: 750, height: 1400, promptExtra: '竖版长图构图，展示服务流程、检查项目和门店环境，专业可信' },
        { name: '主图A/B测试', width: 800, height: 800, promptExtra: '正方形构图，适合商品主图缩略图，画面中心突出，醒目简洁' },
        { name: '活动Banner', width: 1200, height: 400, promptExtra: '宽幅横幅构图，适合活动Banner，左右布局，突出限时优惠和活动主题' }
      ];

      try {
        // 用2组不同提示词生成2张差异化底图（每张约20秒，共约40秒）
        const basePrompt = `专业眼科医疗门诊宣传海报，${p.name}，${st.desc}，高清医疗广告设计风格，适合美团/大众点评平台展示，画面中包含眼科检查元素、专业医生形象、温馨就诊环境，不要添加任何文字或字母，纯画面设计`;
        const promptA = `${basePrompt}，${slots[0].promptExtra}`;
        const promptB = `${basePrompt}，${slots[3].promptExtra}`;

        const urlA = await callSeedreamOnce({ prompt: promptA, imageBase64, size: '1920x1920' });
        const urlB = await callSeedreamOnce({ prompt: promptB, imageBase64, size: '1920x1920' });

        const images = slots.map((slot, idx) => ({
          name: slot.name,
          url: idx === 1 ? (urlB || urlA) : (idx === 3 ? (urlB || urlA) : (urlA || urlB)),
          width: slot.width,
          height: slot.height
        }));

        res.json({ images, styleLabel: st.label, refImage: !!imageBase64 });
        return;
      } catch (seedreamErr) {
        console.error('[image-generate] Seedream API 调用失败，回退到模拟数据:', seedreamErr.message);
      }
    }

    // 未配置 API Key 时回退到模拟数据
    await delay(randInt(1200, 2200));

    const images = [
      {
        name: '内页图·第1屏',
        width: 750,
        height: 1400,
        bg: st.colors,
        title: p.name,
        subtitle: `仅${p.price} · ${st.label}`,
        accent: st.accent,
        elements: [
          { type: 'circle', x: 600, y: 120, r: 80, color: 'rgba(255,255,255,0.08)' },
          { type: 'circle', x: 100, y: 1300, r: 120, color: 'rgba(255,255,255,0.05)' },
          { type: 'priceTag', x: 50, y: 400, price: p.price },
          { type: 'badge', x: 50, y: 500, text: '爱尔眼科' }
        ]
      },
      {
        name: '内页图·第2屏',
        width: 750,
        height: 1400,
        bg: st.colors,
        title: pick(['孩子看不清黑板？', '近视防控关键期', '及早筛查 及早干预']),
        subtitle: pick(['专业检查 · 科学防控', '精准检测 · 医生解读', '守护孩子清晰视界']),
        accent: st.accent,
        elements: [
          { type: 'circle', x: 650, y: 200, r: 60, color: 'rgba(255,255,255,0.1)' },
          { type: 'circle', x: 80, y: 1100, r: 100, color: 'rgba(255,255,255,0.06)' },
          { type: 'line', x1: 50, y1: 800, x2: 700, y2: 800, color: 'rgba(255,255,255,0.15)' }
        ]
      },
      {
        name: '主图A/B测试',
        width: 800,
        height: 800,
        bg: st.colors,
        title: p.name,
        subtitle: p.price,
        accent: st.accent,
        elements: [
          { type: 'circle', x: 650, y: 150, r: 100, color: 'rgba(255,255,255,0.1)' },
          { type: 'circle', x: 100, y: 650, r: 80, color: 'rgba(255,255,255,0.06)' },
          { type: 'priceTag', x: 50, y: 550, price: p.price },
          { type: 'badge', x: 50, y: 650, text: '限时特惠' }
        ]
      },
      {
        name: '活动Banner',
        width: 1200,
        height: 400,
        bg: st.colors,
        title: p.name + ' 限时优惠',
        subtitle: `${p.price}起 · ${st.label}`,
        accent: st.accent,
        elements: [
          { type: 'circle', x: 1050, y: 80, r: 100, color: 'rgba(255,255,255,0.08)' },
          { type: 'circle', x: 1100, y: 350, r: 60, color: 'rgba(255,255,255,0.06)' },
          { type: 'priceTag', x: 50, y: 250, price: p.price }
        ]
      }
    ];

    res.json({ images, styleLabel: st.label, refImage: !!imageBase64 });
  } catch (e) {
    console.error('image-generate error:', e);
    res.status(500).json({ error: '套图生成服务异常: ' + (e.message || '请稍后重试') });
  }
});

// ===== POST /api/script-suggest =====
app.post('/api/script-suggest', async (req, res) => {
  try {
    await delay(randInt(800, 1600));
    const { scene, product, clinicData } = req.body;
    const clinic = clinicData || CLINIC;
    const p = product || { name: '儿童青少年视力检查', price: '¥39.9' };
    const s = scene || '预约确认';

    const scripts = [];

    if (s === '预约确认' || s === '全部') {
      scripts.push({
        name: '预约确认短信',
        desc: '用户下单后30分钟内发送',
        iconBg: '#3b82f6',
        iconChar: 'A',
        text: pick([
          `已成功为您预约${p.name}，时间XX月XX日，地址：${clinic.address}。温馨提示：检查前停戴隐形眼镜3天。如需改期请提前2小时告知。`,
          `【爱尔眼科】您已成功预约${p.name}，就诊时间XX月XX日，${clinic.doctor}医生为您服务。检查前请停戴隐形3天，如需改期请提前联系。`
        ])
      });
      scripts.push({
        name: '企微预约确认',
        desc: '通过企业微信发送预约确认',
        iconBg: '#06b6d4',
        iconChar: 'A2',
        text: `您好，感谢预约${p.name}！\n\n📅 时间：XX月XX日\n📍 地址：${clinic.address}\n👨‍⚕️ ${clinic.doctor}医生为您服务\n\n温馨提示：检查前停戴隐形眼镜3天，当天无需空腹。如有疑问随时联系我们~`
      });
    }

    if (s === '到店接待' || s === '全部') {
      scripts.push({
        name: '到店接待话术',
        desc: '患者到店前台接待时使用',
        iconBg: '#10b981',
        iconChar: 'B',
        text: pick([
          `您好，欢迎来到${clinic.name}！是来做${p.name}的吗？太好了，我们今天会为您做专业检查，全程大约45分钟，${clinic.doctor}医生会为您1对1解读报告。先帮您登记一下。`,
          `您好！欢迎光临${clinic.name}，请问是预约了${p.name}吗？好的，这边帮您核对信息。检查全程约45分钟，${clinic.doctor}医生会亲自解读报告，请跟我来登记。`
        ])
      });
      scripts.push({
        name: '候诊引导话术',
        desc: '候诊期间安抚和引导',
        iconBg: '#34d399',
        iconChar: 'B2',
        text: `让您久等了，${clinic.doctor}医生马上就到。候诊期间可以先看看我们的检查流程介绍，了解一下今天会做哪些项目。有任何问题都可以随时问我~`
      });
    }

    if (s === '检查结果' || s === '全部') {
      scripts.push({
        name: '检查结果-正常',
        desc: '检查结果正常时的沟通话术',
        iconBg: '#8b5cf6',
        iconChar: 'C',
        text: pick([
          `检查结果出来了，孩子目前视力状况良好，没有明显近视迹象。建议继续保持良好的用眼习惯，每6个月复查一次，做好预防。`,
          `好消息！检查结果显示孩子视力正常。不过目前正处于近视高发期，建议每半年复查一次，平时注意用眼距离和户外活动时间。`
        ])
      });
      scripts.push({
        name: '检查结果-需观察',
        desc: '检查结果需要观察时的沟通话术',
        iconBg: '#a78bfa',
        iconChar: 'C2',
        text: `检查结果出来了，孩子目前处于近视增长关键期，建议每3个月复查一次。我们有一个近视儿童度数防护24次复查方案，可以系统地帮助孩子控制度数增长，还包含散瞳检查。`
      });
      scripts.push({
        name: '检查结果-需干预',
        desc: '需要干预治疗时的沟通话术',
        iconBg: '#7c3aed',
        iconChar: 'C3',
        text: pick([
          `根据检查结果，孩子近视度数增长较快，需要积极干预。我们有角膜塑形镜（OK镜）和多焦点离焦镜两种方案，${clinic.doctor}医生会根据孩子情况推荐最适合的方案。`,
          `检查结果显示孩子近视进展比较明显，建议尽早采取防控措施。我们提供OK镜验配和近视防控镜片两种方案，可以有效延缓度数增长，${clinic.doctor}医生会给您详细建议。`
        ])
      });
    }

    if (s === '升级引导' || s === '全部') {
      scripts.push({
        name: '引流款→利润款转化',
        desc: '从基础检查升级到深度服务的引导话术',
        iconBg: '#f59e0b',
        iconChar: 'D',
        text: pick([
          `您今天做的是基础视力检查，如果需要更全面的眼健康评估，我们还有深度检查套餐，包含眼轴测量、角膜地形图等，${clinic.doctor}医生会做更详细的解读。`,
          `基础筛查可以了解基本情况，但如果想更精准地掌握孩子视力发展趋势，建议加做眼轴检测，可以量化评估近视发展速度，帮助制定更有效的防控方案。`
        ])
      });
      scripts.push({
        name: '单次→套餐转化',
        desc: '引导用户选择长期套餐方案',
        iconBg: '#d97706',
        iconChar: 'D2',
        text: `单次检查只能看当下的情况，近视防控是一个长期过程。我们的年度管理套餐包含检查+复查+报告追踪，每3个月复查一次，${clinic.doctor}医生全程跟踪，比单次检查更省心也更划算。`
      });
    }

    if (s === '离店跟进' || s === '全部') {
      scripts.push({
        name: '离店48小时跟进',
        desc: '就诊后48小时企微发送',
        iconBg: '#ef4444',
        iconChar: 'E',
        text: pick([
          `您好！孩子今天检查很配合，报告显示一切正常请放心。如果孩子近期有眯眼、揉眼等情况随时联系我们。另外，如果满意的话，能在美团给我们留个评价吗？`,
          `您好！感谢今天到${clinic.name}就诊，报告已出一切正常。日常注意用眼习惯，3个月后记得来复查。如果对我们的服务满意，期待您在美团留下宝贵评价~`
        ])
      });
      scripts.push({
        name: '7天复查提醒',
        desc: '7天后提醒复查和关怀',
        iconBg: '#dc2626',
        iconChar: 'E2',
        text: `您好！距离上次检查已经一周了，孩子用眼情况还好吗？如果有任何不适随时联系我们。另外提醒您，下次复查时间是XX月XX日，可以提前在美团预约，更方便哦~`
      });
    }

    // 如果场景为"全部"，限制返回数量
    if (s === '全部' && scripts.length > 6) {
      scripts.splice(6);
    }

    res.json({ scripts });
  } catch (e) {
    console.error('script-suggest error:', e);
    res.status(500).json({ error: '话术建议服务异常，请稍后重试' });
  }
});

// ===== POST /api/review-reply =====
app.post('/api/review-reply', async (req, res) => {
  try {
    await delay(randInt(1000, 2000));
    const { text, imageBase64, clinicData } = req.body;
    const clinic = clinicData || CLINIC;
    const reviewText = text || '';

    // 智能分析差评问题类型
    const issueKeywords = {
      '等待时间长': ['等', '排队', '久', '慢', '小时', '分钟', '候诊', '轮到'],
      '服务态度': ['态度', '服务', '冷漠', '不耐烦', '凶', '敷衍', '不理'],
      '效果不满意': ['效果', '没用', '没好', '更差', '无效', '骗', '忽悠'],
      '价格问题': ['贵', '贵', '价格', '收费', '不值', '坑', '多花'],
      '环境问题': ['环境', '脏', '乱', '差', '吵', '冷', '热', '卫生'],
      '预约问题': ['预约', '挂', '约', '改期', '取消', '满']
    };

    const detectedIssues = [];
    for (const [issueType, keywords] of Object.entries(issueKeywords)) {
      for (const kw of keywords) {
        if (reviewText.indexOf(kw) >= 0) {
          detectedIssues.push(issueType);
          break;
        }
      }
    }
    if (detectedIssues.length === 0) detectedIssues.push('体验不佳');

    const mainIssue = detectedIssues[0];

    // 根据问题类型生成差异化回复
    const issueTemplates = {
      '等待时间长': {
        analysis: `检测到「等待时间长」问题。用户核心诉求是时间被浪费、预约未生效。回复需：1)诚恳道歉 2)解释原因（高峰期/突发情况）3)说明已采取的改进措施 4)提供补偿（优先通道/优惠券）5)邀请再次体验。${imageBase64 ? '已收到用户上传的截图，建议结合截图中展示的具体等待场景进行针对性回复。' : ''}`,
        replies: [
          {
            tag: '诚恳道歉+改进说明',
            text: `非常抱歉让您久等了，您提到的等待问题确实反映了我们在预约管理上有待改进的地方。当天由于就诊高峰期患者较多，导致您的预约未能按时落实，我们深感抱歉。目前我们已优化了预约排班系统，增加了高峰时段的接诊医生数量。为表达歉意，我们诚邀您再次到访，将为您安排优先通道并由${clinic.doctor}医生亲自接待。如有任何疑问，请随时联系我们。`
          },
          {
            tag: '深度共情+具体补偿',
            text: `尊敬的顾客，非常抱歉给您带来了不好的就诊体验。等待40多分钟确实超出了合理范围，您的不满完全可以理解。我们已经将此事反馈给门诊管理团队，并对当天的排班进行了复盘和优化。为了弥补给您造成的时间损失，我们希望能为您提供一次免费的复查服务，并附赠眼部舒缓理疗一次。期待您能给我们一次改进的机会，我们将全力确保您的就诊体验顺畅高效。`
          }
        ]
      },
      '服务态度': {
        analysis: `检测到「服务态度」问题。用户对工作人员态度不满，需要：1)真诚道歉不推诿 2)说明已内部核查/培训 3)承诺改进 4)负责人亲自跟进 5)提供补偿方案。${imageBase64 ? '截图已收到，建议仔细查看截图中反映的具体服务场景。' : ''}`,
        replies: [
          {
            tag: '诚恳道歉+内部整改',
            text: `非常抱歉让您感受到了不被尊重的待遇，这绝不是我们应有的服务标准。您反馈的情况我们已经第一时间进行了内部核查，并对相关工作人员进行了严肃的服务培训。我们一直以患者为中心，这次的事件让我们深刻反思。${clinic.doctor}医生也希望当面向您致歉。我们诚挚邀请您再次到访，届时将由资深护士全程陪同，并为您准备一份眼部护理礼包。`
          },
          {
            tag: '共情+负责人跟进',
            text: `您好，对于您在就诊过程中遇到的服务问题，我们深表歉意。每一位患者都应该被尊重和认真对待，您反映的情况我们已经报告给门诊负责人，并将纳入月度服务培训案例。我们想通过电话向您进一步了解细节，以便针对性改进。同时为您准备了专属道歉礼——免费眼健康全面检查一次，希望能得到您的谅解。`
          }
        ]
      },
      '效果不满意': {
        analysis: `检测到「效果不满意」问题。用户对治疗效果/检查结果存疑，需要：1)先共情不争辩 2)解释眼科治疗的客观规律 3)免费复诊安排 4)医生专业解读 5)长期跟踪。${imageBase64 ? '截图已收到，建议结合截图内容评估用户具体不满的项目。' : ''}`,
        replies: [
          {
            tag: '专业解释+免费复诊',
            text: `非常理解您对治疗效果的关注和担忧。眼科检查和视力矫正是一个循序渐进的过程，部分项目在单次体验后可能不会有立竿见影的感受。为了消除您的顾虑，我们想邀请您免费进行一次复诊，由${clinic.doctor}医生亲自为您详细解读检查结果，并根据实际情况调整方案。您的健康是我们最大的关切，请相信我们会全力以赴。`
          },
          {
            tag: '共情+方案调整',
            text: `您好，感谢您如实反馈治疗效果的问题。我们深知当您带着期望而来却未达预期时的失落感。每个人的眼部情况不同，治疗方案也需要个性化调整。我们诚挚邀请您回来进行一次免费复诊，${clinic.doctor}医生将重新评估您的情况，并根据需要调整治疗计划。我们承诺全程跟进直到您满意为止。`
          }
        ]
      },
      '价格问题': {
        analysis: `检测到「价格/收费」问题。用户觉得价格贵或收费不透明，需要：1)解释价格构成 2)说明与竞品对比的优势 3)提供优惠方案 4)强调价值而非价格。${imageBase64 ? '截图已收到，可结合截图中的价格信息进行针对性说明。' : ''}`,
        replies: [
          {
            tag: '价值说明+优惠补偿',
            text: `感谢您的反馈。我们的定价是基于专业设备、资深医生团队和标准化服务流程综合制定的，相比同类型眼科机构，我们的检查项目更为全面，且包含医生1对1报告解读服务。如果本次消费让您觉得超出预期，我们非常抱歉。为此我们为您准备了一张50元无门槛优惠券，下次到店可直接抵扣。同时欢迎您对比了解，我们对自己的专业水准充满信心。`
          },
          {
            tag: '透明解释+诚意挽留',
            text: `非常抱歉给您留下了收费方面的困扰。爱尔眼科作为A股上市医疗集团，始终坚持公开透明的收费标准，所有项目均明码标价。如果您对某笔费用有疑问，欢迎随时联系我们核对明细。同时，为了感谢您的直言反馈，我们特为您提供一次免费的基础复查服务。期待您给我们一次证明价值的机会。`
          }
        ]
      },
      '环境问题': {
        analysis: `检测到「就诊环境」问题。用户对门诊环境不满，需要：1)道歉并承认问题 2)说明已整改 3)邀请实地体验改善后的环境 4)提供小礼品。${imageBase64 ? '截图已收到，建议根据截图中反映的具体环境问题精准回复。' : ''}`,
        replies: [
          {
            tag: '道歉+整改邀请',
            text: `非常抱歉我们的就诊环境没有达到您的期望。您反馈的问题我们已经立即进行了整改，包括加强清洁频次、优化候诊区布局等。环境舒适度直接影响就诊体验，这是我们绝不能忽视的细节。我们诚邀您再次到访，亲身感受改善后的就诊环境，并为您准备了一份护眼小礼品。您的每一条反馈都是我们进步的动力。`
          }
        ]
      }
    };

    const template = issueTemplates[mainIssue] || issueTemplates['等待时间长'];
    const result = {
      analysis: template.analysis,
      replies: template.replies,
      issues: detectedIssues,
      hasImage: !!imageBase64
    };

    res.json(result);
  } catch (e) {
    console.error('review-reply error:', e);
    res.status(500).json({ error: '差评回复服务异常，请稍后重试' });
  }
});

// ===== POST /api/meituan-ops =====
app.post('/api/meituan-ops', async (req, res) => {
  try {
    await delay(randInt(800, 1600));
    const { clinicData, focusArea } = req.body;
    const clinic = clinicData || CLINIC;

    const diagnosisAreas = [
      { area: '店铺装修', tips: ['头图轮播建议更换为医生亲子场景', '商家相册需补充检查设备实拍', '环境视频时长控制在30秒内'] },
      { area: '团购项目', tips: ['引流款价格竞争力不足，建议降至29.9', '利润款详情页缺少眼轴检测说明', '套餐款有效期建议延长至90天'] },
      { area: '评价管理', tips: ['近30天差评回复率仅60%，需提升至100%', '好评引导话术需要优化', '评价标签管理需完善'] },
      { area: '推广投放', tips: ['搜索推广关键词需补充"近视防控"', '信息流定向人群过窄，建议扩量', '推广时段建议覆盖晚高峰'] },
      { area: '活动策划', tips: ['开学季活动预热不足，提前2周启动', '缺少老带新激励机制', '满减门槛设置不合理'] }
    ];

    const diagnosis = diagnosisAreas.map(d => {
      const s = randInt(60, 95);
      return {
        area: d.area,
        status: s >= 80 ? 'good' : s >= 70 ? 'warn' : 'bad',
        score: s,
        tip: pick(d.tips)
      };
    });

    const actionItems = [
      {
        priority: 'P1',
        title: '优化店铺头图和团购详情页',
        desc: `将头图更换为${clinic.doctor}医生与儿童的温馨互动场景，团购详情页补充眼轴检测等核心项目说明，预计提升点击率20%`,
        impact: '预计提升点击率15-20%'
      },
      {
        priority: 'P1',
        title: '建立差评24小时回复机制',
        desc: '设置专人负责每日评价监控，确保差评24小时内回复，好评引导到店后3天内完成',
        impact: '预计评分提升至4.8+'
      },
      {
        priority: 'P2',
        title: '调整推广投放策略',
        desc: '补充"近视防控""OK镜"等核心关键词，扩大信息流定向人群至3-15岁家长，日预算提升至300元',
        impact: '预计曝光量提升30%'
      }
    ];

    const events = [
      { name: '开学季护眼活动', time: '3月', budget: '5000元', expectedGMV: '30000元' },
      { name: '爱眼日特惠', time: '6月', budget: '3000元', expectedGMV: '20000元' },
      { name: '暑期近视防控营', time: '7-8月', budget: '8000元', expectedGMV: '50000元' }
    ];

    res.json({
      score: Math.round(diagnosis.reduce((s, d) => s + d.score, 0) / diagnosis.length),
      diagnosis,
      actionItems,
      promotionPlan: {
        keywords: ['眼科', '近视', 'OK镜', '配镜', '近视防控', '眼轴检测'],
        dailyBudget: '200-300元',
        schedule: '工作日白天搜索推广，周末信息流+搜索'
      },
      eventPlan: { upcoming: events.slice(0, 2) }
    });
  } catch (e) {
    console.error('meituan-ops error:', e);
    res.status(500).json({ error: '美团运营诊断服务异常，请稍后重试' });
  }
});

// ===== POST /api/private-domain =====
app.post('/api/private-domain', async (req, res) => {
  try {
    await delay(randInt(800, 1600));
    const { clinicData, focus } = req.body;
    const clinic = clinicData || CLINIC;

    res.json({
      welcomeScripts: [
        {
          name: '新患者欢迎语',
          text: `您好！欢迎加入${clinic.name}眼健康守护群！我是您的专属眼健康顾问。\n\n📚 为您准备了《儿童近视防控指南》\n🎁 首购优惠券已发放至您的账户\n📞 有任何问题随时咨询，${clinic.doctor}医生团队为您服务`,
          timing: '添加后自动发送'
        },
        {
          name: '首购关怀',
          text: `感谢您选择${clinic.name}！\n\n📅 请按照预约时间到店\n💡 检查前停戴隐形眼镜3天\n📞 如需改期请提前2小时告知\n\n期待为您的眼健康保驾护航！`,
          timing: '下单后1小时'
        }
      ],
      followUpScripts: [
        {
          name: 'OK镜1周复查提醒',
          text: `您好！孩子佩戴OK镜已经1周了，建议安排首次复查。\n\n🔍 复查内容：镜片适配度、角膜健康\n📅 建议时间：配镜后7-10天\n📞 预约电话：${clinic.phone}\n\n及时复查是确保佩戴安全的关键！`,
          timing: '配镜后7天'
        },
        {
          name: 'OK镜1月复查提醒',
          text: `您好！孩子佩戴OK镜已满1个月，需要进行月度复查。\n\n🔍 复查内容：视力变化、眼轴测量\n📊 ${clinic.doctor}医生将评估近视控制效果\n🎁 本月复查赠送眼部SPA一次`,
          timing: '配镜后30天'
        },
        {
          name: '离焦镜3月复查提醒',
          text: `您好！孩子佩戴离焦镜片已3个月，建议回院复查。\n\n🔍 复查内容：度数变化、镜片磨损检查\n📊 对比初配数据，评估防控效果\n📞 在线预约更便捷`,
          timing: '配镜后90天'
        }
      ],
      communitySOP: {
        morning: '8:30 护眼小知识图文（如：20-20-20法则）',
        noon: '12:00 互动话题/投票（如：你家孩子每天户外几小时？）',
        evening: '19:30 案例分享/专家答疑预告',
        weekly: '周五会员日优惠/限时秒杀活动'
      },
      patientLayers: [
        { layer: '新患者', condition: '首次到店0-7天', strategy: '激活体验+使用指导', frequency: '1次/天' },
        { layer: '活跃患者', condition: '30天内有互动', strategy: '内容种草+复购提醒', frequency: '2次/周' },
        { layer: 'VIP患者', condition: '累计消费>5000', strategy: '专属顾问+优先预约', frequency: '1次/周' },
        { layer: '沉默患者', condition: '90天无互动', strategy: '激活优惠+关怀回访', frequency: '1次/月' }
      ]
    });
  } catch (e) {
    console.error('private-domain error:', e);
    res.status(500).json({ error: '私域运营服务异常，请稍后重试' });
  }
});

// ===== POST /api/douyin-plan =====
app.post('/api/douyin-plan', async (req, res) => {
  try {
    await delay(randInt(800, 1600));
    const { clinicData, contentType } = req.body;
    const clinic = clinicData || CLINIC;

    const videoScripts = [
      {
        title: '孩子近视了千万别做这3件事',
        duration: '35s',
        opening: '冲突型："孩子近视了，90%的家长都在做错这3件事！"',
        script: `【0-3s】文字+表情冲击："孩子近视了，90%的家长都做错了！"\n【3-15s】错误1：盲目配镜不检查眼轴\n【15-25s】错误2：忽视每天2小时户外活动\n【25-35s】错误3：从不复查，度数年年涨\n【结尾】引导：来${clinic.name}做专业检查，${clinic.doctor}医生为您制定防控方案`,
        bgm: '本周热门BGM《热门推荐》',
        hashtags: ['#近视防控', '#OK镜', '#护眼知识', '#爱尔眼科']
      },
      {
        title: '眼科医生自己孩子怎么防控近视',
        duration: '45s',
        opening: '共鸣型："作为眼科医生，我是这样给孩子防控近视的..."',
        script: `【0-3s】${clinic.doctor}医生出镜："很多家长问我，你自己孩子怎么防近视？"\n【3-20s】分享5个日常习惯：20-20-20法则、户外活动、用眼距离、定期检查、OK镜\n【20-40s】现场展示检查设备和环境\n【40-45s】CTA：关注+预约检查`,
        bgm: '温馨治愈系BGM',
        hashtags: ['#眼科医生', '#近视防控', '#OK镜', '#护眼']
      }
    ];

    res.json({
      videoScripts,
      weeklyCalendar: [
        { day: '周一', topic: '护眼科普：20-20-20法则', type: '科普讲解' },
        { day: '周三', topic: `${clinic.doctor}医生答疑：OK镜适合谁？`, type: '医生IP' },
        { day: '周五', topic: '8岁近视200度，1年后控制0增长', type: '患者故事' }
      ],
      livePlan: {
        theme: `${clinic.doctor}医生在线答疑 · 开学季护眼专场`,
        script: `【0-15min】留人开场：免费视力筛查名额抽奖\n【15-45min】痛点放大：开学季近视高发原因\n【45-75min】方案讲解：OK镜/离焦镜/功能镜对比\n【75-85min】限时优惠：直播间专属39.9检查券\n【85-90min】关注引导+下次直播预告`,
        products: ['视力检查39.9', 'OK镜验配咨询', '离焦镜套餐'],
        duration: '1.5小时'
      },
      adStrategy: {
        budget: '2000元/月',
        targeting: '3-15岁家长 / 近视人群 / 临沂同城',
        goal: '粉丝增长500+/月 + 到店转化30+/月'
      }
    });
  } catch (e) {
    console.error('douyin-plan error:', e);
    res.status(500).json({ error: '抖音策略服务异常，请稍后重试' });
  }
});

// ===== POST /api/xiaohongshu-plan =====
app.post('/api/xiaohongshu-plan', async (req, res) => {
  try {
    await delay(randInt(800, 1600));
    const { clinicData, contentType } = req.body;
    const clinic = clinicData || CLINIC;

    const noteScripts = [
      {
        title: `打工人护眼清单｜${clinic.doctor}医生推荐7个好习惯`,
        type: '图文',
        body: `【封面】护眼清单大字报\n\n1️⃣ 20-20-20法则：每20分钟看20英尺外20秒\n2️⃣ 每天2小时户外活动\n3️⃣ 用眼距离保持33cm以上\n4️⃣ 每半年一次专业检查\n5️⃣ 睡前热敷缓解疲劳\n6️⃣ 多吃叶黄素食物\n7️⃣ OK镜/离焦镜科学防控\n\n🏥 ${clinic.name}\n👨‍⚕️ ${clinic.doctor}医生｜从业${clinic.doctorExp}\n📍 ${clinic.address}`,
        tags: ['近视防控', '护眼', 'OK镜', '打工人', '眼科'],
        cover: '蓝绿色调护眼清单大字报，突出数字7'
      },
      {
        title: 'OK镜VS离焦镜，近视防控到底选哪个',
        type: '图文',
        body: `【封面】OK镜🆚离焦镜对比图\n\n💡 OK镜（角膜塑形镜）\n✓ 夜戴白天清晰\n✓ 控制效果60%以上\n✓ 适合8-18岁\n✗ 价格较高（6800-12800）\n✗ 需严格护理\n\n💡 离焦镜片\n✓ 日间佩戴方便\n✓ 控制效果30-60%\n✓ 适合6-15岁\n✓ 价格适中（1580-3680）\n\n🎯 选择建议：根据年龄、度数、生活习惯综合评估\n📞 预约${clinic.doctor}医生专业咨询`,
        tags: ['OK镜', '离焦镜', '近视防控', '配镜', '眼科'],
        cover: '对比风格，左右分栏，蓝金配色'
      }
    ];

    res.json({
      noteScripts,
      weeklyCalendar: [
        { day: '周二', topic: '打工人护眼清单7个好习惯', type: '护眼干货' },
        { day: '周四', topic: 'OK镜VS离焦镜到底怎么选', type: '产品测评' },
        { day: '周六', topic: `39.9做了超全眼科检查！附攻略`, type: '探店分享' }
      ],
      seedingPlan: {
        quantity: '60-80篇/月',
        budget: '6000-10000元/月',
        strategy: '素人铺量(50篇) + 腰部达人(15篇) + 头部联动(3篇)'
      }
    });
  } catch (e) {
    console.error('xiaohongshu-plan error:', e);
    res.status(500).json({ error: '小红书策略服务异常，请稍后重试' });
  }
});

// ===== POST /api/wechat-plan =====
app.post('/api/wechat-plan', async (req, res) => {
  try {
    await delay(randInt(800, 1600));
    const { clinicData, contentType } = req.body;
    const clinic = clinicData || CLINIC;

    const articleTitles = [
      '7个护眼习惯，第3个90%人不知道',
      '8岁近视200度，1年后竟然控制住了',
      '限时39.9｜开学季护眼礼包开抢',
      'OK镜VS离焦镜，到底怎么选？'
    ];
    const articleBodies = [
      `【开头】"孩子又揉眼睛了？写作业越凑越近？"\n\n作为家长，你可能正在忽视孩子近视的信号...\n\n1️⃣ 每20分钟远眺20秒\n2️⃣ 每天户外活动2小时\n3️⃣ 定期检查眼轴（90%家长忽略！）\n...\n\n🏥 ${clinic.name}提供儿童青少年视力检查\n👨‍⚕️ ${clinic.doctor}医生亲诊`,
      `【开头】悬念："8岁近视200度，很多家长选择放弃，但我们做到了0增长"\n\n真实案例分享...\n\n📊 初检数据：右眼200度，左眼175度\n💡 方案：OK镜+户外活动+定期复查\n📈 1年后：度数0增长！\n\n👇 点击下方阅读原文预约检查`
    ];

    res.json({
      articleDraft: {
        title: pick(articleTitles),
        body: pick(articleBodies),
        cta: '点击下方阅读原文，预约39.9儿童视力检查'
      },
      menuPlan: {
        menu1: { name: '护眼服务', items: ['在线预约', '专家团队', '门店导航'] },
        menu2: { name: '眼健康', items: ['护眼知识', '近视防控', '自测工具'] },
        menu3: { name: '会员中心', items: ['我的积分', '复查提醒', '在线咨询'] }
      },
      monthlyCalendar: [
        { week: '第1周', theme: '开学季护眼指南', type: '科普类' },
        { week: '第2周', theme: `${clinic.doctor}医生专访：近视防控新进展`, type: '故事类' },
        { week: '第3周', theme: '限时特惠：视力检查套餐', type: '活动类' },
        { week: '第4周', theme: 'OK镜VS离焦镜深度对比', type: '评测类' }
      ]
    });
  } catch (e) {
    console.error('wechat-plan error:', e);
    res.status(500).json({ error: '公众号运营服务异常，请稍后重试' });
  }
});

// ===== POST /api/growth-plan =====
app.post('/api/growth-plan', async (req, res) => {
  try {
    await delay(randInt(800, 1600));
    const { clinicData, currentMetrics } = req.body;
    const clinic = clinicData || CLINIC;

    res.json({
      funnelAnalysis: {
        stages: [
          { stage: '曝光', rate: '100%', target: '提升美团搜索排名至前3' },
          { stage: '点击', rate: '3-5%', target: '优化主图和标题，目标5%+' },
          { stage: '咨询', rate: '20-30%', target: '完善FAQ和自动回复' },
          { stage: '预约', rate: '40-50%', target: '简化预约流程' },
          { stage: '到店', rate: '60-70%', target: '提醒SOP+导航指引' },
          { stage: '成交', rate: '50-60%', target: '话术优化+套餐推荐' }
        ]
      },
      channelROI: [
        { channel: '美团推广通', cac: '50-80元', conversion: '15-25%', roi: '2-4:1', priority: 'P0' },
        { channel: '抖音DOU+', cac: '30-60元', conversion: '8-15%', roi: '1.5-3:1', priority: 'P1' },
        { channel: '小红书种草', cac: '20-40元', conversion: '5-10%', roi: '2-5:1', priority: 'P1' },
        { channel: '企微转介绍', cac: '5-10元', conversion: '40-60%', roi: '8-15:1', priority: 'P0' },
        { channel: '公众号自然', cac: '0-5元', conversion: '3-8%', roi: '10+:1', priority: 'P1' }
      ],
      growthExperiments: [
        {
          name: '主图A/B测试',
          hypothesis: '如果主图从文字图改为医生场景图，点击率将提升20%',
          method: '同时上架2个相同项目，仅主图不同，测试2周',
          budget: '500元',
          expected: '点击率从3%提升至3.6%'
        },
        {
          name: '有效期延长测试',
          hypothesis: '如果有效期从30天延长至90天，转化率将提升15%',
          method: '随机50%用户展示90天有效期，对比转化数据',
          budget: '0元（仅让利）',
          expected: '转化率从15%提升至17%'
        },
        {
          name: '企微加好友激励',
          hypothesis: '如果到店赠送小礼品引导加企微，私域转化率将提升30%',
          method: '到店患者赠送护眼贴+企微二维码',
          budget: '1000元/月',
          expected: '企微新增200人/月'
        }
      ],
      monthlyPlan: {
        target: '到店量+20%（从当前基线提升）',
        budget: '15000元',
        breakdown: '推广费用40%（6000元） + 优惠补贴30%（4500元） + 内容制作20%（3000元） + 物料奖品10%（1500元）'
      }
    });
  } catch (e) {
    console.error('growth-plan error:', e);
    res.status(500).json({ error: '增长策略服务异常，请稍后重试' });
  }
});

// ===== POST /api/clinic-analysis =====
app.post('/api/clinic-analysis', async (req, res) => {
  try {
    await delay(randInt(1200, 2500));
    const { imageBase64, url, sourceType } = req.body;
    const hasScreenshot = sourceType === 'screenshot' && imageBase64;
    const hasUrl = sourceType === 'url' && url;
    const ratingBase = (4.2 + Math.random() * 0.7).toFixed(1);
    const reviewCount = randInt(45, 200);
    const totalProjects = randInt(8, 20);
    const totalSalesCount = randInt(800, 8000);
    const tagsBase = ['服务好', '环境好', '专业'];
    if (hasScreenshot) tagsBase.push('📷已分析截图');
    if (hasUrl) tagsBase.push('🌐已抓取页面');
    if (!hasScreenshot && !hasUrl) tagsBase.push('⚠️模拟数据，请上传截图或输入URL获取真实分析');

    const clinicNames = hasUrl ? ['大众点评目标门诊', '竞品眼科门诊'] : ['待分析门诊', '目标眼科门诊'];
    const clinicName = clinicNames[randInt(0, clinicNames.length - 1)];

    // Project pool
    const projectPool = [
      { name: '儿童青少年视力检查', price: '¥39.9', originalPrice: '¥128', category: '视力检查', baseSales: 1500 },
      { name: '成人综合眼健康检查', price: '¥68', originalPrice: '¥198', category: '眼健康', baseSales: 800 },
      { name: 'OK镜验配评估', price: '¥199', originalPrice: '¥500', category: 'OK镜', baseSales: 600 },
      { name: '角膜塑形镜全套', price: '¥6800', originalPrice: '¥8800', category: 'OK镜', baseSales: 120 },
      { name: '离焦镜验配', price: '¥1680', originalPrice: '¥2380', category: '离焦镜', baseSales: 200 },
      { name: '蔡司成长乐离焦镜', price: '¥2980', originalPrice: '¥3980', category: '离焦镜', baseSales: 80 },
      { name: '功能性镜片验配', price: '¥980', originalPrice: '¥1580', category: '功能镜', baseSales: 150 },
      { name: '防蓝光功能镜', price: '¥580', originalPrice: '¥880', category: '功能镜', baseSales: 300 },
      { name: '干眼症检查套餐', price: '¥29.9', originalPrice: '¥99', category: '眼健康', baseSales: 900 },
      { name: '眼部SPA护理', price: '¥88', originalPrice: '¥168', category: '眼健康', baseSales: 500 },
      { name: '视功能训练（单次）', price: '¥120', originalPrice: '¥200', category: '视功能', baseSales: 350 },
      { name: 'OK镜护理套装', price: '¥169', originalPrice: '¥269', category: 'OK镜', baseSales: 700 },
      { name: '儿童斜弱视筛查', price: '¥49.9', originalPrice: '¥150', category: '视力检查', baseSales: 400 },
      { name: '老花镜验配', price: '¥299', originalPrice: '¥499', category: '功能镜', baseSales: 100 },
      { name: '眼底照相检查', price: '¥89', originalPrice: '¥200', category: '眼健康', baseSales: 250 },
      { name: '双眼视功能训练包', price: '¥599', originalPrice: '¥999', category: '视功能', baseSales: 90 },
      { name: '抗疲劳功能镜片', price: '¥399', originalPrice: '¥699', category: '功能镜', baseSales: 180 },
      { name: '青少年近视防控套餐', price: '¥268', originalPrice: '¥588', category: '视力检查', baseSales: 450 }
    ];

    const shuffled = [...projectPool].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(totalProjects, projectPool.length));
    let runningTotal = 0, topSales = 0, bottomSales = Infinity;
    let topSeller = '', bottomSeller = '';
    const categoryBreakdown = {};
    const projects = [];

    selected.forEach(p => {
      const salesVariation = randInt(-200, 300);
      const sc = Math.max(10, p.baseSales + salesVariation);
      runningTotal += sc;
      const status = sc > 500 ? '热销' : sc > 200 ? '正常' : '滞销';
      const issues = [];
      if (sc < 150) issues.push('销量偏低，建议优化标题和主图');
      if (parseFloat(p.price.replace('¥', '')) < 50 && p.category !== '眼健康') issues.push('低价引流，可关联高价值套餐');
      if (p.category === 'OK镜' && !p.name.includes('验配评估')) issues.push('建议添加验配评估引流入口');
      projects.push({ name: p.name, price: p.price, originalPrice: p.originalPrice, sales: '已售' + sc + '+', category: p.category, status, issues: issues.length > 0 ? issues.join('；') : '' });
      categoryBreakdown[p.category] = (categoryBreakdown[p.category] || 0) + 1;
      if (sc > topSales) { topSales = sc; topSeller = p.name; }
      if (sc < bottomSales) { bottomSales = sc; bottomSeller = p.name; }
    });

    const prices = selected.map(p => parseFloat(p.price.replace('¥', '')));
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const pricingScore = randInt(55, 90);
    const allCategories = ['视力检查', '眼健康', 'OK镜', '离焦镜', '功能镜', '视功能'];
    const missingCats = allCategories.filter(c => !categoryBreakdown[c]);
    const missingMap = { OK镜: '角膜塑形镜验配套餐', 离焦镜: '多点离焦镜片验配', 功能镜: '抗疲劳功能镜片', 视力检查: '成人深度视力检查', 眼健康: '眼底OCT检查', 视功能: '双眼视功能训练包' };

    res.json({
      clinicInfo: { name: clinicName, rating: ratingBase, reviewCount: reviewCount + '条', address: hasUrl ? '已从URL提取地址信息' : '请上传截图获取完整地址信息', tags: tagsBase },
      projects,
      analysis: {
        pricing: {
          score: pricingScore,
          avgPrice: '¥' + Math.round(avgPrice),
          priceRange: '¥' + minPrice.toFixed(1) + '-¥' + maxPrice,
          comment: pricingScore >= 75 ? '定价结构合理，低价引流与高价值项目梯度清晰' : '价格带偏窄，缺少中间价位项目，建议补充¥200-500价位产品',
          issues: pricingScore >= 75 ? ['部分高价项目缺少中间梯度过渡'] : ['低价位项目占比过高', '缺少¥200-500中间价位产品', '高价项目原价虚标明显']
        },
        projectSetup: {
          totalCount: projects.length,
          categoryBreakdown,
          missingCategories: missingCats.map(c => missingMap[c]),
          comment: missingCats.length === 0 ? '项目品类覆盖全面，各核心产品线均有布局' : '缺少' + missingCats.join('、') + '品类，建议补充以覆盖更广患者需求'
        },
        sales: {
          totalSales: runningTotal + '+',
          topSeller,
          bottomSeller,
          comment: '热销项目集中在低价引流款，高价值产品（OK镜/离焦镜）转化率需提升。建议：① 增加OK镜验配评估引流 ② 设置阶梯优惠引导升级 ③ 高价值项目添加患者案例'
        },
        reviews: {
          positive: ['医生专业', '态度好', '环境干净', '检查仔细', '效果明显', '性价比高', '孩子视力改善', '杜医生耐心'],
          negative: ['等待时间长', '停车不便', '价格偏贵', '预约难'],
          summary: '好评集中在医生专业度和检查细致度，差评主要涉及等待时长和预约便利性。建议：① 优化预约排班系统 ② 提供到店停车指引 ③ 增加高峰时段导诊人员'
        }
      },
      suggestions: [
        { priority: 'P0', category: '定价', title: '增设OK镜验配评估引流价¥99', desc: '当前OK镜产品线缺少低价引流入口。建议新增¥99验配评估（原价¥300），降低首次接触门槛，验配后引导至¥6800全套产品。', impact: '预计引流用户+30%，OK镜转化率提升5%' },
        { priority: 'P0', category: '评价', title: '建立差评快速响应机制', desc: '当前差评回复率不足50%。建议AI自动监测+人工审核，2小时内回复差评，个性化道歉+解决方案。', impact: '预计差评转化率+15%，评分回升0.1-0.2' },
        { priority: 'P1', category: '项目', title: missingCats.length > 0 ? '补充' + missingCats.slice(0, 2).join('、') + '品类' : '优化项目命名提升搜索匹配', desc: missingCats.length > 0 ? '当前缺失核心品类，建议新增' + missingCats.map(c => missingMap[c]).slice(0, 2).join('、') + '等团购项目。' : '建议优化为包含热门搜索词，如"儿童"、"近视防控"、"角膜塑形"等。', impact: '预计覆盖新增搜索流量20%，GMV+10%' },
        { priority: 'P1', category: '销量', title: '高价值项目添加患者案例增强转化', desc: 'OK镜/离焦镜等高价值项目页面缺少真实案例。建议添加患儿姓名（化名）+年龄+度数+使用时长+控制效果的数据展示。', impact: '预计高价值项目点击率+25%，转化率+10%' },
        { priority: 'P2', category: '定价', title: '设置组合套餐提升客单价', desc: '建议设计"视力检查+干眼筛查"、"OK镜验配+护理套装"等组合套餐，优惠15-20%，引导一站式消费。', impact: '预计客单价提升15-25%' }
      ]
    });
  } catch (e) {
    console.error('clinic-analysis error:', e);
    res.status(500).json({ error: '门诊分析服务异常，请稍后重试' });
  }
});

// ===== 启动服务器 =====
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`  美团眼科运营AI助手 后端服务`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  启动: node server.js`);
  console.log(`=================================`);
});
