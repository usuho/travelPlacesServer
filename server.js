
require('dotenv').config();
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
/*const mongoose = require('mongoose');*/
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

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

const host = getLocalIPAddress();

app.get('/api/ip', (req, res) => {
  res.json({ ip: host, port: PORT });
});

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return next();
  }

  const requestKey = req.header('x-api-key') || req.query.api_key;

  if (requestKey && requestKey === API_KEY) {
    return next();
  }

  return res.status(401).json({ error: 'Invalid or missing API key' });
}

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=315360000'); // 缓存 10 年
  next();
});

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'ap-northeast-1'
});

// 中间件
app.use(bodyParser.json());
app.use(cors({
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  credentials: true,
  optionsSuccessStatus: 204
}));

app.use('/api', requireApiKey);

// 辅助函数：连接到正确的数据库
async function connectToDatabase(country) {
  const params = {
    Bucket: 'travelplacesbucketjapan',
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
    Bucket: 'travelplacesbucketjapan',
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
      Bucket: 'travelplacesbucketjapan',
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

// 用户注册路由
/*app.post('/register', async (req, res) => {
  const { username, password } = req.body;

  const existingUser = await User.findOne({ username });
  if (existingUser) {
    return res.status(400).json({ msg: '用户已存在' });
  }

  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(password, salt);

  const newUser = new User({ username, password: hashedPassword });
  await newUser.save();
  res.status(201).json({ msg: '用户注册成功' });
});

// 用户登录路由
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const user = await User.findOne({ username });
  if (!user) {
    return res.status(400).json({ msg: '无效的凭证' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(400).json({ msg: '无效的凭证' });
  }

  res.status(200).json({ msg: '登录成功' });
});*/

app.listen(PORT, () => { console.log(`服务器正在端口 ${host}:${PORT} 上运行`); });
