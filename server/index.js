const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const config = require('../config/database.js');

const app = express();
const port = 3000;

// 连接数据库
mongoose.connect(config.mongodb.uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('Connected to MongoDB');
}).catch(err => {
    console.error('MongoDB connection error:', err);
});

// 定义数据模型
const TrackingSchema = new mongoose.Schema({
    user_ip: String,
    event_type: String,
    event_target: String,
    timestamp: Number,
    page: String,
    stay_time: Number,
    created_at: { type: Date, default: Date.now }
});

const Tracking = mongoose.model('Tracking', TrackingSchema);

// 中间件
app.use(cors({
    origin: '*', // 允许所有来源的请求
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// 获取用户真实IP
function getClientIP(req) {
    return req.headers['x-forwarded-for'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress || 
           req.connection.socket.remoteAddress;
}

// 打点接口
app.post('/api/track', (req, res) => {
    const { type, target, timestamp, page, stayTime } = req.body;
    const user_ip = getClientIP(req);

    // 验证数据
    if (!type || !timestamp || !page) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // 创建跟踪记录
    const trackingRecord = new Tracking({
        user_ip,
        event_type: type,
        event_target: target,
        timestamp,
        page,
        stay_time: stayTime
    });

    // 保存到数据库
    trackingRecord.save()
        .then(() => {
            res.status(200).json({ success: true });
        })
        .catch(err => {
            console.error('Save error:', err);
            res.status(500).json({ success: false, error: 'Server error' });
        });
});

// 健康检查接口
app.get('/api/health', (req, res) => {
    res.status(200).json({ success: true, message: 'Server is running' });
});

// 测试接口
app.get('/api/test', (req, res) => {
    // 获取查询参数，设置默认值
    const { name = 'test', age = 18, message = 'Hello World' } = req.query;
    
    // 输出日志
    console.log('Test API called with parameters:', {
        name,
        age,
        message,
        ip: getClientIP(req),
        timestamp: new Date().toISOString()
    });
    
    // 返回响应
    res.status(200).json({
        success: true,
        message: 'Test API called successfully',
        parameters: {
            name,
            age,
            message
        },
        serverTime: new Date().toISOString(),
        clientIP: getClientIP(req)
    });
});

// 处理所有其他请求，返回404错误
app.get('*', (req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});