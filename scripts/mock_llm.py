"""Offline mock of an OpenAI-compatible /chat/completions endpoint.

FOR PLUMBING TESTS ONLY. It returns keyword-based canned answers so the n8n workflow can be
exercised end-to-end without an API key (parsing, routing, escalation, persistence).
It is NOT the classifier and its output must not be submitted as model output.

    python scripts/mock_llm.py            # listens on :8787
    LLM_BASE_URL=http://host.docker.internal:8787/v1   (in .env)

Set MOCK_MODE=garbage to return non-JSON and test the failure path.
"""
import json
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("MOCK_PORT", "8787"))


def classify(msg: str) -> dict:
    m = msg.lower()
    if re.search(r"stopped loading|outage|multiple users|nobody can", m):
        return {"rationale": "mock", "category": "Incident/Outage", "secondary_category": "Bug Report", "priority": "High", "confidence": 0.94}
    if re.search(r"invoice|charge|contract", m):
        return {"rationale": "mock", "category": "Billing Issue", "secondary_category": None, "priority": "Medium", "confidence": 0.95}
    if re.search(r"error|403|broken", m):
        return {"rationale": "mock", "category": "Bug Report", "secondary_category": None, "priority": "High", "confidence": 0.9}
    if re.search(r"is there a way|how do i|possible", m):
        return {"rationale": "mock", "category": "Technical Question", "secondary_category": "Feature Request", "priority": "Low", "confidence": 0.8}
    if re.search(r"love to see|could you add|feature", m):
        return {"rationale": "mock", "category": "Feature Request", "secondary_category": None, "priority": "Low", "confidence": 0.93}
    return {"rationale": "mock", "category": "Technical Question", "secondary_category": "Bug Report", "priority": "Medium", "confidence": 0.41}


def enrich(msg: str) -> dict:
    amounts = []
    for i, v in enumerate(re.findall(r"\$([\d,]+)", msg)):
        amounts.append({"value": float(v.replace(",", "")), "currency": "USD", "role": "charged" if i == 0 else "expected"})
    return {
        "core_issue": "MOCK core issue: " + msg[:80],
        "identifiers": [{"type": "other", "value": "HALLUCINATED-ID-999"}],  # must be dropped by the grounding check
        "amounts": amounts,
        "time_references": [],
        "product_area": None,
        "affected_scope": "multiple_users" if "multiple users" in msg.lower() else "single_user",
        "urgency_signal": {"level": "Medium", "evidence": "mock"},
        "summary": "MOCK summary sentence one. MOCK summary sentence two.",
        "suggested_next_action": "MOCK next action",
    }


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        system, user = body["messages"][0]["content"], body["messages"][-1]["content"]
        msg = user.split('"""')[1] if '"""' in user else user
        if os.environ.get("MOCK_MODE") == "garbage":
            content = "Sure! Here is my answer: it's probably a bug."
        else:
            content = json.dumps(classify(msg) if "intake classifier" in system else enrich(msg))
        out = {"id": "mock", "model": "mock-llm", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}}]}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"mock LLM on :{PORT}")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
