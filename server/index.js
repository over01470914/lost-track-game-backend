const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const config = require('../config/database.js');
const fetch = require('node-fetch');

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

// 定义用户跟踪数据模型
const UserTrackingSchema = new mongoose.Schema({
    user_ip: { type: String, unique: true, required: true },
    profile: {
        location: {
            country: String,
            region: String,
            city: String
        },
        first_login: { type: Date, default: Date.now },
        last_login: { type: Date, default: Date.now }
    },
    tracks: [{
        event_type: String,
        event_target: String,
        timestamp: Number,
        page: String,
        stay_time: Number,
        created_at: { type: Date, default: Date.now }
    }],
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

const UserTracking = mongoose.model('UserTracking', UserTrackingSchema);

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

// 获取IP地理位置
async function getIPGeolocation(ip) {
    try {
        // 使用ipinfo.io的API，无需API密钥（有速率限制）
        const response = await fetch(`https://ipinfo.io/${ip}/json`);
        const data = await response.json();
        return {
            country: data.country || 'Unknown',
            region: data.region || 'Unknown',
            city: data.city || 'Unknown'
        };
    } catch (error) {
        console.error('Error getting geolocation:', error);
        return {
            country: 'Unknown',
            region: 'Unknown',
            city: 'Unknown'
        };
    }
}

// 打点接口
app.post('/api/track', async (req, res) => {
    console.log('Tracking API called with request body:', req.body);
    
    const { type, target, timestamp, page, stayTime } = req.body;
    const user_ip = getClientIP(req);
    console.log('Client IP:', user_ip);

    // 验证数据
    if (!type || !timestamp || !page) {
        console.log('Missing required fields:', { type, timestamp, page });
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    try {
        // 查找用户是否存在
        let userTracking = await UserTracking.findOne({ user_ip });

        if (!userTracking) {
            // 新用户，获取地理位置
            console.log('New user detected, getting geolocation...');
            const location = await getIPGeolocation(user_ip);
            console.log('Location info:', location);
            
            // 创建新用户记录
            userTracking = new UserTracking({
                user_ip,
                profile: {
                    location,
                    first_login: new Date(),
                    last_login: new Date()
                },
                tracks: []
            });
        } else {
            // 老用户，更新最后登录时间
            console.log('Returning user detected, updating last login time...');
            userTracking.profile.last_login = new Date();
        }

        // 添加新的打点记录
        console.log('Adding new tracking record...');
        userTracking.tracks.push({
            event_type: type,
            event_target: target,
            timestamp,
            page,
            stay_time: stayTime
        });

        // 更新时间戳
        userTracking.updated_at = new Date();

        // 保存到数据库
        await userTracking.save();
        
        console.log('Tracking data saved successfully for user:', user_ip);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error saving tracking data:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
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

// 数据分析接口

// 地理分布统计
app.get('/api/stats/geolocation', async (req, res) => {
    try {
        const stats = await UserTracking.aggregate([
            { $match: { 'profile.location.country': { $ne: 'Unknown' } } },
            { $group: {
                _id: '$profile.location.country',
                count: { $sum: 1 }
            }},
            { $sort: { count: -1 } }
        ]);
        console.log('Geolocation stats:', stats);
        res.status(200).json({ success: true, data: stats });
    } catch (error) {
        console.error('Error getting geolocation stats:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 页面访问统计
app.get('/api/stats/pages', async (req, res) => {
    try {
        const stats = await UserTracking.aggregate([
            { $unwind: '$tracks' },
            { $group: {
                _id: '$tracks.page',
                count: { $sum: 1 }
            }},
            { $sort: { count: -1 } }
        ]);
        console.log('Page stats:', stats);
        res.status(200).json({ success: true, data: stats });
    } catch (error) {
        console.error('Error getting page stats:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 用户活跃度统计
app.get('/api/stats/activity', async (req, res) => {
    try {
        const stats = await UserTracking.aggregate([
            { $project: {
                tracks_count: { $size: '$tracks' },
                last_login: '$profile.last_login',
                first_login: '$profile.first_login'
            }},
            { $sort: { tracks_count: -1 } }
        ]);
        console.log('Activity stats:', stats);
        res.status(200).json({ success: true, data: stats });
    } catch (error) {
        console.error('Error getting activity stats:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 事件类型统计
app.get('/api/stats/events', async (req, res) => {
    try {
        const stats = await UserTracking.aggregate([
            { $unwind: '$tracks' },
            { $group: {
                _id: '$tracks.event_type',
                count: { $sum: 1 }
            }},
            { $sort: { count: -1 } }
        ]);
        console.log('Event stats:', stats);
        res.status(200).json({ success: true, data: stats });
    } catch (error) {
        console.error('Error getting event stats:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 总览统计
app.get('/api/stats/overview', async (req, res) => {
    try {
        const totalUsers = await UserTracking.countDocuments();
        const totalTracks = await UserTracking.aggregate([
            { $group: {
                _id: null,
                count: { $sum: { $size: '$tracks' } }
            }}
        ]);
        
        const overview = {
            total_users: totalUsers,
            total_tracks: totalTracks[0]?.count || 0
        };
        
        console.log('Overview stats:', overview);
        res.status(200).json({ success: true, data: overview });
    } catch (error) {
        console.error('Error getting overview stats:', error);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// 处理所有其他请求，返回404错误
app.get('*', (req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});