// Step 2b — parse + validate the classifier output. Never throws: a bad LLM response
// becomes confidence 0 with classification_failed=true, which the escalation step catches.
// Mode: Run Once for Each Item
const ctx = $('Build Classification Prompt').item.json;
const CATEGORIES = ['Bug Report', 'Feature Request', 'Billing Issue', 'Technical Question', 'Incident/Outage'];
const PRIORITIES = ['High', 'Medium', 'Low'];

function extractJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) {}
  const m = text.match(/\{[\s\S]*\}/);            // model wrapped JSON in prose / code fences
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

const content = $json?.choices?.[0]?.message?.content;
const parsed = extractJson(content);
const errors = [];
if ($json.error) errors.push('llm_http_error: ' + String($json.error?.message ?? $json.error).slice(0, 160));
if (!parsed) errors.push('unparseable_llm_output');

let category = parsed?.category ?? null;
if (category && !CATEGORIES.includes(category)) {
  // tolerate case / spacing drift ("incident / outage", "bug report")
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  category = CATEGORIES.find((c) => norm(c) === norm(category)) ?? null;
  if (!category) errors.push('invalid_category: ' + parsed.category);
}
let secondary = parsed?.secondary_category ?? null;
if (secondary && !CATEGORIES.includes(secondary)) secondary = null;

let priority = PRIORITIES.includes(parsed?.priority) ? parsed.priority : null;
if (parsed && !priority) errors.push('invalid_priority: ' + parsed?.priority);

let confidence = Number(parsed?.confidence);
if (!Number.isFinite(confidence)) confidence = 0;
if (confidence > 1 && confidence <= 100) confidence = confidence / 100; // model answered "85"
confidence = Math.min(1, Math.max(0, confidence));
if (!category) confidence = 0;

const { llm_request, ...rest } = ctx;
return {
  json: {
    ...rest,
    classification: {
      category,
      secondary_category: secondary,
      priority: priority ?? 'Medium',            // safe default; record is escalated anyway if parsing failed
      confidence: Math.round(confidence * 100) / 100,
      rationale: parsed?.rationale ?? null,
      classification_failed: !category,
      errors,
      model: $json?.model ?? llm_request?.model ?? null,
    },
  },
};
