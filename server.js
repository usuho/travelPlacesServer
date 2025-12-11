
require('dotenv').config();
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
/*const mongoose = require('mongoose');*/
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const AWS_REGION = process.env.AWS_REGION || 'ap-northeast-1';
const DATA_BUCKET = process.env.AWS_DATA_BUCKET || 'travelplacesbucketjapan';
const USER_BUCKET = process.env.AWS_USER_BUCKET || 'travelplacesbucketjapan';
const USER_PREFIX = process.env.AWS_USER_PREFIX || 'users/';
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || process.env.API_KEY || 'travelplaces-secret';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || `${30 * 24 * 60 * 60 * 1000}`, 10); // default 30 days
const REGISTER_INVITE_CODE = process.env.REGISTER_INVITE_CODE || process.env.INVITE_CODE || '';

// 启动时打印一下邀请码环境变量是否存在，便于排查部署问题（不打印具体值）
try {
  console.info('[env] REGISTER_INVITE_CODE set:', !!REGISTER_INVITE_CODE, 'INVITE_CODE set:', !!process.env.INVITE_CODE);
} catch (_) {}


function loadGeoKeys() {
  return {
    amapKey: process.env.AMAP_KEY || process.env.VITE_AMAP_KEY || '',
    openCageKey: process.env.OPENCAGE_KEY || process.env.VITE_OPENCAGE_KEY || '',
    geoapifyKey: process.env.GEOAPIFY_KEY || process.env.VITE_GEOAPIFY_KEY || '',
    locationIqKey: process.env.LOCATIONIQ_KEY || process.env.VITE_LOCATIONIQ_KEY || '',
    mapQuestKey: process.env.MAPQUEST_KEY || process.env.VITE_MAPQUEST_KEY || '',
    positionstackKey: process.env.POSITIONSTACK_KEY || process.env.VITE_POSITIONSTACK_KEY || ''
  };
}
const COUNTRY_TRANSLATIONS = {
  'afghanistan': '阿富汗', 'albania': '阿尔巴尼亚', 'algeria': '阿尔及利亚', 'andorra': '安道尔', 'angola': '安哥拉',
  'antigua and barbuda': '安提瓜和巴布达', 'argentina': '阿根廷', 'armenia': '亚美尼亚', 'australia': '澳大利亚',
  'austria': '奥地利', 'azerbaijan': '阿塞拜疆', 'bahamas': '巴哈马', 'bahrain': '巴林', 'bangladesh': '孟加拉国',
  'barbados': '巴巴多斯', 'belarus': '白俄罗斯', 'belgium': '比利时', 'belize': '伯利兹', 'benin': '贝宁', 'bhutan': '不丹',
  'bolivia': '玻利维亚', 'bosnia and herzegovina': '波黑', 'botswana': '博茨瓦纳', 'brazil': '巴西', 'brunei': '文莱',
  'bulgaria': '保加利亚', 'burkina faso': '布基纳法索', 'burundi': '布隆迪', 'cabo verde': '佛得角', 'cambodia': '柬埔寨',
  'cameroon': '喀麦隆', 'canada': '加拿大', 'central african republic': '中非共和国', 'chad': '乍得', 'chile': '智利',
  'china': '中国', 'colombia': '哥伦比亚', 'comoros': '科摩罗', 'congo': '刚果', 'costa rica': '哥斯达黎加',
  "cote d'ivoire": '科特迪瓦', 'croatia': '克罗地亚', 'cuba': '古巴', 'cyprus': '塞浦路斯', 'czechia': '捷克',
  'denmark': '丹麦', 'djibouti': '吉布提', 'dominica': '多米尼克', 'dominican republic': '多米尼加', 'ecuador': '厄瓜多尔',
  'egypt': '埃及', 'el salvador': '萨尔瓦多', 'equatorial guinea': '赤道几内亚', 'eritrea': '厄立特里亚', 'estonia': '爱沙尼亚',
  'eswatini': '埃斯瓦蒂尼', 'ethiopia': '埃塞俄比亚', 'fiji': '斐济', 'finland': '芬兰', 'france': '法国', 'gabon': '加蓬',
  'gambia': '冈比亚', 'georgia': '格鲁吉亚', 'germany': '德国', 'ghana': '加纳', 'greece': '希腊', 'grenada': '格林纳达',
  'guatemala': '危地马拉', 'guinea': '几内亚', 'guinea-bissau': '几内亚比绍', 'guyana': '圭亚那', 'haiti': '海地',
  'holy see': '梵蒂冈', 'honduras': '洪都拉斯', 'hungary': '匈牙利', 'iceland': '冰岛', 'india': '印度',
  'indonesia': '印度尼西亚', 'iran': '伊朗', 'iraq': '伊拉克', 'ireland': '爱尔兰', 'israel': '以色列', 'italy': '意大利',
  'jamaica': '牙买加', 'japan': '日本', 'jordan': '约旦', 'kazakhstan': '哈萨克斯坦', 'kenya': '肯尼亚', 'kiribati': '基里巴斯',
  'kuwait': '科威特', 'kyrgyzstan': '吉尔吉斯斯坦', 'laos': '老挝', 'latvia': '拉脱维亚', 'lebanon': '黎巴嫩',
  'lesotho': '莱索托', 'liberia': '利比里亚', 'libya': '利比亚', 'liechtenstein': '列支敦士登', 'lithuania': '立陶宛',
  'luxembourg': '卢森堡', 'madagascar': '马达加斯加', 'malawi': '马拉维', 'malaysia': '马来西亚', 'maldives': '马尔代夫',
  'mali': '马里', 'malta': '马耳他', 'marshall islands': '马绍尔群岛', 'mauritania': '毛里塔尼亚', 'mauritius': '毛里求斯',
  'mexico': '墨西哥', 'micronesia': '密克罗尼西亚', 'moldova': '摩尔多瓦', 'monaco': '摩纳哥', 'mongolia': '蒙古',
  'montenegro': '黑山', 'morocco': '摩洛哥', 'mozambique': '莫桑比克', 'myanmar': '缅甸', 'namibia': '纳米比亚',
  'nauru': '瑙鲁', 'nepal': '尼泊尔', 'netherlands': '荷兰', 'new zealand': '新西兰', 'nicaragua': '尼加拉瓜', 'niger': '尼日尔',
  'nigeria': '尼日利亚', 'north korea': '朝鲜', 'north macedonia': '北马其顿', 'norway': '挪威', 'oman': '阿曼',
  'pakistan': '巴基斯坦', 'palau': '帕劳', 'panama': '巴拿马', 'papua new guinea': '巴布亚新几内亚', 'paraguay': '巴拉圭',
  'peru': '秘鲁', 'philippines': '菲律宾', 'poland': '波兰', 'portugal': '葡萄牙', 'qatar': '卡塔尔', 'romania': '罗马尼亚',
  'russia': '俄罗斯', 'rwanda': '卢旺达', 'saint kitts and nevis': '圣基茨和尼维斯', 'saint lucia': '圣卢西亚',
  'saint vincent and the grenadines': '圣文森特和格林纳丁斯', 'samoa': '萨摩亚', 'san marino': '圣马力诺',
  'sao tome and principe': '圣多美和普林西比', 'saudi arabia': '沙特阿拉伯', 'senegal': '塞内加尔', 'serbia': '塞尔维亚',
  'seychelles': '塞舌尔', 'sierra leone': '塞拉利昂', 'singapore': '新加坡', 'slovakia': '斯洛伐克', 'slovenia': '斯洛文尼亚',
  'solomon islands': '所罗门群岛', 'somalia': '索马里', 'south africa': '南非', 'south korea': '韩国', 'south sudan': '南苏丹',
  'spain': '西班牙', 'sri lanka': '斯里兰卡', 'sudan': '苏丹', 'suriname': '苏里南', 'sweden': '瑞典', 'switzerland': '瑞士',
  'syria': '叙利亚', 'tajikistan': '塔吉克斯坦', 'tanzania': '坦桑尼亚', 'thailand': '泰国', 'timor-leste': '东帝汶',
  'togo': '多哥', 'tonga': '汤加', 'trinidad and tobago': '特立尼达和多巴哥', 'tunisia': '突尼斯', 'turkey': '土耳其',
  'turkmenistan': '土库曼斯坦', 'tuvalu': '图瓦卢', 'uganda': '乌干达', 'ukraine': '乌克兰', 'united arab emirates': '阿联酋',
  'united kingdom': '英国', 'united states': '美国', 'uruguay': '乌拉圭', 'uzbekistan': '乌兹别克斯坦', 'vanuatu': '瓦努阿图',
  'venezuela': '委内瑞拉', 'vietnam': '越南', 'yemen': '也门', 'zambia': '赞比亚', 'zimbabwe': '津巴布韦'
};
const ALLOWED_COUNTRIES = Object.keys(COUNTRY_TRANSLATIONS);
const COUNTRY_ALIASES = {
  usa: 'united states',
  'united states of america': 'united states',
  us: 'united states',
  america: 'united states',
  uk: 'united kingdom',
  'great britain': 'united kingdom',
  uae: 'united arab emirates',
  'south korea': 'south korea',
  'republic of korea': 'south korea',
  korea: 'south korea',
  'north korea': 'north korea',
  'czech republic': 'czechia',
  'ivory coast': "cote d'ivoire",
  'drc': 'congo',
  'democratic republic of the congo': 'congo',
  'congo-brazzaville': 'congo',
  'congo brazzaville': 'congo'
};
const ALLOWED_COUNTRY_SET = new Set(ALLOWED_COUNTRIES.map(normalizeCountryKey));
const COUNTRY_ALIAS_MAP = (() => {
  const acc = {};
  Object.entries(COUNTRY_ALIASES).forEach(([k, v]) => {
    acc[normalizeCountryKey(k)] = normalizeCountryKey(v);
  });
  Object.entries(COUNTRY_TRANSLATIONS).forEach(([en, zh]) => {
    acc[normalizeCountryKey(zh)] = normalizeCountryKey(en);
  });
  return acc;
})();

function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (let iface in interfaces) {
    for (let alias of interfaces[iface]) {
      if (alias.family === 'IPv4' && !alias.internal) {
        if (alias.address.startsWith('192.168')) {
          return alias.address;
        }
        else {
          return alias.address;
        }
      }
    }
  }
  return '0.0.0.0';
}

function getClientIp(req) {
  try {
    const xff = req.headers && req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length > 0) {
        return parts[0];
      }
    }
    const rawIp =
      (req.ip) ||
      (req.connection && req.connection.remoteAddress) ||
      (req.socket && req.socket.remoteAddress) ||
      (req.connection && req.connection.socket && req.connection.socket.remoteAddress) ||
      '';
    if (typeof rawIp === 'string' && rawIp.startsWith('::ffff:')) {
      return rawIp.slice(7);
    }
    return rawIp || '';
  } catch (_) {
    return '';
  }
}

const host = getLocalIPAddress();

app.get('/api/ip', (req, res) => {
  res.json({ ip: host, port: PORT });
});

const AUTH_SKIP_PATHS = new Set(['/api/login', '/api/register', '/login', '/register']);

function requireApiKey(req, res, next) {
  if (AUTH_SKIP_PATHS.has(req.path)) return next();
  if (!API_KEY) {
    return next();
  }

  const requestKey = req.header('x-api-key') || req.query.api_key;

  if (requestKey && requestKey === API_KEY) {
    return next();
  }

  return res.status(401).json({ error: 'Invalid or missing API key' });
}

function requireAuthToken(req, res, next) {
  if (AUTH_SKIP_PATHS.has(req.path)) return next();
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || req.query.token || '';
  const verified = verifySessionToken(token);
  if (!verified) {
    return res.status(401).json({ error: 'Invalid or missing auth token' });
  }
  req.user = { username: verified.username, issuedAt: verified.issuedAt };
  return next();
}

function requireApiKeyOrAuthToken(req, res, next) {
  if (AUTH_SKIP_PATHS.has(req.path)) return next();

  // API key 通过则放行
  if (API_KEY) {
    const requestKey = req.header('x-api-key') || req.query.api_key;
    if (requestKey && requestKey === API_KEY) {
      return next();
    }
  }

  // Bearer token 通过则放行
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || req.query.token || '';
  const verified = verifySessionToken(token);
  if (verified) {
    req.user = { username: verified.username, issuedAt: verified.issuedAt };
    return next();
  }

  return res.status(401).json({ error: 'Invalid or missing API key or auth token' });
}

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=315360000'); // 缓存 10 年
  next();
});

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: AWS_REGION
});

// 中间件
app.use(bodyParser.json());
app.use(cors({
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
  optionsSuccessStatus: 204
}));

// API key 或登录 token 任一通过即可（登录/注册跳过）
app.use('/api', requireApiKeyOrAuthToken);

// Geo API keys 提供给前端（已受 API key / token 保护）
app.get('/api/geo-keys', (req, res) => {
  const keys = loadGeoKeys();
  try {
    console.info('[GeoKeys][server] send', {
      hasAmapKey: !!keys.amapKey,
      hasOpenCageKey: !!keys.openCageKey,
      hasGeoapifyKey: !!keys.geoapifyKey,
      hasLocationIqKey: !!keys.locationIqKey,
      hasMapQuestKey: !!keys.mapQuestKey,
      hasPositionstackKey: !!keys.positionstackKey
    });
  } catch (_) {}
  res.json(keys);
});

// 辅助函数：连接到正确的数据库
async function connectToDatabase(country) {
  const params = {
    Bucket: DATA_BUCKET,
    Key: `${country}.db`,
  };

  try {
    const data = await s3.getObject(params).promise();
    if (!data.Body) {
      throw new Error('S3 getObject response does not contain Body');
    }

    const dbPath = path.join(__dirname, `${country}.db`);
    fs.writeFileSync(dbPath, data.Body);  // 确保只写入文件内容
    const db = new sqlite3.Database(dbPath);
    return db;
  } catch (error) {
    console.error('从S3读取数据库出错:', error.message);
    return null;
  }
}

// 工具：读取某表的列集合（小写）
function getTableColumns(db, tableName) {
  return new Promise((resolve) => {
    try {
      db.all(`PRAGMA table_info(${tableName})`, [], (err, rows) => {
        if (err || !Array.isArray(rows)) return resolve(new Set());
        const set = new Set(rows.map(r => String(r.name || '').toLowerCase()));
        resolve(set);
      });
    } catch (_) {
      resolve(new Set());
    }
  });
}

// 从S3读取图片并转换为Base64
async function getImageFromS3(imageKey) {
  const params = {
    Bucket: DATA_BUCKET,
    Key: imageKey
  };

  try {
    const data = await s3.getObject(params).promise();
    return data.Body.toString('base64');
  } catch (error) {
    console.error('从S3读取图片出错:', error.message);
    return null;
  }
}

function getUserKey(username) {
  const safe = encodeURIComponent(String(username));
  const prefix = USER_PREFIX.endsWith('/') ? USER_PREFIX : `${USER_PREFIX}/`;
  return `${prefix}${safe}.json`;
}

async function getUserFromS3(username) {
  if (!username) return null;
  const Key = getUserKey(username);
  try {
    const data = await s3.getObject({ Bucket: USER_BUCKET, Key }).promise();
    const body = data.Body ? data.Body.toString('utf-8') : '';
    return body ? JSON.parse(body) : null;
  } catch (err) {
    if (err && (err.code === 'NoSuchKey' || err.code === 'NotFound' || err.statusCode === 404)) {
      return null;
    }
    console.error('读取用户失败:', err.message || err);
    throw err;
  }
}

// 列出所有用户（用于邮箱/手机号匹配登录）
async function listAllUsersFromS3() {
  const prefix = USER_PREFIX.endsWith('/') ? USER_PREFIX : `${USER_PREFIX}/`;
  const users = [];
  let ContinuationToken = undefined;
  try {
    do {
      const resp = await s3.listObjectsV2({
        Bucket: USER_BUCKET,
        Prefix: prefix,
        ContinuationToken
      }).promise();
      const contents = Array.isArray(resp.Contents) ? resp.Contents : [];
      for (const item of contents) {
        const key = item.Key;
        if (!key || !key.endsWith('.json')) continue;
        try {
          const obj = await s3.getObject({ Bucket: USER_BUCKET, Key: key }).promise();
          const body = obj.Body ? obj.Body.toString('utf-8') : '';
          if (body) users.push(JSON.parse(body));
        } catch (err) {
          console.error('读取用户列表项失败:', key, err && err.message ? err.message : err);
        }
      }
      ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (ContinuationToken);
  } catch (err) {
    console.error('列出用户失败:', err && err.message ? err.message : err);
    return [];
  }
  return users;
}

async function saveUserToS3(userItem) {
  const Key = getUserKey(userItem.username);
  const body = JSON.stringify(userItem);
  await s3.putObject({
    Bucket: USER_BUCKET,
    Key,
    Body: body,
    ContentType: 'application/json',
    ACL: 'private'
  }).promise();
}

function createSessionToken(username) {
  const issuedAt = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${username}:${issuedAt}:${nonce}`;
  const signature = crypto.createHmac('sha256', AUTH_TOKEN_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${signature}`)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function verifySessionToken(token) {
  if (!token) return null;
  try {
    const raw = Buffer.from(
      token.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf-8');
    const parts = raw.split(':');
    if (parts.length !== 4) return null;
    const [username, issuedAtStr, nonce, signature] = parts;
    const payload = `${username}:${issuedAtStr}:${nonce}`;
    const expected = crypto.createHmac('sha256', AUTH_TOKEN_SECRET)
      .update(payload)
      .digest('hex');
    if (expected !== signature) return null;
    const issuedAt = Number(issuedAtStr);
    if (!Number.isFinite(issuedAt)) return null;
    if (SESSION_TTL_MS > 0 && Date.now() - issuedAt > SESSION_TTL_MS) {
      return null;
    }
    return { username, issuedAt };
  } catch (_) {
    return null;
  }
}

function normalizeCountryKey(val) {
  return String(val || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCountry(val) {
  if (!val) return '';
  const key = normalizeCountryKey(val);
  if (COUNTRY_ALIAS_MAP[key]) return COUNTRY_ALIAS_MAP[key];
  if (ALLOWED_COUNTRY_SET.has(key)) return key;
  return '';
}


// 连接到MongoDB
/*mongoose.connect('mongodb://localhost:27017/vue-auth', {})
  .then(() => console.log('MongoDB 连接成功'))
  .catch(err => console.log(err));*/

// 获取所有景点的region
app.get('/api/regions/:country', async (req, res) => {
  const country = req.params.country;
  try {
    console.log(`连接到 ${country} 的数据库...`);
    const db = await connectToDatabase(country);
    if (!db) {
      throw new Error('数据库连接失败');
    }
    console.log('数据库连接成功。');

    db.all('SELECT DISTINCT region FROM attractions', [], (err, rows) => {
      if (err) {
        console.error('查询数据库出错: ' + err.message);
        return res.status(500).json({ error: err.message });
      }

      const regions = rows.map(row => row.region);
      res.json(regions);

      db.close((err) => {
        if (err) {
          console.error('关闭数据库连接时出错: ' + err.message);
        } else {
          console.log('数据库连接已关闭。');
        }
      });
    });
  } catch (error) {
    console.error('发生错误:', error.message);
    res.status(500).json({ error: error.message });
  }
});

//选择county内有的region
app.get('/api/regions/:country/:county', async (req, res) => {
  const country = req.params.country;
  const county = req.params.county;
  try {
    console.log(`连接到 ${country} 的数据库...`);
    const db = await connectToDatabase(country);
    if (!db) {
      throw new Error('数据库连接失败');
    }
    console.log('数据库连接成功。');

    db.all('SELECT DISTINCT region FROM attractions WHERE county = ?', county, (err, rows) => {
      if (err) {
        console.error('查询数据库出错: ' + err.message);
        return res.status(500).json({ error: err.message });
      }

      const regions = rows.map(row => row.region);
      res.json(regions);

      db.close((err) => {
        if (err) {
          console.error('关闭数据库连接时出错: ' + err.message);
        } else {
          console.log('数据库连接已关闭。');
        }
      });
    });
  } catch (error) {
    console.error('发生错误:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 获取所有景点的county
app.get('/api/countis/:country', async (req, res) => {
  const country = req.params.country;
  try {
    console.log(`连接到 ${country} 的数据库...`);
    const db = await connectToDatabase(country);
    if (!db) {
      throw new Error('数据库连接失败');
    }
    console.log('数据库连接成功。');

    db.all('SELECT DISTINCT county FROM attractions', [], (err, rows) => {
      if (err) {
        console.error('查询数据库出错: ' + err.message);
        return res.status(500).json({ error: err.message });
      }

      const countis = rows.map(row => row.county);
      res.json(countis);

      db.close((err) => {
        if (err) {
          console.error('关闭数据库连接时出错: ' + err.message);
        } else {
          console.log('数据库连接已关闭。');
        }
      });
    });
  } catch (error) {
    console.error('发生错误:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ✅ 获取指定国家所有景点的名称和id（用于搜索）
app.get('/api/attractions-names/:country', async (req, res) => {
  const country = req.params.country;
  try {
    const db = await connectToDatabase(country);
    if (!db) {
      throw new Error('数据库连接失败');
    }

    db.all('SELECT DISTINCT name, MIN(id) as id FROM attractions GROUP BY name ORDER BY name COLLATE NOCASE ASC', [], (err, rows) => {
      if (err) {
        console.error('查询数据库出错:', err.message);
        return res.status(500).json({ error: err.message });
      }

      res.json(rows);
      db.close((err) => {
        if (err) {
          console.error('关闭数据库连接出错:', err.message);
        } else {
          console.log('数据库连接已关闭。');
        }
      });
    });
  } catch (error) {
    console.error('发生错误:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 获取指定国家已过滤的景点名称和ID（支持 region 和 county）
app.get('/api/attractions-names-filtered/:country', async (req, res) => {
  const country = req.params.country;
  const region = req.query.region || '';
  const county = req.query.county || '';

  try {
    const db = await connectToDatabase(country);

    // 构建查询，只返回景点名称和相关标识
    let query = `SELECT DISTINCT name, region, MIN(id) as id FROM attractions WHERE 1=1`;
    const queryParams = [];

    if (county) {
      query += ' AND county = ?';
      queryParams.push(county);
    }

    if (region) {
      query += ' AND region = ?';
      queryParams.push(region);
    }

    // 确保GROUP BY包含所有非聚合字段
    query += ' GROUP BY name, region ORDER BY name COLLATE NOCASE ASC';

    db.all(query, queryParams, (err, rows) => {
      if (err) {
        console.error('查询数据库出错: ' + err.message);
        return res.status(500).json({ error: err.message });
      }

      res.json(rows);
      db.close((err) => {
        if (err) console.error(err.message);
      });
    });
  } catch (error) {
    res.status(500).json({ error: '数据库连接失败' });
  }
});

// 获取指定国家全部景点的原始位置信息（用于地图）
app.get('/api/attractions-positions/:country', async (req, res) => {
  const country = req.params.country;
  try {
  const db = await connectToDatabase(country);
  if (!db) throw new Error('数据库连接失败');
  const sql = `
    SELECT a.id, a.name, a.region, a.county, a.rating, a.positive_reviews, a.position, a.image1
    FROM attractions a
    INNER JOIN (
      SELECT name, region, MIN(id) AS min_id
      FROM attractions
      GROUP BY name, region
    ) g ON a.name = g.name AND a.region = g.region AND a.id = g.min_id
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const data = rows.map(r => ({
      id: r.id,
      name: r.name,
      region: r.region,
      county: r.county,
      rating: r.rating,
      positive_reviews: r.positive_reviews,
      position: r.position,
      hasImage: !!r.image1,
    }));
    res.json(data);
    db.close();
  });
  } catch (error) {
  res.status(500).json({ error: error.message });
  }
  });

  // 批量按 id 获取位置信息（收藏优化）
  app.post('/api/attractions-positions/:country/by-ids', async (req, res) => {
  const country = req.params.country;
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.json([]);

  try {
  const db = await connectToDatabase(country);
  if (!db) throw new Error('数据库连接失败');
  const placeholders = ids.map(() => '?').join(',');
  const sql = `SELECT id, name, region, county, rating, positive_reviews, position, image1
              FROM attractions WHERE id IN (${placeholders})`;
  db.all(sql, ids, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const data = rows.map(r => ({
      id: r.id,
      name: r.name,
      region: r.region,
      county: r.county,
      rating: r.rating,
      positive_reviews: r.positive_reviews,
      position: r.position,
      hasImage: !!r.image1,
    }));
    res.json(data);
    db.close();
  });
  } catch (error) {
  res.status(500).json({ error: error.message });
  }
  });





// 获取国家的景点（不包含图片）
app.get('/api/attractions/:country', async (req, res) => {
  const country = req.params.country;
  const minReviews = parseInt(req.query.minReviews) || 0;
  const order = req.query.order || 'rating_desc';
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = (page - 1) * limit;
  const region = req.query.region || '';
  const county = req.query.county || '';

  let orderByClause;
  if (order === 'rating_asc') {
    orderByClause = `
    CASE WHEN rating = '100%' THEN 1 ELSE 0 END DESC,
    CAST(REPLACE(rating, '%', '') AS REAL) ASC,
    total_reviews ASC
  `;
  } else if (order === 'rating_desc') {
    orderByClause =  `
    CASE WHEN rating = '100%' THEN 1 ELSE 0 END DESC,
    CAST(REPLACE(rating, '%', '') AS REAL) DESC,
    total_reviews DESC
  `;
  } else if (order === 'reviews_asc') {
    orderByClause = 'total_reviews ASC';
  } else if (order === 'reviews_desc') {
    orderByClause = 'total_reviews DESC';
  } else if (order === 'positive_asc') {
    orderByClause = 'positive_reviews ASC';
  } else if (order === 'positive_desc') {
    orderByClause = 'positive_reviews DESC';
  }

  try {
    const db = await connectToDatabase(country);

    let countQuery = `SELECT COUNT(DISTINCT name || '-' || region) as total FROM attractions WHERE total_reviews >= ?`;
    let dataQuery = `SELECT DISTINCT name, region, MIN(id) as id, image1, county, total_reviews, rating, positive_reviews FROM attractions WHERE total_reviews >= ?`;

    const queryParamsCount = [minReviews];
    const queryParamsData = [minReviews];

    if (region) {
      countQuery += ' AND region = ? ';
      dataQuery += ' AND region = ? ';
      queryParamsCount.push(region);
      queryParamsData.push(region);
    }

    if (county) {
      countQuery += ' AND county = ? ';
      dataQuery += ' AND county = ? ';
      queryParamsCount.push(county);
      queryParamsData.push(county);
    }

    dataQuery += ` GROUP BY name, region ORDER BY ${orderByClause} LIMIT ? OFFSET ? `;
    queryParamsData.push(limit, offset);

    db.get(countQuery, queryParamsCount, (err, countRow) => {
      if (err) {
        console.error('查询数据库出错 1: ' + err.message);
        return res.status(500).json({ error: err.message });
      }

      db.all(dataQuery, queryParamsData, async (err, rows) => {
        if (err) {
          console.error('查询数据库出错 2: ' + err.message);
          return res.status(500).json({ error: err.message });
        }

        rows.forEach((row) => {
          // 改为只返回图片索引或标志
          row.hasImage = !!row.image1;
          delete row.image1; // 不返回 base64 图片
        });


        res.json({
          total: countRow.total,
          data: rows
        });
        db.close((err) => {
          if (err) {
            console.error(err.message);
          }
          console.log('关闭数据库连接.');
        });
      });
    });
  } catch (error) {
    res.status(500).json({ error: '数据库连接失败' });
  }
});

// 获取单张景点图片（按编号）
app.get('/api/attraction-image/:country/:id/:index', async (req, res) => {
  const { country, id, index } = req.params;
  const imageKey = `${country}-${id}-image${index}.png`;

  try {
    const params = {
      Bucket: DATA_BUCKET,
      Key: imageKey,
    };
    const data = await s3.getObject(params).promise();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=315360000'); // 长期缓存
    res.send(data.Body);
  } catch (error) {
    console.error(`读取图片 ${imageKey} 出错:`, error.message);
    res.status(404).json({ error: 'Image not found' });
  }
});

// 获取景点详情（包含图片）
app.get('/api/attraction/:country/:id', async (req, res) => {
  const country = req.params.country;
  const id = req.params.id;
  try {
    const db = await connectToDatabase(country);
    // 兼容旧库：如果没有 lat/lng 列，则不在 SELECT 中包含
    const cols = await getTableColumns(db, 'attractions');
    const hasLatLng = cols.has('lat') && cols.has('lng');
    const baseFields = 'id, image1, image2, image3, name, region, county, overview, duration, details, position';
    const extra = hasLatLng ? ', lat, lng' : '';
    const tail = ', total_reviews, rating, positive_reviews, website';
    const sql = `SELECT ${baseFields}${extra}${tail} FROM attractions WHERE id = ?`;
    db.get(sql, [id], async (err, row) => {
      if (err) {
        console.error('查询数据库出错: ' + err.message);
        return res.status(500).json({ error: err.message });
      }

      if (row.image1) {
        row.hasImage1 = !!row.image1;
      }
      else row.hasImage1 = false;

      if (row.image2) {
        row.hasImage2 = !!row.image2;
      }
      else row.hasImage2 = false;

      if (row.image3) {
        row.hasImage3 = !!row.image3;
      }
      else row.hasImage3 = false;

      if (!hasLatLng) {
        // 旧库没有坐标列，确保返回字段存在但为 null，避免前端断言失败
        row.lat = null;
        row.lng = null;
      }
      console.log('从数据库中获取的行:', row);

      res.json(row);
      db.close((err) => {
        if (err) {
          console.error(err.message);
        }
        console.log('关闭数据库连接.');
      });
    });
  } catch (error) {
    res.status(500).json({ error: '数据库连接失败' });
  }
});

// 返回带经纬度的景点列表（仅返回有坐标的数据）
app.get('/api/attractions-geo/:country', async (req, res) => {
  const country = req.params.country;
  try {
    const db = await connectToDatabase(country);
    if (!db) throw new Error('数据库连接失败');
    const cols = await getTableColumns(db, 'attractions');
    const hasLatLng = cols.has('lat') && cols.has('lng');
    if (!hasLatLng) { db.close(); return res.json([]); }
    const sql = `
      SELECT a.id, a.name, a.region, a.county, a.rating, a.positive_reviews, a.total_reviews,
             a.lat, a.lng, a.image1
      FROM attractions a
      INNER JOIN (
        SELECT name, region, MIN(id) AS min_id
        FROM attractions
        WHERE lat IS NOT NULL AND lng IS NOT NULL
        GROUP BY name, region
      ) g ON a.name = g.name AND a.region = g.region AND a.id = g.min_id
      WHERE a.lat IS NOT NULL AND a.lng IS NOT NULL
    `;
    db.all(sql, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const data = rows.map(r => ({
        id: r.id,
        name: r.name,
        region: r.region,
        county: r.county,
        rating: r.rating,
        positive_reviews: r.positive_reviews,
        total_reviews: r.total_reviews,
        lat: typeof r.lat === 'string' ? parseFloat(r.lat) : r.lat,
        lng: typeof r.lng === 'string' ? parseFloat(r.lng) : r.lng,
        hasImage: !!r.image1,
        country,
      }));
      res.json(data);
      db.close();
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 批量按 id 返回经纬度（用于收藏/批量渲染）
app.post('/api/attractions-geo/:country/by-ids', async (req, res) => {
  const country = req.params.country;
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.json([]);

  try {
    const db = await connectToDatabase(country);
    if (!db) throw new Error('数据库连接失败');
    const cols = await getTableColumns(db, 'attractions');
    const hasLatLng = cols.has('lat') && cols.has('lng');
    if (!hasLatLng) { db.close(); return res.json([]); }
    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      SELECT id, name, region, county, rating, positive_reviews, total_reviews,
             lat, lng, image1
      FROM attractions
      WHERE id IN (${placeholders}) AND lat IS NOT NULL AND lng IS NOT NULL
    `;
    db.all(sql, ids, (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const data = rows.map(r => ({
        id: r.id,
        name: r.name,
        region: r.region,
        county: r.county,
        rating: r.rating,
        positive_reviews: r.positive_reviews,
        total_reviews: r.total_reviews,
        lat: typeof r.lat === 'string' ? parseFloat(r.lat) : r.lat,
        lng: typeof r.lng === 'string' ? parseFloat(r.lng) : r.lng,
        hasImage: !!r.image1,
        country,
      }));
      res.json(data);
      db.close();
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 用户注册路由（用户数据存 S3）
app.post(['/register', '/api/register'], async (req, res) => {
  const {
    username,
    password,
    confirmPassword,
    inviteCode,
    name = '',
    country = '',
    company = '',
    address = '',
    mobile = '',
    email = ''
  } = req.body || {};
  const clientIp = getClientIp(req);
  const userAgent = req.get && req.get('user-agent')
    ? req.get('user-agent')
    : (req.headers && req.headers['user-agent']) || '';

  if (!username || !password) {
    return res.status(400).json({ msg: '用户名和密码为必填项' });
  }

  if (!inviteCode) {
    return res.status(400).json({ msg: '邀请码为必填项' });
  }

  if (REGISTER_INVITE_CODE && inviteCode !== REGISTER_INVITE_CODE) {
    return res.status(400).json({ msg: '邀请码不正确' });
  }

  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.status(400).json({ msg: '两次输入的密码不一致' });
  }

  const normalizedCountry = normalizeCountry(country);
  if (!normalizedCountry) {
    return res.status(400).json({ msg: '国家不在允许列表' });
  }

  try {
    const existing = await getUserFromS3(username);
    if (existing) {
      return res.status(409).json({ msg: '用户已存在' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const now = new Date().toISOString();
    const userRecord = {
      username,
      passwordHash,
      name,
      country: normalizedCountry,
    company,
    address,
    mobile,
    email,
    registrationIp: clientIp,
    registrationUserAgent: userAgent,
    createdAt: now,
    updatedAt: now
  };

  await saveUserToS3(userRecord);

  const token = createSessionToken(username);
    const safeUser = {
      username,
      name: name || username,
      country: normalizedCountry,
      company,
      address,
    mobile,
    email
  };

  return res.status(201).json({ msg: '注册成功', token, user: safeUser });
  } catch (error) {
    console.error('注册失败:', error.message || error);
    return res.status(500).json({ msg: '注册失败，请稍后重试' });
  }
});

// 用户登录路由（从 S3 校验）
app.post(['/login', '/api/login'], async (req, res) => {
  const { username: rawIdentifier, password } = req.body || {};
  const identifier = (rawIdentifier || '').toString().trim();
  const identifierLower = identifier.toLowerCase();
  const plainDigits = identifier.replace(/[^\d]/g, '');

  if (!identifier || !password) {
    return res.status(400).json({ msg: '请提供用户名和密码' });
  }

  try {
    let user = await getUserFromS3(identifier);
    let loginUsername = identifier;

    // 如果按用户名找不到，则尝试按邮箱或手机号匹配，或大小写不一致的用户名
    if (!user) {
      const allUsers = await listAllUsersFromS3();
      const mobileExactMatches = [];
      const mobileSuffixMatches = [];

      for (const u of allUsers) {
        if (!u) continue;
        const uUsername = (u.username || '').toString();
        const uUsernameLower = uUsername.toLowerCase();

        // 0) 用户名大小写不敏感匹配
        if (uUsernameLower && uUsernameLower === identifierLower) {
          user = u;
          loginUsername = uUsername || identifier;
          break;
        }

        // 1) 邮箱精确匹配（不区分大小写）
        const email = (u.email || '').toString().trim().toLowerCase();
        if (email && identifierLower && email === identifierLower) {
          user = u;
          loginUsername = uUsername || identifier;
          break;
        }

        // 2) 手机号匹配
        const mobileRaw = (u.mobile || '').toString();
        const mobileDigits = mobileRaw.replace(/[^\d]/g, '');
        if (plainDigits && mobileDigits) {
          // 优先完全相等（去掉+等符号）
          if (mobileDigits === plainDigits) {
            mobileExactMatches.push({ user: u, loginUsername: uUsername || identifier });
            continue;
          }
          // 次优：结尾一致（去掉国家码），可能存在歧义
          if (mobileDigits.length >= plainDigits.length && mobileDigits.endsWith(plainDigits)) {
            mobileSuffixMatches.push({ user: u, loginUsername: uUsername || identifier });
          }
        }
      }

      if (!user) {
        if (mobileExactMatches.length >= 1) {
          const pick = mobileExactMatches[0];
          user = pick.user;
          loginUsername = pick.loginUsername;
        } else if (mobileSuffixMatches.length === 1) {
          const pick = mobileSuffixMatches[0];
          user = pick.user;
          loginUsername = pick.loginUsername;
        } else if (mobileSuffixMatches.length > 1) {
          return res.status(400).json({ msg: '手机号不唯一，请输入完整含国家码的手机号或使用邮箱/用户名登录' });
        }
      }
    }

    if (!user) {
      return res.status(400).json({ msg: '用户名或密码错误' });
    }

    const hash = user.passwordHash || user.password;
    const match = hash ? await bcrypt.compare(password, hash) : false;
    if (!match) {
      return res.status(400).json({ msg: '用户名或密码错误' });
    }

    const token = createSessionToken(loginUsername);
    const safeUser = {
      username: loginUsername,
      name: user.name || loginUsername,
      country: user.country || '',
      company: user.company || '',
      address: user.address || '',
      mobile: user.mobile || '',
      email: user.email || ''
    };

    return res.status(200).json({ msg: '登录成功', token, user: safeUser });
  } catch (error) {
    console.error('登录失败:', error.message || error);
    return res.status(500).json({ msg: '登录失败，请稍后重试' });
  }
});

app.listen(PORT, () => { console.log(`服务器正在端口 ${host}:${PORT} 上运行`); });
