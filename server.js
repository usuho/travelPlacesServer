const os = require('os');
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
  res.json({ ip: host, port: port });
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

// 辅助函数：连接到正确的数据库
async function connectToDatabase(country) {
  const params = {
    Bucket: 'travelplacesbucket',
    Key: `${country}.db`,
  };

 try {
  const data = await s3.getObject(params).promise();
  const dbPath = path.join(__dirname, `${country}.db`);
  fs.writeFileSync(dbPath, Buffer.from(data));
  const db = new sqlite3.Database(dbPath);
  return db;
 }catch (error) {
  console.error('从S3读取数据库出错:', error.message);
  return null;
}

  
}

// 从S3读取图片并转换为Base64
async function getImageFromS3(imageKey) {
  const params = {
    Bucket: 'travelplacesbucket',
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
mongoose.connect('mongodb://localhost:27017/vue-auth', {})
  .then(() => console.log('MongoDB 连接成功'))
  .catch(err => console.log(err));

// 获取所有景点的region
app.get('/regions/:country', async (req, res) => {
  const country = req.params.country;
  try {
    const db = await connectToDatabase(country);
    db.all('SELECT DISTINCT region FROM attractions', [], (err, rows) => {
      if (err) {
        console.error('查询数据库出错: ' + err.message);
        return res.status(500).json({ error: err.message });
      }

      const regions = rows.map(row => row.region);
      res.json(regions);
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

// 获取国家的景点（包含图片1）
app.get('/attractions/:country', async (req, res) => {
  const country = req.params.country;
  const minReviews = parseInt(req.query.minReviews) || 0;
  const order = req.query.order || 'rating_desc';
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = (page - 1) * limit;
  const region = req.query.region || '';

  let orderByClause;
  if (order === 'rating_asc') {
    orderByClause = 'rating ASC';
  } else if (order === 'rating_desc') {
    orderByClause = 'rating DESC';
  } else if (order === 'reviews_asc') {
    orderByClause = 'total_reviews ASC';
  } else if (order === 'reviews_desc') {
    orderByClause = 'total_reviews DESC';
  }

  try {
    const db = await connectToDatabase(country);

    let countQuery = `SELECT COUNT(*) as total FROM attractions WHERE total_reviews >= ?`;
    let dataQuery = `SELECT id, name, image1, region, total_reviews, rating FROM attractions WHERE total_reviews >= ?`;

    const queryParamsCount = [minReviews];
    const queryParamsData = [minReviews];

    if (region) {
      countQuery += ' AND region = ? ';
      dataQuery += ' AND region = ? ';
      queryParamsCount.push(region);
      queryParamsData.push(region);
    }

    dataQuery += ` ORDER BY ${orderByClause} LIMIT ? OFFSET ? `;
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

        for (const row of rows) {
          if (row.image1) {
            const imageKey = `${country}-${row.id}-image1.png`;
            console.log(imageKey);
            row.image1 = await getImageFromS3(imageKey);
          }
        }

        console.log('从数据库中获取的行:', rows);

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

// 获取景点详情（包含图片）
app.get('/attraction/:country/:id', async (req, res) => {
  const country = req.params.country;
  const id = req.params.id;
  try {
    const db = await connectToDatabase(country);
    db.get('SELECT id, image1, image2, image3, name, region, overview, duration, details, position, total_reviews, rating, positive_reviews, website FROM attractions WHERE id = ?', [id], async (err, row) => {
      if (err) {
        console.error('查询数据库出错: ' + err.message);
        return res.status(500).json({ error: err.message });
      }

      if (row.image1) {
        const imageKey1 = `${country}-${row.id}-image1.png`;
        row.image1 = await getImageFromS3(imageKey1);
      }
      if (row.image2) {
        const imageKey2 = `${country}-${row.id}-image2.png`;
        row.image2 = await getImageFromS3(imageKey2);
      }
      if (row.image3) {
        const imageKey3 = `${country}-${row.id}-image3.png`;
        row.image3 = await getImageFromS3(imageKey3);
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

// 用户注册路由
app.post('/register', async (req, res) => {
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
});

app.listen(PORT, () => { console.log(`服务器正在端口 ${host}:${PORT} 上运行`); });
