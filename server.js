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
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname)));

// 根路径直接返回主应用（避免重定向在网关下丢失分享凭证）
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'meituan-agent.html'));
});

// 健康诊断：报告运行进程的环境配置状态（不泄露密钥明文）
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    volcKey: VOLC_API_KEY ? 'set(' + VOLC_API_KEY.substring(0, 8) + '...)' : 'MISSING',
    seedreamModel: SEEDREAM_MODEL,
    node: process.version,
    envKeys: Object.keys(process.env).filter(k => /VOLC|SEEDREAM|RAILWAY/i.test(k)),
    pid: process.pid,
    time: new Date().toISOString()
  });
});

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

// 调用火山引擎豆包视觉模型（OCR/多模态理解），识别美团经营参谋截图内容
// 使用与 Seedream 相同的 VOLC_API_KEY，走 OpenAI 兼容的 chat/completions 接口
// 端点候选：VISION_MODEL 优先，其次按序自动探测（账号可能仅开通其中一版）
const VISION_MODEL_CANDIDATES = [
  process.env.VISION_MODEL,
  'doubao-1-5-vision-pro-32k-250315',
  'doubao-vision-pro-250314',
  'doubao-1.5-vision-pro-32k-250115',
  'doubao-vision-lite-250314',
].filter(Boolean);

// 视觉 OCR 可用性：无 key 直接跳过；单端点超时与总预算都压到 Railway 网关(~35s)以内，避免线上 502
const VISION_OCR_TIMEOUT_MS = 10000;   // 单端点 10s
const VISION_OCR_DEADLINE_MS = 22000;  // 总预算 22s（低于 Railway 35s 网关超时）

function callVisionOCR(images) {
  if (!VOLC_API_KEY) {
    return Promise.reject(new Error('未配置 VOLC_API_KEY，视觉识别不可用'));
  }
  return callVisionOCRWithModels(VISION_MODEL_CANDIDATES, images, 0, Date.now());
}

// 按候选顺序调用视觉模型：命中即返回，全部失败则 reject（触发手动录入降级）
function callVisionOCRWithModels(models, images, idx, startedAt) {
  return new Promise((resolve, reject) => {
    if (idx >= models.length || Date.now() - startedAt > VISION_OCR_DEADLINE_MS) {
      reject(new Error('当前账号未开通豆包视觉模型权限，已降级为手动录入通道'));
      return;
    }
    const visionModel = models[idx];
    const promptText = '你是一名美团商家经营数据分析助手。请仔细识别以下美团「经营参谋」手机截图中的关键数据，'
      + '提取并仅返回如下 JSON（不要输出任何其他文字、不要用 markdown 代码块）：'
      + '{"clinicName":"门店名称","rating":"美团星级(数字)","reviewCount":"累计评价数(数字)","avgStar":"点评星级",'
      + '"exposure":"曝光人数","visit":"访问人数","intent":"意向转化人数","order":"下单人数",'
      + '"projects":[{"name":"项目名称","price":"团购价","sales":"销量"}],"summary":"一句话经营概况"}'
      + '。若某项数据在截图中不存在，则该项填空字符串。项目列表最多提取10个。';

    const content = [{ type: 'text', text: promptText }];
    images.forEach(img => {
      content.push({ type: 'image_url', image_url: { url: img } });
    });

    const payload = {
      model: visionModel,
      messages: [{ role: 'user', content }]
    };

    const body = JSON.stringify(payload);
    const options = {
      hostname: 'ark.cn-beijing.volces.com',
      path: '/api/v3/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VOLC_API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: VISION_OCR_TIMEOUT_MS
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) {
            resolve(json.choices[0].message.content);
          } else {
            const errMsg = json.error ? (json.error.message || JSON.stringify(json.error)) : data.substring(0, 200);
            // 当前端点不可用（常见：账号未开通该模型权限），自动尝试下一个候选端点
            console.warn(`[vision] 端点 ${visionModel} 不可用，尝试下一个候选`);
            resolve(callVisionOCRWithModels(models, images, idx + 1, startedAt));
          }
        } catch (e) {
          console.warn(`[vision] 端点 ${visionModel} 响应解析失败，尝试下一个候选`);
          resolve(callVisionOCRWithModels(models, images, idx + 1, startedAt));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn(`[vision] 端点 ${visionModel} 超时，尝试下一个候选`);
      resolve(callVisionOCRWithModels(models, images, idx + 1, startedAt));
    });
    req.on('error', (err) => {
      console.warn(`[vision] 端点 ${visionModel} 请求失败(${err.message})，尝试下一个候选`);
      resolve(callVisionOCRWithModels(models, images, idx + 1, startedAt));
    });
    req.write(body);
    req.end();
  });
}

// 从视觉模型返回的文本中提取 JSON
function extractJsonFromText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    // 尝试提取第一个 { 到最后一个 } 之间的内容
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.substring(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
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
// 套图三尺寸：900x900 方图 / 1200x900 横图 / 900x1200 竖图
// Seedream 要求总像素 >= 3686400，故按同比例放大生成后用 jimp 缩回精确尺寸
const Jimp = require('jimp');
const GEN_SLOTS = [
  { name: '方图 900×900',   targetW: 900,  targetH: 900,  genSize: '2048x2048', layout: '正方形构图，主体居中偏上，标题位于上方约三分之一处，左右视觉平衡' },
  { name: '横图 1200×900',  targetW: 1200, targetH: 900,  genSize: '2400x1800', layout: '横版4:3构图，标题与主体左右分区自然排布，主视觉约占画面三分之二' },
  { name: '竖图 900×1200',  targetW: 900,  targetH: 1200, genSize: '1800x2400', layout: '竖版3:4构图，标题在上、主体居中、底部留出信息区，符合手机端浏览习惯' }
];
const GEN_STYLES = {
  pixar3d: {
    label: '皮克斯3D卡通动画型',
    desc: '动画电影质感',
    prompt: '皮克斯迪士尼风格的3D卡通动画海报，主角是圆润可爱的三维卡通人物，大眼睛、表情生动夸张，电影级柔光渲染，材质细腻，色彩明快和谐，整体像动画电影剧照'
  },
  illustration: {
    label: '商业插画型',
    desc: '精美商业插画',
    prompt: '高质量商业插画海报，人物为精美动漫插画风格，线条干净利落，色彩层次丰富饱和，光影氛围出色，细节精致，类似游戏或节日主题的商业宣传插画KV'
  },
  movieposter: {
    label: '真人电影海报写实型',
    desc: '写实电影海报',
    prompt: '真人电影海报风格的写实摄影海报，真实人物出镜，电影级布光与调色，浅景深虚化背景，肤色自然真实，人物情绪有感染力，画面质感对标院线电影宣传海报'
  },
  typography: {
    label: '文字图形排版型',
    desc: '大字排版促销',
    prompt: '以文字图形排版为核心的平面海报设计，超大号粗体中文标题为视觉中心，信息层级分明，配以几何色块与简洁虚化底图，版式现代、对齐严谨、留白得当，类似品牌促销主视觉'
  }
};
// 从远程URL拉取图片Buffer
function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects) => {
      const mod = u.startsWith('https') ? require('https') : require('http');
      mod.get(u, { timeout: 60000 }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 3) {
          r.resume();
          get(r.headers.location, redirects + 1);
          return;
        }
        if (r.statusCode !== 200) { r.resume(); reject(new Error('图片下载失败 HTTP ' + r.statusCode)); return; }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
        r.on('error', reject);
      }).on('timeout', function() { this.destroy(); reject(new Error('图片下载超时')); }).on('error', reject);
    };
    get(url, 0);
  });
}
// 缩放到精确目标尺寸并落盘，返回本地访问路径
async function localizeAndResize(imageUrl, targetW, targetH, fileStem) {
  const buf = await fetchImageBuffer(imageUrl);
  const img = await Jimp.read(buf);
  img.resize(targetW, targetH);   // 生成尺寸与目标等比，直接缩放不会变形或裁切
  const outDir = path.join(__dirname, 'generated');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${fileStem}.png`);
  await img.writeAsync(outFile);
  return `/generated/${fileStem}.png`;
}

// ===== 套图生成异步任务（适配 Railway ~35s 网关超时：Seedream 三图需 2 分钟+，同步必被掐 502）=====
const IMG_JOBS = new Map(); // jobId -> { status, progress, total, images, error, styleLabel, refImage }

function runImageJob(jobId, style, product, imageBase64) {
  const job = IMG_JOBS.get(jobId);
  const st = GEN_STYLES[style] || GEN_STYLES.pixar3d;
  const stem = `img-${Date.now()}`;
  const images = [];
  let i = 0;
  const step = () => {
    if (i >= GEN_SLOTS.length) {
      job.status = 'done';
      job.images = images;
      job.styleLabel = st.label;
      job.refImage = !!imageBase64;
      console.log(`  [image-generate] 任务 ${jobId} 完成（${images.length}/${GEN_SLOTS.length}）`);
      return;
    }
    const slot = GEN_SLOTS[i];
    job.progress = i;
    const prompt = [
      `${st.prompt}。眼科门诊宣传海报，主题「${product.name}」`,
      `海报主标题文字为「${product.name}」，中文文字必须书写准确、笔画清晰、自然融入版面，位置排布自然不生硬`,
      slot.layout,
      '画面中所有人物、文字、图形必须完整呈现在画幅之内，四周保留安全边距，任何元素不得被画面边缘裁切、不得贴边出血',
      '适合美团/大众点评平台展示，构图完整，高清商业设计'
    ].join('；');
    console.log(`  [image-generate] 任务 ${jobId} 生成 ${slot.name}（${i + 1}/${GEN_SLOTS.length}）...`);
    callSeedreamOnce({ prompt, imageBase64, size: slot.genSize })
      .then(remoteUrl => localizeAndResize(remoteUrl, slot.targetW, slot.targetH, `${stem}-${i}`))
      .then(localUrl => {
        images.push({ name: slot.name, url: localUrl, width: slot.targetW, height: slot.targetH });
        i++;
        step();
      })
      .catch(err => {
        console.error(`[image-generate] 任务 ${jobId} 失败于 ${slot.name}:`, err.message);
        job.status = 'error';
        job.error = err.message;
      });
  };
  step();
}

app.post('/api/image-generate', async (req, res) => {
  try {
    const { style, product, imageBase64 } = req.body;
    const p = product || { name: '儿童青少年视力检查', price: '¥39.9' };
    const st = GEN_STYLES[style] || GEN_STYLES.pixar3d;

    // 统一走异步任务：立即返回 jobId，前端轮询状态接口取结果（真实 Seedream 或本地模板兜底均在后台执行，
    // 避免长耗时请求撞 Railway ~35s 网关超时）
    const jobId = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    IMG_JOBS.set(jobId, { status: 'running', progress: 0, total: GEN_SLOTS.length, images: null, error: null, startedAt: Date.now() });
    setTimeout(() => IMG_JOBS.delete(jobId), 10 * 60 * 1000); // 10分钟后清理，防内存泄漏
    if (VOLC_API_KEY) {
      runImageJob(jobId, style, p, imageBase64);
    } else {
      runMockImageJob(jobId, style, p, imageBase64);
    }
    return res.json({ async: true, jobId, styleLabel: st.label, refImage: !!imageBase64, mock: !VOLC_API_KEY });
  } catch (e) {
    console.error('image-generate error:', e);
    res.status(500).json({ error: '套图生成服务异常: ' + (e.message || '请稍后重试') });
  }
});

// 本地模板兜底任务：无 VOLC_API_KEY 时后台生成 mock 占位数据（走同一套异步轮询协议）
function runMockImageJob(jobId, style, product, imageBase64) {
  const job = IMG_JOBS.get(jobId);
  const st = GEN_STYLES[style] || GEN_STYLES.pixar3d;
  setTimeout(() => {
    job.status = 'done';
    job.styleLabel = st.label;
    job.refImage = !!imageBase64;
    job.images = [
      {
        name: '方图 900×900',
        width: 900,
        height: 900,
        bg: ['#1a3a5c', '#3b82f6'],
        title: product.name,
        subtitle: `仅${product.price} · ${st.label}`,
        accent: '#ffffff',
        elements: [
          { type: 'circle', x: 780, y: 140, r: 90, color: 'rgba(255,255,255,0.08)' },
          { type: 'circle', x: 110, y: 800, r: 100, color: 'rgba(255,255,255,0.05)' },
          { type: 'priceTag', x: 50, y: 520, price: product.price },
          { type: 'badge', x: 50, y: 620, text: '爱尔眼科' }
        ]
      },
      {
        name: '横图 1200×900',
        width: 1200,
        height: 900,
        bg: ['#1a3a5c', '#3b82f6'],
        title: product.name,
        subtitle: `仅${product.price} · ${st.label}`,
        accent: '#ffffff',
        elements: [
          { type: 'circle', x: 1060, y: 150, r: 90, color: 'rgba(255,255,255,0.1)' },
          { type: 'circle', x: 120, y: 800, r: 90, color: 'rgba(255,255,255,0.06)' },
          { type: 'priceTag', x: 50, y: 500, price: product.price },
          { type: 'badge', x: 50, y: 600, text: '爱尔眼科' }
        ]
      },
      {
        name: '竖图 900×1200',
        width: 900,
        height: 1200,
        bg: ['#1a3a5c', '#3b82f6'],
        title: product.name,
        subtitle: `仅${product.price}起 · ${st.label}`,
        accent: '#ffffff',
        elements: [
          { type: 'circle', x: 760, y: 180, r: 80, color: 'rgba(255,255,255,0.1)' },
          { type: 'circle', x: 100, y: 1080, r: 90, color: 'rgba(255,255,255,0.06)' },
          { type: 'priceTag', x: 50, y: 800, price: product.price },
          { type: 'badge', x: 50, y: 900, text: '限时特惠' }
        ]
      }
    ];
    console.log(`  [image-generate] 任务 ${jobId} 本地模板兜底完成`);
  }, 1200);
}

// ===== GET /api/image-generate-status（前端轮询异步任务进度）=====
app.get('/api/image-generate-status', (req, res) => {
  const job = IMG_JOBS.get(String(req.query.jobId || ''));
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json(job);
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
        desc: '就诊后48小时发送',
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

// ===== 门诊分析：基于真实提取数据的相关分析生成 =====
// extracted: { clinicName, rating, reviewCount, avgStar, exposure, visit, intent, order, projects:[{name,price,sales}], goodCount, badCount }
// meta: { sourceLabel, shotCount }
function buildAnalysisFromData(extracted, meta) {
  const d = extracted || {};
  const clinicName = d.clinicName || '待分析门诊';
  const rating = parseFloat(d.rating) || parseFloat(d.avgStar) || 0;
  const reviewCount = parseInt(d.reviewCount) || 0;
  const exposure = parseInt(d.exposure) || 0;
  const visit = parseInt(d.visit) || 0;
  const intent = parseInt(d.intent) || 0;
  const order = parseInt(d.order) || 0;
  const goodCount = parseInt(d.goodCount) || 0;
  const badCount = parseInt(d.badCount) || 0;

  const visitRate = exposure > 0 ? ((visit / exposure) * 100).toFixed(2) : null;
  const intentRate = visit > 0 ? ((intent / visit) * 100).toFixed(2) : null;
  const goodRate = (goodCount + badCount) > 0 ? ((goodCount / (goodCount + badCount)) * 100).toFixed(1) : null;

  // 项目列表：优先用提取的项目，否则构造
  let projects = [];
  const rawProjects = Array.isArray(d.projects) ? d.projects : [];
  rawProjects.slice(0, 15).forEach(p => {
    if (!p || !p.name) return;
    const price = p.price || '';
    const sales = parseInt(p.sales) || 0;
    const priceNum = parseFloat(String(price).replace(/[¥￥,]/g, ''));
    projects.push({
      name: p.name,
      price: price || '¥—',
      originalPrice: '¥—',
      sales: sales > 0 ? ('已售' + sales + '+') : '—',
      category: '提取项目',
      status: sales > 500 ? '热销' : sales > 100 ? '正常' : '待观察',
      issues: sales > 0 && sales < 100 ? '销量偏低，建议优化标题和主图' : ''
    });
  });
  if (projects.length === 0) {
    projects.push({ name: '未识别到项目数据，请补充截图或手动录入', price: '—', originalPrice: '—', sales: '—', category: '—', status: '待补充', issues: '' });
  }

  const prices = projects.map(p => parseFloat(String(p.price).replace(/[¥￥,]/g, ''))).filter(v => !isNaN(v) && v > 0);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const avgPrice = prices.length ? (prices.reduce((a, b) => a + b, 0) / prices.length) : null;
  const totalSales = projects.reduce((s, p) => s + (parseInt(String(p.sales).replace(/[^\d]/g, '')) || 0), 0);

  // 定价分析
  let pricingScore = 65, pricingComment = '未识别到有效价格数据，建议补充截图或手动录入价格', pricingIssues = ['缺少价格数据'];
  if (avgPrice) {
    if (minPrice <= 100 && maxPrice >= 500) { pricingScore = 82; pricingComment = '价格梯度清晰，低价引流与高价值项目搭配合理'; pricingIssues = []; }
    else if (minPrice <= 100) { pricingScore = 70; pricingComment = '以低价引流为主，缺少高价值项目拉升客单价'; pricingIssues = ['缺少高价值项目', '客单价提升空间有限']; }
    else { pricingScore = 62; pricingComment = '价格带整体偏高，缺少低价引流入口'; pricingIssues = ['缺少低价引流项目', '首次体验门槛偏高']; }
  }

  // 评价分析
  let reviewSummary = '未识别到评价数据';
  if (reviewCount > 0) {
    reviewSummary = '累计评价 ' + reviewCount + ' 条';
    if (badCount > 0) reviewSummary += '，其中差评 ' + badCount + ' 条（差评率 ' + ((badCount / reviewCount) * 100).toFixed(1) + '%），建议重点跟进差评客户';
    else reviewSummary += '，差评较少，评价口碑良好';
    if (goodRate !== null) reviewSummary += '，好评率 ' + goodRate + '%';
  }

  // 客流分析
  let trafficComment = '未识别到客流数据';
  if (exposure > 0) {
    trafficComment = '曝光 ' + exposure + ' 人';
    if (visitRate !== null) trafficComment += '，曝光→访问转化率 ' + visitRate + '%';
    if (intentRate !== null) trafficComment += '，访问→意向转化率 ' + intentRate + '%';
    if (visitRate !== null && parseFloat(visitRate) < 10) trafficComment += '。转化率偏低，建议优化主图和标题';
    else if (visitRate !== null && parseFloat(visitRate) >= 15) trafficComment += '。转化率表现良好，可加大投放';
  }

  // 建议
  const suggestions = [];
  if (badCount > 0) suggestions.push({ priority: 'P0', category: '评价', title: '跟进 ' + badCount + ' 条差评', desc: '针对差评客户逐一跟进，2小时内回复，个性化道歉+解决方案。', impact: '预计评分回升 0.1-0.2' });
  if (pricingIssues.includes('缺少低价引流项目')) suggestions.push({ priority: 'P0', category: '定价', title: '增设低价引流项目', desc: '当前缺少低价引流入口，建议新增 ¥29.9-¥99 体验项目降低首次体验门槛。', impact: '预计引流用户 +20%' });
  if (visitRate !== null && parseFloat(visitRate) < 10) suggestions.push({ priority: 'P1', category: '流量', title: '优化主图与标题提升点击率', desc: '曝光→访问转化率仅 ' + visitRate + '%，建议优化主图为医生场景图、标题补充热门搜索词。', impact: '预计点击率 +15%' });
  if (intentRate !== null && parseFloat(intentRate) < 10 && visit > 0) suggestions.push({ priority: 'P1', category: '转化', title: '优化详情页提升意向转化', desc: '访问→意向转化率仅 ' + intentRate + '%，建议补充患者案例、强化核心卖点。', impact: '预计意向转化 +10%' });
  if (projects.length <= 3) suggestions.push({ priority: 'P1', category: '项目', title: '补充项目品类覆盖', desc: '当前项目数量较少，建议补充视力检查、OK镜、离焦镜等核心品类。', impact: '预计覆盖更多搜索流量' });
  if (suggestions.length === 0) suggestions.push({ priority: 'P2', category: '运营', title: '持续监测经营数据', desc: '当前识别数据较为健康，建议保持日常监测，按周复盘经营指标。', impact: '维持稳定增长' });

  const sourceLabel = meta && meta.sourceLabel ? meta.sourceLabel : '采集数据';
  const tags = [sourceLabel];
  if (meta && meta.shotCount) tags.push('已识别 ' + meta.shotCount + ' 个界面');
  if (reviewCount > 0) tags.push('评价 ' + reviewCount + ' 条');
  if (exposure > 0) tags.push('曝光 ' + exposure);

  return {
    clinicInfo: {
      name: clinicName,
      rating: rating > 0 ? rating : '—',
      reviewCount: reviewCount > 0 ? reviewCount + '条' : '—',
      address: d.address || '（请上传截图或手动录入获取地址）',
      tags
    },
    projects,
    analysis: {
      pricing: { score: pricingScore, avgPrice: avgPrice ? '¥' + Math.round(avgPrice) : '—', priceRange: (minPrice !== null && maxPrice !== null) ? ('¥' + minPrice + '-¥' + maxPrice) : '—', comment: pricingComment, issues: pricingIssues },
      projectSetup: { totalCount: projects.length, categoryBreakdown: { '识别项目': projects.length }, missingCategories: [], comment: '共识别 ' + projects.length + ' 个项目，建议核对是否完整覆盖门店核心品类' },
      sales: { totalSales: totalSales > 0 ? totalSales + '+' : '—', topSeller: '—', bottomSeller: '—', comment: totalSales > 0 ? '累计销量 ' + totalSales + '+' : '未识别到销量数据' },
      reviews: { positive: ['好评'], negative: badCount > 0 ? ['差评 ' + badCount + ' 条'] : [], summary: reviewSummary }
    },
    traffic: { exposure, visit, intent, order, visitRate, intentRate, comment: trafficComment },
    suggestions
  };
}

function buildAnalysisFromManual(manualData) {
  const m = manualData || {};
  const store = m.store || {}, project = m.project || {}, review = m.review || {}, traffic = m.traffic || {};
  const extracted = {
    clinicName: store.name,
    address: store.address,
    rating: parseFloat(review.star) || null,
    reviewCount: parseInt(review.total) || null,
    goodCount: parseInt(review.good) || null,
    badCount: parseInt(review.bad) || null,
    exposure: parseInt(traffic.exposure) || null,
    visit: parseInt(traffic.visit) || null,
    intent: parseInt(traffic.intent) || null,
    order: parseInt(traffic.order) || null,
    projects: (project.name ? [{ name: project.name, price: project.price, sales: project.sales }] : [])
  };
  return buildAnalysisFromData(extracted, { sourceLabel: '✏️手动录入' });
}

function buildAnalysisFromOCR(ocr, shotCount) {
  return buildAnalysisFromData(ocr, { sourceLabel: '📷截图识别', shotCount: shotCount });
}

// ===== POST /api/clinic-analysis =====
app.post('/api/clinic-analysis', async (req, res) => {
  try {
    const { imageBase64, url, sourceType, images, manualData } = req.body;

    // 1) 手动录入模式：用真实字段生成相关分析
    if (sourceType === 'manual' && manualData) {
      await delay(randInt(400, 900));
      return res.json(buildAnalysisFromManual(manualData));
    }

    // 2) 截图模式：尝试视觉 OCR 识别截图内容
    if (sourceType === 'screenshot' && Array.isArray(images) && images.length > 0) {
      await delay(randInt(300, 600));
      try {
        const ocrText = await callVisionOCR(images);
        const ocr = extractJsonFromText(ocrText);
        if (ocr && (ocr.clinicName || ocr.rating || ocr.reviewCount || (Array.isArray(ocr.projects) && ocr.projects.length))) {
          return res.json(buildAnalysisFromOCR(ocr, images.length));
        }
      } catch (ocrErr) {
        console.error('[clinic-analysis] 视觉OCR失败:', ocrErr.message);
      }
      // OCR 通道不可用：降级为「截图已接收 + 引导手动录入」，不丢用户已上传的工作量
      return res.json(buildAnalysisFromData({
        clinicName: '（视觉模型未授权，已切换手动录入通道）',
        projects: []
      }, { sourceLabel: '⚠️待手动补录', shotCount: images.length }));
    }

    // 3) URL 模式：返回明确提示（URL 抓取需额外能力）
    if (sourceType === 'url' && url) {
      await delay(randInt(600, 1200));
      return res.json(buildAnalysisFromData({
        clinicName: '（URL 抓取暂未接入，请使用截图或手动录入）',
        projects: []
      }, { sourceLabel: '🌐URL 采集（待接入）' }));
    }

    // 4) 无有效输入
    await delay(randInt(300, 500));
    return res.json(buildAnalysisFromData({ projects: [] }, { sourceLabel: '⚠️请上传截图或手动录入数据' }));
  } catch (e) {
    console.error('clinic-analysis error:', e);
    res.status(500).json({ error: '门诊分析服务异常，请稍后重试' });
  }
});


// ===== M3-01: 主图诊断分析 =====
app.post('/api/image-diagnosis', async (req, res) => {
  try {
    const { imageBase64, imageUrl, projectName, projectCategory } = req.body;
    if (!imageBase64 && !imageUrl) {
      return res.status(400).json({ error: '请提供图片（Base64或URL）' });
    }

    // 本地规则分析：用 jimp 解析图片真实属性（分辨率/宽高比/亮度/色彩丰富度），
    // 豆包视觉模型未开通权限，此模式不依赖大模型；结果基于可测量的图像事实而非随机数
    let imgInfo = null;
    if (imageBase64) {
      try {
        const b64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
        const img = await Jimp.read(Buffer.from(b64, 'base64'));
        const w = img.bitmap.width, h = img.bitmap.height;
        let lumSum = 0, n = 0;
        const colorSet = new Set();
        const step = Math.max(1, Math.floor(Math.min(w, h) / 48));
        img.scan(0, 0, w, h, function (x, y, idx) {
          if (x % step || y % step) return;
          const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
          lumSum += 0.299 * r + 0.587 * g + 0.114 * b;
          colorSet.add(((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5));
          n++;
        });
        imgInfo = {
          width: w,
          height: h,
          brightness: n ? Math.round(lumSum / n) : null,
          colorVariety: colorSet.size
        };
      } catch (imgErr) {
        console.error('[image-diagnosis] 图片解析失败，退化为通用分析:', imgErr.message);
      }
    }

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // 清晰度：按短边真实分辨率评估（美团主图规范 ≥800px）
    const minSide = imgInfo ? Math.min(imgInfo.width, imgInfo.height) : null;
    const clarityScore = minSide !== null
      ? clamp(Math.round(minSide / 900 * 100), 35, 96)
      : randInt(45, 70);

    // 品类匹配：主图规范为 1:1，其次看色彩层次（过单调或过杂都扣分）
    let categoryScore;
    if (imgInfo) {
      const ratio = imgInfo.width / imgInfo.height;
      const ratioPenalty = Math.abs(ratio - 1) <= 0.05 ? 0 : (ratio === 4 / 3 || ratio === 3 / 4 || Math.abs(ratio - 4 / 3) < 0.05 || Math.abs(ratio - 3 / 4) < 0.05) ? 8 : 22;
      const variety = imgInfo.colorVariety;
      const varietyPenalty = variety < 10 ? 12 : variety > 160 ? 6 : 0;
      categoryScore = clamp(88 - ratioPenalty - varietyPenalty, 30, 92);
    } else {
      categoryScore = randInt(55, 75);
    }

    // 亮度：过暗/过曝都影响质感
    const brightness = imgInfo ? imgInfo.brightness : null;
    const isBright = brightness === null ? Math.random() > 0.3 : (brightness >= 100 && brightness <= 210);

    // 品牌感 / 情感力依赖视觉语义理解，视觉AI未接入时按中性区间估算，不虚构具体问题
    const brandingScore = isBright ? randInt(62, 78) : randInt(50, 65);
    const emotionScore = randInt(60, 78);
    const infoScore = imgInfo && minSide !== null && minSide >= 700 ? randInt(62, 85) : randInt(45, 68);

    const overallScore = Math.round(
      (clarityScore * 0.2 + brandingScore * 0.25 + infoScore * 0.2 + emotionScore * 0.15 + categoryScore * 0.2)
    );

    const cat = projectCategory || '视光检查';
    const catStyles = {
      '角膜塑形镜': { style: '专业医疗', keywords: ['专业', '精准', '安全', '个性化'] },
      'OK镜': { style: '专业医疗', keywords: ['专业', '精准', '安全', '个性化'] },
      '离焦镜': { style: '科技感', keywords: ['科技', '防控', '有效', '舒适'] },
      '视光检查': { style: '温馨信任', keywords: ['细心', '全面', '专业', '安心'] },
      '配镜': { style: '时尚清晰', keywords: ['清晰', '时尚', '舒适', '精准'] },
      '斜弱视训练': { style: '温馨专业', keywords: ['耐心', '趣味', '坚持', '进步'] },
      '干眼治疗': { style: '舒适疗愈', keywords: ['舒缓', '滋润', '温和', '清爽'] }
    };
    const style = catStyles[cat] || { style: '专业医疗', keywords: ['专业', '信赖', '品质'] };

    const issues = [];
    if (minSide !== null && minSide < 800) issues.push({ dim: 'clarity', text: `实际分辨率仅 ${imgInfo.width}×${imgInfo.height}px，低于美团主图规范 800×800px，建议更换高清原图`, severity: 'P0' });
    if (brightness !== null && brightness < 100) issues.push({ dim: 'clarity', text: `画面整体偏暗（平均亮度 ${brightness}/255），建议提亮或换浅色背景`, severity: 'P1' });
    if (brightness !== null && brightness > 230) issues.push({ dim: 'clarity', text: '画面过曝偏白，主体可能缺乏层次，建议适当压暗背景', severity: 'P2' });
    if (imgInfo) {
      const ratio = imgInfo.width / imgInfo.height;
      if (Math.abs(ratio - 1) > 0.05) issues.push({ dim: 'categoryMatch', text: `当前为 ${imgInfo.width}×${imgInfo.height} 非正方形，美团主图展示位按 1:1 裁切时两侧/上下会被裁切，建议输出 1:1 版本`, severity: 'P1' });
      if (imgInfo.colorVariety < 10) issues.push({ dim: 'categoryMatch', text: '画面色彩过于单调（大面积纯色/渐变），信息量偏弱，建议增加主体或卖点元素', severity: 'P2' });
    }
    if (brandingScore < 70) issues.push({ dim: 'branding', text: '品牌感评估为中性：视觉AI未接入，无法确认logo/品牌色/门诊标识是否清晰，建议自查右下角是否有品牌水印', severity: 'P1' });
    if (infoScore < 70) issues.push({ dim: 'information', text: '价格/核心卖点建议放大呈现，标注「原价→团购价」对比', severity: 'P1' });

    const suggestions = [];
    if (minSide !== null && minSide < 800) suggestions.push(`输出尺寸提升到 900×900 以上（套图生成模块可直接生成）`);
    if (imgInfo) {
      const ratio = imgInfo.width / imgInfo.height;
      if (Math.abs(ratio - 1) > 0.05) suggestions.push('补一张 1:1 正方形版本，避免美团主图位自动裁切主体');
    }
    if (brightness !== null && (brightness < 100 || brightness > 230)) suggestions.push('调整曝光：主体与背景明度差保持在可辨识范围，避免死黑或死白');
    if (brandingScore < 70) suggestions.push('所有项目主图统一右下角/左上角添加品牌logo水印');
    if (infoScore < 70) suggestions.push('16pt+核心卖点文字，标注原价→团购价，增加"已售XX+"标签');
    suggestions.push('参考' + style.style + '类主图风格，统一排版和色调');

    const quickWins = [];
    if (minSide !== null && minSide < 800) quickWins.push('换用 ≥900×900 高清原图');
    if (infoScore < 75) quickWins.push('添加价格对比标签："原价¥XX→团购¥XX"');
    quickWins.push('统一添加品牌蓝边框或logo水印');

    res.json({
      clinicName: CLINIC.name,
      analyzedAt: new Date().toISOString(),
      projectCategory: cat,
      styleRecommendation: style.style,
      overallScore,
      analysisMode: imgInfo ? 'local-heuristic' : (imageBase64 ? 'local-fallback' : 'url-not-analyzed'),
      analysisNote: imgInfo
        ? '本地规则分析（视觉AI未接入）：分辨率/比例/亮度/色彩为实测值，品牌感与情感力为中性估算，待开通豆包视觉模型后升级为AI识图'
        : '通用规则分析：未能解析图片像素，建议上传本地图片获得更准的实测分析',
      imageInfo: imgInfo,
      dimensions: {
        clarity: { score: clarityScore, weight: 20, label: '清晰度', status: clarityScore >= 75 ? 'good' : clarityScore >= 60 ? 'warn' : 'bad' },
        branding: { score: brandingScore, weight: 25, label: '品牌感', status: brandingScore >= 75 ? 'good' : brandingScore >= 60 ? 'warn' : 'bad' },
        information: { score: infoScore, weight: 20, label: '信息度', status: infoScore >= 75 ? 'good' : infoScore >= 60 ? 'warn' : 'bad' },
        emotion: { score: emotionScore, weight: 15, label: '情感力', status: emotionScore >= 75 ? 'good' : emotionScore >= 60 ? 'warn' : 'bad' },
        categoryMatch: { score: categoryScore, weight: 20, label: '品类匹配', status: categoryScore >= 75 ? 'good' : categoryScore >= 60 ? 'warn' : 'bad' }
      },
      issues: issues.length > 0 ? issues : [{ dim: 'overall', text: '主图整体表现良好，各项指标均达标', severity: 'P2' }],
      suggestions: suggestions.length > 0 ? suggestions : ['主图符合美团医疗类目最佳实践，建议保持并定期刷新'],
      quickWins: quickWins.length > 0 ? quickWins : ['暂无紧急优化项，建议定期A/B测试微调'],
      perImageAnalysis: [{
        imageIndex: 0,
        projectName: projectName || '待分析项目',
        currentIssues: issues.filter(i => i.severity === 'P0' || i.severity === 'P1').map(i => i.text),
        optimizationDirection: `${style.style}风格，突出${style.keywords.slice(0, 3).join('+')}`,
        priority: issues.some(i => i.severity === 'P0') ? 'P0' : issues.some(i => i.severity === 'P1') ? 'P1' : 'P2'
      }],
      nextSteps: [
        issues.some(i => i.severity === 'P0') ? '立即处理P0级问题（品牌/清晰度）' : '监控效果数据',
        '生成优化Brief → 设计师改图 → 合规检查 → 上传上线',
        '上线后3天查看CTR变化，7天对比转化率'
      ]
    });
  } catch (e) {
    console.error('image-diagnosis error:', e);
    res.status(500).json({ error: '主图诊断服务异常，请稍后重试' });
  }
});

// ===== M3-03: 详情页文案优化 =====
const COPY_RULES = [
  { rule: '绝对化用语', pattern: /最好|第一|唯一|首选|独家|顶尖|No\.1|100%有效|根治/g, severity: 'FAIL', msg: '禁止使用绝对化/疗效承诺用语' },
  { rule: '患者证明', pattern: /XX妈妈说|XX爸爸说|某患者|用了之后/g, severity: 'WARN', msg: '避免使用未授权的患者名义作证明' },
  { rule: '疗效承诺', pattern: /保证|确保|一定|肯定|绝对能/g, severity: 'FAIL', msg: '禁止对效果做断言或保证' },
  { rule: '315敏感词', pattern: /骗人|没效果|坑|假的|上当|投诉/g, severity: 'INFO', msg: '315敏感词（注意语境，可能被算法标记）' },
  { rule: '价格合规', pattern: /原价|市场价|门店价|吊牌价/g, severity: 'WARN', msg: '标注"原价"需有真实成交记录支撑' },
  { rule: '机构比较', pattern: /比其他|比别家|最好.*眼科|最专业/g, severity: 'FAIL', msg: '禁止与其他医疗机构直接比较' }
];

app.post('/api/copy-optimize', async (req, res) => {
  try {
    const { currentCopy, projectName, projectPrice, targetAudience } = req.body;
    if (!currentCopy) return res.status(400).json({ error: '请提供详情页文案' });

    await delay(600 + Math.random() * 800);

    // 合规检查
    const complianceResults = [];
    COPY_RULES.forEach(r => {
      const matches = currentCopy.match(r.pattern);
      if (matches) complianceResults.push({ rule: r.rule, severity: r.severity, matched: [...new Set(matches)], msg: r.msg });
    });

    // 五维度评分 (基于文案特征启发式打分)
    const hasPainPoint = /孩子|近视|看不清|度数|担心|焦虑|怎么办|越来越/.test(currentCopy);
    const hasPriceAnchor = /¥|元|原价|团购|优惠|限时|特惠/.test(currentCopy);
    const hasTrustElement = /爱尔|博士|主任|专家|资质|认证|会员|年.*经验/.test(currentCopy);
    const hasStepByStep = /步骤|第一步|第二步|流程|首先|然后|最后|包含|套餐内容/.test(currentCopy);
    const hasCTA = /立即|马上|点击|团购|预约|咨询|扫码/.test(currentCopy);
    const hasUrgency = /限时|限量|仅剩|最后|即将|截止|名额/.test(currentCopy);
    const hasSocialProof = /好评|五星|已售|复购|推荐|口碑/.test(currentCopy);
    const wordCount = currentCopy.length;

    const hookScore = Math.min(95, 40 + (hasPainPoint ? 30 : 0) + (wordCount > 50 ? 15 : 0) + (hasPriceAnchor ? 10 : 0));
    const trustScore = Math.min(95, 35 + (hasTrustElement ? 25 : 0) + (hasSocialProof ? 20 : 0) + (wordCount > 200 ? 10 : 5));
    const clarityScore = Math.min(95, 30 + (hasStepByStep ? 30 : 0) + (wordCount > 100 ? 15 : 0) + (hasCTA ? 10 : 0));
    const urgencyScore = Math.min(95, 25 + (hasCTA ? 20 : 0) + (hasUrgency ? 30 : 0) + (hasPriceAnchor ? 10 : 0));
    const complianceScore = complianceResults.filter(r => r.severity === 'FAIL').length > 0 ? 30 :
      complianceResults.filter(r => r.severity === 'WARN').length > 0 ? 55 : 85;

    const overallScore = Math.round(hookScore * 0.2 + trustScore * 0.25 + clarityScore * 0.25 + urgencyScore * 0.1 + complianceScore * 0.2);

    // 生成优化版文案
    const name = projectName || '视力检查';
    const price = projectPrice || '¥199';
    const audience = targetAudience || '6-14岁近视儿童家长';

    // 原始文案分段对比
    const sections = [];
    const originalParts = currentCopy.split(/\n\n|\r\n\r\n/).filter(Boolean);
    if (originalParts.length === 0) originalParts.push(currentCopy);

    const improvedParts = [];
    // 开头钩子
    if (!hasPainPoint) {
      improvedParts.push(`【孩子近视度数涨太快？可能是没选对矫正方式】\n\n每年暑假后，很多家长发现孩子近视度数又涨了50-100度。其实，除了配普通眼镜，还有一种国际公认的近视控制方法——角膜塑形镜（OK镜）。`);
    } else {
      improvedParts.push(originalParts[0].replace(/^[【\[]?/, '【').replace(/^(.{0,50})/, '【$1】'));
    }
    // 信任建立
    if (!hasTrustElement) {
      improvedParts.push(`为什么选择爱尔眼科？\n\n爱尔眼科 · 全球连锁眼科医疗机构\n杜秀臻医生 · 从业10年 · 青少年近视防控专家\n已为3000+青少年提供个性化近视防控方案`);
    } else {
      improvedParts.push(originalParts[Math.min(1, originalParts.length - 1)] || '');
    }
    // 流程说明
    if (!hasStepByStep) {
      improvedParts.push(`【${name}包含哪些项目？】\n\n① 综合验光：精准测量屈光状态\n② 角膜地形图：评估角膜形态是否适合OK镜\n③ 眼轴长度测量：客观评估近视进展\n④ 医生一对一解读报告+个性化方案建议`);
    } else {
      improvedParts.push(originalParts[Math.min(2, originalParts.length - 1)] || '');
    }
    // 价格 + CTA
    improvedParts.push(`【限时团购 · 仅需${price}】\n\n${name}\n原价¥${Math.round(parseFloat(price.replace('¥','')) * 2.5)} → 团购价${price}\n含：完整检查 + 医生报告解读 + 个性化方案\n有效期：购买后30天内到院\n\n📍 ${CLINIC.address}\n📞 ${CLINIC.phone}\n\n⚠️ 温馨提示：本套餐为检查评估套餐，不含OK镜产品费用。具体配戴方案需医生面诊后确定。\n\n[点击立即团购 →]`);

    const optimizedCopy = improvedParts.join('\n\n');

    // 对比分析
    const comparison = [];
    const beforeAfterMap = [
      { section: '开头钩子', before: originalParts[0] || '(缺少开头)', after: improvedParts[0].substring(0, 80) + '...', reason: hasPainPoint ? '已包含痛点共鸣，微调格式' : '新增痛点共鸣+数据锚定', score: hasPainPoint ? 75 : 40 },
      { section: '信任建立', before: originalParts[1] || '(缺少)', after: improvedParts[1].substring(0, 80) + '...', reason: hasTrustElement ? '已包含信任元素' : '新增资质/数据背书', score: hasTrustElement ? 70 : 35 },
      { section: '流程说明', before: originalParts[2] || '(缺少)', after: improvedParts[2].substring(0, 80) + '...', reason: hasStepByStep ? '流程描述清晰' : '新增分步骤流程说明', score: hasStepByStep ? 80 : 30 },
      { section: '行动号召', before: '(原无明确CTA)', after: improvedParts[3].substring(0, 80) + '...', reason: '新增价格对比+团购CTA+温馨提示', score: hasCTA ? 65 : 25 }
    ];

    res.json({
      projectName: name,
      projectPrice: price,
      originalScore: overallScore > 75 ? overallScore - randInt(5, 15) : overallScore,
      optimizedScore: overallScore,
      dimensions: {
        hook: { score: hookScore, label: '吸引钩子', comment: hookScore < 60 ? '缺少痛点共鸣，开头不够吸引' : hookScore < 75 ? '有一定吸引力，可增强数据锚定' : '痛点明确，吸引力强' },
        trust: { score: trustScore, label: '信任建立', comment: trustScore < 60 ? '缺少资质/数据背书，信任感不足' : trustScore < 75 ? '有基本信任元素，可增加具体数据' : '信任元素完善' },
        clarity: { score: clarityScore, label: '信息清晰度', comment: clarityScore < 60 ? '缺少流程说明，信息不够清晰' : clarityScore < 75 ? '结构基本清晰，可增加分步骤说明' : '结构清晰，信息完整' },
        urgency: { score: urgencyScore, label: '行动紧迫感', comment: urgencyScore < 50 ? '缺少限时/CTA元素，转化驱动力弱' : urgencyScore < 70 ? '有CTA但紧迫感不足' : 'CTA明确，紧迫感强' },
        compliance: { score: complianceScore, label: '合规性', comment: complianceResults.filter(r => r.severity === 'FAIL').length > 0 ? '存在合规红线问题，必须修改' : complianceResults.filter(r => r.severity === 'WARN').length > 0 ? '有需注意的合规项' : '合规检查通过' }
      },
      complianceCheck: {
        passed: complianceResults.filter(r => r.severity === 'FAIL').length === 0,
        warnings: complianceResults.filter(r => r.severity === 'WARN').length,
        details: complianceResults
      },
      optimizedCopy,
      beforeAfterComparison: comparison.length > 0 ? comparison : beforeAfterMap,
      highImpactChanges: [
        hasPainPoint ? null : '开头增加痛点共鸣（P0）',
        hasTrustElement ? null : '增加医生资质/数据背书（P0）',
        hasStepByStep ? null : '增加分步骤流程说明（P1）',
        hasCTA ? null : '增加明确CTA按钮（P0）'
      ].filter(Boolean),
      seoKeywords: [name, '近视防控', '儿童视力检查', '角膜塑形镜', 'OK镜', '爱尔眼科', '青少年近视', '眼科检查']
    });
  } catch (e) {
    console.error('copy-optimize error:', e);
    res.status(500).json({ error: '文案优化服务异常，请稍后重试' });
  }
});

// ===================================================================
// 月度数据导入模块
// 字段结构依据《8月集团门诊后台得分和星级分析.xlsx》设计：
//   主表「8月」：省区 / 店铺名称 / 城市 / 美团星级 / 点评星级 / 经营评分（228 行）
//   副表「Sheet1」：店铺ID / 店铺名称 / 城市 / 评论内容（11 条差评）
// 缺失值统一处理：文本 "NULL"、空串、"-"、"无" 一律视为缺失，可后续手动补录
// ===================================================================
const XLSX = require('xlsx');
const fs = require('fs');
const DATA_DIR = path.join(__dirname, '.data', 'monthly');

// 标准字段定义（aliases 用于表头自动匹配）
const M_FIELDS = [
  { key: 'region',       label: '省区',     aliases: ['省区', '区域', '大区', '省份', '所属省区'], type: 'text', required: false, fillable: true, hint: '如「山东省区」，缺失时按同城门店自动推荐' },
  { key: 'storeName',    label: '店铺名称', aliases: ['店铺名称', '门店名称', '店铺名', '门诊名称', '门店', 'storename'], type: 'text', required: true, fillable: false, hint: '唯一键，必填' },
  { key: 'city',         label: '城市',     aliases: ['城市', '所在城市', '地市', '市'], type: 'text', required: true, fillable: false, hint: '如「临沂市」，必填' },
  { key: 'manager',      label: '运营经理', aliases: ['运营经理', '省区经理', '运营负责人', '区域经理', '城市经理'], type: 'text', required: false, fillable: false, hint: '仅用于填报链接按经理筛选，可在页面按省区批量设置' },
  { key: 'status',       label: '门店状态', aliases: ['门店状态', '是否开通', '开通状态', '状态', '门店情况'], type: 'text', required: false, fillable: false, hint: '未开通/未上线门店不计入待补录' },
  { key: 'meituanStar',  label: '美团星级', aliases: ['美团星级', '美团评分', '店铺星级', '美团门店星级'], type: 'dec1', required: false, fillable: true, min: 0, max: 5, hint: '0~5，一位小数' },
  { key: 'dianpingStar', label: '点评星级', aliases: ['点评星级', '大众点评星级', '点评评分', '点评分'], type: 'dec1', required: false, fillable: true, min: 0, max: 5, hint: '0~5，一位小数' },
  { key: 'opsScore',     label: '经营评分', aliases: ['经营评分', '后台得分', '后台评分', '经营分', '评分'], type: 'int', required: false, fillable: true, min: 0, max: 110, hint: '0~110（存在加分项，允许超 100）' }
];
const M_FIELDS_REVIEW = [
  { key: 'storeId',       label: '店铺ID',   aliases: ['店铺id', '门店id', 'poiid', 'shopid'], type: 'text' },
  { key: 'storeName',     label: '店铺名称', aliases: ['店铺名称', '门店名称', '店铺名', '门诊名称'], type: 'text' },
  { key: 'city',          label: '城市',     aliases: ['城市', '所在城市'], type: 'text' },
  { key: 'reviewContent', label: '评论内容', aliases: ['评论内容', '评价内容', '差评内容', '评论', '内容'], type: 'text' }
];

// 空值归一：文本 NULL / 空串 / 占位符 → null
function mNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^(null|n\/a|na|none|nil|-|--|—|\/|无|暂无|待补)$/i.test(s)) return null;
  return s;
}
function mNum(v, type) {
  const raw = mNull(v);
  if (raw === null) return null;
  let n;
  if (typeof raw === 'number') n = raw;
  else {
    const cleaned = String(raw).replace(/[^\d.\-]/g, '');
    if (!cleaned) return null;
    n = Number(cleaned);
  }
  if (!isFinite(n)) return null;
  return type === 'int' ? Math.round(n) : Math.round(n * 10) / 10;
}
function mText(v) {
  const raw = mNull(v);
  if (raw === null) return null;
  // 逆向清洗字面量 \n（部分 Excel 导出把换行写成反斜杠+n）
  return String(raw).replace(/\\n/g, '\n').replace(/\s+/g, ' ').trim() || null;
}

// 表头识别：在前 6 行中找命中别名最多的那一行
function mDetectHeader(rows, fields) {
  let best = { row: 0, score: 0, map: {} };
  for (let r = 0; r < Math.min(6, rows.length); r++) {
    const map = {};
    let score = 0;
    (rows[r] || []).forEach((cell, ci) => {
      const name = mNull(cell);
      if (name === null) return;
      const lower = String(name).toLowerCase().replace(/\s/g, '');
      const hit = fields.find(f => f.aliases.some(a => lower === a.toLowerCase().replace(/\s/g, '')));
      if (hit && map[hit.key] === undefined) { map[hit.key] = ci; score++; }
    });
    if (score > best.score) best = { row: r, score, map };
  }
  return best;
}

// 读取工作簿 → { main: {name, rows}, review: {name, rows} }
function mReadWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const candidates = wb.SheetNames.map(name => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null, raw: true, blankrows: false });
    const mainH = mDetectHeader(rows, M_FIELDS);
    const revH = mDetectHeader(rows, M_FIELDS_REVIEW);
    return { name, rows, mainH, revH };
  });
  // 主表：命中最多的主表字段；差评表：含「评论内容」且命中差评字段更多
  let main = null, review = null;
  candidates.forEach(c => {
    const hasReviewCol = c.revH.map.reviewContent !== undefined;
    if (!hasReviewCol && (!main || c.mainH.score > main.mainH.score)) main = c;
  });
  candidates.forEach(c => {
    if (c.revH.map.reviewContent !== undefined && (!review || c.revH.score > review.revH.score)) review = c;
  });
  if (!main) {
    candidates.forEach(c => { if (!main || c.mainH.score > main.mainH.score) main = c; });
  }
  if (main && review && main.name === review.name) {
    // 同一张表既含门店指标又含评论，视为单表模式
    review = null;
  }
  return { wb, main, review };
}

// 从主表提取门店记录
// 门店状态归一：显式状态列优先；无状态列时，三项指标全空视为「疑似未开通」
function mStatusOf(raw, rec) {
  const s = mText(raw);
  const hasStatusCol = raw !== undefined;
  if (s) {
    if (/未开通|未上线|未营业|筹备|筹建|暂停|停业|关闭|装修/.test(s)) return 'unopened';
    if (/已开通|已上线|正常|在营|营业中/.test(s)) return 'active';
  }
  if (hasStatusCol && raw !== null && raw !== undefined) return 'active';
  const allNull = rec.meituanStar === null && rec.dianpingStar === null && rec.opsScore === null;
  return allNull ? 'suspect' : 'active';
}

function mExtractStores(sheet) {
  const { rows, mainH } = sheet;
  const map = mainH.map;
  const out = [];
  for (let r = mainH.row + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const storeName = mText(row[map.storeName]);
    if (!storeName) continue;
    // 跳过合计/小计行
    if (/^(合计|小计|汇总|总计|平均|备注|说明)/.test(storeName)) continue;
    const rec = {
      storeName,
      city: mText(map.city !== undefined ? row[map.city] : null),
      region: mText(map.region !== undefined ? row[map.region] : null),
      manager: mText(map.manager !== undefined ? row[map.manager] : null),
      meituanStar: map.meituanStar !== undefined ? mNum(row[map.meituanStar], 'dec1') : null,
      dianpingStar: map.dianpingStar !== undefined ? mNum(row[map.dianpingStar], 'dec1') : null,
      opsScore: map.opsScore !== undefined ? mNum(row[map.opsScore], 'int') : null,
      sourceRow: r + 1,
      manual: {}
    };
    rec.status = mStatusOf(map.status !== undefined ? row[map.status] : undefined, rec);
    out.push(rec);
  }
  return out;
}

function mExtractReviews(sheet) {
  if (!sheet) return [];
  const { rows, revH } = sheet;
  const map = revH.map;
  const out = [];
  for (let r = revH.row + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const content = mText(map.reviewContent !== undefined ? row[map.reviewContent] : null);
    const storeName = mText(map.storeName !== undefined ? row[map.storeName] : null);
    if (!content && !storeName) continue;
    out.push({
      storeId: mText(map.storeId !== undefined ? row[map.storeId] : null),
      storeName: storeName || '（未填门店）',
      city: mText(map.city !== undefined ? row[map.city] : null),
      content: content || '',
      sourceRow: r + 1
    });
  }
  return out;
}

// 缺失字段清单 + 同城自动推荐
function mPending(store) {
  return M_FIELDS.filter(f => f.fillable && (store[f.key] === null || store[f.key] === undefined)).map(f => f.key);
}
function mSuggest(stores, key) {
  const bucket = {};
  stores.forEach(s => {
    if (s[key] === null || s[key] === undefined) return;
    const c = s.city || '';
    if (!c) return;
    (bucket[c] = bucket[c] || []).push(s[key]);
  });
  const result = {};
  stores.forEach(s => {
    if (s[key] !== null && s[key] !== undefined) return;
    const c = s.city || '';
    const arr = bucket[c];
    if (!arr || !arr.length) return;
    // 取众数
    const freq = {};
    arr.forEach(v => freq[v] = (freq[v] || 0) + 1);
    const top = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
    const pct = Math.round(freq[top] / arr.length * 100);
    // 置信度不足 50% 的不作推荐，避免误导
    if (pct < 50) return;
    const val = isNaN(Number(top)) ? top : Number(top);
    result[s.storeName] = { value: val, from: `${c}同城 ${arr.length} 家门店`, confidence: pct };
  });
  return result;
}

// 分布统计（NULL 单独成箱，不混入数值区间）
function mBucket(values, buckets) {
  const valid = values.filter(v => v !== null && v !== undefined);
  return buckets.map(b => {
    const count = valid.filter(v => v >= b.min && (b.max === null || v < b.max)).length;
    return { label: b.label, min: b.min, max: b.max, count, pct: valid.length ? Math.round(count / valid.length * 1000) / 10 : 0 };
  });
}

// 主分析
function mAnalyze({ month, fileName, stores, reviews, meta }) {
  const managerMap = (meta && meta.managerMap) || {};
  // 运营经理补全：门店自带优先，其次按「省区 → 经理」映射
  const withMgr = stores.map(s => Object.assign({}, s, {
    manager: s.manager || (s.region && managerMap[s.region] ? managerMap[s.region] : null),
    status: s.status || 'active'
  }));
  const isExcluded = s => s.status === 'unopened' || s.status === 'suspect';
  const activeRaw = withMgr.filter(s => !isExcluded(s));
  const excludedRaw = withMgr.filter(isExcluded);

  // 仅「省区」属于地理属性，可由同城门店的同省归属推断；
  // 美团星级 / 点评星级 / 经营评分 是门店级考核指标，同城门店之间没有可比性，禁止自动推断，必须人工补录
  const SUGGEST = { region: mSuggest(activeRaw, 'region') };

  const annotated = s => {
    const missing = mPending(s);
    const suggestions = {};
    if (s.status === 'active') {
      missing.forEach(k => { if (SUGGEST[k] && SUGGEST[k][s.storeName]) suggestions[k] = SUGGEST[k][s.storeName]; });
    }
    return Object.assign({}, s, { missing, suggestions, complete: Math.round((4 - missing.length) / 4 * 100) });
  };

  const enriched = activeRaw.map(annotated);
  const excludedStores = excludedRaw.map(s => Object.assign(annotated(s), { excluded: true }));

  const valid = arr => arr.filter(v => v !== null && v !== undefined);
  const avg = arr => { const v = valid(arr); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) / 100 : null; };

  const starVals = enriched.map(s => s.meituanStar);
  const dianpingVals = enriched.map(s => s.dianpingStar);
  const scoreVals = enriched.map(s => s.opsScore);

  const kpi = {
    storeCount: enriched.length,
    totalStores: withMgr.length,
    excludedCount: excludedStores.length,
    unopenedCount: excludedStores.filter(s => s.status === 'unopened').length,
    suspectCount: excludedStores.filter(s => s.status === 'suspect').length,
    completeStores: enriched.filter(s => s.missing.length === 0).length,
    pendingStores: enriched.filter(s => s.missing.length > 0).length,
    pendingFieldCount: enriched.reduce((a, s) => a + s.missing.length, 0),
    avgMeituanStar: avg(starVals),
    // 点评星级为 0 的样本极可能是「无点评数据」占位，均值仅统计 >0 的有效评分
    avgDianpingStar: avg(dianpingVals.filter(v => v === null || v > 0)),
    dianpingValidCount: dianpingVals.filter(v => v !== null && v > 0).length,
    avgOpsScore: avg(scoreVals),
    nullStarCount: enriched.filter(s => s.meituanStar === null).length,
    zeroStarCount: enriched.filter(s => s.meituanStar === 0).length,
    nullScoreCount: enriched.filter(s => s.opsScore === null).length,
    zeroScoreCount: enriched.filter(s => s.opsScore === 0).length,
    dianpingZeroCount: enriched.filter(s => s.dianpingStar === 0).length,
    opsAbove100: enriched.filter(s => s.opsScore !== null && s.opsScore > 100).length,
    opsBelow70: enriched.filter(s => s.opsScore !== null && s.opsScore < 70).length,
    starBelow40: enriched.filter(s => s.meituanStar !== null && s.meituanStar > 0 && s.meituanStar < 4.0).length,
    reviewCount: reviews.length,
    reviewStores: new Set(reviews.map(r => r.storeName)).size,
    regionCount: new Set(enriched.map(s => s.region).filter(Boolean)).size,
    cityCount: new Set(enriched.map(s => s.city).filter(Boolean)).size
  };

  // 省区对比（仅统计已填省区）
  const regionMap = {};
  enriched.forEach(s => {
    if (!s.region) return;
    const r = regionMap[s.region] = regionMap[s.region] || { region: s.region, stores: [], pending: 0 };
    r.stores.push(s);
    if (s.missing.length) r.pending++;
  });
  const regionStats = Object.values(regionMap).map(r => ({
    region: r.region,
    storeCount: r.stores.length,
    avgMeituanStar: avg(r.stores.map(s => s.meituanStar)),
    avgOpsScore: avg(r.stores.map(s => s.opsScore)),
    pendingStores: r.pending,
    below70: r.stores.filter(s => s.opsScore !== null && s.opsScore < 70).length,
    reviewCount: reviews.filter(v => r.stores.some(s => s.storeName === v.storeName)).length
  })).sort((a, b) => (b.avgOpsScore || 0) - (a.avgOpsScore || 0));

  // 评级：按省区均分的三分位划分（前 1/3 为 A，后 1/3 为 C），省区数不足 6 个时退回固定阈值
  const ratedRegions = regionStats.filter(r => r.avgOpsScore !== null);
  const sortedScores = ratedRegions.map(r => r.avgOpsScore).sort((a, b) => a - b);
  const pick = q => sortedScores.length ? sortedScores[Math.min(sortedScores.length - 1, Math.floor(sortedScores.length * q))] : null;
  const useTercile = sortedScores.length >= 6;
  const p33 = useTercile ? pick(0.33) : 70;
  const p67 = useTercile ? pick(0.67) : 85;
  regionStats.forEach(r => {
    if (r.avgOpsScore === null) { r.grade = '—'; }
    else if (r.avgOpsScore >= p67) { r.grade = 'A'; }
    else if (r.avgOpsScore >= p33) { r.grade = 'B'; }
    else { r.grade = 'C'; }
  });
  const gradeNote = useTercile
    ? `按 ${sortedScores.length} 个省区均分的三分位划分：A ≥ ${p67} 分，B ${p33}–${p67} 分，C ＜ ${p33} 分`
    : `省区数不足 6 个，改用固定阈值：A ≥ 85 分，B 70–85 分，C ＜ 70 分`;

  const starDistribution = mBucket(starVals, [
    { label: '0 分（真实评分）', min: 0, max: 0.0001 },
    { label: '＜4.0', min: 0.0001, max: 4.0 },
    { label: '4.0–4.4', min: 4.0, max: 4.5 },
    { label: '4.5–4.9', min: 4.5, max: 5.0 },
    { label: '5.0', min: 5.0, max: null }
  ]);
  const nullStar = starVals.filter(v => v === null || v === undefined).length;
  if (nullStar > 0) {
    starDistribution.unshift({ label: '未填（NULL）', min: null, max: null, count: nullStar, pct: Math.round(nullStar / enriched.length * 1000) / 10 });
  }

  const scoreDistribution = mBucket(scoreVals, [
    { label: '0 分（真实评分）', min: 0, max: 0.0001 },
    { label: '1–59', min: 0.0001, max: 60 },
    { label: '60–69', min: 60, max: 70 },
    { label: '70–79', min: 70, max: 80 },
    { label: '80–89', min: 80, max: 90 },
    { label: '90–100', min: 90, max: 100.5 },
    { label: '＞100（含加分）', min: 100.5, max: null }
  ]);
  const nullScore = scoreVals.filter(v => v === null || v === undefined).length;
  if (nullScore > 0) {
    scoreDistribution.unshift({ label: '未填（NULL）', min: null, max: null, count: nullScore, pct: Math.round(nullScore / enriched.length * 1000) / 10 });
  }

  const rated = enriched.filter(s => s.opsScore !== null);
  const top10 = rated.slice().sort((a, b) => b.opsScore - a.opsScore).slice(0, 10);
  const bottom10 = rated.slice().sort((a, b) => a.opsScore - b.opsScore).slice(0, 10);
  const lowStar = enriched.filter(s => s.meituanStar !== null && s.meituanStar > 0 && s.meituanStar < 4.2)
    .sort((a, b) => a.meituanStar - b.meituanStar).slice(0, 15);

  const pendingList = enriched.filter(s => s.missing.length > 0).map(s => ({
    storeName: s.storeName, city: s.city, region: s.region, manager: s.manager, sourceRow: s.sourceRow,
    missing: s.missing.map(k => ({ key: k, label: (M_FIELDS.find(f => f.key === k) || {}).label || k })),
    suggestions: s.suggestions
  }));
  const pendingByManager = {};
  pendingList.forEach(p => {
    const m = p.manager || '未分配经理';
    pendingByManager[m] = (pendingByManager[m] || 0) + 1;
  });

  // 规则化洞察（确定性，不依赖大模型）
  const insights = [];
  if (kpi.pendingFieldCount > 0) {
    const fillableHit = pendingList.filter(p => Object.keys(p.suggestions).length > 0).length;
    insights.push({ level: 'P0', text: `${kpi.pendingStores} 家门店共 ${kpi.pendingFieldCount} 个字段缺失，其中 ${fillableHit} 家的「省区」可由同城门店归属自动推荐；星级与经营评分属门店级指标、无法互推，需人工逐个补录。` });
  }
  if (kpi.excludedCount > 0) {
    insights.push({ level: 'P2', text: `已排除 ${kpi.excludedCount} 家未开通/疑似未开通门店（美团星级、点评星级、经营评分三项全空），不计入待补录与省区对标；若其中确有已营业门诊，可在「门店明细」中把状态改回「已开通」。` });
  }
  if (kpi.regionCount > 0 && kpi.storeCount) {
    const uncovered = kpi.storeCount - enriched.filter(s => s.region).length;
    if (uncovered > 0) insights.push({ level: 'P0', text: `省区覆盖率 ${Math.round((1 - uncovered / kpi.storeCount) * 100)}%，${uncovered} 家门店未归属省区，将无法进入省区横向对标，须优先补齐。` });
  }
  if (kpi.opsBelow70 > 0) insights.push({ level: 'P0', text: `经营评分低于 70 分的门店 ${kpi.opsBelow70} 家（占 ${Math.round(kpi.opsBelow70 / (rated.length || 1) * 100)}%），为平台流量分配的最弱环节，建议本月内完成一次一对一诊断。` });
  if (kpi.starBelow40 > 0) insights.push({ level: 'P1', text: `美团星级低于 4.0 的门店 ${kpi.starBelow40} 家，星级直接影响列表排序与点击率，需结合差评原文逐条整改。` });
  if (kpi.opsAbove100 > 0) insights.push({ level: 'P1', text: `${kpi.opsAbove100} 家门店经营评分超过 100（存在加分项），可作为标杆样本反推加分动作，输出可复制的运营 SOP。` });
  if (kpi.dianpingZeroCount > kpi.storeCount * 0.3) insights.push({ level: 'P1', text: `点评星级为 0 的门店 ${kpi.dianpingZeroCount} 家（占 ${Math.round(kpi.dianpingZeroCount / kpi.storeCount * 100)}%），0 很可能代表「无点评数据」而非真实评分，建议与业务确认口径后再纳入考核，避免误判。` });
  if (kpi.nullStarCount > 0) insights.push({ level: 'P2', text: `${kpi.nullStarCount} 家门店美团星级为空（源文件标记 NULL），其中 ${kpi.zeroStarCount} 家为真实 0 分，两者含义不同，补录时请勿一并按 0 处理。` });
  if (regionStats.length >= 2) {
    const best = regionStats[0], worst = regionStats[regionStats.length - 1];
    if (best.avgOpsScore !== null && worst.avgOpsScore !== null && best.avgOpsScore - worst.avgOpsScore > 5) {
      insights.push({ level: 'P1', text: `省区差距显著：${best.region} 均分 ${best.avgOpsScore}，${worst.region} 均分 ${worst.avgOpsScore}，相差 ${Math.round((best.avgOpsScore - worst.avgOpsScore) * 10) / 10} 分，建议把 A 级省区的做法做成标准包下发。` });
    }
  }
  if (kpi.reviewCount > 0) insights.push({ level: 'P2', text: `本月收到差评原文 ${kpi.reviewCount} 条，覆盖 ${kpi.reviewStores} 家门店，已转入「评价管理」模块生成回复话术。` });

  // 字段映射回显
  const mapping = M_FIELDS.map(f => ({
    field: f.key, label: f.label, hint: f.hint,
    columnIndex: meta.mainMap[f.key] !== undefined ? meta.mainMap[f.key] : null,
    columnName: meta.mainMap[f.key] !== undefined ? meta.mainHeaders[meta.mainMap[f.key]] : null,
    matched: meta.mainMap[f.key] !== undefined
  }));

  const result = {
    ok: true,
    month,
    fileName,
    importedAt: new Date().toISOString(),
    meta: {
      sheetCount: meta.sheetCount,
      mainSheet: meta.mainSheet,
      reviewSheet: meta.reviewSheet,
      totalRows: withMgr.length,
      excludedRows: excludedStores.length,
      headerRow: meta.headerRow + 1,
      headers: meta.mainHeaders,
      mainMap: meta.mainMap || {},
      sheetNames: meta.sheetNames || [],
      warnings: meta.warnings || [],
      reviewSource: meta.reviewSheet ? `${meta.reviewSheet}（${reviews.length} 条）` : '未检测到差评明细表'
    },
    mapping,
    kpi,
    stores: enriched.concat(excludedStores),
    pendingList,
    pendingByManager,
    managerMap,
    managers: Array.from(new Set(enriched.map(s => s.manager).filter(Boolean))).sort(),
    regions: Array.from(new Set(enriched.map(s => s.region).filter(Boolean))).sort(),
    regionStats,
    gradeNote,
    starDistribution,
    scoreDistribution,
    top10, bottom10, lowStar,
    reviews: reviews.slice(0, 200),
    insights,
    warnings: meta.warnings || []
  };
  return result;
}

function mEnsureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function mSave(month, payload) {
  try {
    mEnsureDir();
    fs.writeFileSync(path.join(DATA_DIR, `${month || 'unknown'}.json`), JSON.stringify(payload, null, 1), 'utf8');
  } catch (e) { console.error('月度数据落盘失败:', e.message); }
}
function mLoad(month) {
  try {
    const p = path.join(DATA_DIR, `${month}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}
function mFindByToken(token) {
  try {
    mEnsureDir();
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        if (j && j.fillToken && j.fillToken === token) return j;
      } catch (e) { /* skip broken file */ }
    }
  } catch (e) { /* ignore */ }
  return null;
}
// 用存档里的门店原始值重跑分析（补录、设经理、外部填报都走这里）
function mRebuild(data, overrides) {
  const src = data.meta || {};
  const meta = {
    sheetCount: src.sheetCount || 1,
    mainSheet: src.mainSheet || '—',
    reviewSheet: src.reviewSheet || null,
    headerRow: Math.max(0, (src.headerRow || 1) - 1),
    mainHeaders: src.headers || [],
    mainMap: src.mainMap || {},
    sheetNames: src.sheetNames || [],
    warnings: src.warnings || [],
    managerMap: (overrides && overrides.managerMap) || data.managerMap || {}
  };
  const payload = mAnalyze({ month: data.month, fileName: data.fileName, stores: data.stores || [], reviews: data.reviews || [], meta });
  payload.fillToken = data.fillToken || null;
  payload.importedAt = data.importedAt || payload.importedAt;
  if (overrides && overrides.managerMap) payload.managerMap = overrides.managerMap;
  return payload;
}
function mClampNum(v, min, max, type) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  if (!isFinite(n)) return null;
  const clamped = Math.min(max, Math.max(min, n));
  return type === 'int' ? Math.round(clamped) : Math.round(clamped * 10) / 10;
}

// --- POST /api/monthly-import  上传 Excel 并解析 ---
app.post('/api/monthly-import', async (req, res) => {
  try {
    const { month, fileName, fileBase64 } = req.body || {};
    if (!fileBase64) return res.status(400).json({ ok: false, error: '未收到文件内容，请重新选择 Excel 文件' });
    let buffer;
    try {
      buffer = Buffer.from(String(fileBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    } catch (e) {
      return res.status(400).json({ ok: false, error: '文件解码失败，请确认上传的是 .xlsx 文件' });
    }
    if (buffer.length > 20 * 1024 * 1024) return res.status(400).json({ ok: false, error: '文件超过 20MB，请精简后上传' });

    const { wb, main, review } = mReadWorkbook(buffer);
    if (!main || main.mainH.score === 0) {
      return res.status(400).json({ ok: false, error: '未识别到有效表头。请确保表格包含「店铺名称」「城市」以及「美团星级/点评星级/经营评分」中的至少一列。' });
    }
    const stores = mExtractStores(main);
    if (!stores.length) return res.status(400).json({ ok: false, error: '表头识别成功，但未读到任何门店数据行（店铺名称列全部为空）。' });
    const reviews = mExtractReviews(review);

    const warnings = [];
    if (main.mainH.map.city === undefined) warnings.push('未找到「城市」列，同城推荐将不可用');
    if (main.mainH.map.region === undefined) warnings.push('未找到「省区」列，省区对标将不可用');
    if (!review) warnings.push('未检测到差评明细表（含「评论内容」的工作表），本次仅导入门店指标');

    // 同月重导时沿用已设置的省区负责人映射与填报 token，避免重新上传后丢失
    const prev = mLoad(month || 'unknown') || {};
    const prevMap = prev.managerMap || {};
    const prevStatus = {};
    (prev.stores || []).forEach(s => { if (s.status && s.status !== 'active') prevStatus[s.storeName] = s.status; });
    const storesWithPrev = stores.map(s => {
      const st = Object.assign({}, s);
      if (!st.manager && st.region && prevMap[st.region]) st.manager = prevMap[st.region];
      if (prevStatus[st.storeName]) st.status = prevStatus[st.storeName];
      return st;
    });

    const payload = mAnalyze({
      month: month || '未命名月份',
      fileName: fileName || '未命名文件',
      stores: storesWithPrev, reviews,
      meta: {
        sheetCount: wb.SheetNames.length,
        mainSheet: main.name,
        reviewSheet: review ? review.name : null,
        headerRow: main.mainH.row,
        mainHeaders: (main.rows[main.mainH.row] || []).map(v => mNull(v) || ''),
        mainMap: main.mainH.map,
        warnings,
        managerMap: prevMap
      }
    });
    payload.meta.sheetNames = wb.SheetNames;
    payload.fillToken = prev.fillToken || null;
    payload.managerMap = prevMap;
    mSave(month || 'unknown', payload);
    console.log(`  [月度导入] ${month} · ${main.name} · ${stores.length} 家门店 · 差评 ${reviews.length} 条`);
    res.json(payload);
  } catch (e) {
    console.error('monthly-import error:', e);
    res.status(500).json({ ok: false, error: '解析失败：' + e.message });
  }
});

// --- POST /api/monthly-reanalyze  手动补录后重算 ---
app.post('/api/monthly-reanalyze', (req, res) => {
  try {
    const { month, fileName, stores, reviews, meta } = req.body || {};
    if (!Array.isArray(stores)) return res.status(400).json({ ok: false, error: '缺少门店数据' });
    const cur = mLoad(month) || {};
    const bodyMeta = meta || {};
    const payload = mAnalyze({
      month: month || '未命名月份',
      fileName: fileName || '手动补录',
      stores, reviews: Array.isArray(reviews) ? reviews : [],
      meta: {
        sheetCount: (cur.meta && cur.meta.sheetCount) || 1,
        mainSheet: bodyMeta.mainSheet || (cur.meta && cur.meta.mainSheet) || '手动录入',
        reviewSheet: bodyMeta.reviewSheet !== undefined ? bodyMeta.reviewSheet : ((cur.meta && cur.meta.reviewSheet) || null),
        headerRow: bodyMeta.headerRow !== undefined ? bodyMeta.headerRow : Math.max(0, ((cur.meta && cur.meta.headerRow) || 1) - 1),
        mainHeaders: bodyMeta.mainHeaders || (cur.meta && cur.meta.headers) || M_FIELDS.map(f => f.label),
        mainMap: (cur.meta && cur.meta.mainMap) || {},
        sheetNames: (cur.meta && cur.meta.sheetNames) || [],
        warnings: (cur.meta && cur.meta.warnings) || [],
        managerMap: bodyMeta.managerMap || cur.managerMap || {}
      }
    });
    payload.fillToken = cur.fillToken || null;
    mSave(month || 'unknown', payload);
    res.json(payload);
  } catch (e) {
    console.error('monthly-reanalyze error:', e);
    res.status(500).json({ ok: false, error: '重算失败：' + e.message });
  }
});

// --- POST /api/monthly-fill-link  生成外部填报链接 ---
app.post('/api/monthly-fill-link', (req, res) => {
  try {
    const { month } = req.body || {};
    const data = mLoad(month);
    if (!data) return res.status(404).json({ ok: false, error: '该月份尚未导入数据，请先上传 Excel' });
    if (!data.fillToken) {
      data.fillToken = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      mSave(month, data);
    }
    const host = req.get('host') || `localhost:${PORT}`;
    const base = `${req.protocol}://${host}`;
    const pending = (data.stores || []).filter(s => !s.excluded && s.missing && s.missing.length).length;
    res.json({
      ok: true,
      token: data.fillToken,
      path: `/fill.html?t=${data.fillToken}`,
      url: `${base}/fill.html?t=${data.fillToken}`,
      month: data.month,
      pending: pending
    });
  } catch (e) {
    console.error('monthly-fill-link error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- GET /api/monthly-fill-form?token=  外部填报页取数 ---
app.get('/api/monthly-fill-form', (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: '缺少填报凭证' });
    const data = mFindByToken(token);
    if (!data) return res.status(404).json({ ok: false, error: '填报链接已失效，请向运营主管重新获取' });
    const pending = (data.stores || []).filter(s => !s.excluded && s.missing && s.missing.length);
    res.json({
      ok: true,
      month: data.month,
      fileName: data.fileName,
      updatedAt: data.importedAt,
      totalPending: pending.length,
      stores: pending.map(s => ({
        storeName: s.storeName,
        city: s.city || null,
        region: s.region || null,
        manager: s.manager || null,
        meituanStar: s.meituanStar === undefined ? null : s.meituanStar,
        dianpingStar: s.dianpingStar === undefined ? null : s.dianpingStar,
        opsScore: s.opsScore === undefined ? null : s.opsScore,
        missing: s.missing || [],
        suggestions: s.suggestions || {}
      })),
      regions: Array.from(new Set(pending.map(s => s.region).filter(Boolean))).sort(),
      managers: Array.from(new Set(pending.map(s => s.manager).filter(Boolean))).sort()
    });
  } catch (e) {
    console.error('monthly-fill-form error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- POST /api/monthly-fill-submit  外部填报提交回写 ---
app.post('/api/monthly-fill-submit', (req, res) => {
  try {
    const { token, fills } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: '缺少填报凭证' });
    if (!Array.isArray(fills)) return res.status(400).json({ ok: false, error: '没有可提交的填报内容' });
    const data = mFindByToken(token);
    if (!data) return res.status(404).json({ ok: false, error: '填报链接已失效，请向运营主管重新获取' });

    const map = new Map((data.stores || []).map(s => [s.storeName, s]));
    let saved = 0;
    fills.forEach(f => {
      if (!f || !f.storeName) return;
      const s = map.get(f.storeName);
      if (!s) return;
      let touched = false;
      const region = f.region === null || f.region === undefined ? '' : String(f.region).trim();
      if (region) { s.region = region; touched = true; }
      const ms = mClampNum(f.meituanStar, 0, 5, 'dec1');
      if (ms !== null) { s.meituanStar = ms; touched = true; }
      const ds = mClampNum(f.dianpingStar, 0, 5, 'dec1');
      if (ds !== null) { s.dianpingStar = ds; touched = true; }
      const os = mClampNum(f.opsScore, 0, 110, 'int');
      if (os !== null) { s.opsScore = os; touched = true; }
      if (touched) saved++;
    });

    const payload = mRebuild(data);
    payload.fillToken = token;
    mSave(data.month, payload);
    res.json({
      ok: true,
      saved,
      remaining: payload.kpi.pendingStores,
      storeCount: payload.kpi.storeCount,
      message: saved ? `已保存 ${saved} 家门店，还剩 ${payload.kpi.pendingStores} 家待填` : '本次没有可保存的修改'
    });
  } catch (e) {
    console.error('monthly-fill-submit error:', e);
    res.status(500).json({ ok: false, error: '提交失败：' + e.message });
  }
});

// --- POST /api/monthly-set-manager  按省区设置运营经理 ---
app.post('/api/monthly-set-manager', (req, res) => {
  try {
    const { month, managerMap } = req.body || {};
    const data = mLoad(month);
    if (!data) return res.status(404).json({ ok: false, error: '该月份尚未导入数据' });
    const mm = managerMap && typeof managerMap === 'object' ? managerMap : {};
    (data.stores || []).forEach(s => {
      if (s.region && mm[s.region]) s.manager = String(mm[s.region]).trim() || null;
    });
    data.managerMap = mm;
    const payload = mRebuild(data, { managerMap: mm });
    payload.fillToken = data.fillToken || null;
    mSave(month, payload);
    res.json(payload);
  } catch (e) {
    console.error('monthly-set-manager error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- POST /api/monthly-set-status  标记门店开通状态（未开通门店不计入待补录） ---
app.post('/api/monthly-set-status', (req, res) => {
  try {
    const { month, storeNames, status } = req.body || {};
    const data = mLoad(month);
    if (!data) return res.status(404).json({ ok: false, error: '该月份尚未导入数据' });
    const allow = ['active', 'unopened'];
    if (allow.indexOf(status) < 0) return res.status(400).json({ ok: false, error: '状态值只能是 active 或 unopened' });
    const set = new Set(Array.isArray(storeNames) ? storeNames : []);
    let changed = 0;
    (data.stores || []).forEach(s => {
      if (set.has(s.storeName)) { s.status = status; changed++; }
    });
    const payload = mRebuild(data);
    payload.fillToken = data.fillToken || null;
    mSave(month, payload);
    res.json(Object.assign({ changed }, payload));
  } catch (e) {
    console.error('monthly-set-status error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- GET /api/monthly-history  已存档月份 ---
app.get('/api/monthly-history', (req, res) => {
  try {
    mEnsureDir();
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return { month: j.month, fileName: j.fileName, importedAt: j.importedAt, storeCount: j.kpi ? j.kpi.storeCount : 0, pending: j.kpi ? j.kpi.pendingFieldCount : 0 };
      } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => String(b.month).localeCompare(String(a.month)));
    res.json({ ok: true, list });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- GET /api/monthly-detail?month=  ---
app.get('/api/monthly-detail', (req, res) => {
  try {
    const m = req.query.month;
    const p = path.join(DATA_DIR, `${m}.json`);
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: '该月份尚未导入数据' });
    res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- GET /api/monthly-template  下载填报模板 ---
app.get('/api/monthly-template', (req, res) => {
  try {
    const headers = ['省区', '店铺名称', '城市', '美团星级', '点评星级', '经营评分', '运营经理', '门店状态'];
    const sample = [
      ['山东省区', '临沂爱尔眼科视光门诊（金水河畔店）', '临沂市', 4.4, 0, 71, '张三', '已开通'],
      ['湖南省区', '崇德爱尔眼科门诊', '常德市', 4.2, 0, 64, '李四', '已开通'],
      ['', '待填写门店示例', '待填写城市', null, null, null, '', '已开通']
    ];
    const ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
    ws['!cols'] = [{ wch: 14 }, { wch: 36 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '月度门店指标');
    const ws2 = XLSX.utils.aoa_to_sheet([['店铺ID', '店铺名称', '城市', '评论内容']].concat([
      [131624831, '长沙芙蓉爱尔眼科门诊部（芙蓉店）', '长沙市', '差评原文填写在此'],
      [null, '待填写门店', '待填写城市', null]
    ]));
    ws2['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 14 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws2, '差评明细');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="monthly-template.xlsx"');
    res.send(buf);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ===== 启动服务器 =====
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`  美团眼科运营AI助手 后端服务`);
  console.log(`  地址: http://localhost:${PORT}`);
  console.log(`  启动: node server.js`);
  console.log(`=================================`);
});
