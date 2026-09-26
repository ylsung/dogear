#!/usr/bin/env node

const assert = require('node:assert/strict');

function detect(appName, bundle = '', title = '') {
  const application = `${appName} ${bundle}`.toLowerCase();
  const all = `${application} ${title}`.toLowerCase();
  if (['terminal', 'iterm', 'warp', 'wezterm', 'ghostty', 'kitty', 'alacritty'].some((x) => application.includes(x))) return 'terminal';
  if (application.includes('simulator')) return 'simulator';
  if (application.includes('claude') || application.includes('anthropic')) return 'claude';
  if (application.includes('codex') || application.includes('openai') || application.includes('chatgpt')) return 'codex';
  if (all.includes('.pdf') || application.includes('preview') || application.includes('acrobat')) return 'pdf';
  if (all.includes('.md') || all.includes('markdown')) return 'markdown';
  if (all.includes('.html') || all.includes('localhost') || all.includes('safari') || all.includes('chrome')) return 'html';
  return 'other';
}

function source(app, title, page, bundle = '') {
  return { app, title, page, bundle, surface: detect(app, bundle, title) };
}

function captureOwner(app, bundle, preferences) {
  const application = `${app} ${bundle}`.toLowerCase();
  if (preferences.chrome && (application.includes('chrome') || application.includes('chromium'))) return 'chrome-extension';
  if (preferences.vscode && (application.includes('visual studio code') || application.includes('vscode') || application.includes('cursor'))) return 'vscode-extension';
  return 'desktop';
}

function deliveryPlan(queue, target) {
  const events = [{ type: 'activate', target }];
  let text = `I collected ${queue.length} Dogear questions while reviewing desktop content.\n`;
  let imageNumber = 0;
  const flush = () => {
    if (text) events.push({ type: 'paste-text', text });
    text = '';
  };
  queue.forEach((item, index) => {
    text += `[Q${index + 1}] ${item.source.surface}: ${item.source.title} — ${item.source.app}`;
    if (item.source.page) text += `, p.${item.source.page}`;
    text += '\nSelected context:\n';
    for (const part of item.context) {
      if (part.type === 'text') text += `${part.text}\n`;
      else {
        imageNumber += 1;
        text += `[Image I${imageNumber}: ${part.label}]\n`;
        flush();
        events.push({ type: 'paste-image', path: part.path });
      }
    }
    text += `Request:\n${item.question}\n\n`;
  });
  flush();
  return events;
}

const queue = [
  { source: source('Claude', 'Refactor chat'), context: [{ type: 'text', text: 'The cache is global.' }], question: 'Make this per project.' },
  { source: source('Codex', 'dogear'), context: [{ type: 'text', text: 'Implementation complete.' }], question: 'Explain the change.' },
  { source: source('iTerm2', 'claude — dogear', null, 'com.googlecode.iterm2'), context: [{ type: 'text', text: 'FAIL ui.test.ts' }], question: 'Fix this failure.' },
  { source: source('Preview', 'design.pdf', 7), context: [{ type: 'text', text: 'Interaction model' }], question: 'Explain this section.' },
  { source: source('Marked', 'README.md'), context: [{ type: 'text', text: 'Old copy' }], question: 'Revise this Markdown.' },
  { source: source('Safari', 'localhost:3000/index.html'), context: [{ type: 'text', text: 'Save changes' }], question: 'Update this HTML state.' },
  { source: source('Simulator', 'iPhone 17 Pro'), context: [{ type: 'image', path: '/simulation/mobile.png', label: 'mobile.png' }], question: 'Match this mobile layout.' },
];

assert.deepEqual(queue.map((item) => item.source.surface), ['claude', 'codex', 'terminal', 'pdf', 'markdown', 'html', 'simulator']);
const events = deliveryPlan(queue, 'codex');
const imageAt = events.findIndex((event) => event.type === 'paste-image');
assert.ok(imageAt > 0);
assert.match(events[imageAt - 1].text, /\[Image I1: mobile\.png\]/);
assert.match(events[imageAt + 1].text, /Match this mobile layout/);
assert.equal(events.some((event) => event.type === 'press-enter'), false);
assert.equal(events[0].target, 'codex');
assert.equal(deliveryPlan(queue, 'claude')[0].target, 'claude');
assert.equal(deliveryPlan(queue, 'terminal')[0].target, 'terminal');
assert.equal(captureOwner('Google Chrome', 'com.google.Chrome', { chrome: true, vscode: true }), 'chrome-extension');
assert.equal(captureOwner('Visual Studio Code', 'com.microsoft.VSCode', { chrome: true, vscode: true }), 'vscode-extension');
assert.equal(captureOwner('Google Chrome', 'com.google.Chrome', { chrome: false, vscode: true }), 'desktop');

console.log('PASS: capture routing, Claude, Codex, terminal, PDF, Markdown, HTML, Simulator, inline image, and no auto-send');
