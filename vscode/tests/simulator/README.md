# VS Code multimodal webview simulator

This browser-level harness exercises the Dogear sidebar webview with a mocked
VS Code host bridge. It covers multiline capture, three-image attachment,
mixed-content queue rendering, image-file selected context, stable same-ID
queue echoes, and composed image labels.

It expects Playwright under `$DOGEAR_SIM_NODE_MODULES` (default:
`/tmp/dogear-playwright/node_modules`) and a Playwright Chromium installation.

```sh
node vscode/tests/simulator/run.js
```

The simulator writes no repository artifacts.
