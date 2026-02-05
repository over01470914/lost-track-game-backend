const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const config = require("../config/database.js");
const https = require("https");
const nodemailer = require("nodemailer");

const rateLimit = require("express-rate-limit");

// 创建限制规则
const trackLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 15 分钟为一个周期
  max: 100, // 每个 IP 在上述周期内最多允许 100 次打点请求
  message: {
    success: false,
    error: "Too many requests, please try again later.",
  },
  standardHeaders: true, // 返回标准的 RateLimit 相关头
  legacyHeaders: false, // 禁用旧版头
});

const app = express();
const port = 3000;

const ADMIN_TOKEN = "WPWix32CBJpLYAKiHYsx";

// Hook配置
const HOOK_CONFIG = {
  email: {
    recipients: ["mingxun.xie@junkyardgames.com.cn"], // 接收报表的邮箱列表
    // schedule: "0 */12 * * *", // 每天0点、12点发送
    schedule: "0 */1 * * * *", // 每一分钟发送一次
  },
  alert: {
    threshold: 2.0, // 增长超过200%触发警告
    checkInterval: 1 * 60 * 1000, // 每1分钟检查一次
  },
};

// Nginx代理，这样 req.ip 就能直接拿到玩家真实 IP
app.set("trust proxy", true);

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

// 权限校验中间件：保护数据接口
const authGuard = (req, res, next) => {
  // 从请求头获取 token
  const clientToken = req.headers["authorization"];
  if (clientToken === ADMIN_TOKEN) {
    next(); // 校验通过
  } else {
    console.warn(`Unauthorized access attempt from IP: ${req.ip}`);
    res
      .status(403)
      .json({ success: false, error: "Access Denied: Unauthorized" });
  }
};

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

// ==========================================
// [新增功能 1] 重置数据库接口
// 警告：这将删除所有数据！建议在生产环境中增加密码验证
// ==========================================
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

// ==========================================
// [修改功能 2] 打点接口 (支持模拟数据注入)
// ==========================================
app.post("/api/track", trackLimiter, async (req, res) => {
  // 解构参数，新增 custom_created_at 和 mock_location
  const {
    type,
    target,
    timestamp,
    page,
    stayTime,
    custom_created_at,
    mock_location,
  } = req.body;

  // 如果传入了 mock_ip，则使用它，否则获取真实 IP
  const user_ip = req.body.mock_ip || getClientIP(req);

  // 确定记录的时间：如果有自定义时间（Python脚本传入），则使用自定义时间，否则使用当前时间
  const recordTime = custom_created_at
    ? new Date(custom_created_at)
    : new Date();

  // 验证基本数据
  if (!type || !page) {
    return res
      .status(400)
      .json({ success: false, error: "Missing required fields" });
  }

  try {
    let userTracking = await UserTracking.findOne({ user_ip });

    if (!userTracking) {
      // 新用户
      let location;

      // [关键修改] 如果请求体里带了 mock_location，直接使用，不再请求外部 API
      // 这对批量造数据非常重要，防止被 IP API 封锁
      if (mock_location) {
        location = mock_location;
      } else {
        location = await getIPGeolocation(user_ip);
      }

      userTracking = new UserTracking({
        user_ip,
        profile: {
          location,
          first_login: recordTime, // 使用记录时间
          last_login: recordTime,
        },
        tracks: [],
      });
    } else {
      // 老用户，更新最后登录时间 (比较时间，只更新更晚的时间)
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
      created_at: recordTime, // [关键] 使用自定义的历史时间
    };

    // 添加打点记录
    userTracking.tracks.push(newData);

    userTracking.updated_at = new Date();
    await userTracking.save();

    // 输出日志
    console.log("Tracking data saved:", newData);

    // 返回响应
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

// 所有以 /api/stats 开头的统计接口：全部增加 authGuard 保护
app.use("/api/stats", authGuard);

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

// ==========================================
// [Hook功能 1] 比对表格API接口
// ==========================================
app.get("/api/hook/comparison", async (req, res) => {
  try {
    const { hours = 12 } = req.query;
    const now = new Date();
    const previousTime = new Date(now.getTime() - hours * 60 * 60 * 1000);

    // 获取当前时间点的数据
    const currentData = await UserTracking.aggregate([
      {
        $group: {
          _id: null,
          total_users: { $sum: 1 },
          total_tracks: { $sum: { $size: "$tracks" } },
          avg_stay_time: { $avg: "$tracks.stay_time" },
        },
      },
    ]);

    // 获取前一个时间点的数据
    const previousData = await UserTracking.aggregate([
      {
        $match: {
          updated_at: { $lt: previousTime },
        },
      },
      {
        $group: {
          _id: null,
          total_users: { $sum: 1 },
          total_tracks: { $sum: { $size: "$tracks" } },
          avg_stay_time: { $avg: "$tracks.stay_time" },
        },
      },

      { $sort: { updated_at: -1 } },
      { $limit: 1 },
    ]);

    // 计算变化
    const comparison = {
      current: currentData[0] || {},
      previous: previousData[0] || {},
      changes: {},
    };

    if (
      comparison.current.total_users !== undefined &&
      comparison.previous.total_users !== undefined
    ) {
      comparison.changes.users =
        comparison.current.total_users - comparison.previous.total_users;
      comparison.changes.users_percent = (
        (comparison.changes.users / comparison.previous.total_users) *
        100
      ).toFixed(2);
    }

    if (
      comparison.current.total_tracks !== undefined &&
      comparison.previous.total_tracks !== undefined
    ) {
      comparison.changes.tracks =
        comparison.current.total_tracks - comparison.previous.total_tracks;
      comparison.changes.tracks_percent = (
        (comparison.changes.tracks / comparison.previous.total_tracks) *
        100
      ).toFixed(2);
    }

    if (
      comparison.current.avg_stay_time !== undefined &&
      comparison.previous.avg_stay_time !== undefined
    ) {
      comparison.changes.stay_time =
        comparison.current.avg_stay_time - comparison.previous.avg_stay_time;
      comparison.changes.stay_time_percent = (
        (comparison.changes.stay_time / comparison.previous.avg_stay_time) *
        100
      ).toFixed(2);
    }

    console.log("Comparison data:", comparison);
    res.status(200).json({ success: true, data: comparison });
  } catch (error) {
    console.error("Error getting comparison data:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// ==========================================
// [Hook功能 2] 定时任务发送报表邮件
// ==========================================
const sendEmailReport = async (data) => {
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.example.com", // 需要配置实际的SMTP服务器
      port: 587,
      secure: false,
      auth: {
        user: "your-email@example.com",
        pass: "your-password",
      },
    });

    const mailOptions = {
      from: "your-email@example.com",
      to: HOOK_CONFIG.email.recipients.join(", "),
      subject: "数据监控报表",
      html: `
        <h2>数据比对报表</h2>
        <p><strong>时间：</strong>${new Date().toLocaleString()}</p>
        <h3>数据变化</h3>
        <ul>
          <li>用户数变化：${data.changes.users} (${data.changes.users_percent}%)</li>
          <li>交互数变化：${data.changes.tracks} (${data.changes.tracks_percent}%)</li>
          <li>平均停留时间变化：${data.changes.stay_time}秒 (${data.changes.stay_time_percent}%)</li>
        </ul>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log("Email report sent successfully");
  } catch (error) {
    console.error("Error sending email:", error);
  }
};

// 定时任务：每天0点和12点发送报表
const scheduleEmailReports = () => {
  const schedule = HOOK_CONFIG.email.schedule;
  const [hours, minutes] = schedule.split(" ")[1].split(":").map(Number);

  const checkAndSend = async () => {
    const now = new Date();
    if (now.getHours() === hours && now.getMinutes() === minutes) {
      console.log(
        `Sending scheduled email report at ${now.toLocaleTimeString()}`
      );

      // 获取比对数据
      const response = await fetch(
        `http://127.0.0.1:${port}/api/hook/comparison?hours=12`
      );
      const comparisonData = await response.json();

      if (comparisonData.success) {
        await sendEmailReport(comparisonData.data);
      }
    }
  };

  // 每分钟检查一次是否到了发送时间
  setInterval(checkAndSend, 60 * 1000);
};

// ==========================================
// [Hook功能 3] 数据暴增监控和警告
// ==========================================
let previousStats = null;
const checkForAnomalies = async () => {
  try {
    // 获取当前统计数据
    const currentStats = await UserTracking.aggregate([
      {
        $group: {
          _id: null,
          total_users: { $sum: 1 },
          total_tracks: { $sum: { $size: "$tracks" } },
          avg_stay_time: { $avg: "$tracks.stay_time" },
        },
      },
    ]);

    const current = currentStats[0] || {};

    if (previousStats) {
      const previous = previousStats;
      const threshold = HOOK_CONFIG.alert.threshold;

      // 检查用户数暴增
      const userGrowth =
        (current.total_users - previous.total_users) / previous.total_users;
      if (userGrowth > threshold) {
        console.warn(
          `User count anomaly detected: ${userGrowth.toFixed(2)}% growth`
        );

        // 发送警告邮件
        await sendEmailReport({
          changes: {
            users: current.total_users - previous.total_users,
            users_percent: userGrowth.toFixed(2),
            tracks: current.total_tracks - previous.total_tracks,
            tracks_percent: (
              ((current.total_tracks - previous.total_tracks) /
                previous.total_tracks) *
              100
            ).toFixed(2),
            stay_time: current.avg_stay_time - previous.avg_stay_time,
            stay_time_percent: (
              ((current.avg_stay_time - previous.avg_stay_time) /
                previous.avg_stay_time) *
              100
            ).toFixed(2),
          },
          type: "warning",
          message: `检测到用户数暴增：${userGrowth.toFixed(2)}%`,
        });
      }

      // 检查交互数暴增
      const trackGrowth =
        (current.total_tracks - previous.total_tracks) / previous.total_tracks;
      if (trackGrowth > threshold) {
        console.warn(
          `Track count anomaly detected: ${trackGrowth.toFixed(2)}% growth`
        );

        // 发送警告邮件
        await sendEmailReport({
          changes: {
            users: current.total_users - previous.total_users,
            users_percent: (
              ((current.total_users - previous.total_users) /
                previous.total_users) *
              100
            ).toFixed(2),
            tracks: current.total_tracks - previous.total_tracks,
            tracks_percent: trackGrowth.toFixed(2),
            stay_time: current.avg_stay_time - previous.avg_stay_time,
            stay_time_percent: (
              ((current.avg_stay_time - previous.avg_stay_time) /
                previous.avg_stay_time) *
              100
            ).toFixed(2),
          },
          type: "warning",
          message: `检测到交互数暴增：${trackGrowth.toFixed(2)}%`,
        });
      }
    }

    // 更新上一次的统计数据
    previousStats = current;
  } catch (error) {
    console.error("Error checking for anomalies:", error);
  }
};

// 每5分钟检查一次数据异常
setInterval(checkForAnomalies, HOOK_CONFIG.alert.checkInterval);

// 处理所有其他请求，返回404错误
app.get("*", (req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

// 只监听 127.0.0.1
// 这样即便防火墙失效，公网 IP:3000 也无法建立连接，只有服务器内部的 Nginx 能访问
app.listen(port, "127.0.0.1", () => {
  console.log(`Server running internally on port: ${port}`);

  // 启动定时任务
  scheduleEmailReports();
  console.log("Email report scheduler started");
});
