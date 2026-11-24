// Step 1 — Ingestion: normalize the webhook payload into one canonical shape.
// Mode: Run Once for Each Item
const body = $json.body ?? $json;               // webhook puts the POST body under .body
const message = String(body.message ?? body.text ?? '').trim();
const source = String(body.source ?? 'Unknown').trim();

if (!message) {
  throw new Error('Payload must include a non-empty "message" field');
}

const requestId = body.id
  ? String(body.id)
  : 'REQ-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();

return {
  json: {
    request_id: requestId,
    source,
    customer: body.customer ?? null,
    received_at: body.received_at ?? new Date().toISOString(),
    raw_message: message,
  },
};
