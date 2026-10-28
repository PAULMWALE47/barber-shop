const crypto = require("node:crypto");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const password = process.env.CROWN_CUTS_ADMIN_PASSWORD;
const username = process.env.CROWN_CUTS_ADMIN_USERNAME || "admin";
if (!password || password.length < 12) {
    console.error("Set CROWN_CUTS_ADMIN_PASSWORD to a password of at least 12 characters.");
    process.exit(1);
}

const salt = crypto.randomBytes(16);
const digest = crypto.scryptSync(password, salt, 64, { N: 16384, maxmem: 64 * 1024 * 1024 });
const config = {
    username,
    passwordHash: `scrypt$16384$${salt.toString("hex")}$${digest.toString("hex")}`,
};
if (process.argv.includes("--print-hash")) {
    console.log(config.passwordHash);
} else {
    const directory = path.join(__dirname, "data");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "admin.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log("Admin credentials configured securely. The password was not stored.");
}
