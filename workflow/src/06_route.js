// Step 4 — routing decision. Deterministic: the LLM classifies, code decides where it goes.
// Mode: Run Once for Each Item
const ROUTING_TABLE = {
  'Bug Report':         { queue: 'Engineering', reason: 'Defect in product behaviour -> engineering triage' },
  'Incident/Outage':    { queue: 'Engineering', reason: 'Service degradation -> engineering on-call' },
  'Feature Request':    { queue: 'Product',     reason: 'New capability / enhancement -> product backlog' },
  'Billing Issue':      { queue: 'Billing',     reason: 'Invoice / charge / contract question -> billing ops' },
  'Technical Question': { queue: 'Support',     reason: 'How-to / integration question -> support & solutions' },
};
const CONFIDENCE_THRESHOLD = 0.70;

const c = $json.classification;
const route = ROUTING_TABLE[c.category];
let routing;
if (!route) {
  routing = { standard_queue: null, reason: 'Fallback: no valid category from classifier', fallback_applied: true };
} else if (c.confidence < CONFIDENCE_THRESHOLD) {
  routing = {
    standard_queue: route.queue,
    reason: `Fallback: confidence ${c.confidence} < ${CONFIDENCE_THRESHOLD}; best guess was ${route.queue}` +
      (c.secondary_category ? ` (alt: ${ROUTING_TABLE[c.secondary_category]?.queue ?? 'n/a'})` : ''),
    fallback_applied: true,
  };
} else {
  routing = { standard_queue: route.queue, reason: route.reason, fallback_applied: false };
}

return { json: { ...$json, routing } };
