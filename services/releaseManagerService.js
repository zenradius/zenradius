/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Release Manager Service — Phase 10B
 * ─────────────────────────────────────────────────────────────────────────────
 *  Production update execution: official release metadata → verified artifact
 *  → backup → controlled install → restart → health check.
 *
 *  Replaces "git reset --hard origin/<branch>" as the production install
 *  authority. Legacy git-based /admin/update/run remains as a documented
 *  fallback (Phase 10A hardened it with a lock); this module is the new,
 *  safer path used when RELEASE_MANIFEST_URL is configured.
 *
 *  Trust boundaries:
 *   - Release source: ONLY a fixed, environment-configured HTTPS URL
 *     (RELEASE_MANIFEST_URL). Never accepts an arbitrary/user-supplied URL.
 *   - Release signature: services/releaseVerifierService.js + config/releaseTrustAnchor.js
 *     (SEPARATE trust domain from license signing — never reused).
 *   - No shell string interpolation: all child_process calls use array args
 *     with fixed commands (tar) and validated, non-user-controlled paths.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const axios = require('axios');
const { logger } = require('../config/logger');
const releaseVerifier = require('./releaseVerifierService');

let REPO_ROOT = path.resolve(__dirname, '..');
const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024; // 500MB hard cap regardless of metadata claim
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 0; // official host only — do not follow cross-host redirects

/**
 * Test-only seam (mirrors licenseTrustAnchor.__setTestPublicKey pattern):
 * redirect REPO_ROOT to an isolated temp directory so integration tests can
 * exercise the full backup/install pipeline WITHOUT ever touching the real
 * application tree, settings.json, or database. Disabled in production.
 */
function __setTestRepoRoot(dir) {
  if (process.env.NODE_ENV === 'production') return false;
  REPO_ROOT = dir ? path.resolve(dir) : path.resolve(__dirname, '..');
  return true;
}

/**
 * Test-only seam: override the GitHub API base URL and accepted asset hosts
 * so the GitHub Release path can be exercised end-to-end against a local
 * HTTP test server, without ever weakening the production allowlist
 * (github.com / objects.githubusercontent.com / release-assets.githubusercontent.com
 * over HTTPS). Disabled in production.
 */
let githubApiBaseOverride = null;
let githubAssetHostsOverride = null;
function __setTestGithubApiBase(baseUrl, extraAssetHosts = []) {
  if (process.env.NODE_ENV === 'production') return false;
  githubApiBaseOverride = baseUrl || null;
  githubAssetHostsOverride = baseUrl ? new Set([...GITHUB_ASSET_HOSTS, ...extraAssetHosts]) : null;
  return true;
}
function activeAssetHosts() { return githubAssetHostsOverride || GITHUB_ASSET_HOSTS; }
function activeAssetProtocolAllowsHttp() { return Boolean(githubApiBaseOverride) && githubApiBaseOverride.startsWith('http://'); }

const PRESERVED_ENTRIES = Object.freeze([
  'settings.json',
  '.env',
  'database',
  'public/uploads',
  'public/img',
  'data',
  'auth_info_baileys'
]);

const STATES = Object.freeze([
  'idle', 'checking', 'downloading', 'verifying', 'backing_up',
  'installing', 'migrating', 'restarting', 'health_check', 'success',
  'failed', 'recovery_required'
]);

let runLock = false;
let lastRun = { state: 'idle', startedAt: null, finishedAt: null, fromVersion: null, targetVersion: null, failureStage: null, message: '' };

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

// ─── GitHub Release source (Phase 10C) ─────────────────────────────────────
// Official production release source. Repository is read from the SAME
// source already used by the legacy git-based update info (Phase 10A/adminPortal
// getUpdateInfo): "https://github.com/<owner>/<repo>.git". No second/duplicate
// repository configuration is introduced.
const GITHUB_API_HOST = 'api.github.com';
const GITHUB_ASSET_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const GITHUB_TIMEOUT_MS = 15000;
const GITHUB_MAX_BYTES = 1 * 1024 * 1024; // manifest.json is small; hard cap regardless of Content-Length

function getGithubRepoSlug() {
  // Reuse the existing repository URL constant (see getUpdateInfo in
  // routes/adminPortal.js) via env override only if explicitly provided;
  // otherwise fall back to the same canonical repo string used elsewhere in
  // this codebase so there is exactly ONE repository source of truth.
  const override = String(process.env.RELEASE_GITHUB_REPO || '').trim();
  if (override) return override;
  const canonicalUrl = 'https://github.com/zenradius/zenradius.git';
  const m = canonicalUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function isGithubReleaseConfigured() {
  return Boolean(getGithubRepoSlug());
}

/**
 * Fetch the manifest.json asset from the latest GitHub Release of the
 * configured repository. GitHub's API/release-asset responses are NEVER
 * trusted directly as install authority — the fetched manifest still goes
 * through the exact same schema + Ed25519 signature verification as any
 * other source (releaseVerifierService.verifyMetadataSignature).
 */
async function fetchGithubReleaseMetadata() {
  const slug = getGithubRepoSlug();
  if (!slug) return { valid: false, status: 'UNCONFIGURED', message: 'Repository GitHub release belum dikonfigurasi.' };

  let release;
  try {
    const apiBase = githubApiBaseOverride || `https://${GITHUB_API_HOST}`;
    const apiUrl = `${apiBase}/repos/${slug}/releases/latest`;
    const res = await axios.get(apiUrl, {
      timeout: GITHUB_TIMEOUT_MS,
      maxRedirects: 1, // GitHub API itself may 301 http->https only
      maxContentLength: 5 * 1024 * 1024,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ZenRadius-Update-Client' },
      validateStatus: (s) => s === 200
    });
    release = res.data;
  } catch (e) {
    logger.error(`[ReleaseManager] Gagal menghubungi GitHub Release API: ${e.message}`);
    return { valid: false, status: 'NETWORK_ERROR', message: 'Gagal menghubungi GitHub Release API.' };
  }

  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const manifestAsset = assets.find((a) => String(a?.name || '') === 'manifest.json');
  if (!manifestAsset || !manifestAsset.browser_download_url) {
    return { valid: false, status: 'INVALID_FORMAT', message: 'Release GitHub tidak memiliki asset manifest.json.' };
  }

  let assetUrl;
  try { assetUrl = new URL(manifestAsset.browser_download_url); } catch { return { valid: false, status: 'INVALID_FORMAT', message: 'URL asset manifest tidak valid.' }; }
  const assetProtocolOk = assetUrl.protocol === 'https:' || (assetUrl.protocol === 'http:' && activeAssetProtocolAllowsHttp() && isLoopbackHost(assetUrl.hostname));
  if (!assetProtocolOk || !activeAssetHosts().has(assetUrl.hostname)) {
    return { valid: false, status: 'INVALID_FORMAT', message: 'Host asset manifest tidak dikenali sebagai GitHub resmi.' };
  }

  try {
    const assetRes = await axios.get(assetUrl.toString(), {
      timeout: GITHUB_TIMEOUT_MS,
      maxRedirects: 2, // GitHub redirects release assets to objects.githubusercontent.com
      maxContentLength: GITHUB_MAX_BYTES,
      responseType: 'json',
      headers: { 'User-Agent': 'ZenRadius-Update-Client' },
      validateStatus: (s) => s === 200
    });
    const meta = assetRes.data;
    const sigCheck = releaseVerifier.verifyMetadataSignature(meta);
    if (!sigCheck.valid) return sigCheck;
    return { valid: true, status: 'VALID', metadata: meta, releaseTag: release?.tag_name || null, releaseNotes: typeof release?.body === 'string' ? release.body : '' };
  } catch (e) {
    logger.error(`[ReleaseManager] Gagal mengunduh manifest.json dari GitHub Release: ${e.message}`);
    return { valid: false, status: 'NETWORK_ERROR', message: 'Gagal mengunduh manifest release dari GitHub.' };
  }
}

function getManifestUrl() {
  const raw = String(process.env.RELEASE_MANIFEST_URL || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // HTTPS-only in production. HTTP allowed ONLY for loopback (same pattern
    // as services/licenseClientService.js) so this module is testable
    // end-to-end without ever weakening the production trust boundary.
    if (u.protocol === 'https:') return raw;
    if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return raw;
    return null;
  } catch {
    return null;
  }
}

function isConfigured() {
  // RELEASE_MANIFEST_URL (explicit override, e.g. self-hosted manifest or
  // test/dev loopback) takes precedence when set; otherwise GitHub Release
  // is the default official production source.
  return Boolean(getManifestUrl()) || isGithubReleaseConfigured();
}

function readLocalVersion() {
  try {
    return String(fs.readFileSync(path.join(REPO_ROOT, 'version.txt'), 'utf8')).trim();
  } catch {
    return '-';
  }
}

function recordState(state, extra = {}) {
  lastRun = { ...lastRun, state, ...extra };
  logger.info(`[ReleaseManager] state=${state} ${extra.message || ''}`.trim());
}

function getStatus() {
  return {
    configured: isConfigured(),
    source: getManifestUrl() ? 'manifest_url' : (isGithubReleaseConfigured() ? 'github_release' : null),
    trustAnchorConfigured: require('../config/releaseTrustAnchor').isTrustAnchorConfigured(),
    localVersion: readLocalVersion(),
    running: runLock,
    lastRun: { ...lastRun }
  };
}

/**
 * Fetch + validate release metadata from the ONLY configured official source.
 * Never accepts a URL from request/body/query. Prefers an explicit
 * RELEASE_MANIFEST_URL override (self-hosted manifest, or loopback for
 * tests); otherwise uses the official GitHub Release of the configured repo.
 */
async function fetchMetadata() {
  const explicitUrl = getManifestUrl();
  if (explicitUrl) {
    try {
      const res = await axios.get(explicitUrl, {
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxRedirects: MAX_REDIRECTS,
        responseType: 'json',
        validateStatus: (s) => s === 200
      });
      const meta = res.data;
      const sigCheck = releaseVerifier.verifyMetadataSignature(meta);
      if (!sigCheck.valid) return sigCheck;
      return { valid: true, status: 'VALID', metadata: meta, source: 'manifest_url' };
    } catch (e) {
      logger.error(`[ReleaseManager] Gagal mengambil release metadata: ${e.message}`);
      return { valid: false, status: 'NETWORK_ERROR', message: 'Gagal menghubungi release source.' };
    }
  }
  if (isGithubReleaseConfigured()) {
    const gh = await fetchGithubReleaseMetadata();
    if (!gh.valid) return gh;
    return { valid: true, status: 'VALID', metadata: gh.metadata, source: 'github_release', releaseTag: gh.releaseTag, releaseNotes: gh.releaseNotes };
  }
  return { valid: false, status: 'UNCONFIGURED', message: 'Release source belum dikonfigurasi.' };
}

/**
 * Check for update: metadata + version policy only. Never downloads/installs.
 */
async function checkForUpdate() {
  recordState('checking');
  const meta = await fetchMetadata();
  if (!meta.valid) return meta;
  const currentVersion = readLocalVersion();
  const policy = releaseVerifier.evaluateVersionPolicy(currentVersion, meta.metadata.version);
  return { ...policy, metadata: meta.metadata, currentVersion, source: meta.source, releaseTag: meta.releaseTag || null, releaseNotes: meta.releaseNotes || '' };
}

/**
 * Resolve the download URL for metadata.artifact. When the metadata came
 * from an explicit manifest URL, the artifact is resolved relative to that
 * manifest (co-hosted). When it came from a GitHub Release, the artifact is
 * looked up as a release asset by filename via the same GitHub Release API
 * call (never trusts an arbitrary URL from metadata itself).
 */
async function resolveArtifactUrl(metadata, source) {
  if (source === 'github_release') {
    const slug = getGithubRepoSlug();
    const apiBase = githubApiBaseOverride || `https://${GITHUB_API_HOST}`;
    const apiUrl = `${apiBase}/repos/${slug}/releases/latest`;
    const res = await axios.get(apiUrl, {
      timeout: GITHUB_TIMEOUT_MS,
      maxRedirects: 1,
      maxContentLength: 5 * 1024 * 1024,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ZenRadius-Update-Client' },
      validateStatus: (s) => s === 200
    });
    const assets = Array.isArray(res.data?.assets) ? res.data.assets : [];
    const asset = assets.find((a) => String(a?.name || '') === String(metadata.artifact));
    if (!asset || !asset.browser_download_url) return null;
    const url = new URL(asset.browser_download_url);
    const protocolOk = url.protocol === 'https:' || (url.protocol === 'http:' && activeAssetProtocolAllowsHttp() && isLoopbackHost(url.hostname));
    if (!protocolOk || !activeAssetHosts().has(url.hostname)) return null;
    return url;
  }
  const manifestUrl = new URL(getManifestUrl());
  return new URL(metadata.artifact, manifestUrl);
}

/**
 * Stream-download the artifact to a temp file with a hard size cap.
 * Never loads the whole artifact into memory.
 */
async function downloadArtifact(metadata, destPath, source) {
  let url;
  try {
    url = await resolveArtifactUrl(metadata, source);
  } catch (e) {
    return { ok: false, error: 'Gagal menentukan lokasi artifact resmi.' };
  }
  if (!url) return { ok: false, error: 'Artifact tidak ditemukan pada release source resmi.' };

  if (source !== 'github_release') {
    const manifestUrl = new URL(getManifestUrl());
    // Reject cross-host artifact URLs — artifact must be co-hosted with the
    // manifest, and must use the same protocol trust level (https:, or http:
    // only for loopback — same exception as getManifestUrl()).
    const sameProtocolTrust = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
    if (url.host !== manifestUrl.host || !sameProtocolTrust) {
      return { ok: false, error: 'Artifact host tidak sesuai dengan release source resmi.' };
    }
  }
  const declaredSize = Number(metadata.artifact_size);
  try {
    const response = await axios.get(url.toString(), {
      responseType: 'stream',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      maxContentLength: MAX_ARTIFACT_BYTES,
      maxBodyLength: MAX_ARTIFACT_BYTES,
      validateStatus: (s) => s === 200
    });

    let total = 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(destPath, { mode: 0o600 });

    await new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_ARTIFACT_BYTES || total > declaredSize) {
          response.data.destroy();
          out.destroy();
          reject(new Error('Artifact melebihi ukuran maksimum yang diizinkan.'));
          return;
        }
        hash.update(chunk);
      });
      response.data.on('error', reject);
      response.data.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });

    return { ok: true, actualSize: total, actualSha256: hash.digest('hex') };
  } catch (e) {
    try { fs.rmSync(destPath, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  }
}

function copyDirSync(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow symlinks during backup/restore
    if (entry.isDirectory()) copyDirSync(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

/**
 * Backup preserved runtime state to a timestamped directory OUTSIDE the repo,
 * then verify every entry that existed was actually copied.
 */
function createVerifiedBackup() {
  const backupRoot = path.join(os.tmpdir(), `zenradius-update-backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(backupRoot, { recursive: true });
  const backedUp = [];
  for (const rel of PRESERVED_ENTRIES) {
    const src = path.resolve(REPO_ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.resolve(backupRoot, rel);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); copyDirSync(src, dst); }
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
    if (!fs.existsSync(dst)) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
      return { ok: false, error: `Backup verifikasi gagal untuk ${rel}.` };
    }
    backedUp.push(rel);
  }
  return { ok: true, backupRoot, backedUp };
}

function restoreBackup(backupRoot) {
  const restored = [];
  for (const rel of PRESERVED_ENTRIES) {
    const src = path.resolve(backupRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.resolve(REPO_ROOT, rel);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(dst, { recursive: true });
      copyDirSync(src, dst);
    } else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    restored.push(rel);
  }
  return restored;
}

/**
 * Extract a tar.gz artifact into a fresh temp directory, rejecting any entry
 * that escapes the extraction root (path traversal / absolute path / symlink).
 * Uses system `tar` with FIXED array arguments — no shell interpolation.
 */
function safeExtract(archivePath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  // List entries first and validate every path before extracting anything.
  const list = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (list.status !== 0) return { ok: false, error: 'Gagal membaca daftar isi artifact.' };
  const entries = String(list.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const entry of entries) {
    if (path.isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry) || entry.split(/[\\/]/).includes('..')) {
      return { ok: false, error: `Artifact mengandung path tidak aman: ${entry}` };
    }
  }
  const extract = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8' });
  if (extract.status !== 0) return { ok: false, error: 'Ekstraksi artifact gagal.' };
  // Reject any symlink that ended up inside the extraction tree.
  const hasUnsafeSymlink = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory() && hasUnsafeSymlink(full)) return true;
    }
    return false;
  };
  if (hasUnsafeSymlink(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    return { ok: false, error: 'Artifact mengandung symlink yang tidak diizinkan.' };
  }
  return { ok: true };
}

/**
 * Replace application code with extracted release contents, WITHOUT touching
 * preserved runtime state. Only files that exist in the extracted release are
 * copied over; preserved entries are explicitly skipped even if present in
 * the artifact (defense in depth — release build must exclude them anyway).
 */
function installExtractedRelease(extractDir) {
  const preservedSet = new Set(PRESERVED_ENTRIES.map((p) => p.split('/')[0]));
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (preservedSet.has(entry.name) || entry.name === 'node_modules' || entry.name === '.git') continue;
    const src = path.join(extractDir, entry.name);
    const dst = path.join(REPO_ROOT, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(dst, { recursive: true });
      copyDirSync(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
  return { ok: true };
}

// ─── Restart + bounded health polling (Phase 10C) ──────────────────────────
// Reuses the EXISTING PM2 deployment mechanism (Phase 10A findPm2AppName /
// runCmd pattern in routes/adminPortal.js) — no new process manager is
// introduced. Fixed command + array args only, no shell interpolation.
const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL || 'http://127.0.0.1:' + String(process.env.PORT || 3001) + '/health';
const HEALTH_POLL_INTERVAL_MS = 2000;
const HEALTH_POLL_MAX_ATTEMPTS = 15; // bounded: max ~30s total
const HEALTH_POLL_TIMEOUT_MS = 3000;

function findPm2AppName() {
  const result = spawnSync('pm2', ['jlist'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    const apps = JSON.parse(String(result.stdout || '[]'));
    const match = apps.find((app) => {
      const cwd = path.resolve(String(app?.pm2_env?.pm_cwd || ''));
      const script = String(app?.pm2_env?.pm_exec_path || '');
      return cwd === path.resolve(REPO_ROOT) && path.basename(script).toLowerCase() === 'app-customer.js';
    });
    return match?.name || null;
  } catch {
    return null;
  }
}

async function pollHealth() {
  for (let attempt = 0; attempt < HEALTH_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.get(HEALTH_CHECK_URL, { timeout: HEALTH_POLL_TIMEOUT_MS, validateStatus: (s) => s === 200 });
      if (res.status === 200) return { ok: true, attempts: attempt + 1 };
    } catch { /* not ready yet, retry */ }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return { ok: false, attempts: HEALTH_POLL_MAX_ATTEMPTS };
}

/**
 * Controlled restart via PM2 reload + bounded health polling. Never restarts
 * before install/migration are complete. Success ONLY if /health actually
 * returns 200 within the bounded window — a started process is not enough.
 */
async function restartAndHealthCheck() {
  const processName = findPm2AppName();
  if (!processName) {
    return { ok: false, error: 'PM2_NOT_FOUND', message: 'Proses PM2 untuk aplikasi ini tidak ditemukan.' };
  }
  recordState('restarting');
  const reload = spawnSync('pm2', ['reload', processName], { encoding: 'utf8' });
  if (reload.status !== 0) {
    return { ok: false, error: 'RESTART_FAILED', message: 'PM2 reload gagal.' };
  }
  recordState('health_check');
  const health = await pollHealth();
  if (!health.ok) {
    return { ok: false, error: 'HEALTH_CHECK_FAILED', message: `Aplikasi restart tetapi /health tidak sehat setelah ${HEALTH_POLL_MAX_ATTEMPTS} percobaan.` };
  }
  return { ok: true, attempts: health.attempts };
}

/**
 * Full production update: check → download → verify → backup → install →
 * report. Restart/health-check is left to the caller (route layer), matching
 * the existing PM2-reload pattern from Phase 10A.
 */
async function runUpdate() {
  if (runLock) return { ok: false, error: 'UPDATE_IN_PROGRESS' };
  runLock = true;
  const startedAt = new Date().toISOString();
  const fromVersion = readLocalVersion();
  let backupRoot = null;
  try {
    recordState('checking', { startedAt, fromVersion });
    const check = await checkForUpdate();
    if (!check.valid) { recordState('failed', { failureStage: 'checking', message: check.message || check.status }); return { ok: false, error: check.status, message: check.message }; }
    if (check.status === releaseVerifier.STATUS.SAME_VERSION) {
      recordState('success', { message: 'Sudah versi terbaru.', finishedAt: new Date().toISOString() });
      return { ok: true, noop: true, message: 'Sudah versi terbaru.' };
    }
    const metadata = check.metadata;
    const targetVersion = metadata.version;

    recordState('downloading', { targetVersion });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenradius-release-'));
    const archivePath = path.join(tmpDir, 'release.tar.gz');
    const dl = await downloadArtifact(metadata, archivePath, check.source);
    if (!dl.ok) { recordState('failed', { failureStage: 'downloading', message: dl.error }); fs.rmSync(tmpDir, { recursive: true, force: true }); return { ok: false, error: 'DOWNLOAD_FAILED', message: dl.error }; }

    recordState('verifying');
    const digestCheck = releaseVerifier.verifyArtifactDigest(metadata, { actualSize: dl.actualSize, actualSha256: dl.actualSha256 });
    if (!digestCheck.valid) { recordState('failed', { failureStage: 'verifying', message: digestCheck.message }); fs.rmSync(tmpDir, { recursive: true, force: true }); return { ok: false, error: digestCheck.status, message: digestCheck.message }; }

    recordState('backing_up');
    const backup = createVerifiedBackup();
    if (!backup.ok) { recordState('failed', { failureStage: 'backing_up', message: backup.error }); fs.rmSync(tmpDir, { recursive: true, force: true }); return { ok: false, error: 'BACKUP_FAILED', message: backup.error }; }
    backupRoot = backup.backupRoot;

    const extractDir = path.join(tmpDir, 'extracted');
    const extract = safeExtract(archivePath, extractDir);
    if (!extract.ok) { recordState('failed', { failureStage: 'verifying', message: extract.error }); fs.rmSync(tmpDir, { recursive: true, force: true }); return { ok: false, error: 'UNSAFE_ARTIFACT', message: extract.error }; }

    recordState('installing');
    try {
      installExtractedRelease(extractDir);
    } catch (e) {
      recordState('recovery_required', { failureStage: 'installing', message: e.message });
      const restored = restoreBackup(backupRoot);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(backupRoot, { recursive: true, force: true });
      backupRoot = null;
      return { ok: false, error: 'INSTALL_FAILED', message: e.message, recovered: restored.length > 0, applicationRollback: true, databaseRollback: false };
    }

    try { fs.writeFileSync(path.join(REPO_ROOT, 'version.txt'), targetVersion + os.EOL, 'utf8'); } catch { /* non-fatal */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(backupRoot, { recursive: true, force: true });
    backupRoot = null;

    // Application code is now installed. Restart + bounded health polling.
    // If PM2 isn't detected (e.g. non-PM2 deployment), report success but
    // require a manual restart — never silently skip verification.
    const restart = await restartAndHealthCheck();
    if (!restart.ok) {
      if (restart.error === 'PM2_NOT_FOUND') {
        recordState('success', { message: `Update selesai: ${fromVersion} \u2192 ${targetVersion}. PM2 tidak terdeteksi \u2014 restart manual diperlukan.`, targetVersion, finishedAt: new Date().toISOString() });
        return { ok: true, fromVersion, targetVersion, restarted: false, message: 'Update berhasil diinstall. PM2 tidak terdeteksi, silakan restart aplikasi secara manual.' };
      }
      // Code was installed but restart/health failed — NOT a full success.
      // Database is untouched (no migration ran in this path); this is an
      // application-level recovery situation, not a database rollback.
      recordState('recovery_required', { failureStage: restart.error === 'RESTART_FAILED' ? 'restarting' : 'health_check', message: restart.message, targetVersion });
      return { ok: false, error: restart.error, message: restart.message, fromVersion, targetVersion, applicationRollback: false, databaseRollback: false, recoveryRequired: true };
    }

    recordState('success', { message: `Update selesai: ${fromVersion} \u2192 ${targetVersion}. Restart+health check PASS.`, targetVersion, finishedAt: new Date().toISOString() });
    return { ok: true, fromVersion, targetVersion, restarted: true, healthAttempts: restart.attempts, message: 'Update berhasil: terinstall, restart, dan health check PASS.' };
  } catch (e) {
    recordState('failed', { failureStage: lastRun.state, message: e.message });
    return { ok: false, error: 'UNEXPECTED_FAILURE', message: e.message, backupPreserved: Boolean(backupRoot) };
  } finally {
    // NOTE: backupRoot is intentionally NOT deleted here when a failure left
    // it set (backing_up succeeded but a later unexpected error occurred) —
    // it is preserved on disk for manual recovery per Phase 10B backup policy.
    // Only the two explicit success/handled-failure paths above clear it.
    if (backupRoot) {
      logger.warn(`[ReleaseManager] Backup dipertahankan untuk pemulihan manual: ${backupRoot}`);
    }
    runLock = false;
  }
}

module.exports = {
  STATES,
  isConfigured,
  isGithubReleaseConfigured,
  getGithubRepoSlug,
  getStatus,
  checkForUpdate,
  runUpdate,
  readLocalVersion,
  __setTestRepoRoot,
  __setTestGithubApiBase
};
