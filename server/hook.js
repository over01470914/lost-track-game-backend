// --- START OF FILE hook.js ---

const express = require("express");
const mongoose = require("mongoose");
const nodemailer = require("nodemailer");
const schedule = require("node-schedule");

const router = express.Router();

// ==========================================
// 1. 数据模型定义 (SystemConfig)
// ==========================================
const SystemConfigSchema = new mongoose.Schema({
  key: { type: String, default: "main_config", unique: true },
  smtp: {
    host: { type: String, default: "smtp.gmail.com" },
    port: { type: Number, default: 587 },
    secure: { type: Boolean, default: false },
    user: { type: String, default: "" },
    pass: { type: String, default: "" },
  },
  receivers: { type: [String], default: [] },
  report_times: { type: [String], default: ["00:00", "12:00"] },
});

const SystemConfig = mongoose.model("SystemConfig", SystemConfigSchema);

// ==========================================
// 2. 状态管理
// ==========================================
let UserTracking = null; // 将从 index.js 传入
let cachedConfig = null;
let scheduledJobs = [];
const SPIKE_THRESHOLD = 200; // 流量暴增阈值 (1分钟内)
let lastAlertTime = 0;

// ==========================================
// 3. 核心功能函数
// ==========================================

// 加载配置
async function loadConfig() {
  let config = await SystemConfig.findOne({ key: "main_config" });
  if (!config) {
    config = await new SystemConfig({
      receivers: [], // 默认空
      report_times: ["00:00", "12:00"],
    }).save();
  }
  cachedConfig = config;
  console.log("[Hook] Configuration loaded.");
  refreshScheduler();
  return config;
}

// 发送邮件通用函数
async function sendEmail(subject, htmlContent) {
  if (
    !cachedConfig ||
    !cachedConfig.smtp.user ||
    cachedConfig.receivers.length === 0
  ) {
    console.warn("[Hook] Email config missing or no receivers. Skipping.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: cachedConfig.smtp.host,
    port: cachedConfig.smtp.port,
    secure: cachedConfig.smtp.secure,
    auth: {
      user: cachedConfig.smtp.user,
      pass: cachedConfig.smtp.pass,
    },
  });

  try {
    await transporter.sendMail({
      from: `"Analytics Bot" <${cachedConfig.smtp.user}>`,
      to: cachedConfig.receivers.join(", "),
      subject: subject,
      html: htmlContent,
    });
    console.log(`[Hook] Email sent: ${subject}`);
  } catch (error) {
    console.error("[Hook] Failed to send email:", error);
  }
}

// 获取统计数据 (用于报表)
async function getStatsForPeriod(startTime, endTime) {
  const query = { $gte: startTime, $lte: endTime };

  const activeUsers = (
    await UserTracking.distinct("user_ip", {
      "tracks.created_at": query,
    })
  ).length;

  const interactions = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    { $match: { "tracks.created_at": query } },
    { $count: "total" },
  ]);

  return {
    users: activeUsers,
    tracks: interactions[0]?.total || 0,
  };
}

// 执行报表生成与发送
async function runScheduledReport() {
  if (!UserTracking) return;

  const now = new Date();
  // 当前周期：过去12小时 (根据你的需求，这里可以写死或者做成配置)
  const currentEnd = now;
  const currentStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);

  // 上个周期：再往前12小时
  const prevEnd = currentStart;
  const prevStart = new Date(prevEnd.getTime() - 12 * 60 * 60 * 1000);

  const currentStats = await getStatsForPeriod(currentStart, currentEnd);
  const prevStats = await getStatsForPeriod(prevStart, prevEnd);

  const userDiff = currentStats.users - prevStats.users;
  const trackDiff = currentStats.tracks - prevStats.tracks;

  const html = `
    <h2>📊 Analytics Report (${now.getHours()}:00)</h2>
    <p>Time Range: ${currentStart.toLocaleString()} - ${currentEnd.toLocaleString()}</p>
    <table border="1" cellpadding="10" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px;">
      <tr style="background-color: #f2f2f2;">
        <th>Metric</th>
        <th>Current (Last 12h)</th>
        <th>Previous (Prev 12h)</th>
        <th>Change</th>
      </tr>
      <tr>
        <td><strong>Active Users</strong></td>
        <td>${currentStats.users}</td>
        <td>${prevStats.users}</td>
        <td style="color: ${userDiff >= 0 ? "green" : "red"}"><strong>${userDiff >= 0 ? "+" : ""}${userDiff}</strong></td>
      </tr>
      <tr>
        <td><strong>Interactions</strong></td>
        <td>${currentStats.tracks}</td>
        <td>${prevStats.tracks}</td>
        <td style="color: ${trackDiff >= 0 ? "green" : "red"}"><strong>${trackDiff >= 0 ? "+" : ""}${trackDiff}</strong></td>
      </tr>
    </table>
  `;

  await sendEmail(`📈 Analytics Report [${now.getHours()}:00]`, html);
}

// 刷新定时任务调度
function refreshScheduler() {
  scheduledJobs.forEach((job) => job.cancel());
  scheduledJobs = [];

  if (!cachedConfig || !cachedConfig.report_times) return;

  console.log(
    `[Hook] Scheduling reports at: ${cachedConfig.report_times.join(", ")}`
  );

  cachedConfig.report_times.forEach((timeStr) => {
    // timeStr "14:30" -> cron "30 14 * * *"
    const [hour, minute] = timeStr.split(":");
    const cronRule = `${minute} ${hour} * * *`;

    const job = schedule.scheduleJob(cronRule, () => {
      console.log(`[Hook] Running scheduled task for ${timeStr}`);
      runScheduledReport();
    });

    if (job) scheduledJobs.push(job);
  });
}

// 异常流量检测 (每分钟)
function startAnomalyDetection() {
  setInterval(async () => {
    if (!UserTracking) return;

    try {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      const recentStats = await UserTracking.aggregate([
        { $unwind: "$tracks" },
        { $match: { "tracks.created_at": { $gte: oneMinuteAgo } } },
        { $count: "count" },
      ]);

      const count = recentStats[0]?.count || 0;

      if (count > SPIKE_THRESHOLD) {
        const now = Date.now();
        // 冷却时间 1小时
        if (now - lastAlertTime > 3600 * 1000) {
          const html = `
            <h1 style="color: red;">⚠️ High Traffic Warning</h1>
            <p><strong>Spike Detected!</strong></p>
            <p>Interactions in last 1 min: <strong>${count}</strong> (Threshold: ${SPIKE_THRESHOLD})</p>
            <p>Please check server status.</p>
          `;
          await sendEmail("⚠️ ALERT: Traffic Spike Detected", html);
          lastAlertTime = now;
          console.warn(`[Hook] High traffic alert sent! Count: ${count}`);
        }
      }
    } catch (error) {
      console.error("[Hook] Error in anomaly detection:", error);
    }
  }, 60 * 1000);
}

// ==========================================
// 4. API 路由定义
// ==========================================

// 获取配置
router.get("/config", async (req, res) => {
  const config = await SystemConfig.findOne({ key: "main_config" });
  if (config) {
    res.json({ success: true, data: config });
  } else {
    res.json({ success: false, error: "Config not found" });
  }
});

// 保存配置
router.post("/config", async (req, res) => {
  try {
    const { smtp, receivers, report_times } = req.body;
    let config = await SystemConfig.findOne({ key: "main_config" });

    config.smtp = smtp;
    config.receivers = receivers;
    config.report_times = report_times;

    await config.save();
    await loadConfig(); // 重新加载并刷新调度

    res.json({ success: true, message: "Configuration saved." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Failed to save config" });
  }
});

// 测试邮件
router.post("/test-email", async (req, res) => {
  try {
    await sendEmail(
      "🧪 Test Email",
      "<h1>It Works!</h1><p>Configuration is correct.</p>"
    );
    res.json({ success: true, message: "Test email sent" });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================
// 5. 导出初始化函数
// ==========================================

/**
 * 初始化 Hooks
 * @param {Express.Application} app - Express 实例
 * @param {Mongoose.Model} userTrackingModel - UserTracking 模型
 */
const initHooks = (app, userTrackingModel) => {
  UserTracking = userTrackingModel;

  // 注册路由 (挂载在 /api/admin 下)
  app.use("/api/admin", router);

  // 启动后台任务
  mongoose.connection.once("open", () => {
    loadConfig();
    startAnomalyDetection();
  });

  console.log("[Hook] Module initialized.");
};

module.exports = initHooks;
