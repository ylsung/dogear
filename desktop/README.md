# Dogear Desktop (macOS prototype)

Dogear Desktop brings the selection-and-queue workflow to native apps. It uses
the same numbered prompt model as the Chrome and VS Code extensions, without
depending on another application's private DOM.

## Run

```sh
cd desktop
./build-app.sh
open dist/Dogear.app
```

The build script signs the complete bundle with a persistent local development
certificate stored in `~/Library/Application Support/DogearDevelopmentSigning`.
Keep that directory across rebuilds: it preserves the identity macOS authorizes.
Alternatively, set `DOGEAR_SIGNING_IDENTITY` to an installed code-signing identity
and use the same certificate on subsequent builds. The local signing helper uses
OpenSSL 3 and a dedicated keychain; it temporarily adds that keychain to the user
search list while signing, then restores the list. It does not change certificate
trust settings. Do not share the generated private key or keychain password.
Distribution still requires the appropriate signing and notarization.

When a capture hotkey or delivery action needs Accessibility and access is off,
Dogear automatically requests permission and shows a centered red notice with an
**Open Settings** button. Repeated hotkeys do not request another system prompt
while this notice remains open. The notice clears when access is detected.
The explanation is collapsed by default under **Why does Dogear need
Accessibility?** only in the notice. **Enable Accessibility…** is also
available in the menu.
While the notice is visible, Dogear rechecks permission. If the current process
recognizes the grant, the notice clears immediately. **Restart Dogear** lets you
apply a permission change manually if necessary. Restart refuses until you finish or cancel an open
question so unsaved composer text is not lost. macOS does not guarantee a restart
or permission-change notification for this API.
Screen-region capture may also require **Screen Recording** permission.
Dogear requests it on the first region capture and shows a centered recovery
notice if macOS still reports it as unavailable. Wallpaper-only captures mean
macOS is hiding application windows. Choose **Set Up Access Again** in that
notice to reset only Dogear's Screen Recording approval, allow Dogear in the
Settings window, and restart Dogear if macOS asks you to. Before showing the
crosshair, Dogear brings the captured source app back to the front.
Accessibility is needed only to invoke Copy/Paste in another app and read its
focused window title; Dogear's registered hotkey does not monitor general
keystrokes. Captures stay local in
`~/Library/Application Support/DogearDesktop`.

If Accessibility is enabled but Dogear reports no access, choose **Set Up Access
Again** in the red notice, then turn on Dogear in the Settings window that opens.
This resets only Dogear's Accessibility approval; other apps are unaffected.
Restart Dogear if the notice remains after approving. Older ad-hoc builds had
changing identities; moving to the persistent certificate requires a new approval.
Local installation is supported;
App Store distribution is not required. Run the built `.app` for this workflow,
since `swift run` launches an executable with a different identity.
Quit Dogear before rebuilding: the build script refuses to replace a running
copy, preventing the running process and on-disk bundle from getting out of sync.

## Workflow

1. Press `Control+Option+Q` in Claude, Codex/ChatGPT, a terminal, a PDF viewer,
   or another desktop app. Dogear captures selected text when available. With
   no text selection, it immediately opens screen-region capture for visual
   context such as an HTML/Markdown preview, mobile Simulator, chart, or figure.
   Region capture is also available directly from the app and menu-bar menu.
   The hotkey opens only a compact **Ask Dogear** panel. The queue window is
   hidden throughout capture, writing, and submission so it does not cover the
   source. Adding or cancelling closes the panel and returns focus to the source
   app. Open the full queue explicitly from the Dogear menu-bar menu.
2. Write the request, add optional reference images, and queue it. PDF captures
   have an optional page field because native viewers do not expose a universal
   page-number API.
   Adding an image inserts its actual thumbnail at the text cursor. It is a
   native rich-text attachment: select or drag it to move it, use Cut/Copy/Paste,
   or press Delete to remove it. Queued questions remain directly editable in
   their bordered question fields, with no edit mode or double-click required.
3. Review or reorder the queue. Choose **Claude**, **Codex**, or **Terminal**.
   Dogear activates an already-running destination and pastes text and images in
   their prompt order. It never synthesizes Enter. You can also export without
   opening the queue: use **Export prompt** in the menu-bar menu, or press
   `Control+Option+E` to open the compact destination chooser.

For selected text in apps that support macOS Services, right-click and choose
**Services → Ask with Dogear**. The selected text opens directly in the compact
Ask Dogear panel. macOS and the source app decide whether the command appears
directly in the context menu or inside its Services submenu.

Claude and Codex delivery is deliberately based on public desktop behavior
(clipboard/image paste), not brittle inspection of private app UI. If a target
is not running, Dogear copies a text fallback containing local image paths.

### Capture routing

The gear menu contains two settings, both enabled by default:

- **Prefer Chrome extension** unregisters the desktop hotkey while Chrome is
  frontmost. Use the Chrome extension's configured shortcut there.
- **Prefer VS Code extension** does the same for VS Code and Cursor, allowing
  the editor extension to own `Control+Option+Q`.

Turn either preference off to use desktop capture in that app. Switching apps
updates hotkey ownership automatically, so two Dogears never process one keypress.

## Simulation and tests

```sh
node tests/simulator/run.js
swift run DogearSimulation
swift test
bash tests/signing.sh
swift build -c release --product DogearDesktop
.build/release/DogearDesktop --editor-self-test /tmp/dogear-editor-test.png
```

The simulation exercises captures from Claude, a terminal, Preview/PDF, an HTML
viewer, and mobile Simulator, then verifies Codex delivery with the image kept
inline. Unit tests also cover Markdown detection, PDF page labels, ordering, and
the no-auto-send boundary.

The signing regression test changes a temporary copy's signed contents and
checks that its designated requirement stays identical across updates. It also
checks keychain search-list restoration after successful and failed signing.
These tests do not approve macOS permissions or exercise real cross-app capture;
that still needs an interactive check after granting Accessibility access.
The native editor self-test reconstructs an image attachment as AppKit does
during drag/drop, then verifies thumbnail normalization, text color, wrapping,
caret alignment, and a rendered attachment border. `build-app.sh` runs this test
automatically before replacing the app bundle.

The Node simulation is dependency-free and can run even on machines without a
complete Xcode installation. The Swift commands validate the native model and
app when the macOS SDK and Swift toolchain are installed as a matching pair.
SwiftPM may print an XCTest `PlatformPath` warning when only Apple's standalone
Command Line Tools are installed; release builds and `DogearSimulation` still
work. Installing full Xcode is required only for `swift test` on that setup.

## Prototype scope

- macOS 13 or newer; Windows/Linux system adapters are not implemented yet.
- Text capture uses the focused app's Copy command, so protected fields and apps
  that override Copy may not expose a selection.
- Persistent highlights inside third-party native apps are not possible through
  public APIs. The exact excerpt or screenshot is retained in the queue.
- The destination composer must already be focused. Dogear uses supported paste
  semantics and does not reach into Claude or Codex internals.
