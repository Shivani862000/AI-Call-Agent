const cron = require('node-cron');
const { sendDailyReportToAdmin } = require('../services/email-service');
const logger = require('../../services/system-logger');
const { getEffectiveRuntimeSettings } = require('../webmaster/settings-service');
const { supabase } = require('../supabase');

async function sendReportsForTime(timeString) {
  try {
    // Find tenants whose daily_report_time matches the current timeString (e.g., '19:00')
    const { data: tenants } = await supabase.from('tenants')
      .select('*')
      .eq('daily_report_time', timeString)
      .eq('status', 'active');
      
    if (!tenants || tenants.length === 0) return;

    // Get today's bounds
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    for (const tenant of tenants) {
      const settings = await getEffectiveRuntimeSettings(String(tenant.id));
      if (settings.featureFlags?.dailyReports === false) continue;
      
      // Find the CLIENT_ADMINs for this tenant
      const { data: admins } = await supabase.from('users')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('role', 'CLIENT_ADMIN')
        .eq('status', 'active');
        
      if (!admins || admins.length === 0) continue;

      // Aggregate call stats for this tenant today
      const { data: callsToday } = await supabase.from('calls')
        .select('status')
        .eq('tenant_id', tenant.id)
        .gte('created_at', startOfDay.toISOString())
        .lte('created_at', endOfDay.toISOString())
        .neq('status', 'archived');

      const totalCalls = callsToday ? callsToday.length : 0;
      const successful = callsToday ? callsToday.filter(c => c.status === 'completed' || c.status === 'answered').length : 0;
      const failed = totalCalls - successful;

      const reportData = { totalCalls, successful, failed };

      for (const admin of admins) {
        if (admin.email) {
          await sendDailyReportToAdmin(admin.email, tenant.name, reportData, { tenantId: String(tenant.id) });
        }
      }
      logger.info('CRON_DAILY_REPORT_SENT', { tenantId: tenant.id, tenantName: tenant.name, adminCount: admins.length });
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
