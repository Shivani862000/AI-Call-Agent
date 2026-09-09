'use strict';

/**
 * Renders the owner's daily digest as an HTML email with a plain-text
 * alternative.
 *
 * Formatting only -- it touches no database, so the whole layout is testable
 * from fixtures. The caller supplies the window's calls and feedback; see
 * services/reporting.js buildDigestCallReport.
 *
 * The email carries patient names and their own words about the service. It
 * deliberately carries no audio and no transcript text: those live behind the
 * console's login, and every link here points there.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Everything interpolated into the HTML is caller-spoken text. Escape it all. */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * Last four digits only. The inbox is the least controlled place this data
 * lands, and the full number is one click away in the console.
 */
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `+91 ••••• •${digits.slice(-4, -3)}${digits.slice(-3)}`;
}

function inZone(iso, timezone) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatTime(iso, timezone) {
  const date = inZone(iso, timezone);
  if (!date) return '';
  return date.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
}

function formatDay(iso, timezone) {
  const date = inZone(iso, timezone);
  if (!date) return '';
  return date.toLocaleDateString('en-GB', { timeZone: timezone, day: 'numeric', month: 'short' });
}

/** "3m 12s", or '' when the call never connected. */
function formatDuration(answeredAt, endedAt) {
  if (!answeredAt || !endedAt) return '';
  const seconds = Math.round((new Date(endedAt) - new Date(answeredAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

const ANSWERED_OUTCOMES = new Set([
  'completed', 'answered', 'callback', 'interested', 'hot_lead', 'consent_given', 'not_interested'
]);

function isAnswered(call) {
  return ANSWERED_OUTCOMES.has(String(call.outcome || '').toLowerCase()) || Boolean(call.answered_at);
}

function outcomeLabel(outcome) {
  const text = String(outcome || 'unknown').replace(/[_-]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const OUTCOME_TONE = {
  completed: { fg: '#15803d', bg: '#dcfce7' },
  answered: { fg: '#15803d', bg: '#dcfce7' },
  hot_lead: { fg: '#15803d', bg: '#dcfce7' },
  interested: { fg: '#15803d', bg: '#dcfce7' },
  callback: { fg: '#92400e', bg: '#fef3c7' },
  failed: { fg: '#b91c1c', bg: '#fee2e2' }
};

function tone(outcome) {
  return OUTCOME_TONE[String(outcome || '').toLowerCase()] || { fg: '#4b5563', bg: '#eef0f3' };
}

/**
 * Links are omitted entirely when PUBLIC_BASE_URL is unset: config falls back to
 * http://localhost:<port>, and a localhost link in the owner's inbox is worse
 * than no link.
 */
function callLink(baseUrl, callId, anchor) {
  if (!baseUrl || !callId) return '';
  return `${String(baseUrl).replace(/\/$/, '')}/feedback-analysis.html?callId=${callId}#${anchor}`;
}

function stars(count) {
  const value = Number(count);
  if (!Number.isFinite(value) || value <= 0) return '';
  const filled = Math.max(0, Math.min(5, Math.round(value)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

const CATEGORY_TONE = {
  good: '#16a34a',
  average: '#9ca3af',
  bad: '#dc2626'
};

// ── HTML ──────────────────────────────────────────────────────────────────────

function htmlCallCard(call, timezone, baseUrl) {
  const badge = tone(call.outcome);
  const duration = formatDuration(call.answered_at, call.ended_at);
  const meta = [`${formatDay(call.called_at, timezone)} ${formatTime(call.called_at, timezone)}`.trim(), duration, maskPhone(call.customer_phone)]
    .filter(Boolean).join(' · ');

  const transcript = call.has_transcript && callLink(baseUrl, call.id, 'transcriptSection');
  const recording = call.has_recording && callLink(baseUrl, call.id, 'recordingSection');

  const linkParts = [];
  if (transcript) {
    linkParts.push(`<a href="${esc(transcript)}" style="color:#1a56db;text-decoration:none;font-weight:600;">Transcript&nbsp;&rsaquo;</a>`);
  } else if (call.has_transcript) {
    linkParts.push('<span style="color:#4b5563;">Transcript available in the console</span>');
  } else {
    linkParts.push('<span style="color:#aab0ba;">No transcript</span>');
  }

  if (recording) {
    linkParts.push(`<a href="${esc(recording)}" style="color:#1a56db;text-decoration:none;font-weight:600;">Recording&nbsp;&rsaquo;</a>`);
  } else {
    linkParts.push('<span style="color:#aab0ba;">Recording not captured</span>');
  }

  const summary = String(call.summary || '').trim();

  return `
  <tr><td style="padding:10px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e9ee;border-radius:8px;">
      <tr><td style="padding:12px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:14px;font-weight:600;color:#12203a;">${esc(call.patient_name || 'Unnamed patient')}</td>
          <td align="right" style="font-size:11px;font-weight:600;color:${badge.fg};background:${badge.bg};border-radius:20px;padding:3px 9px;white-space:nowrap;">${esc(outcomeLabel(call.outcome))}</td>
        </tr></table>
        <div style="font-size:11px;color:#9199a6;margin-top:3px;">${esc(meta)}</div>
        ${summary ? `<div style="font-size:13px;color:#3f4855;line-height:1.5;margin-top:8px;">${esc(summary)}</div>` : ''}
        <div style="margin-top:10px;font-size:12px;">${linkParts.join('<span style="color:#d6dae0;padding:0 8px;">|</span>')}</div>
      </td></tr>
    </table>
  </td></tr>`;
}

function htmlFeedbackCard(item, timezone, baseUrl) {
  const accent = CATEGORY_TONE[String(item.category || '').toLowerCase()] || '#9ca3af';
  const rating = stars(item.stars);
  const link = callLink(baseUrl, item.call_id, 'transcriptSection');

  const right = rating
    ? `<span style="font-size:12px;color:#f59e0b;letter-spacing:1px;">${rating}</span>`
    : `<span style="font-size:11px;font-weight:600;color:${accent};">${esc(outcomeLabel(item.category || 'unrated'))}</span>`;

  const footer = link
    ? `<a href="${esc(link)}" style="color:#1a56db;text-decoration:none;font-weight:600;">Open call&nbsp;&rsaquo;</a>`
    : (item.call_id ? '' : '<span style="color:#aab0ba;">Not linked to a call</span>');

  return `
  <tr><td style="padding:8px 24px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${accent};background:#f8f9fa;border-radius:0 8px 8px 0;">
      <tr><td style="padding:11px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:13px;font-weight:600;color:#12203a;">${esc(item.patient_name || 'Anonymous')}${item.source && item.source !== 'call' ? ` <span style="font-weight:400;color:#9199a6;">· ${esc(item.source)}</span>` : ''}</td>
          <td align="right">${right}</td>
        </tr></table>
        ${item.review_text ? `<div style="font-size:13px;color:#3f4855;line-height:1.5;margin-top:6px;">“${esc(item.review_text)}”</div>` : ''}
        ${footer ? `<div style="margin-top:8px;font-size:12px;">${footer}</div>` : ''}
      </td></tr>
    </table>
  </td></tr>`;
}

function sectionHeading(label) {
  return `
  <tr><td style="padding:22px 24px 4px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8b93a1;">${esc(label)}</div>
  </td></tr>`;
}

function statCell(value, label) {
  return `<td width="25%" style="padding:8px 4px;">
    <div style="font-size:22px;font-weight:700;color:#12203a;line-height:1;">${esc(value)}</div>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">${esc(label)}</div>
  </td>`;
}

function renderHtml(data, parts) {
  const { timezone, baseUrl } = parts;
  const rows = [];

  rows.push(`
  <tr><td style="padding:22px 24px 18px;border-bottom:1px solid #eceff2;">
    <div style="font-size:17px;font-weight:700;color:#12203a;line-height:1.3;">Daily call digest</div>
    <div style="font-size:12px;color:#6b7280;margin-top:5px;">Calls from <b style="color:#374151;">${esc(parts.windowLabel)}</b></div>
  </td></tr>`);

  if (parts.answered.length || parts.unanswered.length) {
    rows.push(`
  <tr><td style="padding:16px 24px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${statCell(parts.total, 'Calls placed')}
    ${statCell(parts.answered.length, 'Answered')}
    ${statCell(data.feedback.length, 'Feedback')}
    ${statCell(parts.averageRating || '—', 'Avg rating')}
  </tr></table></td></tr>`);

    rows.push(sectionHeading(`Calls in the last ${parts.windowHours} hours`));
    for (const call of parts.answered) rows.push(htmlCallCard(call, timezone, baseUrl));

    if (parts.unanswered.length) {
      const names = parts.unanswered
        .map((call) => `${esc(call.patient_name || 'Unnamed patient')} (${esc(formatTime(call.called_at, timezone))})`)
        .join(', ');
      rows.push(`
  <tr><td style="padding:12px 24px 0;">
    <div style="font-size:12px;color:#6b7280;line-height:1.6;background:#f7f8fa;border-radius:8px;padding:11px 14px;">
      <b style="color:#3f4855;">${parts.notAnswered} not answered, ${parts.failed} failed.</b> ${names}. No audio or transcript exists for these.
    </div>
  </td></tr>`);
    }
  } else {
    rows.push(`
  <tr><td style="padding:22px 24px;">
    <div style="background:#f7f8fa;border-radius:8px;padding:18px;text-align:center;">
      <div style="font-size:14px;font-weight:600;color:#12203a;">No calls were placed in the last ${parts.windowHours} hours.</div>
      <div style="font-size:12px;color:#6b7280;margin-top:6px;line-height:1.5;">Nothing went wrong with this report — the queue was idle.</div>
    </div>
  </td></tr>`);
  }

  if (data.feedback.length) {
    rows.push(sectionHeading('Feedback received'));
    for (const item of data.feedback) rows.push(htmlFeedbackCard(item, timezone, baseUrl));
  }

  if (data.alerts.length) {
    rows.push(sectionHeading('Priority alerts'));
    rows.push(`<tr><td style="padding:8px 24px 0;"><div style="font-size:13px;color:#3f4855;line-height:1.7;">${
      data.alerts.map((item) => `• <b>${esc(item.customer_name)}</b> — ${esc(item.headline)}`).join('<br>')
    }</div></td></tr>`);
  }

  if (data.expectedVisitors.length) {
    rows.push(sectionHeading('Donors expecting to visit'));
    rows.push(`<tr><td style="padding:8px 24px 0;"><div style="font-size:13px;color:#3f4855;line-height:1.7;">${
      data.expectedVisitors.map((row) => `• <b>${esc(row.name)}</b> — ${esc(row.when || 'said yes but gave no time')}`).join('<br>')
    }</div>
    <div style="font-size:12px;color:#9199a6;margin-top:7px;line-height:1.5;">No appointment is booked and nobody is calling them back. Expect them as walk-ins.</div></td></tr>`);
  }

  if (parts.roiRows.length) {
    rows.push(sectionHeading('Pipeline snapshot'));
    rows.push(`<tr><td style="padding:8px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#3f4855;">${
      parts.roiRows.map(([label, value]) => `<tr><td style="padding:3px 0;">${esc(label)}</td><td align="right" style="font-weight:600;color:#12203a;">${esc(value)}</td></tr>`).join('')
    }</table></td></tr>`);
  }

  rows.push(`
  <tr><td style="padding:22px 24px 24px;">
    <div style="border-top:1px solid #eceff2;padding-top:14px;font-size:11px;color:#9199a6;line-height:1.6;">
      ${baseUrl ? 'Links open the call in the console and require you to be signed in.<br>' : ''}This message contains patient information. Handle accordingly.
    </div>
  </td></tr>`);

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;margin:0;padding:0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e3e6ea;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${rows.join('\n')}
</table>
</td></tr></table>`;
}

// ── Plain text ────────────────────────────────────────────────────────────────

function renderText(data, parts) {
  const { timezone, baseUrl } = parts;
  const lines = [`Daily call digest — calls from ${parts.windowLabel}`, ''];

  if (parts.answered.length || parts.unanswered.length) {
    lines.push(`${parts.total} calls placed, ${parts.answered.length} answered, ${data.feedback.length} feedback.`, '');
    lines.push(`CALLS IN THE LAST ${parts.windowHours} HOURS`);

    for (const call of parts.answered) {
      const meta = [`${formatDay(call.called_at, timezone)} ${formatTime(call.called_at, timezone)}`.trim(), formatDuration(call.answered_at, call.ended_at), maskPhone(call.customer_phone)]
        .filter(Boolean).join(' · ');
      lines.push('', `- ${call.patient_name || 'Unnamed patient'} — ${outcomeLabel(call.outcome)} (${meta})`);
      if (call.summary) lines.push(`  ${call.summary}`);

      const transcript = call.has_transcript && callLink(baseUrl, call.id, 'transcriptSection');
      const recording = call.has_recording && callLink(baseUrl, call.id, 'recordingSection');
      if (transcript) lines.push(`  Transcript: ${transcript}`);
      else if (!call.has_transcript) lines.push('  No transcript');
      if (recording) lines.push(`  Recording: ${recording}`);
      else if (!call.has_recording) lines.push('  Recording not captured');
    }

    if (parts.unanswered.length) {
      const names = parts.unanswered
        .map((call) => `${call.patient_name || 'Unnamed patient'} (${formatTime(call.called_at, timezone)})`)
        .join(', ');
      lines.push('', `${parts.notAnswered} not answered, ${parts.failed} failed: ${names}.`);
    }
  } else {
    lines.push(`No calls were placed in the last ${parts.windowHours} hours. Nothing went wrong with this report — the queue was idle.`);
  }

  if (data.feedback.length) {
    lines.push('', 'FEEDBACK RECEIVED');
    for (const item of data.feedback) {
      const rating = stars(item.stars) || outcomeLabel(item.category || 'unrated');
      lines.push('', `- ${item.patient_name || 'Anonymous'} — ${rating}`);
      if (item.review_text) lines.push(`  "${item.review_text}"`);
      const link = callLink(baseUrl, item.call_id, 'transcriptSection');
      if (link) lines.push(`  ${link}`);
      else if (!item.call_id) lines.push('  Not linked to a call');
    }
  }

  if (data.alerts.length) {
    lines.push('', 'PRIORITY ALERTS');
    for (const item of data.alerts) lines.push(`- ${item.customer_name}: ${item.headline}`);
  }

  if (data.expectedVisitors.length) {
    lines.push('', 'DONORS EXPECTING TO VISIT');
    for (const row of data.expectedVisitors) lines.push(`- ${row.name}: ${row.when || 'said yes but gave no time'}`);
    lines.push('No appointment is booked and nobody is calling them back. Expect them as walk-ins.');
  }

  if (parts.roiRows.length) {
    lines.push('', 'PIPELINE SNAPSHOT');
    for (const [label, value] of parts.roiRows) lines.push(`${label}: ${value}`);
  }

  lines.push('', 'This message contains patient information. Handle accordingly.');
  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

function renderDigest(input = {}) {
  const data = {
    calls: input.calls || [],
    feedback: input.feedback || [],
    alerts: input.alerts || [],
    expectedVisitors: input.expectedVisitors || [],
    roi: input.roi || {}
  };

  const timezone = input.timezone || 'Asia/Kolkata';
  const baseUrl = String(input.baseUrl || '').trim();

  const answered = data.calls.filter(isAnswered);
  const unanswered = data.calls.filter((call) => !isAnswered(call));
  const failed = unanswered.filter((call) => String(call.outcome || '').toLowerCase() === 'failed').length;

  const rated = data.feedback.map((item) => Number(item.stars)).filter((value) => Number.isFinite(value) && value > 0);
  const averageRating = rated.length
    ? `${(rated.reduce((sum, value) => sum + value, 0) / rated.length).toFixed(1)}/5`
    : '';

  const rupees = (value) => `Rs ${Number(value || 0).toFixed(0)}`;
  const roiRows = Object.keys(data.roi).length ? [
    ['Revenue pipeline', rupees(data.roi.revenue_pipeline_estimate)],
    ['Estimated AI ops cost', rupees(data.roi.ai_ops_cost_estimate)],
    ['Estimated staff saving', rupees(data.roi.estimated_saving_vs_staff)]
  ] : [];

  const end = input.generatedAt ? new Date(input.generatedAt) : new Date();
  const start = new Date(end.getTime() - (input.windowHours || 24) * 3600 * 1000);
  const windowLabel = `${formatDay(start, timezone)} ${formatTime(start, timezone)} to ${formatDay(end, timezone)} ${formatTime(end, timezone)} ${timezone === 'Asia/Kolkata' ? 'IST' : ''}`.trim();

  const parts = {
    timezone,
    baseUrl,
    answered,
    unanswered,
    failed,
    notAnswered: unanswered.length - failed,
    total: data.calls.length,
    averageRating,
    roiRows,
    windowHours: input.windowHours || 24,
    windowLabel
  };

  return { html: renderHtml(data, parts), text: renderText(data, parts) };
}

module.exports = { renderDigest, maskPhone, formatDuration };
