# User-controlled discovery capture

Approved flow: open the website without collecting; explicitly start on that
owner-bound tab; explicitly end the batch; finish responses and uploads; then AI.

- Add an explicit open operation and manual-capture capability. Keep old clients
  compatible, but new clients must not silently fall back to automatic capture.
- Start with the prepared session reference, checking owner/document/origin.
- On manual stop, reject new requests, drain bounded pending responses and uploads.
- Freeze the workbench after stop; AI stays disabled during collection, draining,
  uncertain stop and failed/pending uploads. Explicit retry may update the batch.
- Verify extension, bridge, workbench and preview. Preserve pending AI alias fixes.
- No branch push, deployment or distributable build in this change.
