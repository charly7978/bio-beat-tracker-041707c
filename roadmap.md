# Unified vital display smoothing
- [ ] Remove presentation EMAs from vital and heartbeat processors; preserve estimator and gate logic.
- [ ] Apply one ref-owned display filter in the router, never in React updater functions; keep raw save data separate.
- [ ] Remove the monitor's extra numeric filter without changing its design.
- [ ] Test A/B settling latency, precision, resets, clinical boundaries and router wiring.
- [ ] Verify available preview signals and commit changes; physical camera validation requires a real device.
