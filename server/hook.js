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

// 报表快照
const ReportSnapshotSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  metrics: {
    total_users: Number, // 累计总用户
    total_tracks: Number, // 累计总交互
    new_users_delta: Number, // 周期内新增
    tracks_delta: Number, // 周期内交互量
    avg_stay_time: Number, // 周期内平均停留
    // active_users_delta 已移除
  },
});

const ReportSnapshot = mongoose.model("ReportSnapshot", ReportSnapshotSchema);

// ==========================================
// 2. 状态管理
// ==========================================
let UserTracking = null;
let cachedConfig = null;
let scheduledJobs = [];
const SPIKE_THRESHOLD = 200;
let lastAlertTime = 0;

// ==========================================
// 3. 核心功能函数
// ==========================================

async function loadConfig() {
  let config = await SystemConfig.findOne({ key: "main_config" });
  if (!config) {
    config = await new SystemConfig({
      receivers: [],
      report_times: ["00:00", "12:00"],
    }).save();
  }
  cachedConfig = config;
  console.log("[Hook] Configuration loaded.");
  refreshScheduler();
  return config;
}

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
    console.log(
      "[Hook] Sending email to:",
      cachedConfig.receivers.length,
      "recipients"
    );
    const info = await transporter.sendMail(mailOptions);
    console.log(
      `[Hook] ✅ Email sent successfully! Message ID: ${info.messageId}`
    );
  } catch (error) {
    console.error("[Hook] ❌ Failed to send email:", error);
    throw error;
  }
}

// [核心] 计算当前的各项指标
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

  // 2. 周期内新增用户 (New Users)
  const newUsersCount = await UserTracking.countDocuments({
    "profile.first_login": dateQuery,
  });

  // 3. 周期内交互量 (Interactions Delta)
  const tracksAgg = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    { $match: { "tracks.created_at": dateQuery } },
    { $count: "count" },
  ]);
  const tracksDelta = tracksAgg[0]?.count || 0;

  // 4. 周期内平均停留时长
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

  // 5. [Insight] Top 5 组件
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

  // 6. [Insight] Top 5 地区
  const topGeo = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    { $match: { "tracks.created_at": dateQuery } },
    { $group: { _id: "$profile.location.country", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  return {
    raw: {
      total_users: totalUsers,
      total_tracks: totalTracks,
      new_users_delta: newUsersCount,
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
        tracks_delta: 0,
        avg_stay_time: 0,
      };

  // 辅助：计算变化率和样式
  const getDiffHtml = (curr, prev, isTime = false) => {
    const diff = curr - prev;
    const sign = diff >= 0 ? "+" : "";
    const color = diff >= 0 ? "#16a34a" : "#dc2626"; // Green / Red
    const bg = diff >= 0 ? "#dcfce7" : "#fee2e2"; // Light Green / Light Red

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

  // 辅助：计算总量变化 (Total Diff)
  const getTotalDiffHtml = (currTotal, prevTotal) => {
    const diff = currTotal - prevTotal;
    const sign = diff >= 0 ? "+" : "";
    const color = diff >= 0 ? "green" : "red"; // Simple colors for inline
    return `<span style="color: ${color}; font-size: 12px; font-weight: bold;">(${sign}${diff})</span>`;
  };

  // 辅助：生成列表 HTML
  const generateList = (items) => {
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

  return `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      
      <!-- Header -->
      <div style="background-color: #0f172a; padding: 20px; text-align: center;">
        <h2 style="margin: 0; color: #ffffff; font-size: 24px;">📊 Analytics Report</h2>
        <p style="margin: 5px 0 0; color: #94a3b8; font-size: 13px;">
          ${currentMetrics.range_start.toLocaleString("zh-CN", { hour12: false })} ~ ${currentMetrics.range_end.toLocaleString("zh-CN", { hour12: false })}
        </p>
      </div>

      <!-- Section 1: Total Growth (Overview) -->
      <div style="padding: 20px 20px 10px 20px;">
        <h3 style="margin-top: 0; color: #3b82f6; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">📈 Total Overview Change</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="width: 50%; padding: 15px; background: #f1f5f9; border-radius: 8px; text-align: center; border-right: 4px solid #fff;">
              <div style="font-size: 13px; color: #64748b; margin-bottom: 5px;">TOTAL USERS</div>
              <div style="font-size: 24px; font-weight: 800; color: #0f172a;">${c.total_users.toLocaleString()}</div>
              <div style="margin-top:4px;">${getTotalDiffHtml(c.total_users, p.total_users)}</div>
            </td>
            <td style="width: 50%; padding: 15px; background: #f1f5f9; border-radius: 8px; text-align: center;">
              <div style="font-size: 13px; color: #64748b; margin-bottom: 5px;">TOTAL VIEWS</div>
              <div style="font-size: 24px; font-weight: 800; color: #0f172a;">${c.total_tracks.toLocaleString()}</div>
              <div style="margin-top:4px;">${getTotalDiffHtml(c.total_tracks, p.total_tracks)}</div>
            </td>
          </tr>
        </table>
      </div>

      <!-- Section 2: Period Activity -->
      <div style="padding: 10px 20px 20px 20px;">
        <h3 style="margin-top: 10px; color: #8b5cf6; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">🚀 Period Activity</h3>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="width: 33%; padding: 10px; background: #fafafa; border: 1px solid #f3f4f6; border-radius: 6px; text-align: center;">
              <div style="font-size: 12px; color: #64748b;">New Users</div>
              ${getDiffHtml(c.new_users_delta, p.new_users_delta)}
            </td>
            <td style="width: 33%; padding: 10px; background: #fafafa; border: 1px solid #f3f4f6; border-radius: 6px; text-align: center;">
              <div style="font-size: 12px; color: #64748b;">Interactions</div>
              ${getDiffHtml(c.tracks_delta, p.tracks_delta)}
            </td>
            <td style="width: 33%; padding: 10px; background: #fafafa; border: 1px solid #f3f4f6; border-radius: 6px; text-align: center;">
              <div style="font-size: 12px; color: #64748b;">Avg Stay Time</div>
              ${getDiffHtml(c.avg_stay_time, p.avg_stay_time, true)}
            </td>
          </tr>
        </table>
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

      <div style="text-align: center; padding: 10px; font-size: 11px; color: #cbd5e1; background-color: #0f172a;">
        Automated Report from Lost Track Backend
      <a href="https://dashboard.lost-track-game.com/" target="_blank" style="color: #4A88D4;">&emsp;&emsp;Link to Lost Track Dashboard</a>
      </div>

    </div>
  `;
}

// 执行报表生成与发送
async function runScheduledReport() {
  try {
    const lastSnapshot = await ReportSnapshot.findOne().sort({
      timestamp: -1,
    });

    const startTime = lastSnapshot
      ? lastSnapshot.timestamp
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

    const currentMetrics = await calculateMetrics(startTime);
    const html = generateProfessionalHtml(currentMetrics, lastSnapshot);

    const now = new Date();
    await sendEmail(`📈 Analytics Report [${now.getHours()}:00]`, html);

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

// 异常流量检测
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

router.get("/config", async (req, res) => {
  const config = await SystemConfig.findOne({ key: "main_config" });
  if (config) {
    res.json({ success: true, data: config });
  } else {
    res.json({ success: false, error: "Config not found" });
  }
});

router.post("/config", async (req, res) => {
  try {
    const { smtp, receivers, report_times } = req.body;
    let config = await SystemConfig.findOne({ key: "main_config" });

    config.smtp = smtp;
    config.receivers = receivers;
    config.report_times = report_times;

    await config.save();
    await loadConfig();

    res.json({ success: true, message: "Configuration saved." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: "Failed to save config" });
  }
});

router.post("/test-email", async (req, res) => {
  try {
    if (!cachedConfig || !cachedConfig.smtp.user) {
      return res.status(400).json({ success: false, error: "Config missing" });
    }

    const lastSnapshot = await ReportSnapshot.findOne().sort({
      timestamp: -1,
    });

    const mockStartTime = new Date(Date.now() - 12 * 60 * 60 * 1000);

    const currentMetrics = await calculateMetrics(mockStartTime);
    const html = generateProfessionalHtml(currentMetrics, lastSnapshot);

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

const initHooks = (app, userTrackingModel) => {
  UserTracking = userTrackingModel;

  app.use("/api/admin", router);

  mongoose.connection.once("open", () => {
    loadConfig();
    startAnomalyDetection();
  });

  console.log("[Hook] Module initialized.");
};

module.exports = initHooks;
