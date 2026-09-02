// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * Generic adapter driven by an argv template from config.json, e.g.
 *   { "type": "custom", "argv": ["alacritty", "--working-directory", "{cwd}", "--title", "{title}", "-e", "bash", "-lic", "{command}"] }
 *
 * Placeholders: {cwd} {title} {shell} {command}
 *   {command} expands to "<command>; exec <shell> -l -i" when a profile command is set,
 *   or to "exec <shell> -l -i" for a plain shell.
 */
const { spawnProcess, scrubEnv } = require('./spawn');

module.exports = (cfg = {}, backend = null) => ({
  name: 'custom',
  launch({ cwd, env = {}, title, command, shell }) {
    if (!Array.isArray(cfg.argv) || !cfg.argv.length) throw new Error('terminal.argv is not configured in config.json');
    const sh = shell || cfg.shell || process.env.SHELL || '/bin/bash';
    const cmd = command ? `${command}; exec ${sh} -l -i` : `exec ${sh} -l -i`;
    const vars = { cwd, title: title || 'Satchel', shell: sh, command: cmd };
    const argv = cfg.argv.map((a) => a.replace(/\{(cwd|title|shell|command)\}/g, (_, k) => vars[k]));
    return spawnProcess(backend, { exe: argv[0], args: argv.slice(1), cwd, env: { ...scrubEnv(process.env), ...env } });
  },
});
