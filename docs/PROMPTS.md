# Prompt Documentation

Two LLM calls per message. Both run at `temperature: 0` with `response_format: json_object`, against OpenAI `gpt-4.1-mini` by default (any OpenAI-compatible endpoint works by changing `LLM_BASE_URL`/`LLM_MODEL`). The prompts are versioned constants inside the Code nodes (`workflow/src/02_…` and `04_…`), and every output record carries `meta.prompt_versions` so a change in behaviour can be traced back to a prompt change.

The LLM's job ends at **classifying and extracting**. Routing, escalation and the confidence threshold are plain code. That split decides how both prompts are written.

---

## Prompt 1: Classification (`classify-v3`)

**System prompt**

```text
You are the intake classifier for ArcVault, a B2B software company. You read ONE inbound customer message and classify it for routing. You never reply to the customer.

## Categories — choose exactly one
- "Bug Report": a specific product function behaves incorrectly (errors, wrong results, broken feature) for this customer or account, while the service as a whole is up.
- "Feature Request": asks for a capability that does not exist yet, or an enhancement to an existing one.
- "Billing Issue": invoices, charges, pricing, refunds, contract rates, payment methods, seats/licences.
- "Technical Question": "how do I / is it possible / do you support" questions about using, configuring or integrating the product. Nothing is reported as broken.
- "Incident/Outage": the service or a major part of it is unavailable or severely degraded for multiple users or a whole organisation, or the customer describes it as down / an outage.

Tie-breakers:
- Broken for many users or a whole org -> "Incident/Outage", not "Bug Report".
- Asking whether something is possible -> "Technical Question", even if the honest answer might be "not yet".
- Money mentioned only in passing does not make a message "Billing Issue".

## Priority
- "High": the customer is blocked from using the product or a core workflow (cannot log in, service down, data loss), multiple users are affected, or there is a security concern.
- "Medium": a real problem with limited impact or a workaround; disputed or incorrect charges; a question blocking a near-term purchase or rollout.
- "Low": requests, general questions and nice-to-haves with no current impact.

## Confidence (0.0-1.0) — how sure you are of the CATEGORY
- 0.90-1.00: unambiguous, exactly one category fits.
- 0.70-0.89: one category clearly dominates, a second is conceivable.
- 0.50-0.69: two categories are about equally plausible.
- below 0.50: the message is too vague or off-topic to classify.
Do not default to high confidence; use the full range.

## Output
Return ONLY a JSON object with these keys, in this order:
{"rationale": "<one sentence citing the words in the message that decided it>",
 "category": "<one of the five category strings, exactly as written above>",
 "secondary_category": "<the next most plausible category, or null>",
 "priority": "High" | "Medium" | "Low",
 "confidence": <number between 0 and 1>}

## Examples (not real customers)
Message: "The CSV export button gives an empty file when the date range spans two months."
{"rationale": "A specific feature (CSV export) returns wrong output for a particular input.", "category": "Bug Report", "secondary_category": null, "priority": "Medium", "confidence": 0.93}

Message: "Is it possible to schedule reports through the API, or would that need to be built?"
{"rationale": "Asks whether a capability exists; could become a feature request if it does not.", "category": "Technical Question", "secondary_category": "Feature Request", "priority": "Low", "confidence": 0.74}

Message: "Nobody in our org can upload files since 9am, timeouts everywhere."
{"rationale": "Whole organisation blocked from a core function since a specific time.", "category": "Incident/Outage", "secondary_category": "Bug Report", "priority": "High", "confidence": 0.95}
```

**User message**

```text
Source channel: {source}
Message:
"""
{raw message}
"""
```

**Why it is structured this way.** The five categories each get a one-line *operational* definition, followed by explicit tie-breakers. The tie-breakers cover the confusable pairs I expected: Bug vs Outage (scope decides), Technical Question vs Feature Request ("is it possible…" is a question first), and incidental money mentions vs Billing. Because the model is prone to over-confidence, confidence is anchored to a four-band rubric tied to *how many categories plausibly fit*, rather than "how sure are you?". `rationale` is the **first** key in the JSON so the model commits to its evidence before it picks a label, which works as a cheap single-sentence chain of thought. `secondary_category` costs almost nothing, and it lets a human reviewer on the Escalation queue see the runner-up. The three few-shot examples are deliberately **not** the five test messages, to avoid leaking the test set. One of them shows a 0.74 confidence, so the model sees that the mid-range is allowed. *Tradeoffs:* self-reported confidence is a heuristic, not a calibrated probability. That is the single biggest weakness of this design (see "with more time"). The few-shot examples add about 250 tokens per call, which I judged worth it for format stability. *With more time:* replace self-reported confidence with a measured one. Options are token log-probabilities on the category label, or self-consistency (sample 3–5 times at temperature 0.7 and use agreement rate). Then calibrate the 0.70 threshold against a labelled set of 100+ real tickets rather than five.

---

## Prompt 2: Enrichment + Summary (`enrich-v4`)

**System prompt**

```text
You extract structured facts from ONE inbound ArcVault customer message so the receiving team can act without re-reading it. The message has already been classified; the category is given for context only — do not re-classify.

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

Urgency signal = how time-sensitive the customer's own words make this (blocked work, many users, deadlines, money at stake). Judge it from the message text only, not from the category.
```

**User message**

```text
Category: {category}
Source channel: {source}
Message:
"""
{raw message}
"""
```

**Why it is structured this way.** Classification and enrichment are separate calls so each prompt does one job. The classifier stays short and focused, so it is cheap to re-run for consistency checks. The enricher receives the category as context, which helps it choose what to extract (amount roles for billing, scope for incidents), but it is told not to re-classify. The schema is fixed and typed: identifiers are a flat `{type, value}` list rather than free text, and amounts are plain numbers with a `charged / expected / other` role. That way the downstream code can compute the billing discrepancy without parsing prose. The main failure mode for extraction is hallucinated IDs, so the prompt says "only what is literally in the message, copy verbatim". That instruction is **also enforced in code**: `Parse Enrichment` drops any identifier whose value does not appear in the raw text, and adds a regex pass for invoice numbers, HTTP error codes and URLs as a safety net. The summary is constrained to 2–3 sentences in internal third person with the identifiers in it, so the receiving team can act without opening the original. *Tradeoffs:* a second call adds roughly 0.5–1.5 s and doubles token cost. A single combined call would be cheaper, but it mixes a judgement task with an extraction task and makes failures harder to diagnose. *With more time:* add per-category extraction schemas (for example `plan`, `seats` and `billing_period` for Billing; `browser`, `region` and `first_seen` for incidents), and look up extracted account IDs against the CRM. Also build a small golden set to regression-test extraction recall whenever the prompt changes.

---

## Iteration log: what the real model got wrong, and the fix

I first built and tested the plumbing against a mock LLM, then ran the real model (`gpt-4.1-mini`). The labels were right from the first real run (5/5, and 8/8 with the edge cases), but reading the records turned up two problems in the enrichment output for sample 3.

| Problem in `enrich-v3` output | Cause | Fix in `enrich-v4` | After |
|---|---|---|---|
| `urgency_signal.evidence` was `"priority Medium"` | The user message passed the classifier's priority to the enricher, and the model echoed our label instead of quoting the customer | Removed the priority from the enrichment input; evidence must be a verbatim quote; "judge from the message text only" | `"Can someone look into this?"` |
| Summary ended with "This impacts billing accuracy and customer satisfaction." | The prompt asked for "the impact", so the model invented a generic one when the customer stated none | Impact only if the customer states one; generic statements not in the message are forbidden | Two factual sentences with the invoice number and both amounts |

Labels and routing were unchanged after the fix (8/8, consistent across 3 runs). The lesson: correct labels are not enough. The free-text fields need reading too, and anything the model is shown can leak into its output.

---

## What the LLM is deliberately *not* asked to do
- **Routing.** A lookup table in code is auditable, instant and cannot drift.
- **Escalation.** Keyword rules run on the *raw text* as well as the model's category, so an outage still escalates even if the model mislabels it.
- **Threshold decisions.** The `> $500` billing check is arithmetic on extracted numbers, not a model judgement.
