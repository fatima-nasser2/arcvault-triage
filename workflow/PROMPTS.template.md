# Prompt Documentation

Two LLM calls per message. Both run at `temperature: 0` with `response_format: json_object`, against OpenAI `gpt-4.1-mini` by default (any OpenAI-compatible endpoint works by changing `LLM_BASE_URL`/`LLM_MODEL`). The prompts are versioned constants inside the Code nodes (`workflow/src/02_…` and `04_…`), and every output record carries `meta.prompt_versions` so a change in behaviour can be traced back to a prompt change.

The LLM's job ends at **classifying and extracting**. Routing, escalation and the confidence threshold are plain code. That split decides how both prompts are written.

---

## Prompt 1: Classification (`classify-v3`)

**System prompt**

```text
{{CLASSIFY}}
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
{{ENRICH}}
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
