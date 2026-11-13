# Processing rules
- Keep vital estimators and heartbeat RR publication free of presentation EMAs; one ref-owned display filter in the signal router smooths accepted samples, so display latency never stacks.
- Keep raw vital snapshots separate from rendered values; never advance a stateful filter inside a React state updater or a canvas animation loop, because replay/render cadence must not affect measurements.
- Preserve existing signal gates, physiological RR acceptance and clinical boundary functions when changing display smoothing; deterministic A/B tests measure software settling delay, not clinical accuracy.
