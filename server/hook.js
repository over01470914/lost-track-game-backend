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

  const transporterContent = {
    host: cachedConfig.smtp.host,
    port: cachedConfig.smtp.port,
    secure: cachedConfig.smtp.secure,
    auth: {
      user: cachedConfig.smtp.user,
      pass: cachedConfig.smtp.pass,
    },
  };

  const transporter = nodemailer.createTransport(transporterContent);

  const mailOptions = {
    from: `"Analytics Bot" <${cachedConfig.smtp.user}>`,
    to: cachedConfig.receivers.join(", "),
    subject: subject,
    text: "htmlContent",
  };

  try {
    console.log("[Hook] Transporter created with:", transporterContent);
    console.log("[Hook] Mail options:", mailOptions);

    transporter.sendMail(mailOptions, function (error, info) {
      if (error) {
        console.error("[Hook] Failed to send email:", error);
      } else {
        console.log(`[Hook] Email sent successfully. ID: ${info.messageId}`);
      }
    });

    console.log(`[Hook] Email sent successfully.`);
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

// 1. [新增] 专门用于生成 HTML 报表的函数 (复用逻辑)
async function generateReportHtml() {
  if (!UserTracking) throw new Error("Database model not initialized");

  const now = new Date();

  // 定义时间窗口：模拟当前执行时的过去12小时 vs 再前12小时
  const currentEnd = now;
  const currentStart = new Date(now.getTime() - 12 * 60 * 60 * 1000);

  const prevEnd = currentStart;
  const prevStart = new Date(prevEnd.getTime() - 12 * 60 * 60 * 1000);

  // 获取数据
  const currentStats = await getStatsForPeriod(currentStart, currentEnd);
  const prevStats = await getStatsForPeriod(prevStart, prevEnd);

  // 计算差异
  const userDiff = currentStats.users - prevStats.users;
  const trackDiff = currentStats.tracks - prevStats.tracks;

  // 辅助样式函数
  const formatDiff = (val) => {
    const color = val >= 0 ? "green" : "red";
    const sign = val >= 0 ? "+" : "";
    return `<span style="color: ${color}; font-weight: bold;">${sign}${val}</span>`;
  };

  // 生成 HTML (这是你要的比对表格)
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
      <h2 style="color: #2c3e50;">📊 Analytics Report</h2>
      <p style="color: #7f8c8d; font-size: 14px;">
        Generated at: ${now.toLocaleString()}<br/>
        Period: Last 12 Hours
      </p>
      
      <table border="1" cellpadding="12" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; border-color: #eee;">
        <tr style="background-color: #f8f9fa;">
          <th style="text-align: left;">Metric</th>
          <th style="text-align: center;">Current Period</th>
          <th style="text-align: center;">Previous Period</th>
          <th style="text-align: center;">Change</th>
        </tr>
        <tr>
          <td><strong>👥 Active Users</strong></td>
          <td style="text-align: center; font-size: 16px;">${currentStats.users}</td>
          <td style="text-align: center; color: #999;">${prevStats.users}</td>
          <td style="text-align: center;">${formatDiff(userDiff)}</td>
        </tr>
        <tr>
          <td><strong>🖱️ Interactions</strong></td>
          <td style="text-align: center; font-size: 16px;">${currentStats.tracks}</td>
          <td style="text-align: center; color: #999;">${prevStats.tracks}</td>
          <td style="text-align: center;">${formatDiff(trackDiff)}</td>
        </tr>
      </table>
      
      <p style="margin-top: 20px; font-size: 12px; color: #aaa;">
        System Auto-generated Report.
      </p>
    </div>
  `;

  return html;
}

// 执行报表生成与发送
async function runScheduledReport() {
  try {
    const html = await generateReportHtml(); // 获取 HTML
    const now = new Date();
    await sendEmail(`📈 Scheduled Report [${now.getHours()}:00]`, html);
  } catch (error) {
    console.error("[Hook] Failed to run scheduled report:", error);
  }
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
    // 1. 先检查配置是否存在
    if (!cachedConfig || !cachedConfig.smtp.user) {
      return res.status(400).json({
        success: false,
        error: "SMTP config not found. Please save config first.",
      });
    }

    console.log("[Hook] Generating test report...");

    // 2. 生成真实的报表数据 (复用逻辑)
    const htmlContent = await generateReportHtml();

    // 3. 发送邮件 (标题加个 Test 前缀区分)
    await sendEmail("🧪 [TEST] Real Data Comparison Report", htmlContent);

    res.json({
      success: true,
      message: "Real comparison report sent to receivers!",
    });
  } catch (e) {
    console.error(e);
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
