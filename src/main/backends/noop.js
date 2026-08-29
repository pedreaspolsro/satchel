// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/** Fallback backend: sees nothing, can do nothing. Used on unsupported platforms. */
const notSupported = (op) => () => { throw new Error(`Window backend: ${op} is not supported on ${process.platform}`); };

module.exports = {
  name: 'noop',
  capabilities: { list: false, focus: false, move: false, dock: false },
  reserveEdge: () => null, // no screen-edge reservation: a docked panel is just an always-on-top strip
  releaseEdge: () => {},
  listWindows: () => [],
  processImage: () => null,
  processParents: () => new Map(),
  focus: notSupported('focus'),
  setBounds: notSupported('setBounds'),
  getBounds: () => null,
  minimize: notSupported('minimize'),
  restore: notSupported('restore'),
  raise: () => false,
  raiseAll: () => 0,
  isMinimized: () => false,
  close: notSupported('close'),
  foreground: () => null,
};
