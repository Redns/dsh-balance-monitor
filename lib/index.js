/**
 * dsh-balance-monitor — host half.
 *
 * Routes used by the browser half:
 *
 *   GET  /balance-monitor/health   — diagnostics (carrier, node, version, last
 *                                    error). The only route that answers
 *                                    without the loopback token.
 *   GET  /balance-monitor/balance  — resolve DEEPSEEK_API_KEY through the
 *                                    `credentials` service, query the official
 *                                    DeepSeek balance API with the Node global
 *                                    fetch, and answer
 *                                    `{ balances, granted, toppedUp, spend,
 *                                       flag, balance, currency, error }`.
 *                                    Successful reads append a history sample
 *                                    and fold the real spend into the ledger.
 *   GET  /balance-monitor/config   — `{ config, history, stats, lastError }`.
 *   POST /balance-monitor/config   — JSON patch of parameters, validated +
 *                                    clamped, persisted, same body back.
 *   POST /balance-monitor/reset    — clear history / spend ledger / errors
 *                                    (`{ keepConfig }`, default true).
 *
 * Persistence deliberately does NOT use the DSH settings seam: the browser
 * settings wire only exposes an allowlisted set of namespaces, and a
 * third-party namespace answers `settings-not-exposed`. A private JSON file
 * (`<dsh home>/.balance-monitor.json`) keeps the plugin self-contained and
 * survives app upgrades.
 *
 * Both request surfaces are supported. Web profile: `webServer` exists and the
 * routes are registered on it (same-origin relative paths). Electron Desktop:
 * the composition never loads `dsh-host-webserver`, so the plugin starts its
 * own loopback HTTP server bound to 127.0.0.1 with a per-process token and
 * publishes `window.__BALANCE_MONITOR_HOST__ = { origin, token, ports }`
 * through the `webserver/index-inject` hook for the browser half.
 *
 * Only Node builtins are imported here: a plugin installed by symlink or by
 * pnpm does not necessarily resolve `@deepseek-ai/*` bare imports from its
 * realpath.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Parameters & persistence
// ---------------------------------------------------------------------------

export const VERSION = "1.2.1";

const DEFAULTS = Object.freeze({
    showBadge: true, // 显示侧边栏余额徽章
    autoRefresh: true, // 自动按间隔刷新余额
    refreshInterval: 30, // 自动刷新间隔（秒）
    showRefreshButton: true, // 徽章右侧显示手动刷新按钮
    showTrend: true, // 「余额监控」页显示趋势曲线
    displayCurrency: "auto", // 'auto'（CNY 优先，否则第一个）或具体货币码（如 'USD'）
    icon: "wallet", // 余额行图标；必须属于下面的 ICON_IDS
    rollDuration: 0.85, // 数字滚动动画时长（秒）
    rollStagger: 0.04, // 相邻数位开始滚动的间隔（秒），0 = 同时滚动
    showPhaseTag: true, // 余额行显示「高峰 / 低谷 / 周末」时段标签
    currencySymbol: "after", // 货币符号位置：after（12.69￥）/ before（￥12.69）/ none（不显示）
});

const REFRESH_MIN = 5;
const REFRESH_MAX = 3600;
const ROLL_MIN = 0.3;
const ROLL_MAX = 3;
const STAGGER_MIN = 0;
const STAGGER_MAX = 0.2;
/** Where the currency mark is drawn relative to the amount. */
const SYMBOL_POSITIONS = ["after", "before", "none"];
const HISTORY_LIMIT = 1440;
/** Currency code shape: 2-8 uppercase letters (ISO 4217 style). */
const CURRENCY_PATTERN = /^[A-Z]{2,8}$/;

// ---------------------------------------------------------------------------
// Peak / off-peak pricing windows (DeepSeek 峰谷定价)
//
// All arithmetic is done in UTC and shifted by a fixed +08:00, so the answer
// does not depend on the host machine's timezone, locale, DST rules, or the
// browser's clock — only on the real instant.
// ---------------------------------------------------------------------------

/** Beijing is a fixed UTC+8 offset (no DST). */
const BEIJING_OFFSET_MS = 8 * 3600000;
/** Peak windows in minutes-from-midnight, Beijing time: 09:00-12:00, 14:00-18:00. */
const PEAK_WINDOWS = [
    [540, 720],
    [840, 1080],
];
/**
 * Weekend-all-day-off-peak effective instant (2026-08-23 00:00 Beijing
 * = 2026-08-22T16:00:00Z). Before it, weekends priced like weekdays.
 */
const WEEKEND_IDLE_SINCE = Date.parse("2026-08-22T16:00:00Z");

/** Beijing-time weekday of an instant: 0 = Sunday, 6 = Saturday. */
function beijingDay(at) {
    return new Date(at + BEIJING_OFFSET_MS).getUTCDay();
}

/** Minutes from Beijing midnight of an instant. */
function beijingMinutes(at) {
    const shifted = new Date(at + BEIJING_OFFSET_MS);
    return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/**
 * Current pricing phase.
 *
 * 低谷/周末 = off-peak (half price), 高峰 = peak. Since 2026-08-23 weekends are
 * off-peak for the whole day instead of keeping the weekday peak windows.
 *
 * @param at - instant in ms (defaults to now).
 * @returns `{ phase, label, hint, dateKey, minute }` — `label` is the 2-character
 *          badge text, `hint` the full wording, and `minute` lets a client
 *          decide when to re-check.
 */
function pricingPhase(at = Date.now()) {
    const day = beijingDay(at);
    const minute = beijingMinutes(at);
    const weekend = (day === 0 || day === 6) && at >= WEEKEND_IDLE_SINCE;
    const peak = !weekend && PEAK_WINDOWS.some(([from, to]) => minute >= from && minute < to);
    if (peak) {
        return {
            phase: "peak",
            label: "高峰",
            hint: "高峰时段（北京时间 9:00-12:00、14:00-18:00，价格约为低谷的 2 倍）",
            dateKey: new Date(at + BEIJING_OFFSET_MS).toISOString().slice(0, 10),
            minute,
        };
    }
    if (weekend) {
        return {
            phase: "weekend-idle",
            label: "周末",
            hint: "周末全天低谷价（2026-08-23 起生效，约半价）",
            dateKey: new Date(at + BEIJING_OFFSET_MS).toISOString().slice(0, 10),
            minute,
        };
    }
    return {
        phase: "idle",
        label: "低谷",
        hint: "低谷时段（约半价）",
        dateKey: new Date(at + BEIJING_OFFSET_MS).toISOString().slice(0, 10),
        minute,
    };
}

/** Force an exact instant for tests; a non-finite override uses the real clock. */
function phaseAt(override) {
    return pricingPhase(Number.isFinite(override) ? override : Date.now());
}

/** Exported for the host tests: pricingPhase() is otherwise time-of-day bound. */
export const pricingPhaseForTest = phaseAt;
/**
 * Accepted `icon` values — MUST stay in sync with the ICONS collection in
 * lib/client.js. The browser half renders every collected glyph, so a value the
 * host rejects here shows up as a picker that silently refuses to save; keep
 * this list a superset of the client collection.
 */
const ICON_IDS = [
    "coin",
    "coins",
    "bag",
    "sack",
    "wallet",
    "purse",
    "card",
    "yuan",
    "dollar",
    "euro",
    "pound",
    "bank",
    "safe",
    "safe2",
    "safe3",
    "chart",
    "tag",
    "gift",
    "shopping",
];

/** API response cache window shared by every connected client. */
const FETCH_CACHE_MS = 5000;

const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** `<dsh home>`: DSH_HOME wins, then the platform home fallback used by dsh-home-paths. */
function dshHome() {
    const fromEnv = process.env.DSH_HOME;
    if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
    const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
    return join(home, ".dsh");
}

const STATE_FILE = join(dshHome(), ".balance-monitor.json");
const LOG_FILE = join(dshHome(), ".balance-monitor.log");

/** Append one diagnostic line; never throws. */
function monitorLog(message) {
    try {
        appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // diagnostics must never break the plugin
    }
}

/** Defaults plus a fresh, empty account ledger. */
function freshState() {
    return {
        config: { ...DEFAULTS },
        history: [], // [{ t, balances: { CNY: 12.54 } }]
        spend: { CNY: 0, USD: 0 }, // real billed spend accumulated from granted - balance
        ledger: null, // { currency, granted, latest } baseline for the spend accumulator
        lastError: null,
        lastAttempt: null,
        lastSuccess: null,
    };
}

let cached = null;
let loading = null;

/** Read + parse the state file, merging it over the defaults. Never throws. */
async function loadState() {
    if (cached !== null) return cached;
    if (loading !== null) return loading;
    loading = (async () => {
        const next = freshState();
        try {
            const text = await readFile(STATE_FILE, "utf8");
            const parsed = JSON.parse(text);
            if (parsed !== null && typeof parsed === "object") {
                if (
                    parsed.config !== null &&
                    typeof parsed.config === "object"
                ) {
                    Object.assign(
                        next.config,
                        sanitizeConfig(parsed.config).value ?? {},
                    );
                }
                if (Array.isArray(parsed.history))
                    next.history = parsed.history
                        .filter(isHistorySample)
                        .slice(-HISTORY_LIMIT);
                if (parsed.spend !== null && typeof parsed.spend === "object") {
                    next.spend = {
                        CNY: Number(parsed.spend.CNY) || 0,
                        USD: Number(parsed.spend.USD) || 0,
                    };
                }
                if (parsed.ledger !== null && typeof parsed.ledger === "object")
                    next.ledger = parsed.ledger;
                if (typeof parsed.lastError === "string")
                    next.lastError = parsed.lastError;
                if (typeof parsed.lastAttempt === "number")
                    next.lastAttempt = parsed.lastAttempt;
                if (typeof parsed.lastSuccess === "number")
                    next.lastSuccess = parsed.lastSuccess;
            }
        } catch (err) {
            // A missing file is the normal first run; a corrupt one must not be fatal.
            if (
                err !== null &&
                typeof err === "object" &&
                err.code !== "ENOENT"
            ) {
                monitorLog(`state read failed: ${describe(err)}`);
            }
        }
        cached = next;
        return cached;
    })();
    try {
        return await loading;
    } finally {
        loading = null;
    }
}

/** One history sample: a timestamp and a non-empty currency→amount map. */
function isHistorySample(entry) {
    if (
        entry === null ||
        typeof entry !== "object" ||
        typeof entry.t !== "number"
    )
        return false;
    return entry.balances !== null && typeof entry.balances === "object";
}

/** Serialize the state file next to its final name, then rename over it. */
async function persist() {
    const state = cached;
    if (state === null) return;
    try {
        await mkdir(dshHome(), { recursive: true });
        const body = JSON.stringify(
            {
                version: 1,
                config: state.config,
                history: state.history,
                spend: state.spend,
                ledger: state.ledger,
                lastError: state.lastError,
                lastAttempt: state.lastAttempt,
                lastSuccess: state.lastSuccess,
            },
            null,
            2,
        );
        const temp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temp, body, "utf8");
        await rename(temp, STATE_FILE);
    } catch (err) {
        monitorLog(`state write failed: ${describe(err)}`);
    }
}

/** Coalesce bursts of writes into one atomic file write. */
let persistTimer = null;
function persistSoon() {
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void persist();
    }, 250);
}

/** Human-readable message for an unknown thrown value. */
function describe(err) {
    if (err === null || typeof err !== "object") return String(err);
    return typeof err.message === "string" ? err.message : String(err);
}

/**
 * Validate + clamp one config patch.
 * @returns `{ ok: true, value }` with only the recognised keys, or
 *          `{ ok: false, error }` naming the first rejected field.
 */
function sanitizeConfig(patch) {
    const value = {};
    if (patch === null || typeof patch !== "object")
        return { ok: false, error: "config patch must be an object" };
    if (patch.showBadge !== undefined) {
        if (typeof patch.showBadge !== "boolean")
            return { ok: false, error: "showBadge must be a boolean" };
        value.showBadge = patch.showBadge;
    }
    if (patch.autoRefresh !== undefined) {
        if (typeof patch.autoRefresh !== "boolean")
            return { ok: false, error: "autoRefresh must be a boolean" };
        value.autoRefresh = patch.autoRefresh;
    }
    if (patch.showRefreshButton !== undefined) {
        if (typeof patch.showRefreshButton !== "boolean")
            return { ok: false, error: "showRefreshButton must be a boolean" };
        value.showRefreshButton = patch.showRefreshButton;
    }
    if (patch.showTrend !== undefined) {
        if (typeof patch.showTrend !== "boolean")
            return { ok: false, error: "showTrend must be a boolean" };
        value.showTrend = patch.showTrend;
    }
    if (patch.refreshInterval !== undefined) {
        const n = Number(patch.refreshInterval);
        if (!Number.isFinite(n))
            return { ok: false, error: "refreshInterval must be a number" };
        value.refreshInterval = Math.round(
            Math.min(REFRESH_MAX, Math.max(REFRESH_MIN, n)),
        );
    }
    if (patch.displayCurrency !== undefined) {
        if (typeof patch.displayCurrency !== "string")
            return { ok: false, error: "displayCurrency must be a string" };
        if (
            patch.displayCurrency !== "auto" &&
            !CURRENCY_PATTERN.test(patch.displayCurrency)
        ) {
            return {
                ok: false,
                error: 'displayCurrency must be "auto" or an uppercase currency code',
            };
        }
        value.displayCurrency = patch.displayCurrency;
    }
    if (patch.icon !== undefined) {
        if (!ICON_IDS.includes(patch.icon))
            return {
                ok: false,
                error: `icon must be one of ${ICON_IDS.join(", ")}`,
            };
        value.icon = patch.icon;
    }
    if (patch.rollDuration !== undefined) {
        const n = Number(patch.rollDuration);
        if (!Number.isFinite(n))
            return { ok: false, error: "rollDuration must be a number" };
        value.rollDuration = Math.round(Math.min(ROLL_MAX, Math.max(ROLL_MIN, n)) * 100) / 100;
    }
    if (patch.rollStagger !== undefined) {
        const n = Number(patch.rollStagger);
        if (!Number.isFinite(n))
            return { ok: false, error: "rollStagger must be a number" };
        value.rollStagger = Math.round(Math.min(STAGGER_MAX, Math.max(STAGGER_MIN, n)) * 1000) / 1000;
    }
    if (patch.showPhaseTag !== undefined) {
        if (typeof patch.showPhaseTag !== "boolean")
            return { ok: false, error: "showPhaseTag must be a boolean" };
        value.showPhaseTag = patch.showPhaseTag;
    }
    if (patch.currencySymbol !== undefined) {
        if (!SYMBOL_POSITIONS.includes(patch.currencySymbol))
            return {
                ok: false,
                error: `currencySymbol must be one of ${SYMBOL_POSITIONS.join(", ")}`,
            };
        value.currencySymbol = patch.currencySymbol;
    }
    return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Account math + history
// ---------------------------------------------------------------------------

/** Round to fen (2 decimals) without float drift. */
function round2(n) {
    return Math.round(Number(n) * 100) / 100;
}

/** A finite number, or null — the balance API reports numbers as strings. */
function toNumber(value) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Fold one balance-API reading into the persisted spend ledger and history.
 *
 * The official API reports `total_balance = granted_balance + topped_up_balance`
 * per currency, plus one account-level `is_available` flag. It exposes no usage
 * history, so the only way to measure what has actually been billed is the
 * decrease of the total between two readings — every top-up therefore shows up
 * as a matching increase, which we subtract instead of counting as negative
 * spend.
 */
function recordReading(state, infos, balances, now, available) {
    for (const item of infos) {
        if (
            item === null ||
            typeof item !== "object" ||
            typeof item.currency !== "string"
        )
            continue;
        const total = toNumber(item.total_balance);
        if (total === null) continue;
        const entry = balances.find((b) => b.currency === item.currency);
        if (entry === undefined) continue;
        entry.granted = toNumber(item.granted_balance);
        entry.toppedUp = toNumber(item.topped_up_balance);
        entry.total = round2(total);
        entry.available = available;
    }

    // Per-currency spend ledger, keyed by the currency of the baseline reading.
    const ledger =
        state.ledger !== null && typeof state.ledger === "object"
            ? { ...state.ledger }
            : {};
    for (const item of balances) {
        const base = ledger[item.currency];
        if (
            base === undefined ||
            typeof base !== "number" ||
            !Number.isFinite(base)
        ) {
            ledger[item.currency] = item.balance;
            continue;
        }
        const delta = round2(base - item.balance);
        if (delta > 0) {
            state.spend[item.currency] = round2(
                (Number(state.spend[item.currency]) || 0) + delta,
            );
        }
        ledger[item.currency] = item.balance;
    }
    state.ledger = ledger;

    const snapshot = {};
    for (const item of balances) snapshot[item.currency] = item.balance;
    state.history.push({ t: now, balances: snapshot });
    if (state.history.length > HISTORY_LIMIT)
        state.history = state.history.slice(-HISTORY_LIMIT);
}

// ---------------------------------------------------------------------------
// Route carrier
//
// Web profile: the `webServer` service exists and the routes are registered on
// it. Electron Desktop: it does not, so the plugin serves the same routes from
// a loopback HTTP server and publishes the address to the renderer through the
// `webserver/index-inject` hook.
// ---------------------------------------------------------------------------

/** Loopback ports tried in order; also advertised so the client can probe. */
const LOOPBACK_PORTS = [
    17881, 17882, 17883, 17884, 17885, 17886, 17887, 17888, 17889, 17890,
];

/** Diagnostics of the active carrier, surfaced by GET /balance-monitor/health. */
const carrierDiagnostics = {
    kind: "none",
    origin: null,
    port: null,
    requests: 0,
    lastRequest: null,
    lastError: null,
    startedAt: Date.now(),
};

const CARRIER_CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-private-network": "true",
    "cache-control": "no-store",
};

/** Carrier backed by the real `webServer` service (Web profile). */
function createWebServerCarrier(webServer) {
    carrierDiagnostics.kind = "webServer";
    return {
        kind: "webServer",
        register: (route) => webServer.register(route),
    };
}

/**
 * Carrier backed by a loopback HTTP server (Electron Desktop).
 * @param ctx - plugin context (used for the index-injection hook).
 */
function createLoopbackCarrier(ctx) {
    const token = randomBytes(24).toString("hex");
    const exact = new Map();
    carrierDiagnostics.kind = "loopback";

    const authorized = (req, url) => {
        const header = req.headers.authorization;
        if (typeof header === "string" && header === `Bearer ${token}`)
            return true;
        return url.searchParams.get("token") === token;
    };

    const serve = (req, res, url) => {
        carrierDiagnostics.requests += 1;
        carrierDiagnostics.lastRequest = `${req.method} ${url.pathname}`;
        if (req.method === "OPTIONS") {
            res.writeHead(204, CARRIER_CORS);
            res.end();
            return;
        }
        // /health carries no account data and makes the carrier discoverable
        // locally (the browser half probes it when the injection is missing).
        const isHealth = url.pathname === "/balance-monitor/health";
        if (!isHealth && !authorized(req, url)) {
            res.writeHead(403, {
                ...CARRIER_CORS,
                "content-type": "application/json",
            });
            res.end(JSON.stringify({ error: "forbidden" }));
            return;
        }
        const handler = exact.get(url.pathname);
        if (handler === undefined) {
            res.writeHead(404, {
                ...CARRIER_CORS,
                "content-type": "application/json",
            });
            res.end(JSON.stringify({ error: "not found" }));
            return;
        }
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (status, headers) =>
            writeHead(status, { ...CARRIER_CORS, ...(headers ?? {}) });
        Promise.resolve(handler(req, res)).catch((err) => {
            carrierDiagnostics.lastError = describe(err);
            monitorLog(
                `route ${url.pathname} failed: ${carrierDiagnostics.lastError}`,
            );
            if (!res.headersSent)
                res.writeHead(500, {
                    ...CARRIER_CORS,
                    "content-type": "application/json",
                });
            if (!res.writableEnded)
                res.end(JSON.stringify({ error: "internal" }));
        });
    };

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        serve(req, res, url);
    });

    /**
     * Bind the first free port in LOOPBACK_PORTS, in order.
     * @returns true when the server is listening.
     */
    const bindNextFreePort = (index) =>
        new Promise((settle) => {
            if (index >= LOOPBACK_PORTS.length) {
                carrierDiagnostics.lastError = `loopback ports ${LOOPBACK_PORTS[0]}-${LOOPBACK_PORTS[LOOPBACK_PORTS.length - 1]} are all in use`;
                monitorLog(carrierDiagnostics.lastError);
                settle(false);
                return;
            }
            const port = LOOPBACK_PORTS[index];
            const onError = () => {
                server.removeListener("listening", onListening);
                settle(false);
            };
            const onListening = () => {
                server.removeListener("error", onError);
                carrierDiagnostics.origin = `http://127.0.0.1:${port}`;
                carrierDiagnostics.port = port;
                monitorLog(
                    `loopback carrier listening on ${carrierDiagnostics.origin}`,
                );
                settle(true);
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(port, "127.0.0.1");
        });

    // Ports are tried strictly in order, so the search is sequential rather than
    // racing every port at once.
    const startCarrier = (async () => {
        for (let index = 0; index < LOOPBACK_PORTS.length; index += 1) {
            if (await bindNextFreePort(index)) return true;
        }
        return false;
    })();

    // Publish address + token to the renderer through the structured injection
    // table the host renders into index.html. The `global` row kind is the
    // documented shape (`{ kind: 'global', name, value }`); an ad-hoc row object
    // makes renderRow() throw and the whole page render fail.
    const disposeInject = ctx.on("webserver/index-inject", (rows) => {
        rows.push({
            kind: "global",
            name: "__BALANCE_MONITOR_HOST__",
            value: {
                origin: carrierDiagnostics.origin,
                token,
                ports: LOOPBACK_PORTS,
            },
        });
    });

    return {
        kind: "loopback",
        /** Resolves once listening (or once every port is exhausted). */
        ready: startCarrier,
        register: (route) => {
            exact.set(route.path, route.handler);
            return () => {
                exact.delete(route.path);
            };
        },
        /**
         * Stop listening and unhook the injection. Without this, a profile reload
         * (HMR after a plugin edit) would leave every previously bound port in
         * LOOPBACK_PORTS owned by a dead-but-listening server until the app exits.
         */
        dispose: () => {
            if (typeof disposeInject === "function") disposeInject();
            server.close();
        },
    };
}

/** Pick the carrier this composition actually provides. */
function createCarrier(ctx) {
    const webServer = ctx.get("webServer");
    if (webServer !== undefined && typeof webServer.register === "function")
        return createWebServerCarrier(webServer);
    monitorLog("webServer service is absent — using the loopback carrier");
    return createLoopbackCarrier(ctx);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res, body, status = 200) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(body));
}

/** Read + parse a JSON request body, or null when it is absent/invalid. */
function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > 65536) {
                resolve(null);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (chunks.length === 0) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                resolve(null);
            }
        });
        req.on("error", () => resolve(null));
    });
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/** Last successful /balance body, reused inside FETCH_CACHE_MS. */
let lastRead = null; // { at, body }

/** Query the official balance API with an explicit, cancellable timeout. */
async function fetchBalancePayload(apiKey) {
    // AbortSignal.timeout() has no cancel path: its timer stays armed until it
    // fires, which keeps a handle alive after the response is already handled.
    // An explicit controller lets us clear it in both directions.
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new Error("timeout")),
        10000,
    );
    try {
        const response = await fetch(BALANCE_URL, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
        });
        const payload = await response.json();
        return { response, payload };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Query the official balance API for every currency on the account.
 * @returns the route body (never throws).
 */
async function readBalance(credentials, force) {
    const now = Date.now();
    if (!force && lastRead !== null && now - lastRead.at < FETCH_CACHE_MS) {
        // The stored body is reused, but `phase` is a property of the current
        // instant — refresh it so a cached read never reports a stale phase.
        return { ...lastRead.body, phase: pricingPhase(now) };
    }

    const state = await loadState();
    state.lastAttempt = now;
    let body;
    try {
        const cred = await credentials.resolve("DEEPSEEK_API_KEY");
        if (
            cred === undefined ||
            typeof cred.value !== "string" ||
            cred.value.length === 0
        ) {
            body = {
                balances: [],
                spend: state.spend,
                balance: null,
                currency: "CNY",
                error: "未找到 DEEPSEEK_API_KEY，请在 ~/.dsh/.credentials.yaml 中配置",
            };
            state.lastError = body.error;
            persistSoon();
            return body;
        }
        const { response, payload } = await fetchBalancePayload(cred.value);
        if (!response.ok) {
            const detail =
                payload !== null &&
                typeof payload === "object" &&
                typeof payload.error?.message === "string"
                    ? payload.error.message
                    : `HTTP ${response.status}`;
            body = {
                balances: [],
                spend: state.spend,
                balance: null,
                currency: "CNY",
                error: `余额接口返回错误：${detail}`,
            };
            state.lastError = body.error;
            persistSoon();
            return body;
        }
        const infos =
            payload !== null &&
            typeof payload === "object" &&
            Array.isArray(payload.balance_infos)
                ? payload.balance_infos
                : [];
        // Account-level availability: one flag for the whole account, not per row.
        const available =
            payload !== null &&
            typeof payload === "object" &&
            typeof payload.is_available === "boolean"
                ? payload.is_available
                : null;
        const balances = [];
        for (const item of infos) {
            if (
                item === null ||
                typeof item !== "object" ||
                typeof item.currency !== "string"
            )
                continue;
            const parsed = toNumber(item.total_balance);
            if (parsed === null) continue;
            balances.push({ currency: item.currency, balance: round2(parsed) });
        }
        // Stable ordering so the UI never reorders between refreshes: CNY first,
        // then the remaining currencies alphabetically.
        balances.sort((a, b) => {
            if (a.currency === "CNY") return b.currency === "CNY" ? 0 : -1;
            if (b.currency === "CNY") return 1;
            return a.currency < b.currency
                ? -1
                : a.currency > b.currency
                  ? 1
                  : 0;
        });
        const primary =
            balances.find((item) => item.currency === "CNY") ??
            balances[0] ??
            null;
        if (primary !== null) {
            recordReading(state, infos, balances, now, available);
            state.lastSuccess = now;
            state.lastError = null;
            persistSoon();
        } else {
            state.lastError = "余额接口未返回可用币种";
            persistSoon();
        }
        body = {
            balances,
            spend: {
                CNY: Number(state.spend.CNY) || 0,
                USD: Number(state.spend.USD) || 0,
            },
            available,
            // Peak/off-peak is a property of "now", not of the balance, so it is
            // recomputed on every read (including a cache hit below) rather than
            // cached alongside the numbers.
            phase: phaseAt(now),
            balance: primary === null ? null : primary.balance,
            currency: primary === null ? "CNY" : primary.currency,
            error: primary === null ? state.lastError : null,
        };
        lastRead = { at: now, body };
    } catch (err) {
        body = {
            balances: [],
            spend: state.spend,
            balance: null,
            currency: "CNY",
            error: `余额查询失败：${describe(err)}`,
        };
        state.lastError = body.error;
        persistSoon();
    }
    return body;
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

/**
 * The carrier created by the last {@link apply} call.
 *
 * The loopback carrier binds its port asynchronously and exposes `ready`, so a
 * harness can await the bind (or inspect the chosen origin) before probing. The
 * DSH host never needs this: routes are registered against the carrier object,
 * not against a live socket.
 * @returns the active carrier, or null before apply() ran.
 */
export function activeCarrier() {
    return activeCarrierRef;
}

let activeCarrierRef = null;

export function apply(ctx) {
    const credentials = ctx.get("credentials");
    if (credentials === undefined) {
        monitorLog("credentials service is absent — plugin idle");
        return;
    }
    const carrier = createCarrier(ctx);
    activeCarrierRef = carrier;
    monitorLog(`carrier=${carrier.kind} node=${process.versions.node}`);

    if (typeof carrier.dispose === "function") {
        ctx.effect(() => carrier.dispose, "balance-monitor: carrier disposal");
    }

    ctx.effect(
        () =>
            carrier.register({
                kind: "exact",
                path: "/balance-monitor/health",
                async handler(req, res) {
                    const state = await loadState();
                    json(res, {
                        ok: true,
                        version: VERSION,
                        transport: carrierDiagnostics.kind,
                        origin: carrierDiagnostics.origin,
                        port: carrierDiagnostics.port,
                        requests: carrierDiagnostics.requests,
                        lastRequest: carrierDiagnostics.lastRequest,
                        lastError:
                            carrierDiagnostics.lastError ?? state.lastError,
                        lastSuccess: state.lastSuccess,
                        uptimeMs: Date.now() - carrierDiagnostics.startedAt,
                        node: process.versions.node,
                        stateFile: STATE_FILE,
                    });
                },
            }),
        "balance-monitor: health route",
    );

    ctx.effect(
        () =>
            carrier.register({
                kind: "exact",
                path: "/balance-monitor/balance",
                async handler(req, res) {
                    // ?force=1 bypasses the short shared cache (manual refresh).
                    const url = new URL(req.url ?? "/", "http://127.0.0.1");
                    json(
                        res,
                        await readBalance(
                            credentials,
                            url.searchParams.get("force") === "1",
                        ),
                    );
                },
            }),
        "balance-monitor: balance route",
    );

    ctx.effect(
        () =>
            carrier.register({
                kind: "exact",
                path: "/balance-monitor/config",
                async handler(req, res) {
                    const state = await loadState();
                    if (req.method === "POST") {
                        const body = await readJsonBody(req);
                        const patch =
                            body !== null &&
                            typeof body === "object" &&
                            body.config !== undefined
                                ? body.config
                                : body;
                        const clean = sanitizeConfig(patch);
                        if (!clean.ok) {
                            json(res, { error: clean.error }, 400);
                            return;
                        }
                        state.config = { ...state.config, ...clean.value };
                        persistSoon();
                    }
                    json(res, {
                        config: state.config,
                        history: state.history,
                        spend: state.spend,
                        lastError: state.lastError,
                        lastSuccess: state.lastSuccess,
                        version: VERSION,
                    });
                },
            }),
        "balance-monitor: config route",
    );

    ctx.effect(
        () =>
            carrier.register({
                kind: "exact",
                path: "/balance-monitor/reset",
                async handler(req, res) {
                    if (req.method !== "POST") {
                        json(res, { error: "method not allowed" }, 405);
                        return;
                    }
                    const state = await loadState();
                    const body = await readJsonBody(req);
                    const keepConfig =
                        body === null ||
                        typeof body !== "object" ||
                        body.keepConfig !== false;
                    state.history = [];
                    state.spend = { CNY: 0, USD: 0 };
                    state.ledger = null;
                    state.lastError = null;
                    state.lastSuccess = null;
                    if (!keepConfig) state.config = { ...DEFAULTS };
                    lastRead = null;
                    persistSoon();
                    json(res, {
                        ok: true,
                        config: state.config,
                        history: state.history,
                        spend: state.spend,
                    });
                },
            }),
        "balance-monitor: reset route",
    );
}
