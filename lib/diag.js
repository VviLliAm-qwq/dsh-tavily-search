/**
 * Bounded lifecycle log for dsh-web-tavily.
 *
 * The plugin declares `inject = ["web"]`, so on a host that never mounts the web
 * seam `apply()` stays parked — and a parked plugin is indistinguishable from
 * one that was never loaded unless the module says something at import time.
 * That is the whole reason this file exists.
 *
 * Same conventions as the other plugins in this ecosystem: one line per
 * lifecycle event, the host logger when there is one, a plugin-owned file under
 * `~/.dsh-tui/` capped at 128 KiB, and no file writes under `node --test`.
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Plugin-owned log path. */
export const DIAG_LOG = join(homedir(), '.dsh-tui', 'dsh-web-tavily.log');

/** Above this size the file is trimmed to its newest half. */
export const MAX_LOG_BYTES = 128 * 1024;

/** Append one line, trimming the file when it has grown past the cap. */
function appendLogLine(path, line) {
    try {
        if (statSync(path).size > MAX_LOG_BYTES) {
            writeFileSync(path, readFileSync(path, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2)));
        }
    }
    catch {
        // Missing or unreadable: the append below recreates it.
    }
    appendFileSync(path, line);
}

/**
 * Write one lifecycle line.
 *
 * @param ctx - Cordis context when there is one (`ctx.logger` is used if the
 *   host offers it); `undefined` at import time.
 * @param message - the line, without timestamp or level.
 * @param options.env - environment override (tests).
 */
export function diag(ctx, message, options = {}) {
    try {
        ctx?.logger?.info?.(`dsh-web-tavily: ${message}`);
    }
    catch {
        // Observability only; never let logging break the plugin.
    }
    const env = options.env ?? process.env;
    if (typeof env?.NODE_TEST_CONTEXT === 'string') return;
    try {
        appendLogLine(DIAG_LOG, `${new Date().toISOString()} info ${message}\n`);
    }
    catch {
        // An unwritable log path is not worth surfacing.
    }
}
