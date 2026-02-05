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

// 报表快照：用于存储上一次发送时的统计数据，以便做精准比对
const ReportSnapshotSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  metrics: {
    total_users: Number, // 累计总用户
    total_tracks: Number, // 累计总交互
    new_users_delta: Number, // 周期内新增
    active_users_delta: Number, // 周期内活跃
    tracks_delta: Number, // 周期内交互量
    avg_stay_time: Number, // 周期内平均停留
  },
});

const ReportSnapshot = mongoose.model("ReportSnapshot", ReportSnapshotSchema);

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

  const isSecure = cachedConfig.smtp.port === 465;

  const transporterContent = {
    host: cachedConfig.smtp.host,
    port: cachedConfig.smtp.port,
    secure: isSecure,
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
    html: htmlContent,
  };

  try {
    console.log("[Hook] Transporter created with:", transporterContent);
    console.log("[Hook] Mail options:", mailOptions);

    const info = await transporter.sendMail(mailOptions);

    console.log(
      `[Hook] ✅ Email sent successfully! Message ID: ${info.messageId}`
    );

    // 如果是腾讯企业邮，通常 info.response 会包含 'Ok'
    console.log(`[Hook] Server response: ${info.response}`);
  } catch (error) {
    console.error("========================================");
    console.error("[Hook] ❌ Failed to send email.");
    console.error("Error Message:", error.message);
    console.error("Error Code:", error.code);
    console.error("Error Response:", error.response);
    console.error("========================================");
    // 这里抛出错误，以便前端能收到 500 错误提示
    throw error;
  }
}

// [核心] 计算当前的各项指标
// rangeStart: 如果传入，则计算该时间点之后的数据增量；如果不传，则计算全量
async function calculateMetrics(rangeStart = null) {
  if (!UserTracking) throw new Error("DB not initialized");

  const now = new Date();

  // 1. 全量数据 (Total Overview)
  const totalUsers = await UserTracking.countDocuments();
  const totalTracksAgg = await UserTracking.aggregate([
    { $group: { _id: null, count: { $sum: { $size: "$tracks" } } } },
  ]);
  const totalTracks = totalTracksAgg[0]?.count || 0;

  // 如果没有 rangeStart，说明是第一次运行，默认看过去24小时
  const startTime = rangeStart || new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateQuery = { $gte: startTime };

  // 2. 周期内活跃用户 (Active Users) - 在周期内有产生 track 的用户
  const activeUsersCount = (
    await UserTracking.distinct("user_ip", {
      "tracks.created_at": dateQuery,
    })
  ).length;

  // 3. 周期内新增用户 (New Users) - 首次登录时间在周期内
  const newUsersCount = await UserTracking.countDocuments({
    "profile.first_login": dateQuery,
  });

  // 4. 周期内交互量 (Interactions)
  const tracksAgg = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    { $match: { "tracks.created_at": dateQuery } },
    { $count: "count" },
  ]);
  const tracksDelta = tracksAgg[0]?.count || 0;

  // 5. 周期内平均停留时长
  const timeAgg = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    {
      $match: {
        "tracks.created_at": dateQuery,
        "tracks.stay_time": { $gt: 0 },
      },
    },
    { $group: { _id: null, avg: { $avg: "$tracks.stay_time" } } },
  ]);
  const avgTime = timeAgg[0]?.avg ? Math.round(timeAgg[0].avg) : 0;

  // 6. [Insight] Top 5 组件
  const topTargets = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    {
      $match: {
        "tracks.created_at": dateQuery,
        "tracks.event_target": { $ne: "" },
      },
    },
    { $group: { _id: "$tracks.event_target", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  // 7. [Insight] Top 5 地区
  // 注意：这里为了简化性能，我们统计活跃用户的地区，而不是每次交互的地区
  const topGeo = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    { $match: { "tracks.created_at": dateQuery } },
    { $group: { _id: "$profile.location.country", count: { $sum: 1 } } }, // 按交互量统计地区热度
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  return {
    raw: {
      total_users: totalUsers,
      total_tracks: totalTracks,
      new_users_delta: newUsersCount,
      active_users_delta: activeUsersCount,
      tracks_delta: tracksDelta,
      avg_stay_time: avgTime,
    },
    insights: {
      targets: topTargets,
      geo: topGeo,
    },
    range_start: startTime,
    range_end: now,
  };
}

// [核心] 生成专业报表 HTML
function generateProfessionalHtml(currentMetrics, prevSnapshot) {
  const c = currentMetrics.raw;
  // 如果没有上一次快照，对比数据设为 0
  const p = prevSnapshot
    ? prevSnapshot.metrics
    : {
        total_users: 0,
        total_tracks: 0,
        new_users_delta: 0,
        active_users_delta: 0,
        tracks_delta: 0,
        avg_stay_time: 0,
      };

  // 辅助：计算变化率和样式
  const getDiffHtml = (curr, prev, isTime = false) => {
    const diff = curr - prev;
    const sign = diff >= 0 ? "+" : "";
    const color = diff >= 0 ? "#16a34a" : "#dc2626"; // Green / Red
    const bg = diff >= 0 ? "#dcfce7" : "#fee2e2"; // Light Green / Light Red

    // 如果是时间，格式化一下
    const valStr = isTime
      ? (curr / 1000).toFixed(1) + "s"
      : curr.toLocaleString();

    return `
      <div style="font-size: 20px; font-weight: bold; color: #1f2937;">${valStr}</div>
      <div style="font-size: 12px; display: inline-block; padding: 2px 6px; border-radius: 4px; background-color: ${bg}; color: ${color}; font-weight: 600;">
        ${sign}${isTime ? (diff / 1000).toFixed(1) + "s" : diff}
      </div>
    `;
  };

  // 辅助：生成列表 HTML
  const generateList = (items, icon) => {
    if (!items || items.length === 0)
      return '<div style="color:#9ca3af; font-size:12px;">No data</div>';
    return items
      .map(
        (item, idx) => `
      <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #f3f4f6; padding: 8px 0;">
        <span style="color: #4b5563;">${idx + 1}. ${item._id || "Unknown"}</span>
        <span style="font-weight: bold; color: #111827;">${item.count}</span>
      </div>
    `
      )
      .join("");
  };

  // 计算人均交互 (Engagement Depth)
  const engagementRate =
    c.active_users_delta > 0
      ? (c.tracks_delta / c.active_users_delta).toFixed(1)
      : "0.0";

  return `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      
      <!-- Header -->
      <div style="background-color: #0f172a; padding: 20px; text-align: center;">
        <h2 style="margin: 0; color: #ffffff; font-size: 24px;">📊 Analytics Report</h2>
        <p style="margin: 5px 0 0; color: #94a3b8; font-size: 13px;">
          ${currentMetrics.range_start.toLocaleString("zh-CN", { hour12: false })} ~ ${currentMetrics.range_end.toLocaleString("zh-CN", { hour12: false })}
        </p>
      </div>

      <!-- Section 1: Growth (Cycle Metrics) -->
      <div style="padding: 20px;">
        <h3 style="margin-top: 0; color: #3b82f6; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">🚀 Period Growth (vs Last Report)</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="width: 33%; padding: 10px; background: #f8fafc; border-radius: 6px; text-align: center;">
              <div style="font-size: 12px; color: #64748b;">New Users</div>
              ${getDiffHtml(c.new_users_delta, p.new_users_delta)}
            </td>
            <td style="width: 33%; padding: 10px; background: #f8fafc; border-radius: 6px; text-align: center; border-left: 4px solid #fff;">
              <div style="font-size: 12px; color: #64748b;">Active Users</div>
              ${getDiffHtml(c.active_users_delta, p.active_users_delta)}
            </td>
            <td style="width: 33%; padding: 10px; background: #f8fafc; border-radius: 6px; text-align: center; border-left: 4px solid #fff;">
              <div style="font-size: 12px; color: #64748b;">Interactions</div>
              ${getDiffHtml(c.tracks_delta, p.tracks_delta)}
            </td>
          </tr>
        </table>
      </div>

      <!-- Section 2: Engagement & Quality -->
      <div style="padding: 0 20px 20px;">
        <h3 style="margin-top: 0; color: #8b5cf6; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">💎 Engagement Quality</h3>
        <div style="display: flex; gap: 10px;">
           <div style="flex: 1; padding: 15px; border: 1px solid #e5e7eb; border-radius: 6px;">
              <div style="font-size: 12px; color: #64748b;">Avg Stay Time</div>
              ${getDiffHtml(c.avg_stay_time, p.avg_stay_time, true)}
           </div>
           <div style="flex: 1; padding: 15px; border: 1px solid #e5e7eb; border-radius: 6px;">
              <div style="font-size: 12px; color: #64748b;">Interactions / User</div>
              <div style="font-size: 20px; font-weight: bold; color: #1f2937;">${engagementRate}</div>
              <div style="font-size: 11px; color: #9ca3af;">Depth of usage</div>
           </div>
        </div>
      </div>

      <!-- Section 3: Top Lists -->
      <div style="padding: 0 20px 20px;">
        <div style="display: flex; gap: 20px;">
          <div style="flex: 1;">
            <h4 style="margin: 0 0 10px; font-size: 13px; color: #475569; border-bottom: 2px solid #3b82f6; display: inline-block;">🔥 Top Targets</h4>
            ${generateList(currentMetrics.insights.targets)}
          </div>
          <div style="flex: 1;">
            <h4 style="margin: 0 0 10px; font-size: 13px; color: #475569; border-bottom: 2px solid #10b981; display: inline-block;">🌍 Top Regions</h4>
            ${generateList(currentMetrics.insights.geo)}
          </div>
        </div>
      </div>

      <!-- Section 4: All Time Overview -->
      <div style="background-color: #f1f5f9; padding: 15px 20px; border-top: 1px solid #e2e8f0;">
        <h3 style="margin: 0 0 10px; font-size: 12px; color: #64748b; text-transform: uppercase;">Total Overview (All Time)</h3>
        <div style="display: flex; justify-content: space-between;">
           <div>
             <span style="color: #64748b; font-size: 13px;">Total Users:</span>
             <strong style="color: #0f172a;">${c.total_users.toLocaleString()}</strong>
             <span style="font-size: 11px; color: ${c.total_users - p.total_users >= 0 ? "green" : "red"}">
               (${c.total_users - p.total_users >= 0 ? "+" : ""}${c.total_users - p.total_users})
             </span>
           </div>
           <div>
             <span style="color: #64748b; font-size: 13px;">Total Events:</span>
             <strong style="color: #0f172a;">${c.total_tracks.toLocaleString()}</strong>
           </div>
        </div>
      </div>

      <div style="text-align: center; padding: 10px; font-size: 11px; color: #cbd5e1; background-color: #0f172a;">
        Automated Report from Lost Track Backend
      </div>
    </div>
  `;
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
    // 1. 获取上一次的快照
    const lastSnapshot = await ReportSnapshot.findOne().sort({
      timestamp: -1,
    });

    // 2. 确定时间窗口：从上一次快照时间到现在
    // 如果是第一次运行，默认统计过去 24 小时
    const startTime = lastSnapshot
      ? lastSnapshot.timestamp
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 3. 计算当前数据
    const currentMetrics = await calculateMetrics(startTime);

    // 4. 生成 HTML
    const html = generateProfessionalHtml(currentMetrics, lastSnapshot);

    // 5. 发送邮件
    const now = new Date();
    await sendEmail(`📈 Analytics Report [${now.getHours()}:00]`, html);

    // 6. [关键] 发送成功后，保存当前数据为新的快照
    const newSnapshot = new ReportSnapshot({
      timestamp: now,
      metrics: currentMetrics.raw,
    });
    await newSnapshot.save();
    console.log("[Hook] Report snapshot saved.");
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
    if (!cachedConfig || !cachedConfig.smtp.user) {
      return res.status(400).json({ success: false, error: "Config missing" });
    }

    // 1. 获取上一次快照 (只读，不保存)
    const lastSnapshot = await ReportSnapshot.findOne().sort({
      timestamp: -1,
    });

    // 2. 为了测试效果，我们强制比对“过去12小时”的数据，而不是依赖上次快照的时间
    // 这样在测试时，你总能看到一些数据，而不是因为距离上次快照太近而全是0
    const mockStartTime = new Date(Date.now() - 12 * 60 * 60 * 1000);

    // 3. 计算 metrics
    const currentMetrics = await calculateMetrics(mockStartTime);

    // 4. 生成报表 (传入 lastSnapshot 以便计算变化量)
    const html = generateProfessionalHtml(currentMetrics, lastSnapshot);

    // 5. 发送 (注意：测试模式下，我们不保存新的 Snapshot，否则会打乱正常调度的数据流)
    await sendEmail("🧪 [TEST] Professional Analytics Report", html);

    res.json({ success: true, message: "Test report sent!" });
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
