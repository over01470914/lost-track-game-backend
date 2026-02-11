// --- START OF FILE index.js ---

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const config = require("../config/database.js");
const https = require("https");
const rateLimit = require("express-rate-limit");

// [新增] 引入 Hook 模块
const initHooks = require("./hook");

// 创建限制规则
const trackLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: "Too many requests, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  // [修复] 显式设置 trustProxy 校验为 false，或者依靠下方的 app.set('trust proxy', 1)
  validate: { trustProxy: false },
});

const app = express();
const port = 3000;

const ADMIN_TOKEN = "WPWix32CBJpLYAKiHYsx";

// [修复] 修改 Trust Proxy 设置，解决报错并安全获取 IP
// 1 表示信任第一层代理 (Nginx)，这样 req.ip 依然准确，且 rate-limit 库不会报错
app.set("trust proxy", 1);

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
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// 权限校验中间件
const authGuard = (req, res, next) => {
  // 同时支持 X-Admin-Token 和 Authorization，优先读 X-Admin-Token
  // 注意：Express headers 都是小写的
  const clientToken =
    req.headers["x-admin-token"] || req.headers["authorization"];

  // 打印日志方便调试
  if (clientToken !== ADMIN_TOKEN) {
    console.warn(
      `[Auth] Failed. IP: ${req.ip}, Token received: ${clientToken}`
    );
  }

  if (clientToken === ADMIN_TOKEN) {
    next();
  } else {
    // 确保返回 403
    res
      .status(403)
      .json({ success: false, error: "Access Denied: Unauthorized" });
  }
};

// [新增] 初始化 Hooks (邮件、报表、配置接口)
// 这行代码必须在 authGuard, UserTracking 定义之后，app.listen 之前
initHooks(app, UserTracking);

// 获取用户真实IP
function getClientIP(req) {
  return (
    req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress
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

// 3. 管理员接口：增加 authGuard 保护
app.use("/api/admin", authGuard);

// 重置数据库接口（增强版 - 带详细日志）
app.delete("/api/admin/reset", async (req, res) => {
  try {
    const results = {
      usertracking_deleted: 0,
      snapshots_deleted: 0,
      config_preserved: true,
    };

    // 1. 删除用户追踪数据
    const userResult = await UserTracking.deleteMany({});
    results.usertracking_deleted = userResult.deletedCount;
    console.log(
      `[Reset] Deleted ${results.usertracking_deleted} user tracking records.`
    );

    // 2. 删除报表快照数据
    const ReportSnapshot = mongoose.model("ReportSnapshot");
    const snapshotResult = await ReportSnapshot.deleteMany({});
    results.snapshots_deleted = snapshotResult.deletedCount;
    console.log(
      `[Reset] Deleted ${results.snapshots_deleted} report snapshots.`
    );

    // 3. 可选：删除系统配置
    // 如果需要完全重置（包括邮件配置），取消下面的注释
    /*
    const SystemConfig = mongoose.model("SystemConfig");
    const configResult = await SystemConfig.deleteMany({});
    results.config_deleted = configResult.deletedCount;
    results.config_preserved = false;
    console.log(`[Reset] Deleted ${results.config_deleted} system configs.`);
    */

    res.status(200).json({
      success: true,
      message: "Database reset successfully",
      details: results,
    });
  } catch (error) {
    console.error("[Reset] Error resetting database:", error);
    res.status(500).json({
      success: false,
      error: "Server error",
      details: error.message,
    });
  }
});

// 打点接口
app.post("/api/track", trackLimiter, async (req, res) => {
  const {
    type,
    target,
    timestamp,
    page,
    stayTime,
    custom_created_at,
    mock_location,
  } = req.body;

  const user_ip = req.body.mock_ip || getClientIP(req);
  const recordTime = custom_created_at
    ? new Date(custom_created_at)
    : new Date();

  if (!type || !page) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });
  }

  try {
    let userTracking = await UserTracking.findOne({ user_ip });

    if (!userTracking) {
      let location;
      if (mock_location) {
        location = mock_location;
      } else {
        location = await getIPGeolocation(user_ip);
      }

      userTracking = new UserTracking({
        user_ip,
        profile: {
          location,
          first_login: recordTime,
          last_login: recordTime,
        },
        tracks: [],
      });
    } else {
      if (recordTime > userTracking.profile.last_login) {
        userTracking.profile.last_login = recordTime;
      }
    }

    let newData = {
      user_ip,
      location: userTracking.profile.location,
      event_type: type,
      event_target: target || "",
      timestamp: timestamp || Date.now(),
      page,
      stay_time: stayTime || 0,
      created_at: recordTime,
    };

    userTracking.tracks.push(newData);
    userTracking.updated_at = new Date();
    await userTracking.save();

    console.log("Tracking data saved:", newData);
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
  const { name = "test", age = 18, message = "Hello World" } = req.query;
  console.log("Test API called:", { ip: getClientIP(req) });
  res.status(200).json({
    success: true,
    message: "Test API called successfully",
    parameters: { name, age, message },
    serverTime: new Date().toISOString(),
    clientIP: getClientIP(req),
  });
});

// 数据分析接口
app.use("/api/stats", authGuard);

app.get("/api/stats/naked-data", async (req, res) => {
  try {
    const stats = await UserTracking.find().populate("tracks");
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/stats/timeline", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$tracks.created_at" },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/stats/targets", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.event_target": { $exists: true, $ne: "" } } },
      { $group: { _id: "$tracks.event_target", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/stats/staytime", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.stay_time": { $gt: 0 } } },
      { $group: { _id: null, avgTime: { $avg: "$tracks.stay_time" } } },
    ]);
    const avg = stats.length > 0 ? Math.round(stats[0].avgTime) : 0;
    res.status(200).json({ success: true, data: avg });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/stats/geolocation", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $match: { "profile.location.country": { $ne: "Unknown" } } },
      { $group: { _id: "$profile.location.country", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/stats/pages", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $group: { _id: "$tracks.page", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

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
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/stats/events", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $group: { _id: "$tracks.event_type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.status(200).json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/stats/overview", async (req, res) => {
  try {
    const totalUsers = await UserTracking.countDocuments();
    const totalTracks = await UserTracking.aggregate([
      { $group: { _id: null, count: { $sum: { $size: "$tracks" } } } },
    ]);
    const overview = {
      total_users: totalUsers,
      total_tracks: totalTracks[0]?.count || 0,
    };
    res.status(200).json({ success: true, data: overview });
  } catch (error) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// 辅助函数
function getDateRangeQuery(startStr, endStr) {
  const start = startStr ? new Date(startStr) : new Date();
  start.setHours(0, 0, 0, 0);
  const end = endStr ? new Date(endStr) : new Date();
  end.setHours(23, 59, 59, 999);
  return { $gte: start, $lte: end };
}

// 区间视图接口
app.get("/api/stats/daily/overview", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const dateQuery = getDateRangeQuery(startDate, endDate);
    const activeUsers = await UserTracking.distinct("user_ip", {
      "tracks.created_at": dateQuery,
    });
    const interactionStats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.created_at": dateQuery } },
      { $count: "total" },
    ]);
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
    res.json({
      success: true,
      data: {
        active_users: activeUsers.length,
        total_interactions: interactionStats[0]?.total || 0,
        avg_stay_time: timeStats[0]?.avg ? Math.round(timeStats[0].avg) : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.get("/api/stats/daily/geolocation", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $match: { "tracks.created_at": getDateRangeQuery(startDate, endDate) },
      },
      { $group: { _id: "$profile.location.country", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.get("/api/stats/daily/hourly", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $match: { "tracks.created_at": getDateRangeQuery(startDate, endDate) },
      },
      // 🔧 [修复] 添加时区转换为北京时间 (UTC+8)
      {
        $addFields: {
          beijing_hour: {
            $hour: {
              date: "$tracks.created_at",
              timezone: "+08:00", // 北京时间
            },
          },
        },
      },
      { $group: { _id: "$beijing_hour", count: { $sum: 1 } } }, // 使用转换后的小时
      { $sort: { _id: 1 } },
    ]);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

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
      { $group: { _id: "$tracks.event_target", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ===============================================
// 新增：View Analytics（真实访问统计）
// ===============================================

// 1. 区间内的 PV/UV 统计
app.get("/api/stats/daily/views", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const dateQuery = getDateRangeQuery(startDate, endDate);

    // PV (Page Views) - 所有 tracks 记录数
    const pvStats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.created_at": dateQuery } },
      { $count: "total" },
    ]);

    // UV (Unique Visitors) - 去重 IP 数
    const uvList = await UserTracking.distinct("user_ip", {
      "tracks.created_at": dateQuery,
    });

    // 新用户数（首次访问在区间内的）
    const newUsers = await UserTracking.countDocuments({
      "profile.first_login": dateQuery,
    });

    res.json({
      success: true,
      data: {
        page_views: pvStats[0]?.total || 0,
        unique_visitors: uvList.length,
        new_users: newUsers,
        returning_users: uvList.length - newUsers,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 2. 区间内的访问时段分布（基于 UV 而非 Interaction）
app.get("/api/stats/daily/visit-hourly", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const dateQuery = getDateRangeQuery(startDate, endDate);

    // 按小时统计独立访客数（通过 user_ip 去重）
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.created_at": dateQuery } },
      // 🔧 [修复] 添加时区转换为北京时间 (UTC+8)
      {
        $addFields: {
          beijing_hour: {
            $hour: {
              date: "$tracks.created_at",
              timezone: "+08:00", // 北京时间
            },
          },
        },
      },
      {
        $group: {
          _id: {
            hour: "$beijing_hour", // 使用转换后的小时
            user_ip: "$user_ip",
          },
        },
      },
      {
        $group: {
          _id: "$_id.hour",
          unique_visitors: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 3. 区间内的平均停留时长（基于用户维度）
app.get("/api/stats/daily/avg-duration", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const dateQuery = getDateRangeQuery(startDate, endDate);

    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $match: {
          "tracks.created_at": dateQuery,
          "tracks.stay_time": { $gt: 0 },
        },
      },
      {
        $group: {
          _id: "$user_ip",
          total_time: { $sum: "$tracks.stay_time" },
        },
      },
      {
        $group: {
          _id: null,
          avg_duration: { $avg: "$total_time" },
        },
      },
    ]);

    res.json({
      success: true,
      data: stats[0]?.avg_duration ? Math.round(stats[0].avg_duration) : 0,
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 4. 区间内的地理分布（基于 UV）
app.get("/api/stats/daily/geo-visitors", async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const dateQuery = getDateRangeQuery(startDate, endDate);

    // 获取在区间内有活动的所有用户
    const activeIPs = await UserTracking.distinct("user_ip", {
      "tracks.created_at": dateQuery,
    });

    // 统计这些用户的地理分布
    const stats = await UserTracking.aggregate([
      { $match: { user_ip: { $in: activeIPs } } },
      { $group: { _id: "$profile.location.country", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// ===============================================
// 新增：总览增强指标
// ===============================================

// 5. 用户活跃度分布（按访问次数分组）
app.get("/api/stats/user-engagement", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      {
        $project: {
          visit_count: { $size: "$tracks" },
        },
      },
      {
        $bucket: {
          groupBy: "$visit_count",
          boundaries: [1, 2, 5, 10, 20, 50, 100],
          default: "100+",
          output: {
            count: { $sum: 1 },
          },
        },
      },
    ]);

    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 6. 回访率统计
app.get("/api/stats/retention", async (req, res) => {
  try {
    const totalUsers = await UserTracking.countDocuments();
    const returningUsers = await UserTracking.countDocuments({
      $expr: { $gt: [{ $size: "$tracks" }, 1] },
    });

    res.json({
      success: true,
      data: {
        total: totalUsers,
        returning: returningUsers,
        rate:
          totalUsers > 0 ? ((returningUsers / totalUsers) * 100).toFixed(1) : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 7. 页面访问深度（平均每个用户访问的页面数）
app.get("/api/stats/page-depth", async (req, res) => {
  try {
    const stats = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $group: {
          _id: "$user_ip",
          unique_pages: { $addToSet: "$tracks.page" },
        },
      },
      {
        $project: {
          page_count: { $size: "$unique_pages" },
        },
      },
      {
        $group: {
          _id: null,
          avg_depth: { $avg: "$page_count" },
        },
      },
    ]);

    res.json({
      success: true,
      data: stats[0]?.avg_depth ? stats[0].avg_depth.toFixed(1) : 0,
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 高价值用户识别（访问次数 > 10 且停留时间 > 平均值）
app.get("/api/stats/high-value-users", async (req, res) => {
  try {
    const avgTime = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.stay_time": { $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: "$tracks.stay_time" } } },
    ]);

    const threshold = avgTime[0]?.avg || 0;

    const highValueUsers = await UserTracking.aggregate([
      {
        $project: {
          user_ip: 1,
          visit_count: { $size: "$tracks" },
          total_time: { $sum: "$tracks.stay_time" },
        },
      },
      {
        $match: {
          visit_count: { $gt: 10 },
          total_time: { $gt: threshold },
        },
      },
      { $count: "total" },
    ]);

    res.json({ success: true, data: highValueUsers[0]?.total || 0 });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 页面访问漏斗（首页 -> 详情页 -> 联系页）
app.get("/api/stats/funnel", async (req, res) => {
  try {
    const funnel = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $group: {
          _id: "$user_ip",
          pages: { $addToSet: "$tracks.page" },
        },
      },
      {
        $project: {
          visited_home: { $in: ["/", "$pages"] },
          visited_detail: { $in: ["/detail", "$pages"] },
          visited_contact: { $in: ["/contact", "$pages"] },
        },
      },
      {
        $group: {
          _id: null,
          step1: { $sum: { $cond: ["$visited_home", 1, 0] } },
          step2: { $sum: { $cond: ["$visited_detail", 1, 0] } },
          step3: { $sum: { $cond: ["$visited_contact", 1, 0] } },
        },
      },
    ]);

    res.json({ success: true, data: funnel[0] || {} });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 7日留存率
app.get("/api/stats/retention-7d", async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // 7天前注册的用户
    const cohort = await UserTracking.find({
      "profile.first_login": { $lte: sevenDaysAgo },
    }).select("user_ip");

    const cohortIPs = cohort.map((u) => u.user_ip);

    // 这些用户中，最近7天内有活动的
    const retained = await UserTracking.countDocuments({
      user_ip: { $in: cohortIPs },
      "profile.last_login": { $gte: sevenDaysAgo },
    });

    res.json({
      success: true,
      data: {
        cohort_size: cohortIPs.length,
        retained: retained,
        rate:
          cohortIPs.length > 0
            ? ((retained / cohortIPs.length) * 100).toFixed(1)
            : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

app.get("/api/stats/online-now", async (req, res) => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const online = await UserTracking.countDocuments({
      "profile.last_login": { $gte: fiveMinutesAgo },
    });

    res.json({ success: true, data: online });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 后端接口：对比上周同期数据
app.get("/api/stats/compare-last-week", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);

    const thisWeekData = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      { $match: { "tracks.created_at": { $gte: today } } },
      { $count: "total" },
    ]);

    const lastWeekData = await UserTracking.aggregate([
      { $unwind: "$tracks" },
      {
        $match: {
          "tracks.created_at": {
            $gte: lastWeek,
            $lt: today,
          },
        },
      },
      { $count: "total" },
    ]);

    const thisWeek = thisWeekData[0]?.total || 0;
    const lastWeekTotal = lastWeekData[0]?.total || 0;
    const change =
      lastWeekTotal > 0
        ? (((thisWeek - lastWeekTotal) / lastWeekTotal) * 100).toFixed(1)
        : 0;

    res.json({
      success: true,
      data: {
        this_week: thisWeek,
        last_week: lastWeekTotal,
        change_percent: change,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false });
  }
});

// 处理 404
app.get("*", (req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// 监听
app.listen(port, "127.0.0.1", () => {
  console.log(`Server running internally on port: ${port}`);
});
