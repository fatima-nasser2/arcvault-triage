// Step 3b — parse enrichment output and cross-check it with deterministic regex extraction.
// Mode: Run Once for Each Item
const ctx = $('Build Enrichment Prompt').item.json;
const raw = ctx.raw_message;

function extractJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}
const p = extractJson($json?.choices?.[0]?.message?.content) ?? {};
const errors = [];
if ($json.error) errors.push('llm_http_error');
if (!Object.keys(p).length) errors.push('unparseable_llm_output');

// --- deterministic extraction (safety net: the LLM sometimes drops an ID) ---
const regexIds = [];
for (const m of raw.matchAll(/(?:invoice|inv\.?)\s*#?\s*(\d{3,})/gi)) regexIds.push({ type: 'invoice_number', value: '#' + m[1] });
for (const m of raw.matchAll(/\b(?:error|status|code)\s*:?\s*([45]\d{2})\b|\b([45]\d{2})\s+error\b/gi)) regexIds.push({ type: 'error_code', value: m[1] ?? m[2] });
for (const m of raw.matchAll(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s,;)]+/gi)) regexIds.push({ type: 'url', value: m[0].replace(/[.]$/, '') });

const llmIds = Array.isArray(p.identifiers) ? p.identifiers.filter((i) => i && i.value) : [];
// keep only LLM identifiers that actually appear in the message (blocks hallucinated IDs)
const normalise = (v) => String(v).toLowerCase().replace(/[#\s]/g, '');
const grounded = llmIds.filter((i) => normalise(raw).includes(normalise(i.value)));
if (grounded.length < llmIds.length) errors.push(`dropped_${llmIds.length - grounded.length}_ungrounded_identifier(s)`);
const seen = new Set();
const identifiers = [...grounded, ...regexIds].filter((i) => {
  const k = normalise(i.value);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// amounts: LLM gives roles; regex gives a fallback list of every $ figure in the text
let amounts = Array.isArray(p.amounts)
  ? p.amounts.map((a) => ({ value: Number(String(a.value).replace(/[^0-9.]/g, '')), currency: a.currency || 'USD', role: a.role || 'other' }))
      .filter((a) => Number.isFinite(a.value))
  : [];
if (!amounts.length) {
  for (const m of raw.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)) amounts.push({ value: Number(m[1].replace(/,/g, '')), currency: 'USD', role: 'other' });
}

const LEVELS = ['High', 'Medium', 'Low'];
const urgency = p.urgency_signal && LEVELS.includes(p.urgency_signal.level)
  ? p.urgency_signal
  : { level: ctx.classification.priority, evidence: 'not extracted; defaulted to classification priority' };

const { llm_request, ...rest } = ctx;
return {
  json: {
    ...rest,
    enrichment: {
      core_issue: p.core_issue ?? raw.slice(0, 160),
      identifiers,
      amounts,
      time_references: Array.isArray(p.time_references) ? p.time_references : [],
      product_area: p.product_area ?? null,
      affected_scope: ['single_user', 'multiple_users', 'organization', 'unknown'].includes(p.affected_scope) ? p.affected_scope : 'unknown',
      urgency_signal: urgency,
      // if enrichment failed, still give the human reviewer something readable
      summary: p.summary ?? `Automatic enrichment failed for this ${ctx.source} message (category: ${ctx.classification.category ?? 'unclassified'}). Original text: "${raw.slice(0, 300)}"`,
      suggested_next_action: p.suggested_next_action ?? null,
      errors,
    },
  },
};
