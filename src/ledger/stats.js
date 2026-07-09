function computeStats(detections) {
  const total = detections.length;
  const verified = detections.filter(d => d.status === 'verified').length;
  const fp = detections.filter(d => d.status === 'false_positive').length;
  const pending = detections.filter(d => d.status === 'pending').length;
  const leads = detections.filter(d => d.leadTimeMs != null).map(d => d.leadTimeMs);
  const avgLead = leads.length ? Math.round(leads.reduce((a,b) => a+b,0) / leads.length / 1000) : 0;
  const minLead = leads.length ? Math.round(Math.min(...leads) / 1000) : 0;
  const maxLead = leads.length ? Math.round(Math.max(...leads) / 1000) : 0;
  const accuracy = (total - pending) > 0 ? ((verified / (total - pending)) * 100).toFixed(1) : 'N/A';
  return { total, verified, fp, pending, avgLead, minLead, maxLead, accuracy };
}

module.exports = { computeStats };
