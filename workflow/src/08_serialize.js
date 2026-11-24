// Step 5 — serialize the record as one JSON line (binary) so the file nodes can append it.
// Mode: Run Once for Each Item
const line = JSON.stringify($json) + '\n';
return {
  json: $json,
  binary: {
    data: {
      data: Buffer.from(line, 'utf8').toString('base64'),
      mimeType: 'application/x-ndjson',
      fileName: 'record.jsonl',
    },
  },
};
