const process = require("node:process");
const { mkdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { backup, DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const projectDirectory = path.resolve(__dirname, "..");
const databaseDirectory = path.join(projectDirectory, "data");
const sqlitePath = path.join(databaseDirectory, "appointments.sqlite");
const migrationPath = path.join(projectDirectory, "migrations", "001-create-appointments.sql");
const requiredProjectId = "quiet-dust-10972876";
const requiredOrganizationId = "org-noisy-surf-10706331";

function loadLocalEnvironment() {
    try {
        process.loadEnvFile(path.join(projectDirectory, ".env.local"));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

function countStatuses(rows) {
    return rows.reduce((counts, row) => {
        counts[row.status] = (counts[row.status] || 0) + 1;
        return counts;
    }, {});
}

function sameAppointment(source, migrated) {
    return String(source.id) === String(migrated.id)
        && source.name === migrated.name
        && source.phone === migrated.phone
        && source.service === migrated.service
        && source.appointment_date === migrated.appointment_date
        && source.status === migrated.status
        && new Date(source.created_at).getTime() === new Date(migrated.created_at).getTime()
        && source.cancellation_token_hash === migrated.cancellation_token_hash;
}

async function main() {
    if (!process.argv.includes("--confirm-production")) {
        throw new Error("Production migration requires the explicit --confirm-production flag.");
    }

    loadLocalEnvironment();

    const neonContext = JSON.parse(readFileSync(path.join(projectDirectory, ".neon"), "utf8"));
    if (neonContext.projectId !== requiredProjectId
        || neonContext.orgId !== requiredOrganizationId
        || neonContext.branch !== "production") {
        throw new Error("Linked Neon context does not match the approved production project and branch.");
    }

    const connectionString = process.env.DATABASE_URL_UNPOOLED;
    if (!connectionString) throw new Error("DATABASE_URL_UNPOOLED is required for the migration.");
    const connectionUrl = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(connectionUrl.protocol)
        || connectionUrl.hostname.includes("-pooler")) {
        throw new Error("Use the direct, unpooled Neon PostgreSQL connection for migrations.");
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(databaseDirectory, `appointments-pre-neon-${timestamp}.sqlite`);
    mkdirSync(databaseDirectory, { recursive: true });

    const liveDatabase = new DatabaseSync(sqlitePath);
    try {
        await backup(liveDatabase, backupPath);
    } finally {
        liveDatabase.close();
    }

    const sqliteDatabase = new DatabaseSync(backupPath, { readOnly: true });
    const appointments = sqliteDatabase.prepare(`
        SELECT id, name, phone, service, appointment_date, status, created_at, cancellation_token_hash
        FROM appointments
        ORDER BY id
    `).all();
    sqliteDatabase.close();

    const sourceStatuses = countStatuses(appointments);
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
    const client = await pool.connect();
    let transactionStarted = false;

    try {
        await client.query("BEGIN");
        transactionStarted = true;

        const existingTable = await client.query("SELECT to_regclass('public.appointments') AS relation");
        if (existingTable.rows[0].relation) {
            throw new Error("public.appointments already exists. Migration stopped to avoid altering existing production data.");
        }

        const schema = readFileSync(migrationPath, "utf8");
        await client.query(schema);

        for (const appointment of appointments) {
            await client.query(`
                INSERT INTO public.appointments
                    (id, name, phone, service, appointment_date, status, created_at, cancellation_token_hash)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
                appointment.id,
                appointment.name,
                appointment.phone,
                appointment.service,
                appointment.appointment_date,
                appointment.status,
                appointment.created_at,
                appointment.cancellation_token_hash,
            ]);
        }

        const result = await client.query(`
            SELECT id, name, phone, service, appointment_date::text AS appointment_date, status, created_at, cancellation_token_hash
            FROM public.appointments
            ORDER BY id
        `);
        const migratedAppointments = result.rows;
        if (migratedAppointments.length !== appointments.length
            || migratedAppointments.some((row, index) => !sameAppointment(appointments[index], row))) {
            throw new Error("Post-migration record verification failed; transaction will be rolled back.");
        }

        const destinationStatuses = countStatuses(migratedAppointments);
        if (JSON.stringify(sourceStatuses) !== JSON.stringify(destinationStatuses)) {
            throw new Error("Post-migration status-count verification failed; transaction will be rolled back.");
        }

        const maximumId = appointments.reduce((maximum, appointment) => Math.max(maximum, appointment.id), 1);
        await client.query(`
            SELECT setval(
                pg_get_serial_sequence('public.appointments', 'id'),
                $1::bigint,
                $2::boolean
            )
        `, [maximumId, appointments.length > 0]);

        await client.query("COMMIT");
        transactionStarted = false;
        console.log(JSON.stringify({
            branch: neonContext.branch,
            backupPath: path.relative(projectDirectory, backupPath),
            sqliteAppointmentCount: appointments.length,
            migratedAppointmentCount: migratedAppointments.length,
            statusCounts: destinationStatuses,
            verification: "all appointment fields and status counts match",
        }, null, 2));
    } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        console.error(`Migration stopped safely: ${error.message}`);
        console.error(`SQLite data remains available at ${backupPath}.`);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(`Migration could not start: ${error.message}`);
    process.exitCode = 1;
});
