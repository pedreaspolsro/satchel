// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
/**
 * macOS backend — NOT IMPLEMENTED YET (stub, status-only mode).
 *
 * What it will take:
 *   - listing windows + titles: CGWindowListCopyWindowInfo (titles need the Screen Recording
 *     permission on macOS >= 10.15) or the Accessibility API (AXUIElement, needs Accessibility permission).
 *   - focus / move: Accessibility API (AXRaise, kAXPositionAttribute / kAXSizeAttribute), or
 *     `osascript` against System Events as a slow but dependency-free fallback.
 *   - Terminal.app / iTerm2 are single-process apps with many windows, so sessions must be matched
 *     by a title token (SATCHEL_ID echoed into the initial title) rather than by pid.
 * Until then: launching and hook events work, window operations do not.
 */
const noop = require('./noop');

module.exports = { ...noop, name: 'darwin-stub' };
