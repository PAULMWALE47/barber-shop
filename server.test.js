const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("./server");

async function listen(server) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("creates and validates an appointment", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "crown-cuts-"));
    const databasePath = path.join(directory, "appointments.sqlite");
    const server = createServer({ databasePath });
    const origin = await listen(server);

    try {
        const nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + 1);
        const appointmentDate = [
            nextDate.getFullYear(),
            String(nextDate.getMonth() + 1).padStart(2, "0"),
            String(nextDate.getDate()).padStart(2, "0"),
        ].join("-");

        const response = await fetch(`${origin}/api/appointments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "Alex Smith",
                phone: "+27 12 345 6789",
                service: "Fade & finish",
                appointmentDate,
            }),
        });

        assert.equal(response.status, 201);
        const body = await response.json();
        assert.equal(body.id, 1);
        assert.match(body.cancellationToken, /^[A-Za-z0-9_-]{43}$/);

        const database = new DatabaseSync(databasePath);
        const appointment = database.prepare("SELECT * FROM appointments WHERE id = ?").get(body.id);
        assert.equal(
            appointment.cancellation_token_hash,
            crypto.createHash("sha256").update(body.cancellationToken).digest("hex"),
        );
        assert.equal(appointment.name, "Alex Smith");
        assert.equal(appointment.appointment_date, appointmentDate);
        assert.equal(appointment.status, "requested");
        database.close();

        const invalidCancellation = await fetch(`${origin}/api/appointments/${body.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cancellationToken: "invalid-token" }),
        });
        assert.equal(invalidCancellation.status, 404);

        const cancellation = await fetch(`${origin}/api/appointments/${body.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cancellationToken: body.cancellationToken }),
        });
        assert.equal(cancellation.status, 200);
        assert.equal((await cancellation.json()).message, "Your appointment has been cancelled.");

        const verificationDatabase = new DatabaseSync(databasePath);
        assert.equal(
            verificationDatabase.prepare("SELECT status FROM appointments WHERE id = ?").get(body.id).status,
            "cancelled",
        );
        verificationDatabase.close();

        const replay = await fetch(`${origin}/api/appointments/${body.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cancellationToken: body.cancellationToken }),
        });
        assert.equal(replay.status, 404);

        const invalidResponse = await fetch(`${origin}/api/appointments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "", phone: "123", service: "Unknown", appointmentDate }),
        });
        assert.equal(invalidResponse.status, 422);
    } finally {
        await close(server);
        rmSync(directory, { recursive: true, force: true });
    }
});

test("adds customer cancellation tokens without replacing existing appointments", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "crown-cuts-migration-"));
    const databasePath = path.join(directory, "appointments.sqlite");
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
        CREATE TABLE appointments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            service TEXT NOT NULL,
            appointment_date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested', 'confirmed', 'cancelled')),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO appointments (name, phone, service, appointment_date)
        VALUES ('Existing Client', '5551234567', 'The classic cut', '2099-01-01');
    `);
    legacyDatabase.close();

    const server = createServer({ databasePath });
    const origin = await listen(server);
    try {
        const database = new DatabaseSync(databasePath);
        const existingAppointment = database.prepare("SELECT * FROM appointments WHERE id = 1").get();
        assert.equal(existingAppointment.name, "Existing Client");
        assert.equal(existingAppointment.status, "requested");
        assert.equal(existingAppointment.cancellation_token_hash, null);
        database.close();

        const response = await fetch(origin);
        assert.equal(response.status, 200);
    } finally {
        await close(server);
        rmSync(directory, { recursive: true, force: true });
    }
});

test("protects admin dashboard and updates appointment status", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "crown-cuts-admin-"));
    const databasePath = path.join(directory, "appointments.sqlite");
    const salt = crypto.randomBytes(16);
    const password = "A-secure-test-password-123!";
    const passwordHash = `scrypt$16384$${salt.toString("hex")}$${crypto.scryptSync(password, salt, 64, { N: 16384, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
    const server = createServer({ databasePath, adminUsername: "admin", adminPasswordHash: passwordHash });
    const origin = await listen(server);

    try {
        const dashboard = await fetch(`${origin}/admin`);
        assert.equal(dashboard.status, 200);
        assert.match(await dashboard.text(), /Admin sign in/);
        const encodedLogo = await fetch(`${origin}/images/ChatGPT%20Image%20Oct%202,%202026,%2010_00_04%20AM.png`);
        assert.equal(encodedLogo.status, 200);
        assert.match(encodedLogo.headers.get("content-type"), /^image\/png/);
        const encodedGalleryImage = await fetch(`${origin}/images/images%20%281%29.jpg`);
        assert.equal(encodedGalleryImage.status, 200);
        assert.match(encodedGalleryImage.headers.get("content-type"), /^image\/jpeg/);
        const mensShopImage = await fetch(`${origin}/images/images.jpg`);
        assert.equal(mensShopImage.status, 200);
        assert.match(mensShopImage.headers.get("content-type"), /^image\/jpeg/);
        for (const imagePath of [
            "/images/woman1%20%282%29.jpg",
            "/images/woman2%20%281%29.jpg",
            "/images/woman3%20%282%29.jpg",
            "/images/woman4%282%29.jpg",
        ]) {
            const image = await fetch(`${origin}${imagePath}`);
            assert.equal(image.status, 200);
            assert.match(image.headers.get("content-type"), /^image\/jpeg/);
        }

        const deniedList = await fetch(`${origin}/api/admin/appointments`);
        assert.equal(deniedList.status, 401);
        const deniedPage = await fetch(`${origin}/admin.js`);
        assert.equal(deniedPage.status, 401);
        const deniedStyles = await fetch(`${origin}/admin.css`);
        assert.equal(deniedStyles.status, 401);
        const deniedVoiceScript = await fetch(`${origin}/admin-voice-navigation.js`);
        assert.equal(deniedVoiceScript.status, 401);
        const publicVoiceScript = await fetch(`${origin}/voice-navigation.js`);
        assert.equal(publicVoiceScript.status, 200);
        assert.match(publicVoiceScript.headers.get("content-type"), /^text\/javascript/);
        const publicVoiceStyles = await fetch(`${origin}/voice-navigation.css`);
        assert.equal(publicVoiceStyles.status, 200);
        assert.match(publicVoiceStyles.headers.get("content-type"), /^text\/css/);
        const loginStyles = await fetch(`${origin}/admin-login.css`);
        assert.equal(loginStyles.status, 200);
        assert.match(loginStyles.headers.get("content-type"), /^text\/css/);

        const login = await fetch(`${origin}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "admin", password }),
        });

        assert.equal(login.status, 200);
        const cookie = login.headers.get("set-cookie").split(";")[0];
        assert.match(login.headers.get("set-cookie"), /HttpOnly/);
        assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
        assert.match(dashboard.headers.get("content-security-policy"), /style-src 'self'/);
        const { csrfToken } = await login.json();
        const adminVoiceScript = await fetch(`${origin}/admin-voice-navigation.js`, { headers: { Cookie: cookie } });
        assert.equal(adminVoiceScript.status, 200);
        const adminVoiceStyles = await fetch(`${origin}/admin-voice-navigation.css`, { headers: { Cookie: cookie } });
        assert.equal(adminVoiceStyles.status, 200);

        const database = new DatabaseSync(databasePath);
        const result = database.prepare(`
            INSERT INTO appointments (name, phone, service, appointment_date)
            VALUES (?, ?, ?, ?)
        `).run("Admin Test", "0123456789", "The classic cut", "2099-01-01");
        const id = Number(result.lastInsertRowid);
        database.close();

        const missingCsrf = await fetch(`${origin}/api/admin/appointments/${id}/status`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ status: "confirmed" }),
        });
        assert.equal(missingCsrf.status, 403);

        const update = await fetch(`${origin}/api/admin/appointments/${id}/status`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: cookie, "x-csrf-token": csrfToken },
            body: JSON.stringify({ status: "confirmed" }),
        });
        assert.equal(update.status, 200);

        const filtered = await fetch(`${origin}/api/admin/appointments?status=confirmed&search=Admin+Test`, {
            headers: { Cookie: cookie },
        });
        assert.equal(filtered.status, 200);
        const filteredBody = await filtered.json();
        assert.equal(filteredBody.appointments.length, 1);
        assert.equal(filteredBody.stats.confirmed, 1);

        const logout = await fetch(`${origin}/api/admin/logout`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie, "x-csrf-token": csrfToken },
            body: "{}",
        });
        assert.equal(logout.status, 200);
        const revoked = await fetch(`${origin}/api/admin/appointments`, { headers: { Cookie: cookie } });
        assert.equal(revoked.status, 401);
    } finally {
        await close(server);
        rmSync(directory, { recursive: true, force: true });
    }
});

test("requires production database and admin environment configuration", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        assert.throws(
            () => createServer({
                databaseUrl: "",
                adminUsername: "admin",
                adminPasswordHash: "scrypt$16384$" + "a".repeat(32) + "$" + "b".repeat(128),
            }),
            /DATABASE_URL must be configured in production/,
        );
        assert.throws(
            () => createServer({
                databaseUrl: "postgres://localhost/test",
                adminUsername: "",
                adminPasswordHash: "",
            }),
            /CROWN_CUTS_ADMIN_USERNAME and CROWN_CUTS_ADMIN_PASSWORD_HASH/,
        );
    } finally {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
    }
});

test("sets the Secure flag on admin session cookies in production", async () => {
    const salt = crypto.randomBytes(16);
    const password = "A-secure-test-password-123!";
    const passwordHash = `scrypt$16384$${salt.toString("hex")}$${crypto.scryptSync(password, salt, 64, { N: 16384, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let server;
    try {
        server = createServer({
            appointmentStore: { async close() {} },
            adminUsername: "admin",
            adminPasswordHash: passwordHash,
        });
    } finally {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
    }
    const origin = await listen(server);

    try {
        const response = await fetch(`${origin}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: "admin", password }),
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("set-cookie"), /;\s*Secure(?:;|$)/);

        const dashboard = await fetch(`${origin}/admin`, {
            headers: { Cookie: response.headers.get("set-cookie").split(";")[0] },
        });
        assert.equal(dashboard.status, 200);
        assert.match(dashboard.headers.get("set-cookie"), /;\s*Secure(?:;|$)/);
    } finally {
        await close(server);
    }
});

test("serves the website", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "crown-cuts-static-"));
    const server = createServer({ databasePath: path.join(directory, "appointments.sqlite") });
    const origin = await listen(server);

    try {
        const response = await fetch(origin);
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /^text\/html/);
        const html = await response.text();
        assert.match(html, /CROWN <strong>CUTS<\/strong>/);
        assert.match(html, /A finished natural hairstyle with twists and volume/);
        assert.equal((html.match(/class="gallery-item/g) || []).length, 7);
        assert.match(html, /Men’s cuts &amp; the shop/);
        assert.match(html, /src="images\/images\.jpg"/);
        assert.match(html, /images\/beforimages%20\(2\)\.jpg/);
        assert.match(html, /images\/beforeandafter\.jpg/);
        assert.match(html, /woman4%282%29\.jpg/);

        const privateFileResponse = await fetch(`${origin}/server.js`);
        assert.equal(privateFileResponse.status, 404);
    } finally {
        await close(server);
        rmSync(directory, { recursive: true, force: true });
    }
});
