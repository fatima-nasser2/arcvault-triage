"""Assemble arcvault_triage.json (importable n8n workflow) from the JS sources in src/.

Keeping each Code node's JS in its own file makes the logic reviewable and diffable;
re-run this after editing anything in src/:   python workflow/build_workflow.py
"""
import json
import pathlib
import uuid

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "src"


def code_node(name, src_file, x, y, notes):
    return {
        "parameters": {"mode": "runOnceForEachItem", "jsCode": (SRC / src_file).read_text(encoding="utf-8")},
        "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [x, y],
        "notes": notes, "notesInFlow": True,
    }


def llm_node(name, x, y, notes):
    return {
        "parameters": {
            "method": "POST",
            "url": "={{ $env.LLM_BASE_URL }}/chat/completions",
            "sendHeaders": True,
            "headerParameters": {"parameters": [{"name": "Authorization", "value": "=Bearer {{ $env.LLM_API_KEY }}"}]},
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.llm_request) }}",
            "options": {"timeout": 60000},
        },
        "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [x, y],
        "retryOnFail": True, "maxTries": 3, "waitBetweenTries": 2000,
        # after 3 failed tries, pass the error downstream instead of killing the run:
        # the parser turns it into classification_failed -> Escalation queue. No message is dropped.
        "onError": "continueRegularOutput",
        "notes": notes, "notesInFlow": True,
    }


def write_node(name, file_expr, x, y, notes):
    return {
        "parameters": {"operation": "write", "fileName": file_expr, "dataPropertyName": "data", "options": {"append": True}},
        "name": name, "type": "n8n-nodes-base.readWriteFile", "typeVersion": 1, "position": [x, y],
        "notes": notes, "notesInFlow": True,
    }


nodes = [
    {
        "parameters": {"httpMethod": "POST", "path": "arcvault/intake", "responseMode": "responseNode", "options": {}},
        "name": "Inbound Request (Webhook)", "type": "n8n-nodes-base.webhook", "typeVersion": 2,
        "position": [0, 300], "webhookId": str(uuid.uuid5(uuid.NAMESPACE_URL, "arcvault-intake")),
        "notes": "Step 1: POST {source, message}", "notesInFlow": True,
    },
    code_node("Normalize Input", "01_normalize.js", 220, 300, "Step 1: canonical shape + request_id"),
    code_node("Build Classification Prompt", "02_build_classification_prompt.js", 440, 300, "Step 2: prompt classify-v3"),
    llm_node("LLM: Classify", 660, 300, "Step 2: OpenAI / any OpenAI-compatible API"),
    code_node("Parse Classification", "03_parse_classification.js", 880, 300, "Step 2: validate enums, clamp confidence"),
    code_node("Build Enrichment Prompt", "04_build_enrichment_prompt.js", 1100, 300, "Step 3: prompt enrich-v3"),
    llm_node("LLM: Enrich + Summarize", 1320, 300, "Step 3 + 5: entities, urgency, summary"),
    code_node("Parse Enrichment", "05_parse_enrichment.js", 1540, 300, "Step 3: grounding check + regex safety net"),
    code_node("Routing Decision", "06_route.js", 1760, 300, "Step 4: category -> queue table"),
    code_node("Escalation Check + Assemble Record", "07_escalate_and_assemble.js", 1980, 300, "Step 6 + 5: rules, final record"),
    code_node("Serialize JSONL", "08_serialize.js", 2200, 300, "Step 5: record -> JSON line"),
    write_node("Append to Queue File", "=/data/output/queue_{{ $json.destination_queue }}.jsonl", 2420, 300,
               "Step 5: one file per destination queue"),
    write_node("Append to Audit Log", "=/data/output/all_records.jsonl", 2640, 300, "Step 5: every record, every queue"),
    {
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ JSON.stringify($('Escalation Check + Assemble Record').item.json) }}",
            "options": {},
        },
        "name": "Respond with Record", "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.1,
        "position": [2860, 300], "notes": "Return the record to the caller", "notesInFlow": True,
    },
]

for n in nodes:
    n["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "arcvault/" + n["name"]))

connections = {}
for a, b in zip(nodes, nodes[1:]):
    connections[a["name"]] = {"main": [[{"node": b["name"], "type": "main", "index": 0}]]}

sticky = {
    "parameters": {
        "content": "## ArcVault Intake & Triage\n"
                   "LLM **classifies and extracts**; code **routes and escalates**.\n\n"
                   "Env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`\n"
                   "Output: `/data/output/queue_<Queue>.jsonl` + `all_records.jsonl`\n"
                   "Queues: Engineering · Product · Billing · Support · Escalation",
        "height": 200, "width": 520,
    },
    "name": "Overview", "type": "n8n-nodes-base.stickyNote", "typeVersion": 1, "position": [0, 40],
    "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "arcvault/sticky")),
}

workflow = {
    "name": "ArcVault Intake & Triage",
    "nodes": [sticky] + nodes,
    "connections": connections,
    "settings": {"executionOrder": "v1"},
    "pinData": {},
    "active": False,
}

out = HERE / "arcvault_triage.json"
out.write_text(json.dumps(workflow, indent=2), encoding="utf-8")
print(f"wrote {out} ({len(nodes)} nodes)")

# --- keep docs/PROMPTS.md in sync with the prompts actually shipped in the workflow ---
import re  # noqa: E402


def system_prompt(src_file):
    return re.search(r"const SYSTEM_PROMPT = `(.*?)`;", (SRC / src_file).read_text(encoding="utf-8"), re.S).group(1)


tpl = (HERE / "PROMPTS.template.md").read_text(encoding="utf-8")
doc = tpl.replace("{{CLASSIFY}}", system_prompt("02_build_classification_prompt.js")) \
         .replace("{{ENRICH}}", system_prompt("04_build_enrichment_prompt.js"))
(HERE.parent / "docs" / "PROMPTS.md").write_text(doc, encoding="utf-8")
print("wrote docs/PROMPTS.md")