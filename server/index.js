const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const config = require("../config/database.js");
const https = require("https");

const app = express();
const port = 3000;

// 连接数据库
mongoose
  .connect(config.mongodb.uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err);
  });

// 定义用户跟踪数据模型
const UserTrackingSchema = new mongoose.Schema({
  user_ip: { type: String, unique: true, required: true },
  profile: {
    location: {
      country: String,
      region: String,
      city: String,
    },
    first_login: { type: Date, default: Date.now },
    last_login: { type: Date, default: Date.now },
  },
  tracks: [
    {
      event_type: String,
      event_target: String,
      timestamp: Number,
      page: String,
      stay_time: Number,
      created_at: { type: Date, default: Date.now },
    },
  ],
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

const UserTracking = mongoose.model("UserTracking", UserTrackingSchema);

// 中间件
app.use(
  cors({
    origin: "*", // 允许所有来源的请求
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// 获取用户真实IP
function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.connection.socket.remoteAddress
  );
}

// 获取IP地理位置
async function getIPGeolocation(ip) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "ipinfo.io",
      path: `/${ip}/json`,
      method: "GET",
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          resolve({
            country: result.country || "Unknown",
            region: result.region || "Unknown",
            city: result.city || "Unknown",
          });
        } catch (error) {
          console.error("Error parsing geolocation data:", error);
          resolve({
            country: "Unknown",
            region: "Unknown",
            city: "Unknown",
          });
        }
      });
    });

    req.on("error", (error) => {
      console.error("Error getting geolocation:", error);
      resolve({
        country: "Unknown",
        region: "Unknown",
        city: "Unknown",
      });
    });

    req.end();
  });
}

// 打点接口
app.post("/api/track", async (req, res) => {
  console.log("Tracking API called with request body:", req.body);

  const { type, target, timestamp, page, stayTime } = req.body;
  const user_ip = getClientIP(req);
  console.log("Client IP:", user_ip);

  // 验证数据
  if (!type || !timestamp || !page) {
    console.log("Missing required fields:", { type, timestamp, page });
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });
  }

  try {
    // 查找用户是否存在
    let userTracking = await UserTracking.findOne({ user_ip });

    if (!userTracking) {
      // 新用户，获取地理位置
      console.log("New user detected, getting geolocation...");
      const location = await getIPGeolocation(user_ip);
      console.log("Location info:", location);

      // 创建新用户记录
      userTracking = new UserTracking({
        user_ip,
        profile: {
          location,
          first_login: new Date(),
          last_login: new Date(),
        },
        tracks: [],
      });
    } else {
      // 老用户，更新最后登录时间
      console.log("Returning user detected, updating last login time...");
      userTracking.profile.last_login = new Date();
    }

    // 添加新的打点记录
    console.log("Adding new tracking record...");
    userTracking.tracks.push({
      event_type: type,
      event_target: target,
      timestamp,
      page,
      stay_time: stayTime,
    });

    // 更新时间戳
    userTracking.updated_at = new Date();

    // 保存到数据库
    await userTracking.save();

    console.log("Tracking data saved successfully for user:", user_ip);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error saving tracking data:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 健康检查接口
app.get("/api/health", (req, res) => {
  res.status(200).json({ success: true, message: "Server is running" });
});

// 测试接口
app.get("/api/test", (req, res) => {
  // 获取查询参数，设置默认值
  const { name = "test", age = 18, message = "Hello World" } = req.query;

  // 输出日志
  console.log("Test API called with parameters:", {
    name,
    age,
    message,
    ip: getClientIP(req),
    timestamp: new Date().toISOString(),
  });

  // 返回响应
  res.status(200).json({
    success: true,
    message: "Test API called successfully",
    parameters: {
      name,
      age,
      message,
    },
    serverTime: new Date().toISOString(),
    clientIP: getClientIP(req),
  });
});

// 数据分析接口

// 直接拿到所有裸数据
app.get("/api/stats/naked-data", async (req, res) => {
  try {
    const stats = await UserTracking.find().populate("tracks");
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 时间趋势统计 (最近7天或30天的打点趋势)
app.get("/api/stats/timeline", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" }, // 展开数组，把每个 track 单独拿出来
      {
        $group: {
          // 按日期格式化分组 (YYYY-MM-DD)
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$tracks.created_at" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } }, // 按日期升序排列
    ]);
    console.log("Timeline stats:", stats);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error("Error getting timeline stats:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 1. 组件交互排行 (Event Target 统计)
app.get("/api/stats/targets", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      // 过滤掉空的 target
      { $match: { "tracks.event_target": { $exists: true, $ne: "" } } },
      {
        $group: {
          _id: "$tracks.event_target",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 }, // 只取前10名
    ]);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 2. 平均停留时长统计
app.get("/api/stats/staytime", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.stay_time": { $gt: 0 } } }, // 只统计大于0的时间
      {
        $group: {
          _id: null,
          avgTime: { $avg: "$tracks.stay_time" },
        },
      },
    ]);
    // 如果没有数据，返回 0
    const avg = stats.length > 0 ? Math.round(stats[0].avgTime) : 0;
    res.status(200).json({ success: true, data: avg });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 地理分布统计
app.get("/api/stats/geolocation", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $match: { "profile.location.country": { $ne: "Unknown" } } },
      {
        $group: {
          _id: "$profile.location.country",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);
    console.log("Geolocation stats:", stats);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error("Error getting geolocation stats:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 页面访问统计
app.get("/api/stats/pages", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $group: {
          _id: "$tracks.page",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);
    console.log("Page stats:", stats);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error("Error getting page stats:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 用户活跃度统计
app.get("/api/stats/activity", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      {
        $project: {
          tracks_count: { $size: "$tracks" },
          last_login: "$profile.last_login",
          first_login: "$profile.first_login",
        },
      },
      { $sort: { tracks_count: -1 } },
    ]);
    console.log("Activity stats:", stats);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error("Error getting activity stats:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 事件类型统计
app.get("/api/stats/events", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $group: {
          _id: "$tracks.event_type",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);
    console.log("Event stats:", stats);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error("Error getting event stats:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 总览统计
app.get("/api/stats/overview", async (req, res) => {
  try {
    const totalUsers = await UserTracking.countDocuments();
    const totalTracks = await UserTracking.aggregate([
      {
        $group: {
          _id: null,
          count: { $sum: { $size: "$tracks" } },
        },
      },
    ]);

    const overview = {
      total_users: totalUsers,
      total_tracks: totalTracks[0]?.count || 0,
    };

    console.log("Overview stats:", overview);
    res.status(200).json({ success: true, data: overview });
  } catch (error) {
    console.error("Error getting overview stats:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 辅助函数：构建日期查询范围 (处理 UTC 时区问题，这里简化为当天的起止)
function getDateRange(dateStr) {
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateStr);
  end.setHours(23, 59, 59, 999);
  return { $gte: start, $lte: end };
}

// --- 辅助函数：构建日期查询范围 (支持区间) ---
function getDateRangeQuery(startStr, endStr) {
  // 如果没有传日期，默认当天
  const start = startStr ? new Date(startStr) : new Date();
  start.setHours(0, 0, 0, 0);

  const end = endStr ? new Date(endStr) : new Date();
  end.setHours(23, 59, 59, 999);

  return { $gte: start, $lte: end };
}

// 1. [区间视图] 概览数据 (KPI) - 支持 start/end
app.get("/api/stats/daily/overview", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const dateQuery = getDateRangeQuery(startDate, endDate);

    // 1. 活跃用户 (在区间内有记录的去重IP)
    const activeUsers = await UserTracking.distinct("user_ip", {
      "tracks.created_at": dateQuery,
    });

    // 2. 总交互数 (Aggregation 更准确)
    const interactionStats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.created_at": dateQuery } },
      { $count: "total" },
    ]);
    const totalInteractions = interactionStats[0]?.total || 0;

    // 3. 平均停留时长
    const timeStats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $match: {
          "tracks.created_at": dateQuery,
          "tracks.stay_time": { $gt: 0 },
        },
      },
      { $group: { _id: null, avg: { $avg: "$tracks.stay_time" } } },
    ]);
    const avgTime = timeStats[0]?.avg ? Math.round(timeStats[0].avg) : 0;

    res.json({
      success: true,
      data: {
        active_users: activeUsers.length,
        total_interactions: totalInteractions,
        avg_stay_time: avgTime,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// 2. [区间视图] 地区分布
app.get("/api/stats/daily/geolocation", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    // 注意：为了性能，这里简化为查询用户最后更新时间在区间内的，或者也可以 unwind tracks 查精确的
    // 这里使用更精确的 unwind 方式，统计区间内产生的流量来源
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $match: { "tracks.created_at": getDateRangeQuery(startDate, endDate) },
      },
      // 这里需要关联 profile，因为 unwind 后 profile 在根节点
      {
        $group: {
          _id: "$profile.location.country",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// 3. [日视图] 小时级流量趋势 (更有意义的指标!)
app.get("/api/stats/daily/hourly", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $match: { "tracks.created_at": getDateRangeQuery(startDate, endDate) },
      },
      {
        $group: {
          _id: { $hour: "$tracks.created_at" },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// 4. [区间视图] 热门组件 (新增需求)
app.get("/api/stats/daily/targets", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $match: {
          "tracks.created_at": getDateRangeQuery(startDate, endDate),
          "tracks.event_target": { $exists: true, $ne: "" },
        },
      },
      {
        $group: {
          _id: "$tracks.event_target",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false });
  }
});

// 处理所有其他请求，返回404错误
app.get("*", (req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
