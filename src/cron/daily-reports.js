const cron = require('node-cron');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const Call = require('../models/Call');
const { sendDailyReportToAdmin } = require('../services/email-service');
const logger = require('../../services/system-logger');
const { activeRecordFilter } = require('../webmaster/lifecycle');
const { getEffectiveRuntimeSettings } = require('../webmaster/settings-service');

async function sendReportsForTime(timeString) {
  try {
    // Find tenants whose dailyReportTime matches the current timeString (e.g., '19:00')
    const tenants = await Tenant.find({ dailyReportTime: timeString, status: 'active' });
    if (tenants.length === 0) return;

    // Get today's bounds
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    for (const tenant of tenants) {
      const settings = await getEffectiveRuntimeSettings(String(tenant._id));
      if (settings.featureFlags?.dailyReports === false) continue;
      // Find the CLIENT_ADMINs for this tenant
      const admins = await User.find({ tenantId: tenant._id, role: 'CLIENT_ADMIN', status: 'active' });
      if (admins.length === 0) continue;

      // Aggregate call stats for this tenant today
      const callsToday = await Call.find(activeRecordFilter({
        tenantId: tenant._id,
        created_at: { $gte: startOfDay, $lte: endOfDay }
      }));

      const totalCalls = callsToday.length;
      const successful = callsToday.filter(c => c.status === 'completed' || c.status === 'answered').length;
      const failed = totalCalls - successful;

      const reportData = { totalCalls, successful, failed };

      for (const admin of admins) {
        if (admin.email) {
          await sendDailyReportToAdmin(admin.email, tenant.name, reportData, { tenantId: String(tenant._id) });
        }
      }
      logger.info('CRON_DAILY_REPORT_SENT', { tenantId: tenant._id, tenantName: tenant.name, adminCount: admins.length });
    }
  } catch (error) {
    logger.error('CRON_DAILY_REPORT_ERROR', { code: 'DAILY_REPORT_DELIVERY_FAILED' });
  }
}

// Run every minute and check if it's the right time for any tenant
cron.schedule('* * * * *', () => {
  const now = new Date();
  const timeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  sendReportsForTime(timeString);
});
