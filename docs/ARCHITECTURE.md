# ArcVault Intake & Triage: Architecture

**Stack:** n8n 2.x self-hosted in Docker (orchestration) · OpenAI `gpt-4.1-mini` (LLM, pay-as-you-go) · JSONL files on a mounted volume (persistence). Everything else is free or open source.

## 1. System design

```
POST /webhook/arcvault/intake  {source, message}
  │
  ├─ Normalize Input ─────────────── request_id, received_at, trimmed text           (Step 1)
  ├─ Build Classification Prompt → LLM: Classify → Parse Classification               (Step 2)
  ├─ Build Enrichment Prompt → LLM: Enrich + Summarize → Parse Enrichment             (Step 3)
  ├─ Routing Decision ────────────── category → queue table, low-confidence fallback  (Step 4)
  ├─ Escalation Check + Assemble ─── rules → Escalation queue, final record           (Step 6 + 5)
  ├─ Serialize → Append queue_<Queue>.jsonl → Append all_records.jsonl                (Step 5)
  └─ Respond with Record (the caller gets the JSON back synchronously)
```

**Trigger.** An n8n Webhook node. Any channel (email parser, web form, support-portal hook) POSTs `{source, message}`, and `scripts/run_samples.py` stands in for those channels. I chose a webhook over an IMAP or Gmail trigger because every channel can reach it, and it needs no OAuth setup for a reviewer to reproduce.

**Where state lives.** The workflow is stateless per message. Each run carries everything it needs in the item, so there is no shared memory between messages. The durable state is the output files: one append-only JSONL file per queue (`queue_Engineering.jsonl`, `queue_Escalation.jsonl`, …), which stands in for the team's ticket queue, plus `all_records.jsonl` as an audit log. n8n's own execution history keeps every intermediate node output for debugging.

**Why the LLM classifies and code decides.** The two LLM calls produce *judgements* (category, priority, confidence) and *extractions* (entities, summary). Everything with a business rule attached (where a ticket goes, what counts as urgent, the $500 threshold) is deterministic JavaScript in a single node with the rules as constants at the top. A reviewer can read the routing table in ten seconds, the rules can't hallucinate, and changing a threshold doesn't mean re-testing a prompt.

**Failure handling.** No message is ever dropped. Each LLM node retries 3× with a 2 s back-off. If it still fails, it passes the error downstream (`onError: continueRegularOutput`) instead of killing the run. The parser converts any unparseable or invalid output into `category: null, confidence: 0`, which the escalation rules route to a human with reason `classification_failed`. I tested this path with a mock LLM returning garbage and with the LLM endpoint down.

**Model choice.** `gpt-4.1-mini` is a non-reasoning model tuned for instruction following, with reliable JSON mode and low latency. That matters here because the task is a constrained labelling job, not open-ended reasoning, and I want `temperature: 0` for repeatable labels. Reasoning models such as `gpt-5-mini` don't accept `temperature: 0` and spend hidden tokens thinking, which adds cost and latency for no gain on a five-way classification. All testing for this submission (several full runs of the 8 test messages, including 3× consistency runs) cost **$0.08** in total. The endpoint is OpenAI-compatible, so switching to Groq's free Llama 3.3 70B or to Ollama (fully local, no data leaves the machine) means changing three env vars, and `.env.example` has all three set up.

## 2. Routing logic

| Category | Queue | Why |
|---|---|---|
| Bug Report | **Engineering** | A defect needs someone who can reproduce and fix it. |
| Incident/Outage | **Engineering** (on-call) | Same owners as bugs, but it always escalates (see §3). |
| Feature Request | **Product** | Goes to the backlog for prioritisation, not to the engineers fixing things today. |
| Billing Issue | **Billing** | Needs access to invoices and contracts, which engineering doesn't have. |
| Technical Question | **Support** | How-to and integration questions. Sample 4 (SSO with Okta during an auth-provider evaluation) is also a buying signal, which Support/Solutions can pass to Sales. |
| *invalid / missing category, or confidence < 0.70* | **Escalation** (fallback) | A human decides. The record keeps `standard_queue` (the best guess) and `secondary_category`, so the reviewer starts with a recommendation rather than a blank. |

Queues map to *teams that own an action*, not to categories one-to-one. That is why Bug and Incident share an owner.

## 3. Escalation logic

A record goes to the **Escalation** queue (with `escalation_flag: true` and machine-readable `escalation_reasons`) if **any** of these hold:

1. **Low confidence**: `confidence < 0.70`, or classification failed. This is the threshold from the brief. A wrong queue costs a re-route and hours of delay, while a human glance costs about a minute. Testing showed why the fallback keys on confidence rather than the label: across 3 runs, the deliberately vague edge case was labelled Technical Question twice and Bug Report once, but its confidence stayed at 0.40–0.60, so it was escalated every time. The label was unstable; the routing outcome was not.
2. **Outage**: the model says `Incident/Outage`, **or** the raw text matches outage phrases (`outage`, `is/went down`, `stopped loading/working`, `multiple/all users`, `nobody can`). The phrases are checked on the raw text so an outage escalates even if the model mislabels it. They are word-boundary phrases on purpose: a bare `down` matched "download" and "drop**down**" (edge case 3 in `data/samples.json`).
3. **Billing error > $500**: I read "billing error" as the **disputed amount**, `|charged − expected|`, because that is the money actually at risk. If only a charged amount is known, I use that, which is the conservative choice. Under this reading, sample 3 (charged $1,240 vs contract $980) has a disputed amount of **$260**, so it goes to Billing rather than escalating. The other reading ("any invoice over $500 that is disputed") would escalate nearly every billing ticket and swamp the human queue. This is an assumption: it is one constant to change if ArcVault means the other reading.
4. **Security** (my addition): `breach`, `hacked`, `unauthorized access`, `data leak`, `compromised`, `vulnerability`. Security reports should never sit in a normal queue.

`priority: High` alone does **not** escalate. Sample 1 (a single user getting a 403) is High but goes straight to Engineering, because escalation is for cases where the *automation* shouldn't decide alone, not a synonym for "urgent".

**A caveat I'd raise with the team.** The brief has escalated records go to a separate queue *instead of* the standard destination. For an outage, a human-review queue sitting in front of on-call is a delay at exactly the wrong moment. In production I'd make escalation **additive**: page on-call immediately **and** put the record in front of a human. Here I followed the brief and kept `standard_queue` on the record so that change is trivial.

## 4. At production scale

- **Reliability.** Move from a synchronous webhook to webhook → queue (Redis/SQS) → n8n in queue mode with workers, so traffic spikes buffer instead of timing out. Make ingestion idempotent on a message hash so retried emails don't create duplicate tickets. Add a dead-letter queue and alerting on `parse_errors` rate.
- **Cost.** At around 900 tokens per message across two calls, 10k messages a day is about 9M tokens a day. Options: send obvious cases (regex-certain invoices, outage keywords) through a smaller model (`gpt-4.1-nano`) and keep the larger model for ambiguous ones, cache the static system prompts, and merge the two calls once quality is proven.
- **Latency.** Triage isn't user-facing, so 1–2 s is fine. Outage detection is the one path that is latency-sensitive, and the keyword pre-check could page on-call *before* the LLM returns.
- **Quality.** Self-reported confidence is the weakest link. Calibrate it with self-consistency or log-probabilities against a labelled set, and track the share of human overrides on the Escalation queue as the real accuracy metric.
- **Data and privacy.** Customer messages go to a third-party API. Production needs a vendor data-processing agreement, PII redaction before the call, or a self-hosted model (the Ollama path already works).

## 5. Phase 2 (one more week)

1. **Real destinations**: create tickets in Jira/Linear/Zendesk per queue, post a Slack alert for escalations, and a Google Sheet view for non-technical teams.
2. **Feedback loop**: when a human re-routes a ticket, store `(message, model label, human label)` and use it as an eval set and as few-shot examples retrieved by similarity.
3. **Customer context**: look up extracted account IDs and invoice numbers against the CRM and billing system (plan tier, contract rate, open incidents), so the Billing team gets "contract says $980" verified rather than claimed, and enterprise accounts get a priority bump.
4. **De-duplication and incident clustering**: five customers reporting "dashboard not loading" within 10 minutes should become one incident with five linked reports.
5. **Eval harness in CI**: `run_samples.py` already checks expected labels and runs repeats for consistency. Grow it to 100+ labelled messages and gate prompt changes on it.
