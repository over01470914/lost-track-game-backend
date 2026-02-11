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
    // 总览指标
    total_users: Number,
    total_tracks: Number,

    // View Analytics (周期内)
    page_views: Number,
    unique_visitors: Number,
    new_users: Number,
    returning_users: Number,
    avg_duration: Number,

    // 用户质量
    retention_rate: Number,
    avg_page_depth: Number,

    // Interaction (参考数据)
    total_interactions: Number,
    avg_interaction_time: Number,
  },
  insights: {
    top_targets: Array,
    top_geo: Array,
    peak_hour: Object,
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
  const startTime = rangeStart || new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const dateQuery = { $gte: startTime, $lte: now };

  // ========== 1. 总览指标 (Total Overview) ==========
  const totalUsers = await UserTracking.countDocuments();
  const totalTracksAgg = await UserTracking.aggregate([
    { $group: { _id: null, count: { $sum: { $size: "$tracks" } } } },
  ]);
  const totalTracks = totalTracksAgg[0]?.count || 0;

  // ========== 2. View Analytics (周期内) ==========

  // PV (Page Views) - 所有 tracks 记录数
  const pvStats = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    { $match: { "tracks.created_at": dateQuery } },
    { $count: "total" },
  ]);
  const pageViews = pvStats[0]?.total || 0;

  // UV (Unique Visitors) - 去重 IP 数
  const uvList = await UserTracking.distinct("user_ip", {
    "tracks.created_at": dateQuery,
  });
  const uniqueVisitors = uvList.length;

  // 新用户数（首次访问在区间内的）
  const newUsers = await UserTracking.countDocuments({
    "profile.first_login": dateQuery,
  });

  const returningUsers = uniqueVisitors - newUsers;

  // 平均停留时长（基于用户维度）
  const durationStats = await UserTracking.aggregate([
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
  const avgDuration = durationStats[0]?.avg_duration
    ? Math.round(durationStats[0].avg_duration)
    : 0;

  // ========== 3. 用户质量指标 ==========

  // 回访率
  const returningCount = await UserTracking.countDocuments({
    $expr: { $gt: [{ $size: "$tracks" }, 1] },
  });
  const retentionRate =
    totalUsers > 0 ? ((returningCount / totalUsers) * 100).toFixed(1) : 0;

  // 页面深度
  const depthStats = await UserTracking.aggregate([
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
  const avgPageDepth = depthStats[0]?.avg_depth
    ? depthStats[0].avg_depth.toFixed(1)
    : 0;

  // ========== 4. Interaction Analytics (参考数据) ==========

  const interactionStats = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    { $match: { "tracks.created_at": dateQuery } },
    { $count: "total" },
  ]);
  const totalInteractions = interactionStats[0]?.total || 0;

  const interactionTimeStats = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    {
      $match: {
        "tracks.created_at": dateQuery,
        "tracks.stay_time": { $gt: 0 },
      },
    },
    { $group: { _id: null, avg: { $avg: "$tracks.stay_time" } } },
  ]);
  const avgInteractionTime = interactionTimeStats[0]?.avg
    ? Math.round(interactionTimeStats[0].avg)
    : 0;

  // ========== 5. Insights ==========

  // Top 5 组件
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

  // Top 5 地区（基于 UV）
  const activeIPs = await UserTracking.distinct("user_ip", {
    "tracks.created_at": dateQuery,
  });

  const topGeo = await UserTracking.aggregate([
    { $match: { user_ip: { $in: activeIPs } } },
    { $group: { _id: "$profile.location.country", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  // 访问高峰时段（修复：使用北京时间 UTC+8）
  const hourlyStats = await UserTracking.aggregate([
    { $unwind: "$tracks" },
    { $match: { "tracks.created_at": dateQuery } },
    {
      $addFields: {
        // 将 UTC 时间转换为北京时间（+8小时）
        beijing_hour: {
          $hour: {
            date: "$tracks.created_at",
            timezone: "+08:00",
          },
        },
      },
    },
    {
      $group: {
        _id: {
          hour: "$beijing_hour",
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
    { $sort: { unique_visitors: -1 } },
    { $limit: 1 },
  ]);

  const peakHour = hourlyStats[0] || { _id: 0, unique_visitors: 0 };

  return {
    raw: {
      // 总览
      total_users: totalUsers,
      total_tracks: totalTracks,

      // View Analytics
      page_views: pageViews,
      unique_visitors: uniqueVisitors,
      new_users: newUsers,
      returning_users: returningUsers,
      avg_duration: avgDuration,

      // 用户质量
      retention_rate: parseFloat(retentionRate),
      avg_page_depth: parseFloat(avgPageDepth),

      // Interaction
      total_interactions: totalInteractions,
      avg_interaction_time: avgInteractionTime,
    },
    insights: {
      targets: topTargets,
      geo: topGeo,
      peak_hour: peakHour,
    },
    range_start: startTime,
    range_end: now,
  };
}

// [核心] 生成暗色简约风格的专业报表 HTML
function generateDarkMinimalHtml(currentMetrics, prevSnapshot) {
  const c = currentMetrics.raw;
  const insights = currentMetrics.insights;

  // 如果没有上一次快照，对比数据设为 0
  const p = prevSnapshot
    ? prevSnapshot.metrics
    : {
        total_users: 0,
        total_tracks: 0,
        page_views: 0,
        unique_visitors: 0,
        new_users: 0,
        returning_users: 0,
        avg_duration: 0,
        retention_rate: 0,
        avg_page_depth: 0,
        total_interactions: 0,
        avg_interaction_time: 0,
      };

  // 辅助函数：计算变化并生成徽章
  const getDelta = (curr, prev) => {
    const diff = curr - prev;
    if (diff === 0) return '<span style="color:#64748b;">—</span>';
    const sign = diff > 0 ? "+" : "";
    const color = diff > 0 ? "#10b981" : "#ef4444";
    return `<span style="color:${color}; font-weight:600;">${sign}${diff}</span>`;
  };

  const getPercentDelta = (curr, prev) => {
    const diff = curr - prev;
    if (diff === 0) return '<span style="color:#64748b;">—</span>';
    const sign = diff > 0 ? "+" : "";
    const color = diff > 0 ? "#10b981" : "#ef4444";
    return `<span style="color:${color}; font-weight:600;">${sign}${diff.toFixed(1)}%</span>`;
  };

  // 辅助函数：生成 KPI 卡片
  const kpiCard = (label, value, delta, unit = "") => `
    <div style="background:#1e293b; border-radius:8px; padding:16px; text-align:center; border:1px solid #334155;">
      <div style="color:#94a3b8; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">${label}</div>
      <div style="color:#f1f5f9; font-size:24px; font-weight:700; margin-bottom:4px;">${value}${unit}</div>
      <div style="font-size:12px;">${delta}</div>
    </div>
  `;

  // 辅助函数：生成列表
  const generateList = (items, showCount = true) => {
    if (!items || items.length === 0) {
      return '<div style="color:#64748b; font-size:12px; padding:8px 0;">No data available</div>';
    }
    return items
      .map(
        (item, idx) => `
      <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #334155;">
        <span style="color:#cbd5e1; font-size:13px;">${idx + 1}. ${item._id || "Unknown"}</span>
        ${showCount ? `<span style="color:#f1f5f9; font-weight:600; font-size:13px;">${item.count}</span>` : ""}
      </div>
    `
      )
      .join("");
  };

  // 格式化时间
  const formatDate = (date) => {
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  };

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Analytics Report</title>
</head>
<body style="margin:0; padding:0; background-color:#0f172a; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  
  <div style="max-width:650px; margin:0 auto; background-color:#0f172a;">
    
    <!-- Header -->
    <div style="background:linear-gradient(135deg, #1e293b 0%, #0f172a 100%); padding:32px 24px; text-align:center; border-bottom:2px solid #3b82f6;">
      <div style="color:#3b82f6; font-size:32px; margin-bottom:8px;">📊</div>
      <h1 style="margin:0; color:#f1f5f9; font-size:28px; font-weight:700; letter-spacing:-0.5px;">Analytics Report</h1>
      <p style="margin:12px 0 0; color:#94a3b8; font-size:13px; font-weight:400;">
        ${formatDate(currentMetrics.range_start)} ~ ${formatDate(currentMetrics.range_end)}
      </p>
    </div>

    <!-- Content Container -->
    <div style="padding:24px;">

      <!-- Section 1: Total Overview -->
      <div style="margin-bottom:32px;">
        <h2 style="color:#3b82f6; font-size:14px; text-transform:uppercase; letter-spacing:1px; margin:0 0 16px; font-weight:600;">
          📈 Total Overview
        </h2>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          ${kpiCard("Total Users", c.total_users.toLocaleString(), getDelta(c.total_users, p.total_users))}
          ${kpiCard("Total Views", c.total_tracks.toLocaleString(), getDelta(c.total_tracks, p.total_tracks))}
        </div>
      </div>

      <!-- Section 2: View Analytics -->
      <div style="margin-bottom:32px;">
        <h2 style="color:#10b981; font-size:14px; text-transform:uppercase; letter-spacing:1px; margin:0 0 16px; font-weight:600;">
          👁️ View Analytics (Period)
        </h2>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
          ${kpiCard("Page Views (PV)", c.page_views.toLocaleString(), getDelta(c.page_views, p.page_views))}
          ${kpiCard("Unique Visitors (UV)", c.unique_visitors.toLocaleString(), getDelta(c.unique_visitors, p.unique_visitors))}
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px;">
          ${kpiCard("New Users", c.new_users.toLocaleString(), getDelta(c.new_users, p.new_users))}
          ${kpiCard("Returning", c.returning_users.toLocaleString(), getDelta(c.returning_users, p.returning_users))}
          ${kpiCard("Avg Duration", (c.avg_duration / 1000).toFixed(1), getDelta(c.avg_duration, p.avg_duration), "s")}
        </div>
      </div>

      <!-- Section 3: User Quality -->
      <div style="margin-bottom:32px;">
        <h2 style="color:#8b5cf6; font-size:14px; text-transform:uppercase; letter-spacing:1px; margin:0 0 16px; font-weight:600;">
          ⭐ User Quality
        </h2>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          ${kpiCard("Retention Rate", c.retention_rate.toFixed(1), getPercentDelta(c.retention_rate, p.retention_rate), "%")}
          ${kpiCard("Avg Page Depth", c.avg_page_depth, getDelta(parseFloat(c.avg_page_depth), parseFloat(p.avg_page_depth || 0)))}
        </div>
      </div>

      <!-- Section 4: Peak Hour Insight -->
      <div style="margin-bottom:32px;">
        <h2 style="color:#f59e0b; font-size:14px; text-transform:uppercase; letter-spacing:1px; margin:0 0 16px; font-weight:600;">
          ⏰ Peak Activity
        </h2>
        <div style="background:#1e293b; border-radius:8px; padding:20px; text-align:center; border:1px solid #334155;">
          <div style="color:#94a3b8; font-size:12px; margin-bottom:8px;">Most Active Hour</div>
          <div style="color:#f59e0b; font-size:36px; font-weight:700; margin-bottom:4px;">
            ${insights.peak_hour._id}:00
          </div>
          <div style="color:#cbd5e1; font-size:13px;">
            ${insights.peak_hour.unique_visitors} unique visitors
          </div>
        </div>
      </div>

      <!-- Section 5: Top Lists -->
      <div style="margin-bottom:32px;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;">
                    <!-- Top Targets -->
          <div>
            <h3 style="color:#f1f5f9; font-size:13px; margin:0 0 12px; font-weight:600; border-bottom:2px solid #3b82f6; padding-bottom:8px;">
              🔥 Top Components
            </h3>
            <div style="background:#1e293b; border-radius:8px; padding:12px; border:1px solid #334155;">
              ${generateList(insights.targets)}
            </div>
          </div>

          <!-- Top Geo -->
          <div>
            <h3 style="color:#f1f5f9; font-size:13px; margin:0 0 12px; font-weight:600; border-bottom:2px solid #10b981; padding-bottom:8px;">
              🌍 Top Regions
            </h3>
            <div style="background:#1e293b; border-radius:8px; padding:12px; border:1px solid #334155;">
              ${generateList(insights.geo)}
            </div>
          </div>

        </div>
      </div>

      <!-- Section 6: Interaction Analytics (Reference) -->
      <div style="margin-bottom:32px;">
        <h2 style="color:#64748b; font-size:14px; text-transform:uppercase; letter-spacing:1px; margin:0 0 16px; font-weight:600;">
          ⚡ Interaction Analytics (Reference)
        </h2>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          ${kpiCard("Total Interactions", c.total_interactions.toLocaleString(), getDelta(c.total_interactions, p.total_interactions))}
          ${kpiCard("Avg Interaction Time", (c.avg_interaction_time / 1000).toFixed(1), getDelta(c.avg_interaction_time, p.avg_interaction_time), "s")}
        </div>
        <div style="background:#1e293b; border-radius:8px; padding:12px; margin-top:12px; border:1px solid #334155;">
          <p style="color:#94a3b8; font-size:11px; margin:0; line-height:1.6;">
            ⚠️ Note: Interaction data may be inflated due to automated scripts or bots. 
            View Analytics (UV-based) provides more accurate user behavior insights.
          </p>
        </div>
      </div>

    </div>

    <!-- Footer -->
    <div style="background:#0f172a; padding:20px; text-align:center; border-top:1px solid #334155;">
      <p style="margin:0; color:#64748b; font-size:11px; line-height:1.6;">
        Automated Report from <strong style="color:#3b82f6;">Analytics Backend</strong><br>
        <a href="https://dashboard.lost-track.com" style="color:#3b82f6; text-decoration:none;">View Dashboard →</a>
      </p>
    </div>

  </div>

</body>
</html>
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
    const html = generateDarkMinimalHtml(currentMetrics, lastSnapshot);

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`;
    await sendEmail(`📊 Analytics Report [${timeStr}]`, html);

    const newSnapshot = new ReportSnapshot({
      timestamp: now,
      metrics: currentMetrics.raw,
      insights: currentMetrics.insights,
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

// 异常流量检测（增强版 - 基于 UV）
function startAnomalyDetection() {
  setInterval(async () => {
    if (!UserTracking) return;

    try {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);

      // 检测最近1分钟的独立访客数（更准确）
      const recentUV = await UserTracking.distinct("user_ip", {
        "tracks.created_at": { $gte: oneMinuteAgo },
      });

      const uvCount = recentUV.length;

      // 同时检测交互数（作为参考）
      const recentStats = await UserTracking.aggregate([
        { $unwind: "$tracks" },
        { $match: { "tracks.created_at": { $gte: oneMinuteAgo } } },
        { $count: "count" },
      ]);

      const interactionCount = recentStats[0]?.count || 0;

      // 如果 UV 超过阈值，或者交互数远超 UV（可能是刷量）
      if (
        uvCount > SPIKE_THRESHOLD ||
        (interactionCount > uvCount * 10 && uvCount > 10)
      ) {
        const now = Date.now();
        if (now - lastAlertTime > 3600 * 1000) {
          const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Traffic Alert</title>
</head>
<body style="margin:0; padding:0; background-color:#0f172a; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px; margin:0 auto; background-color:#1e293b; border:2px solid #ef4444; border-radius:12px; overflow:hidden;">
    
    <div style="background:#ef4444; padding:24px; text-align:center;">
      <div style="font-size:48px; margin-bottom:8px;">⚠️</div>
      <h1 style="margin:0; color:#fff; font-size:24px; font-weight:700;">High Traffic Alert</h1>
    </div>

    <div style="padding:32px 24px; color:#f1f5f9;">
      <h2 style="color:#fbbf24; font-size:18px; margin:0 0 16px;">Spike Detected!</h2>
      
      <div style="background:#0f172a; border-radius:8px; padding:20px; margin-bottom:20px; border:1px solid #334155;">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; text-align:center;">
          <div>
            <div style="color:#94a3b8; font-size:12px; margin-bottom:8px;">Unique Visitors</div>
            <div style="color:#ef4444; font-size:32px; font-weight:700;">${uvCount}</div>
          </div>
          <div>
            <div style="color:#94a3b8; font-size:12px; margin-bottom:8px;">Interactions</div>
            <div style="color:#f59e0b; font-size:32px; font-weight:700;">${interactionCount}</div>
          </div>
        </div>
      </div>

      <div style="background:#1e293b; border-left:4px solid #3b82f6; padding:16px; border-radius:4px; margin-bottom:20px;">
        <p style="margin:0; color:#cbd5e1; font-size:13px; line-height:1.6;">
          <strong style="color:#3b82f6;">Threshold:</strong> ${SPIKE_THRESHOLD} UV/min<br>
          <strong style="color:#3b82f6;">Time:</strong> ${new Date().toLocaleString("zh-CN", { hour12: false })}
        </p>
      </div>

      <p style="color:#94a3b8; font-size:13px; line-height:1.6; margin:0;">
        Please check server status and review recent activity logs. 
        This could indicate a DDoS attack, bot traffic, or legitimate viral growth.
      </p>
    </div>

    <div style="background:#0f172a; padding:16px; text-align:center; border-top:1px solid #334155;">
      <a href="https://dashboard.lost-track.com" style="display:inline-block; background:#3b82f6; color:#fff; padding:10px 24px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:600;">
        View Dashboard →
      </a>
    </div>

  </div>
</body>
</html>
          `;
          await sendEmail("⚠️ ALERT: Traffic Spike Detected", html);
          lastAlertTime = now;
          console.warn(
            `[Hook] High traffic alert sent! UV: ${uvCount}, Interactions: ${interactionCount}`
          );
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

    if (!config) {
      config = new SystemConfig({ key: "main_config" });
    }

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

    // 测试邮件使用过去12小时的数据
    const mockStartTime = new Date(Date.now() - 12 * 60 * 60 * 1000);

    const currentMetrics = await calculateMetrics(mockStartTime);
    const html = generateDarkMinimalHtml(currentMetrics, lastSnapshot);

    await sendEmail("🧪 [TEST] Analytics Report", html);

    res.json({ success: true, message: "Test report sent successfully!" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// [新增] 手动触发报表生成（用于调试）
router.post("/trigger-report", async (req, res) => {
  try {
    await runScheduledReport();
    res.json({ success: true, message: "Report generated and sent!" });
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

  // [新增] 初始化快照清理任务
  function startSnapshotCleanup() {
    // 每天凌晨 3:00 清理 30 天前的快照
    schedule.scheduleJob("0 3 * * *", async () => {
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const result = await ReportSnapshot.deleteMany({
          timestamp: { $lt: thirtyDaysAgo },
        });
        console.log(`[Cleanup] Deleted ${result.deletedCount} old snapshots.`);
      } catch (error) {
        console.error("[Cleanup] Error:", error);
      }
    });
  }

  mongoose.connection.once("open", () => {
    loadConfig();
    startAnomalyDetection();
    startSnapshotCleanup();
  });

  console.log("[Hook] Module initialized with enhanced metrics.");
};

module.exports = initHooks;

// --- END OF FILE hook.js ---
