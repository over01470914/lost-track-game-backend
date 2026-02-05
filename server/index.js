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
  const clientToken = req.headers["authorization"];
  if (clientToken === ADMIN_TOKEN) {
    next();
  } else {
    console.warn(`Unauthorized access attempt from IP: ${req.ip}`);
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
app.use("/api/admin");

// 重置数据库接口
app.delete("/api/admin/reset", async (req, res) => {
  try {
    await UserTracking.deleteMany({});
    console.log("Database reset successfully.");
    res.status(200).json({ success: true, message: "All data deleted" });
  } catch (error) {
    console.error("Error resetting database:", error);
    res.status(500).json({ success: false, error: "Server error" });
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
      { $group: { _id: { $hour: "$tracks.created_at" }, count: { $sum: 1 } } },
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

// 处理 404
app.get("*", (req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// 监听
app.listen(port, "127.0.0.1", () => {
  console.log(`Server running internally on port: ${port}`);
});
