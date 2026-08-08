# Attachment-status simulator

This end-to-end harness loads a temporary copy of the unpacked Dogear extension
in Chromium and exercises its real side panel against two local destination
fixtures:

- ChatGPT-style chips that retain stale filename nodes after middle removal.
- Claude-style anonymous chips that are asynchronously replaced after upload.

It attaches three images, removes the middle image first, then removes the two
remaining images. The runner verifies the exact green/neutral state after every
operation and records the destination page and real Dogear side panel together.

The runner expects `playwright` and `chrome-remote-interface` under
`$DOGEAR_SIM_NODE_MODULES` (default: `/tmp/dogear-playwright/node_modules`) and a
Playwright Chromium/FFmpeg installation. Run:

```sh
node extension/tests/simulator/run.js
```

Outputs are written to `artifacts/attachment-status-simulator.{json,webm}` and
ignored by Git.
