// Step 3a — build the enrichment + summary request.
// Mode: Run Once for Each Item
const PROMPT_VERSION = 'enrich-v4';

const SYSTEM_PROMPT = `You extract structured facts from ONE inbound ArcVault customer message so the receiving team can act without re-reading it. The message has already been classified; the category is given for context only — do not re-classify.

Rules:
- Extract only what is literally in the message. Never invent IDs, amounts, names or dates. If something is absent, use an empty list or null.
- Copy identifiers exactly as written (keep "#", URLs, codes verbatim).
- Amounts: plain numbers without symbols or thousands separators (e.g. "$1,240" -> 1240).

Return ONLY a JSON object with exactly these keys:
{
  "core_issue": "<one sentence, max 25 words, stating the problem or request in neutral third person>",
  "identifiers": [ {"type": "account_id" | "invoice_number" | "error_code" | "url" | "order_id" | "other", "value": "<verbatim>"} ],
  "amounts": [ {"value": <number>, "currency": "<ISO code, assume USD for $>", "role": "charged" | "expected" | "other"} ],
  "time_references": ["<verbatim time/date phrases, e.g. 'around 2pm EST', 'after the update last Tuesday'>"],
  "product_area": "<short noun phrase for the affected area, e.g. 'login / authentication', 'dashboard', 'audit logs', 'invoicing', 'SSO'; null if unclear>",
  "affected_scope": "single_user" | "multiple_users" | "organization" | "unknown",
  "urgency_signal": {"level": "High" | "Medium" | "Low", "evidence": "<a short verbatim quote from the customer's message that justifies the level, or 'none stated'>"},
  "summary": "<2-3 sentences for the internal team: what happened, key identifiers and amounts, and the impact only if the customer states one. Do not add generic statements that are not in the message (e.g. about customer satisfaction). No greeting, no promises to the customer.>",
  "suggested_next_action": "<one concrete first step for the receiving team>"
}

Urgency signal = how time-sensitive the customer's own words make this (blocked work, many users, deadlines, money at stake). Judge it from the message text only, not from the category.`;

let model = 'gpt-4.1-mini';
try { if ($env.LLM_MODEL) model = $env.LLM_MODEL; } catch (e) {}

const c = $json.classification;
return {
  json: {
    ...$json,
    prompt_versions: { ...$json.prompt_versions, enrichment: PROMPT_VERSION },
    llm_request: {
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Category: ${c.category ?? 'Unclassified'}\nSource channel: ${$json.source}\nMessage:\n"""\n${$json.raw_message}\n"""`,
        },
      ],
    },
  },
};