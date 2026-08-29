// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Builds dist/Satchel-win32-x64/Satchel.exe.
 * Packages into dist/.staging first and then replaces the contents of the final folder file by
 * file — never the folder itself — so a file-manager tab sitting in that folder (which locks it on
 * Windows) cannot break the build. Refuses to run while Satchel.exe is running.
 */
const fs = require('fs');
const path = require('path');
const mod = require('@electron/packager');
const packager = mod.packager || mod;

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const finalDir = path.join(out, 'Satchel-win32-x64');
const staging = path.join(out, '.staging');
const exe = path.join(finalDir, 'Satchel.exe');

/** Delete everything inside dir, keeping dir itself (and any subdir something holds open). */
function clearDir(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      clearDir(p);
      try { fs.rmdirSync(p); } catch { /* held open by a file manager - contents are gone, fine */ }
    } else {
      fs.rmSync(p, { force: true });
    }
  }
}

/** The runtime dependency closure from package.json (production deps + their transitive deps). */
function prodClosure(nmDir) {
  const rootDeps = Object.keys(require(path.join(root, 'package.json')).dependencies || {});
  const keep = new Set();
  const visit = (name) => {
    if (keep.has(name)) return;
    const dir = path.join(nmDir, ...name.split('/'));
    if (!fs.existsSync(dir)) return;
    keep.add(name);
    let pj = {};
    try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* */ }
    for (const d of Object.keys(pj.dependencies || {})) visit(d);
  };
  rootDeps.forEach(visit);
  return keep;
}

/**
 * electron-packager's `prune` leaves the devDependency tree in place here, so shipping the app
 * would include electron-packager's own build tooling. Keep only the production closure, and for
 * koffi drop the prebuilt binaries for platforms other than the one we are building for.
 */
function pruneModules(nmDir, platform, arch) {
  if (!fs.existsSync(nmDir)) return;
  const keep = prodClosure(nmDir);
  for (const entry of fs.readdirSync(nmDir)) {
    if (entry.startsWith('@')) {
      const scope = path.join(nmDir, entry);
      for (const sub of fs.readdirSync(scope)) if (!keep.has(`${entry}/${sub}`)) fs.rmSync(path.join(scope, sub), { recursive: true, force: true });
      try { if (fs.readdirSync(scope).length === 0) fs.rmdirSync(scope); } catch { /* */ }
    } else if (!keep.has(entry)) {
      fs.rmSync(path.join(nmDir, entry), { recursive: true, force: true }); // .bin, .package-lock.json, devDeps
    }
  }
  const koffiBuild = path.join(nmDir, 'koffi', 'build', 'koffi');
  if (fs.existsSync(koffiBuild)) {
    const wanted = `${platform}_${arch === 'x64' ? 'x64' : arch}`;
    for (const d of fs.readdirSync(koffiBuild)) if (d !== wanted) fs.rmSync(path.join(koffiBuild, d), { recursive: true, force: true });
  }
}

(async () => {
  if (fs.existsSync(exe)) {
    try { fs.closeSync(fs.openSync(exe, 'r+')); }
    catch { console.error('Satchel.exe is running (or locked) - close it and run the build again.'); process.exit(2); }
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const [built] = await packager({
    dir: root,
    name: 'Satchel',
    platform: 'win32',
    arch: 'x64',
    out: staging,
    overwrite: true,
    prune: true,
    executableName: 'Satchel',
    appBundleId: 'sk.pedrea.satchel', // application id (macOS bundle id; Windows AppUserModelId is set in main.js)
    icon: path.join(root, 'build', 'icon.ico'),
    win32metadata: { ProductName: 'Satchel', FileDescription: 'Satchel', CompanyName: 'PEDREA, spol. s r. o.' },
    ignore: [/^\/dist($|\/)/, /^\/test($|\/)/, /^\/build\/(make-icon|build)\.js$/, /^\/(satchel|build)\.bat$/, /^\/\.git($|\/)/, /^\/\.gitignore$/, /^\/LICENSE$/, /^\/package-lock\.json$/],
  });
  pruneModules(path.join(built, 'resources', 'app', 'node_modules'), 'win32', 'x64');
  fs.mkdirSync(finalDir, { recursive: true });
  clearDir(finalDir);
  fs.cpSync(built, finalDir, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  console.log(`Built ${exe}`);
})().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
