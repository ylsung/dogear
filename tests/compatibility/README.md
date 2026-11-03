# Compatibility checks

GitHub Actions runs `.github/workflows/compatibility.yml` for pull requests,
pushes to main/master, manually, and every Monday at 13:00 UTC. Failed scheduled
runs appear in GitHub Actions and use the repository's GitHub notification
settings. The workflow takes effect once these changes reach the default branch.

## Run locally

```sh
npm ci --prefix tests/compatibility
npm ci --prefix vscode
npm run build --prefix vscode
export DOGEAR_SIM_NODE_MODULES="$PWD/tests/compatibility/node_modules"
(cd tests/compatibility && npx playwright install --with-deps chromium)
npm test --prefix tests/compatibility
node vscode/tests/simulator/capture.js
npm run test:handoff --prefix tests/compatibility
swift test --package-path desktop
```

`swift test` requires full Xcode on Macs where Command Line Tools omit XCTest.
`swift run --package-path desktop DogearSimulation` exercises the production core
without XCTest. The old Node desktop runner duplicates Swift logic and is not
used as proof of native compatibility.

## Coverage and limits

| Surface | Automated coverage | Live checks still needed |
| --- | --- | --- |
| Web: ChatGPT, Claude, Grok, Gemini | Production capture/composer scripts in Chromium with closed shadow DOM, global capture-phase type-to-focus handlers, text selection, click/focus, real typing, backspace, multiline, IME Enter guard, queue save, Escape, continued host editing | Current signed-in site DOM, shortcuts, upload controls |
| Web: PDF and Markdown | Same browser capture fixtures; PDF text-layer page attribution | Bundled PDF.js rendering, browser PDF restrictions, actual rendered Markdown |
| Web: ChatGPT and Claude images | Existing unpacked-extension simulator: real side panel, repeated three-image uploads, stale/replaced attachment chips | Actual upload responses and attachment limits |
| VS Code: Codex, Claude, Markdown preview | Production clipboard capture bridge with simulated VS Code API: selection, clipboard restoration, empty selection, cancel; browser queue/composer, multimodal and handoff simulations | Extension webview IDs, context menus, actual workbench focus and Copy |
| VS Code: Gemini/Antigravity | Queue rendering and prompt preservation with representative source records | Dedicated capture commands are not implemented; verify screenshot capture and manual handoff in each installed editor/extension |
| Desktop: Codex, Claude, Grok, Gemini/Antigravity, terminal | Swift production source/prompt/delivery simulation across all supported delivery targets; text/image ordering and context preservation | Accessibility permissions, actual Copy/Paste and focus in each app |

The web keyboard suite also opens ChatGPT-style image previews after Dogear has
loaded. It covers a scripted focus trap with inert body siblings and a native
`dialog.showModal()` preview. Both verify clicking and typing into the ask box,
multiline/save/cancel, screenshot-region capture with a mocked image response,
Escape leaving the preview open, and reconnecting Dogear after the preview is
removed. The host is mounted within the visible dialog so the editor remains
inside its focus scope. These are deterministic modal fixtures, not a recorded
or signed-in ChatGPT session.

Focus ownership is explicit: focusing Dogear's visible capture UI claims keyboard
priority. Early focus handlers hide its closed shadow host from page focus
traps and restore the chosen control after scripted focus stealing. Real outside
pointerdown, Tab navigation, dismissal, or switching away from the browser
releases ownership. Pending editor initialization and screenshot responses cannot
reclaim focus after a later user action. Tests verify a partially typed draft
survives scripted focus stealing, that an aggressive focus trap cannot redirect
the editor, and that outside clicks and Tab still transfer focus. Browser and OS
shortcuts remain under browser/OS control.

Desktop automatic delivery targets remain Codex, Claude and terminal. Grok and
Gemini/Antigravity are generic capture sources, not dedicated delivery targets.
Fixture success does not certify current third-party application compatibility.

For a live smoke check after third-party updates: select an answer, invoke
Dogear, click its ask editor, type a multiline question, edit it, add and cancel
questions, and verify the host prompt remains unchanged. Repeat with an image,
PDF selection and rendered Markdown. Confirm queue source context, then hand off
to an already focused destination composer and verify text/images without
sending. Record app version/date and update the relevant fixture when behavior
changes. Live signed-in checks require an interactive session and are not run by
CI.

To prove the focus regression is detectable, run:

```sh
DOGEAR_TEST_WITHOUT_BOUNDARY=1 node extension/tests/simulator/keyboard.js
```

This must fail: the hostile host receives typing instead of Dogear. The normal
run must pass. The early keyboard boundary registers at `document_start` in all
frames; existing content scripts still initialize at idle. Only keyboard events
originating in Dogear are stopped. Native editing uses the original trusted
event; composer shortcuts receive a non-composed local event, and cancellation
is mirrored to the original event. This avoids exposing a closed editor as a
non-editable target to page capture handlers. It is not a security boundary
against arbitrary hostile page scripts.
