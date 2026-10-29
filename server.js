const http = require("node:http");
const crypto = require("node:crypto");
const process = require("node:process");
const { mkdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");
const { createPostgresAppointmentStore, createSqliteAppointmentStore } = require("./appointment-store");

const SESSION_COOKIE = "crown_cuts_admin";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const SCRYPT_COST = 16384;
const CSRF_HEADER = "x-csrf-token";

const publicDirectory = __dirname;
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
};

function createDatabase(databasePath) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(`
        CREATE TABLE IF NOT EXISTS appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            service TEXT NOT NULL,
            appointment_date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested', 'confirmed', 'cancelled')),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE INDEX IF NOT EXISTS appointments_date_idx
            ON appointments (appointment_date);
    `);
    const appointmentColumns = database.prepare("PRAGMA table_info(appointments)").all();
    if (!appointmentColumns.some((column) => column.name === "cancellation_token_hash")) {
        database.exec("ALTER TABLE appointments ADD COLUMN cancellation_token_hash TEXT");
    }
    database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS appointments_cancellation_token_idx
            ON appointments (cancellation_token_hash)
            WHERE cancellation_token_hash IS NOT NULL
    `);
    return database;
}

function sendJson(response, statusCode, payload, headers = {}) {
    response.writeHead(statusCode, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        ...headers,
    });
    response.end(JSON.stringify(payload));
}

function timingSafeEqualText(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length
        && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyPassword(password, storedHash) {
    if (!storedHash) return false;
    const match = /^scrypt\$([0-9]+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(storedHash);
    if (!match) return false;

    const [, costText, saltHex, hashHex] = match;
    const cost = Number(costText);
    if (!Number.isSafeInteger(cost) || cost < 16384 || cost > 65536) return false;

    try {
        const expected = Buffer.from(hashHex, "hex");
        const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, {
            N: cost,
            maxmem: 64 * 1024 * 1024,
        });
        return crypto.timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

function parseCookies(cookieHeader = "") {
    return Object.fromEntries(cookieHeader.split(";").map((part) => {
        const separator = part.indexOf("=");
        return separator < 0
            ? [part.trim(), ""]
            : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
    }).filter(([name]) => name));
}

function sessionCookie(value, expires, secure) {
    const attributes = [
        `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
        "HttpOnly",
        "SameSite=Strict",
        "Path=/",
        `Expires=${expires.toUTCString()}`,
        "Max-Age=28800",
    ];
    if (secure) attributes.push("Secure");
    return attributes.join("; ");
}

function sendAdminHtml(response, htmlPath, session, secureCookies) {
    const headers = {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    };
    if (session) headers["Set-Cookie"] = sessionCookie(session.id, session.expiresAt, secureCookies);
    response.writeHead(200, headers);
    response.end(readFileSync(htmlPath));
}

function serveAdminAsset(response, filename, contentType) {
    const filePath = path.join(__dirname, filename);
    response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'self'; script-src 'self';",
        "Content-Type": contentType,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(readFileSync(filePath));
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
            if (body.length > 16_384) {
                reject(new Error("Request body is too large"));
                request.destroy();
            }
        });
        request.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("Invalid JSON"));
            }
        });
        request.on("error", reject);
    });
}

function validateAppointment(value) {
    const allowedServices = new Set([
        "The classic cut",
        "Fade & finish",
        "Beard trim",
        "The full works",
    ]);
    const appointment = {
        name: typeof value.name === "string" ? value.name.trim() : "",
        phone: typeof value.phone === "string" ? value.phone.trim() : "",
        service: typeof value.service === "string" ? value.service.trim() : "",
        appointmentDate: typeof value.appointmentDate === "string" ? value.appointmentDate : "",
    };

    if (appointment.name.length < 2 || appointment.name.length > 80) {
        throw new Error("Name must be between 2 and 80 characters");
    }
    if (appointment.phone.length < 7 || appointment.phone.length > 30) {
        throw new Error("Phone number must be between 7 and 30 characters");
    }
    if (!allowedServices.has(appointment.service)) {
        throw new Error("Please choose a valid service");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(appointment.appointmentDate)) {
        throw new Error("Please choose a valid date");
    }

    const now = new Date();
    const today = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
    ].join("-");
    if (appointment.appointmentDate < today) {
        throw new Error("The appointment date cannot be in the past");
    }

    return appointment;
}

function serveStatic(response, pathname) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(pathname);
    } catch {
        sendJson(response, 404, { error: "Page not found" });
        return;
    }

    const requestedPath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
    const isPublicFile = requestedPath === "index.html"
        || requestedPath === "style.css"
        || requestedPath === "script.js"
        || requestedPath === "admin-login.js"
        || requestedPath === "admin-login.css"
        || requestedPath === "voice-navigation.js"
        || requestedPath === "voice-navigation.css"
        || (requestedPath.startsWith("images/") && /\.(?:jpg|png|webp)$/i.test(requestedPath));
    if (!isPublicFile) {
        sendJson(response, 404, { error: "Page not found" });
        return;
    }

    const filePath = path.resolve(publicDirectory, requestedPath);
    const imageDirectory = path.resolve(publicDirectory, "images");
    const isWithinPublicRoot = filePath.startsWith(`${publicDirectory}${path.sep}`);
    const isWithinImages = requestedPath.startsWith("images/")
        && filePath.startsWith(`${imageDirectory}${path.sep}`);
    if (!isWithinPublicRoot || (requestedPath.startsWith("images/") && !isWithinImages)) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
    }

    try {
        if (!statSync(filePath).isFile()) throw new Error("Not a file");
        const content = readFileSync(filePath);
        response.writeHead(200, {
            "Cache-Control": "no-cache",
            "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        });
        response.end(content);
    } catch {
        sendJson(response, 404, { error: "Page not found" });
    }
}

function createServer({
    databasePath = path.join(__dirname, "data", "appointments.sqlite"),
    databaseUrl = process.env.DATABASE_URL,
    appointmentStore,
    adminUsername = process.env.CROWN_CUTS_ADMIN_USERNAME || "",
    adminPasswordHash = process.env.CROWN_CUTS_ADMIN_PASSWORD_HASH || "",
} = {}) {
    const isProduction = process.env.NODE_ENV === "production";
    if (isProduction && !databaseUrl && !appointmentStore) {
        throw new Error("DATABASE_URL must be configured in production; SQLite fallback is disabled.");
    }
    if (isProduction && (!adminUsername || !adminPasswordHash)) {
        throw new Error("CROWN_CUTS_ADMIN_USERNAME and CROWN_CUTS_ADMIN_PASSWORD_HASH must be configured in production.");
    }
    if (isProduction && !/^scrypt\$(16384|32768|65536)\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(adminPasswordHash)) {
        throw new Error("CROWN_CUTS_ADMIN_PASSWORD_HASH is not a valid supported scrypt hash.");
    }

    let configuredAdminUsername = adminUsername;
    let configuredAdminPasswordHash = adminPasswordHash;
    if (!isProduction && (!configuredAdminUsername || !configuredAdminPasswordHash)) {
        try {
            const config = JSON.parse(readFileSync(path.join(__dirname, "data", "admin.json"), "utf8"));
            configuredAdminUsername ||= config.username;
            configuredAdminPasswordHash ||= config.passwordHash;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }

    const database = appointmentStore || (databaseUrl
        ? createPostgresAppointmentStore(new Pool({
            connectionString: databaseUrl,
            max: 10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 5_000,
        }))
        : createSqliteAppointmentStore(createDatabase(databasePath)));
    const sessions = new Map();

    function cleanupSessions(now = Date.now()) {
        for (const [id, session] of sessions) {
            if (session.expiresAt.getTime() <= now) sessions.delete(id);
        }
    }

    function currentSession(request) {
        cleanupSessions();
        const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (!sessionId || !sessions.has(sessionId)) return null;
        const session = sessions.get(sessionId);
        session.expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
        return session;
    }

    function requireAdmin(request, response) {
        const session = currentSession(request);
        if (!session) {
            sendJson(response, 401, { error: "Authentication required" });
            return null;
        }
        return session;
    }

    function requireCsrf(request, response, session) {
        if (timingSafeEqualText(request.headers[CSRF_HEADER] || "", session.csrfToken)) return true;
        sendJson(response, 403, { error: "Invalid security token" });
        return false;
    }

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, "http://localhost");

        if (request.method === "POST" && url.pathname === "/api/admin/login") {
            try {
                const credentials = await readJson(request);
                const username = typeof credentials.username === "string" ? credentials.username : "";
                const password = typeof credentials.password === "string" ? credentials.password : "";
                const loginValid = configuredAdminUsername && configuredAdminPasswordHash
                    && timingSafeEqualText(username, configuredAdminUsername)
                    && verifyPassword(password, configuredAdminPasswordHash);
                if (!loginValid) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    sendJson(response, 401, { error: "Invalid username or password" });
                    return;
                }

                cleanupSessions();
                const oldSessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
                if (oldSessionId) sessions.delete(oldSessionId);
                const session = {
                    id: crypto.randomBytes(32).toString("base64url"),
                    csrfToken: crypto.randomBytes(32).toString("base64url"),
                    expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
                };
                sessions.set(session.id, session);
                sendJson(response, 200, { csrfToken: session.csrfToken }, {
                    "Set-Cookie": sessionCookie(
                        session.id,
                        session.expiresAt,
                        isProduction || Boolean(request.socket.encrypted),
                    ),
                });
            } catch (error) {
                sendJson(response, error.message === "Invalid JSON" ? 400 : 422, { error: error.message });
            }
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/admin/logout") {
            const session = requireAdmin(request, response);
            if (!session) return;
            if (!requireCsrf(request, response, session)) return;
            sessions.delete(session.id);
            sendJson(response, 200, { ok: true }, {
                "Set-Cookie": sessionCookie(
                    "",
                    new Date(0),
                    isProduction || Boolean(request.socket.encrypted),
                ),
            });
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/admin/session") {
            const session = requireAdmin(request, response);
            if (!session) return;
            sendJson(response, 200, { csrfToken: session.csrfToken });
            return;
        }

        if (request.method === "GET" && url.pathname === "/api/admin/appointments") {
            const session = requireAdmin(request, response);
            if (!session) return;
            const status = url.searchParams.get("status") || "";
            const search = (url.searchParams.get("search") || "").slice(0, 80);
            const from = url.searchParams.get("from") || "";
            const to = url.searchParams.get("to") || "";
            if (!['', 'requested', 'confirmed', 'cancelled'].includes(status)
                || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from))
                || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
                sendJson(response, 400, { error: "Invalid filter" });
                return;
            }
            try {
                const dashboard = await database.getDashboard({ status, search, from, to });
                sendJson(response, 200, dashboard);
            } catch (error) {
                console.error("Unable to load appointments:", error.code || "database error");
                sendJson(response, 500, { error: "Unable to load appointments" });
            }
            return;
        }

        if (/^\/api\/admin\/appointments\/\d+\/status$/.test(url.pathname)) {
            const session = requireAdmin(request, response);
            if (!session) return;
            if (request.method !== "PATCH") {
                sendJson(response, 405, { error: "Method not allowed", Allow: "PATCH" });
                return;
            }
            if (!requireCsrf(request, response, session)) return;

            try {
                const id = Number(url.pathname.split("/")[4]);
                const body = await readJson(request);
                const status = typeof body.status === "string" ? body.status : "";
                if (!['confirmed', 'cancelled'].includes(status)) {
                    sendJson(response, 400, { error: "Invalid appointment status" });
                    return;
                }

                const result = await database.updateAppointmentStatus(id, status);
                if (result.outcome === "not-found") {
                    sendJson(response, 404, { error: "Appointment not found" });
                    return;
                }
                if (result.outcome === "conflict") {
                    sendJson(response, 409, { error: "Appointment cannot change to that status" });
                    return;
                }
                sendJson(response, 200, { id, status });
            } catch (error) {
                console.error("Unable to update appointment:", error.code || "database error");
                sendJson(response, error.message === "Invalid JSON" ? 400 : 500, {
                    error: error.message === "Invalid JSON" ? "Invalid JSON" : "Unable to update appointment",
                });
            }
            return;
        }

        if (url.pathname === "/admin" || url.pathname === "/admin/") {
            if (request.method !== "GET") {
                response.writeHead(405, { Allow: "GET" });
                response.end();
                return;
            }
            const session = currentSession(request);
            sendAdminHtml(
                response,
                path.join(__dirname, session ? "admin.html" : "admin-login.html"),
                session,
                isProduction || Boolean(request.socket.encrypted),
            );
            return;
        }

        if (request.method === "GET" && url.pathname === "/admin-login.js") {
            serveStatic(response, "/admin-login.js");
            return;
        }

        if (request.method === "GET" && [
            "/admin.js",
            "/admin.css",
            "/admin-voice-navigation.js",
            "/admin-voice-navigation.css",
        ].includes(url.pathname)) {
            if (!requireAdmin(request, response)) return;
            const isCss = url.pathname.endsWith(".css");
            const fileName = url.pathname.startsWith("/admin-voice-navigation.")
                ? `voice-navigation.${isCss ? "css" : "js"}`
                : url.pathname.slice(1);
            serveAdminAsset(response, fileName, isCss ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
            return;
        }

        if (request.method === "POST" && url.pathname === "/api/appointments") {
            let appointment;
            try {
                appointment = validateAppointment(await readJson(request));
            } catch (error) {
                const statusCode = error.message === "Invalid JSON" || error.message.includes("too large") ? 400 : 422;
                sendJson(response, statusCode, { error: error.message });
                return;
            }

            const cancellationToken = crypto.randomBytes(32).toString("base64url");
            const cancellationTokenHash = crypto.createHash("sha256").update(cancellationToken).digest("hex");
            try {
                const id = await database.createAppointment(appointment, cancellationTokenHash);
                sendJson(response, 201, {
                    id,
                    message: "Appointment request saved.",
                    cancellationToken,
                });
            } catch (error) {
                console.error("Unable to save appointment:", error.code || "database error");
                sendJson(response, 500, { error: "Unable to save appointment right now" });
            }
            return;
        }

        const cancellationMatch = /^\/api\/appointments\/(\d+)\/cancel$/.exec(url.pathname);
        if (cancellationMatch) {
            if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed", Allow: "POST" });
                return;
            }
            try {
                const id = Number(cancellationMatch[1]);
                const body = await readJson(request);
                const token = typeof body.cancellationToken === "string" ? body.cancellationToken : "";
                if (!Number.isSafeInteger(id) || id < 1 || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
                    sendJson(response, 404, { error: "Appointment could not be cancelled" });
                    return;
                }

                const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
                const cancelled = await database.cancelAppointment(id, tokenHash);
                if (!cancelled) {
                    sendJson(response, 404, { error: "Appointment could not be cancelled" });
                    return;
                }
                sendJson(response, 200, { message: "Your appointment has been cancelled." });
            } catch (error) {
                console.error("Unable to cancel appointment:", error.code || "database error");
                const statusCode = error.message === "Invalid JSON" || error.message.includes("too large") ? 400 : 500;
                sendJson(response, statusCode, {
                    error: statusCode === 400 ? error.message : "Unable to cancel appointment",
                });
            }
            return;
        }

        if (url.pathname.startsWith("/api/")) {
            sendJson(response, 404, { error: "API endpoint not found" });
            return;
        }

        if (request.method !== "GET" && request.method !== "HEAD") {
            sendJson(response, 405, { error: "Method not allowed" });
            return;
        }
        serveStatic(response, url.pathname);
    });

    server.on("close", () => {
        database.close().catch((error) => {
            console.error("Unable to close appointment database:", error.code || "database error");
        });
    });
    return server;
}

   if (require.main === module) {
    try {
        process.loadEnvFile(path.join(__dirname, ".env.local"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    const port = Number(process.env.PORT) || 3000;
    createServer().listen(port, () => {
        console.log(`Crown Cuts is running at http://localhost:${port}`);
    });
}

module.exports = {
    createDatabase,
    createPostgresAppointmentStore,
    createServer,
    validateAppointment,
};

if (process.env.VERCEL) {
    const vercelServer = createServer();
    module.exports = (request, response) => vercelServer.emit("request", request, response);
}