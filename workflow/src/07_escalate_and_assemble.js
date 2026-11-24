// Steps 5 + 6 — apply escalation rules, then assemble the final structured record.
// Mode: Run Once for Each Item
const CONFIDENCE_THRESHOLD = 0.70;
const BILLING_THRESHOLD_USD = 500;

// Word-boundary phrases only: a bare /down/ would match "download" and "dropdown".
const OUTAGE_PATTERNS = [
  /\boutage\b/i,
  /\b(?:is|are|was|went|been|still|completely|totally)\s+down\b/i,
  /\bdown\s+for\s+(?:all|everyone|everybody|multiple|several|our)\b/i,
  /\bstopped\s+(?:loading|working|responding)\b/i,
  /\b(?:multiple|several|many|all)\s+(?:of\s+our\s+)?users\b/i,
  /\b(?:nobody|no\s+one|none\s+of\s+us)\s+can\b/i,
];
const SECURITY_PATTERNS = [
  /\bbreach(?:ed)?\b/i, /\bhacked\b/i, /\bunauthori[sz]ed\s+access\b/i,
  /\bdata\s+leak\b/i, /\bcompromised\b/i, /\bvulnerabilit(?:y|ies)\b/i,
];

const raw = $json.raw_message;
const c = $json.classification;
const e = $json.enrichment;
const reasons = [];

// 1. Low confidence / failed classification
if (c.classification_failed) reasons.push('classification_failed');
else if (c.confidence < CONFIDENCE_THRESHOLD) reasons.push(`low_confidence (${c.confidence} < ${CONFIDENCE_THRESHOLD})`);

// 2. Outage — either the model says so, or the text does (rules run on raw text so they still work if the LLM is wrong)
const outageHits = OUTAGE_PATTERNS.map((r) => raw.match(r)?.[0]).filter(Boolean);
if (c.category === 'Incident/Outage') reasons.push('category_incident_outage');
if (outageHits.length) reasons.push(`outage_keywords: ${outageHits.map((h) => `"${h}"`).join(', ')}`);

// 3. Security
const secHits = SECURITY_PATTERNS.map((r) => raw.match(r)?.[0]).filter(Boolean);
if (secHits.length) reasons.push(`security_keywords: ${secHits.map((h) => `"${h}"`).join(', ')}`);

// 4. Billing error > $500. "Error" = disputed amount = |charged - expected| when both are known;
//    if we only know the charge, use the charge itself (conservative).
let disputedAmount = null;
if (c.category === 'Billing Issue' || c.secondary_category === 'Billing Issue') {
  const usd = e.amounts.filter((a) => (a.currency || 'USD').toUpperCase() === 'USD');
  const charged = usd.filter((a) => a.role === 'charged').map((a) => a.value);
  const expected = usd.filter((a) => a.role === 'expected').map((a) => a.value);
  if (charged.length && expected.length) disputedAmount = Math.abs(Math.max(...charged) - Math.max(...expected));
  else if (charged.length) disputedAmount = Math.max(...charged);
  else if (usd.length) disputedAmount = Math.max(...usd.map((a) => a.value));
  if (disputedAmount !== null && disputedAmount > BILLING_THRESHOLD_USD) {
    reasons.push(`billing_error_over_${BILLING_THRESHOLD_USD} ($${disputedAmount})`);
  }
}

const escalate = reasons.length > 0;
const finalQueue = escalate ? 'Escalation' : $json.routing.standard_queue;

const record = {
  request_id: $json.request_id,
  received_at: $json.received_at,
  processed_at: new Date().toISOString(),
  source: $json.source,
  customer: $json.customer,
  raw_message: raw,

  // Step 2
  category: c.category,
  secondary_category: c.secondary_category,
  priority: c.priority,
  confidence: c.confidence,
  classification_rationale: c.rationale,

  // Step 3
  core_issue: e.core_issue,
  identifiers: e.identifiers,
  amounts: e.amounts,
  disputed_amount_usd: disputedAmount,
  time_references: e.time_references,
  product_area: e.product_area,
  affected_scope: e.affected_scope,
  urgency_signal: e.urgency_signal,

  // Step 4 + 6
  standard_queue: $json.routing.standard_queue,
  routing_reason: $json.routing.reason,
  escalation_flag: escalate,
  escalation_reasons: reasons,
  destination_queue: finalQueue,

  // Step 5
  summary: e.summary,
  suggested_next_action: e.suggested_next_action,

  // audit
  meta: {
    model: c.model,
    prompt_versions: $json.prompt_versions,
    parse_errors: [...c.errors, ...e.errors],
    fallback_applied: $json.routing.fallback_applied,
  },
};

return { json: record };
