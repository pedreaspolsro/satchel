// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Git for Windows' mintty. Launched with Daemonize=no / DaemonizeCommands=no: by default mintty
 * forks and the original process exits, which would leave us with a dead pid instead of the
 * window owner (verified with mintty 3.8.1: -D is something else entirely).
 * We set MSYSTEM/CHERE_INVOKING ourselves because git-bash.exe (the usual launcher) is bypassed.
 */
const fs = require('fs');
const path = require('path');
const { spawnProcess, scrubEnv } = require('./spawn');

function findMintty() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'usr', 'bin', 'mintty.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'usr', 'bin', 'mintty.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

module.exports = (cfg = {}, backend = null) => ({
  name: 'mintty',
  launch({ cwd, env = {}, title, command, shell }) {
    const exe = cfg.path || findMintty();
    if (!fs.existsSync(exe)) throw new Error(`mintty not found at "${exe}" (set terminal.path in config.json)`);
    const gitRoot = path.resolve(path.dirname(exe), '..', '..');
    const icon = cfg.icon || path.join(gitRoot, 'mingw64', 'share', 'git', 'git-for-windows.ico');
    const sh = shell || cfg.shell || '/usr/bin/bash';

    const args = ['-o', 'Daemonize=no', '-o', 'DaemonizeCommands=no', '-t', title || 'Satchel'];
    if (fs.existsSync(icon)) args.push('-i', icon);
    args.push(sh, '--login', '-i');
    // Run the profile command first, then drop into an interactive shell so the window survives it.
    if (command) args.push('-c', `${command}; exec ${sh} --login -i`);

    // Match what git-bash.exe sets up, so this shell is indistinguishable from a real Git Bash:
    //  - MSYSTEM=MINGW64 selects the 64-bit toolchain (the "MINGW64" shown in the prompt/title)
    //  - CHERE_INVOKING=1 keeps the shell in `cwd` instead of jumping to ~ (like "Git Bash Here")
    //  - EXEPATH points at the Git install root (git-bash.exe sets this; the bare mintty launch doesn't)
    const fullEnv = {
      ...scrubEnv(process.env), // drop agent-session leftovers; profile env below still wins
      MSYSTEM: process.env.MSYSTEM || 'MINGW64',
      CHERE_INVOKING: '1',
      EXEPATH: cfg.exepath || gitRoot,
      ...env,
    };
    return spawnProcess(backend, { exe, args, cwd, env: fullEnv });
  },
});
