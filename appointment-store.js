function isAllowedStatusTransition(currentStatus, nextStatus) {
    return (currentStatus === "requested" && ["confirmed", "cancelled"].includes(nextStatus))
        || (currentStatus === "confirmed" && nextStatus === "cancelled");
}

function createSqliteAppointmentStore(database) {
    const insertAppointment = database.prepare(`
        INSERT INTO appointments (name, phone, service, appointment_date, cancellation_token_hash)
        VALUES (?, ?, ?, ?, ?)
    `);
    const cancelWithToken = database.prepare(`
        UPDATE appointments SET status = 'cancelled'
        WHERE id = ? AND cancellation_token_hash = ? AND status IN ('requested', 'confirmed')
    `);
    const listAppointments = database.prepare(`
        SELECT id, name, phone, service, appointment_date, status, created_at
        FROM appointments
        WHERE (? = '' OR status = ?)
          AND (? = '' OR name LIKE '%' || ? || '%' OR phone LIKE '%' || ? || '%' OR service LIKE '%' || ? || '%')
          AND (? = '' OR appointment_date >= ?)
          AND (? = '' OR appointment_date <= ?)
        ORDER BY appointment_date ASC, id ASC
    `);
    const appointmentStats = database.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'requested' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
        FROM appointments
    `);
    const getStatus = database.prepare("SELECT status FROM appointments WHERE id = ?");
    const updateStatus = database.prepare("UPDATE appointments SET status = ? WHERE id = ? AND status = ?");

    return {
        async createAppointment(appointment, cancellationTokenHash) {
            const result = insertAppointment.run(
                appointment.name,
                appointment.phone,
                appointment.service,
                appointment.appointmentDate,
                cancellationTokenHash,
            );
            return Number(result.lastInsertRowid);
        },
        async cancelAppointment(id, tokenHash) {
            return cancelWithToken.run(id, tokenHash).changes === 1;
        },
        async getDashboard(filters) {
            const { status, search, from, to } = filters;
            const appointments = listAppointments.all(
                status, status, search, search, search, search, from, from, to, to,
            );
            const rawStats = appointmentStats.get();
            const stats = Object.fromEntries(
                Object.entries(rawStats).map(([key, value]) => [key, Number(value || 0)]),
            );
            return { appointments, stats };
        },
        async updateAppointmentStatus(id, nextStatus) {
            const current = getStatus.get(id);
            if (!current) return { outcome: "not-found" };
            if (!isAllowedStatusTransition(current.status, nextStatus)) return { outcome: "conflict" };
            const result = updateStatus.run(nextStatus, id, current.status);
            return result.changes === 1 ? { outcome: "updated" } : { outcome: "conflict" };
        },
        async close() {
            database.close();
        },
    };
}

function createPostgresAppointmentStore(database) {
    return {
        async createAppointment(appointment, cancellationTokenHash) {
            const result = await database.query(`
                INSERT INTO appointments (name, phone, service, appointment_date, cancellation_token_hash)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id
            `, [
                appointment.name,
                appointment.phone,
                appointment.service,
                appointment.appointmentDate,
                cancellationTokenHash,
            ]);
            return result.rows[0].id;
        },
        async cancelAppointment(id, tokenHash) {
            const result = await database.query(`
                UPDATE appointments SET status = 'cancelled'
                WHERE id = $1 AND cancellation_token_hash = $2 AND status IN ('requested', 'confirmed')
                RETURNING id
            `, [id, tokenHash]);
            return result.rowCount === 1;
        },
        async getDashboard(filters) {
            const { status, search, from, to } = filters;
            const [appointments, rawStats] = await Promise.all([
                database.query(`
                    SELECT id, name, phone, service, appointment_date::text AS appointment_date, status, created_at
                    FROM appointments
                    WHERE ($1 = '' OR status = $1)
                      AND ($2 = '' OR name ILIKE '%' || $2 || '%' OR phone ILIKE '%' || $2 || '%' OR service ILIKE '%' || $2 || '%')
                      AND ($3::date IS NULL OR appointment_date >= $3::date)
                      AND ($4::date IS NULL OR appointment_date <= $4::date)
                    ORDER BY appointment_date ASC, id ASC
                `, [status, search, from || null, to || null]),
                database.query(`
                    SELECT
                        COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE status = 'requested')::int AS pending,
                        COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
                        COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
                    FROM appointments
                `),
            ]);
            return {
                appointments: appointments.rows,
                stats: Object.fromEntries(
                    Object.entries(rawStats.rows[0]).map(([key, value]) => [key, Number(value)]),
                ),
            };
        },
        async updateAppointmentStatus(id, nextStatus) {
            const current = await database.query("SELECT status FROM appointments WHERE id = $1", [id]);
            if (current.rowCount === 0) return { outcome: "not-found" };
            if (!isAllowedStatusTransition(current.rows[0].status, nextStatus)) return { outcome: "conflict" };

            const result = await database.query(`
                UPDATE appointments SET status = $1
                WHERE id = $2 AND status = $3
                RETURNING id
            `, [nextStatus, id, current.rows[0].status]);
            return result.rowCount === 1 ? { outcome: "updated" } : { outcome: "conflict" };
        },
        async close() {
            if (typeof database.end === "function") await database.end();
        },
    };
}

module.exports = { createPostgresAppointmentStore, createSqliteAppointmentStore };
