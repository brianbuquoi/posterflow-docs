// PosterFlow documentation screenshot capture.
//
// Drives a running PosterFlow instance with Playwright, walks every screen
// referenced by docs/, and writes PNGs to docs/images/. Re-runnable: starts
// from a fresh /config (delete and recreate scratch/config to reset).
//
// Usage: node capture.mjs [--base http://localhost:8357] [--out ../docs/images]
//
// Conventions:
//   * 1440x900 viewport, deviceScaleFactor 2.
//   * File names are stable and descriptive (no screenshot-7.png).
//   * Unannotated originals always written. Annotated variants get -annot suffix.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, arr) => {
    if (arg.startsWith('--')) acc.push([arg.replace(/^--/, ''), arr[i + 1]]);
    return acc;
  }, [])
);

const BASE = args.base || 'http://localhost:8357';
const OUT = resolve(__dirname, args.out || '../docs/images');

const FIXTURES = {
  plex: { name: 'Docs Plex', url: 'http://plex.docs.local:32400', token: 'DOCSPLEX_PLACEHOLDER_TOKEN' },
  sonarr: { name: 'Docs Sonarr', url: 'http://sonarr.docs.local:8989', api_key: 'DOCSSONARR_PLACEHOLDER_APIKEY' },
  radarr: { name: 'Docs Radarr', url: 'http://radarr.docs.local:7878', api_key: 'DOCSRADARR_PLACEHOLDER_APIKEY' },
  tmdb: 'DOCS_TMDB_PLACEHOLDER_KEY',
  google: {
    clientId: '123456789012.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-DOCS-PLACEHOLDER',
    refreshToken: '1//docs-placeholder-refresh-token',
  },
};

async function ensureOut() {
  if (!existsSync(OUT)) await mkdir(OUT, { recursive: true });
}

async function shot(page, name, opts = {}) {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path, fullPage: !!opts.fullPage, ...opts });
  console.log(`  → ${name}.png`);
}

async function api(path, init = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  return res;
}

async function setupStatus() {
  const r = await api('/api/setup/status');
  return r.ok ? r.json() : { setup_complete: false };
}

async function bulkSettings(payload) {
  return api('/api/settings/bulk', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function waitForApp(page) {
  for (let i = 0; i < 30; i++) {
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      return;
    } catch (e) {
      await page.waitForTimeout(1000);
    }
  }
  throw new Error('App did not load');
}

async function dismissAnyToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.toast, .toast-content').forEach(el => el.remove());
  }).catch(() => {});
}

async function clickByText(page, text, opts = {}) {
  const loc = page.getByText(text, { exact: opts.exact ?? false }).first();
  await loc.waitFor({ state: 'visible', timeout: opts.timeout ?? 5000 });
  await loc.click();
}

async function fillByPlaceholder(page, placeholder, value) {
  const loc = page.getByPlaceholder(placeholder, { exact: false }).first();
  await loc.waitFor({ state: 'visible', timeout: 4000 });
  await loc.fill(value);
}

async function runWizard(page) {
  console.log('Wizard: starting at', BASE);
  await page.goto(`${BASE}/setup`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);

  // Step 0 — welcome
  await shot(page, 'wizard-step-0-welcome');

  // Click "Start Setup Wizard"
  await page.getByRole('button', { name: /Start Setup Wizard/i }).click();
  await page.waitForTimeout(600);

  // Step 1 — Google Drive (collapsed instructions)
  await shot(page, 'wizard-step-1-google-collapsed');

  // Expand instructions
  const toggle = page.locator('.instructions-toggle');
  if (await toggle.count()) {
    await toggle.first().click();
    await page.waitForTimeout(400);
    await shot(page, 'wizard-step-1-google-expanded', { fullPage: true });
    await toggle.first().click(); // collapse again
    await page.waitForTimeout(300);
  }

  // Fill OAuth fields (placeholder values)
  await fillByPlaceholder(page, '123456789', FIXTURES.google.clientId);
  await fillByPlaceholder(page, 'GOCSPX-', FIXTURES.google.clientSecret);
  await fillByPlaceholder(page, '1//', FIXTURES.google.refreshToken);

  // Save & Continue
  await page.getByRole('button', { name: /Save & Continue/i }).click();
  await page.waitForTimeout(800);

  // Step 2 — Storage
  await shot(page, 'wizard-step-2-storage');
  await page.getByRole('button', { name: /Save & Continue/i }).click();
  await page.waitForTimeout(800);

  // Step 3 — Media Servers (default empty instances)
  // Fill first Plex instance
  await page.locator('input[placeholder*="Plex Main"], input[placeholder*="Plex"]').first().fill(FIXTURES.plex.name).catch(() => {});
  await page.locator('input[placeholder*="32400"]').first().fill(FIXTURES.plex.url).catch(() => {});
  await page.locator('input[placeholder*="Your Plex Token"]').first().fill(FIXTURES.plex.token).catch(() => {});
  // Fill first Sonarr
  await page.locator('input[placeholder*="8989"]').first().fill(FIXTURES.sonarr.url).catch(() => {});
  // Fill first Radarr
  await page.locator('input[placeholder*="7878"]').first().fill(FIXTURES.radarr.url).catch(() => {});

  await page.waitForTimeout(300);
  await shot(page, 'wizard-step-3-media-servers', { fullPage: true });

  // Capture a failed test result
  const plexTestBtn = page.locator('.server-section').filter({ hasText: 'Plex' }).locator('button:has-text("Test Connection")').first();
  if (await plexTestBtn.count()) {
    try {
      await plexTestBtn.click();
      await page.waitForTimeout(2500);
      await shot(page, 'wizard-test-failed');
    } catch (e) { console.log('  (skip test failed capture)'); }
  }

  // Tick "I don't have Plex/Sonarr/Radarr" to allow advancing without a working test
  for (const label of ["I don't have Plex", "I don't have Sonarr", "I don't have Radarr"]) {
    const cb = page.getByLabel(label).first();
    if (await cb.count()) { await cb.check().catch(() => {}); }
  }
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /Save & Continue/i }).click();
  await page.waitForTimeout(800);

  // Step 4 — TMDB
  await shot(page, 'wizard-step-4-tmdb');
  await fillByPlaceholder(page, 'Enter your TMDB API key', FIXTURES.tmdb).catch(() => {});
  await page.getByRole('button', { name: /Save & Continue/i }).click();
  await page.waitForTimeout(800);

  // Step 5 — Destination
  await shot(page, 'wizard-step-5-destination');
  await page.getByRole('button', { name: /Save & Continue/i }).click();
  await page.waitForTimeout(800);

  // Step 6 — Complete
  await shot(page, 'wizard-step-6-complete');
  await page.getByRole('button', { name: /Complete Setup/i }).click();
  await page.waitForTimeout(1500);
}

async function ensureSetupComplete() {
  const s = await setupStatus();
  if (s.setup_complete) {
    console.log('Setup already complete; skipping wizard.');
    return false;
  }
  return true;
}

async function forceSetupComplete() {
  // Fallback: backend allows setting setup_complete via /api/settings/bulk.
  await bulkSettings({ setup_complete: 'true' });
}

async function navTo(page, path, name) {
  console.log(`Nav: ${path}`);
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);
  await dismissAnyToasts(page);
  if (name) await shot(page, name, { fullPage: true });
}

async function captureSidebarOpen(page) {
  // Sidebar is always present on desktop viewport (1440x900); no toggle needed.
  // But capture the version popover if reachable.
  const verBadge = page.locator('.sidebar .version, .release-notes-toggle, [class*="update"]').first();
  if (await verBadge.count()) {
    try { await verBadge.click({ trial: false, timeout: 1000 }); } catch {}
    await page.waitForTimeout(400);
    await shot(page, 'sidebar-version-popover');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
}

async function captureDashboard(page) {
  await navTo(page, '/', 'dashboard-overview');
  await page.waitForTimeout(800);
  await shot(page, 'dashboard-hero', { fullPage: true });
}

async function captureGdrives(page) {
  await navTo(page, '/drives', 'drives-list-all');

  // CL2K filter
  const cl2k = page.locator('.filter-buttons button, button').filter({ hasText: /^CL2K$/ }).first();
  if (await cl2k.count()) {
    await cl2k.click().catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, 'drives-list-cl2k', { fullPage: true });
  }

  // MM2K filter
  const mm2k = page.locator('.filter-buttons button, button').filter({ hasText: /^MM2K$/ }).first();
  if (await mm2k.count()) {
    await mm2k.click().catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, 'drives-list-mm2k', { fullPage: true });
  }

  // Reset to All
  const all = page.locator('.filter-buttons button, button').filter({ hasText: /^All$/ }).first();
  if (await all.count()) await all.click().catch(() => {});
  await page.waitForTimeout(300);

  // Add custom modal
  const addBtn = page.getByRole('button', { name: /\+ Custom/i }).first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(500);
    await shot(page, 'drives-add-custom-modal');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  // Configure (storage modal)
  const configBtn = page.getByRole('button', { name: /^Configure$/i }).first();
  if (await configBtn.count()) {
    await configBtn.click();
    await page.waitForTimeout(500);
    await shot(page, 'drives-storage-modal');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  // Drive settings modal (first card)
  const settingsIcon = page.locator('.drive-card').first().locator('.btn-icon, button[title*="ettings" i], button[aria-label*="ettings" i]').first();
  if (await settingsIcon.count()) {
    await settingsIcon.click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, 'drives-edit-modal');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function subscribeOneDrive() {
  // Subscribe to the first drive in DB so dashboard/stats look non-empty.
  try {
    const drives = await (await api('/api/drives/')).json();
    if (Array.isArray(drives) && drives.length > 0) {
      const first = drives[0];
      await api(`/api/drives/${first.id}/subscribe`, { method: 'POST' });
      console.log(`  · subscribed drive id=${first.id} (${first.name})`);
    }
  } catch (e) { console.log('  (subscribe attempt failed)', e.message); }
}

async function capturePosterManager(page) {
  await navTo(page, '/poster-manager', 'poster-manager-tabs');

  const tabs = [
    ['Workflow', 'poster-manager-workflow'],
    ['Poster Renamer', 'poster-manager-renamer'],
    ['Border Replacer', 'poster-manager-border'],
    ['Unmatched Assets', 'poster-manager-unmatched'],
    ['Drive Priority', 'poster-manager-priority'],
    ['Settings', 'poster-manager-settings'],
  ];
  for (const [label, name] of tabs) {
    const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
    if (await btn.count()) {
      await btn.click().catch(() => {});
    } else {
      // fallback: locate by tab class
      const fallback = page.locator(`button:has-text("${label}")`).first();
      if (await fallback.count()) await fallback.click().catch(() => {});
    }
    await page.waitForTimeout(500);
    await shot(page, name, { fullPage: true });
  }
}

async function capturePlexUpload(page) {
  await navTo(page, '/plex-upload', 'plex-upload-page');
  // Tabs: Manual Upload, Automation Settings
  const automation = page.locator('button:has-text("Automation")').first();
  if (await automation.count()) {
    await automation.click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, 'plex-upload-automation', { fullPage: true });
  }
  const manual = page.locator('button:has-text("Manual")').first();
  if (await manual.count()) {
    await manual.click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, 'plex-upload-manual', { fullPage: true });
  }
}

async function captureIDarr(page) {
  await navTo(page, '/IDarr', 'idarr-main');
  const settingsTab = page.locator('button:has-text("Settings")').first();
  if (await settingsTab.count()) {
    await settingsTab.click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, 'idarr-settings', { fullPage: true });
  }
}

async function captureMakerTools(page) {
  await navTo(page, '/maker-tools', 'maker-tools-page');
  const tmdbTab = page.locator('button:has-text("TMDB Search")').first();
  if (await tmdbTab.count()) {
    await tmdbTab.click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, 'maker-tools-tmdb-search', { fullPage: true });
  }
  const monitor = page.locator('button:has-text("Monitor")').first();
  if (await monitor.count()) {
    await monitor.click().catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, 'maker-tools-monitor', { fullPage: true });
  }
}

async function captureLogs(page) {
  await navTo(page, '/logs', 'logs-page');
  const system = page.locator('button:has-text("System")').first();
  if (await system.count()) {
    await system.click().catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, 'logs-system-tab', { fullPage: true });
  }
  const job = page.locator('button:has-text("Job Logs")').first();
  if (await job.count()) {
    await job.click().catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, 'logs-job-logs-tab', { fullPage: true });
  }
}

async function capturePosterSearch(page) {
  await navTo(page, '/poster-search', 'poster-search-empty');
}

async function captureCommunityRequests(page) {
  await navTo(page, '/community-requests', 'community-requests');
}

async function captureSettings(page) {
  await navTo(page, '/settings', 'settings-overview');

  const tabs = [
    ['General', 'settings-tab-general'],
    ['Notifications', 'settings-tab-notifications'],
    ['Scheduling', 'settings-tab-scheduling'],
    ['Media Servers', 'settings-tab-media-servers'],
    ['Rclone', 'settings-tab-rclone'],
    ['Backup', 'settings-tab-backup-restore'],
    ['Maintenance', 'settings-tab-maintenance'],
    ['Security', 'settings-tab-security'],
    ['Scripts', 'settings-tab-scripts'],
  ];
  for (const [label, name] of tabs) {
    const btn = page.locator('.settings-tabs button, button').filter({ hasText: new RegExp(`^${label}`, 'i') }).first();
    if (await btn.count()) {
      await btn.click().catch(() => {});
    }
    await page.waitForTimeout(600);
    await shot(page, name, { fullPage: true });
  }

  // Try to open schedule edit modal
  await navTo(page, '/settings', null);
  const schedTab = page.locator('button').filter({ hasText: /Scheduling/i }).first();
  if (await schedTab.count()) {
    await schedTab.click().catch(() => {});
    await page.waitForTimeout(600);
    const addSched = page.locator('button').filter({ hasText: /Add Schedule|\+ Add/i }).first();
    if (await addSched.count()) {
      await addSched.click().catch(() => {});
      await page.waitForTimeout(700);
      await shot(page, 'schedule-edit-modal');
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

async function captureWizardTestFailedSeparate(page) {
  // Already captured during runWizard.
}

(async function main() {
  await ensureOut();
  console.log('Output dir:', OUT);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  try {
    await waitForApp(page);

    const wizardNeeded = await ensureSetupComplete();
    if (wizardNeeded) {
      try {
        await runWizard(page);
      } catch (e) {
        console.error('Wizard run failed:', e.message);
        console.log('Forcing setup_complete via API and continuing...');
        await forceSetupComplete();
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(800);
      }
    }

    // Subscribe a drive so dashboard/stats look populated.
    await subscribeOneDrive();
    await page.waitForTimeout(1200);

    await captureDashboard(page);
    await captureSidebarOpen(page);
    await captureGdrives(page);
    await capturePosterManager(page);
    await capturePlexUpload(page);
    await captureCommunityRequests(page);
    await captureIDarr(page);
    await captureMakerTools(page);
    await captureLogs(page);
    await capturePosterSearch(page);
    await captureSettings(page);

    console.log('\nAll captures complete.');
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
