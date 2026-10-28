const rows = document.querySelector("#rows");
const message = document.querySelector("#message");
const search = document.querySelector("#search");
const statusFilter = document.querySelector("#status-filter");
const from = document.querySelector("#from");
const to = document.querySelector("#to");
let csrfToken = "";
let loadTimer;

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]);

async function request(url, options = {}) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (response.status === 401) window.location.replace("/admin/");
    if (!response.ok) throw new Error(body.error || "Request failed.");
    return body;
}

async function loadAppointments() {
    const parameters = new URLSearchParams();
    if (search.value) parameters.set("search", search.value);
    if (statusFilter.value) parameters.set("status", statusFilter.value);
    if (from.value) parameters.set("from", from.value);
    if (to.value) parameters.set("to", to.value);

    try {
        message.textContent = "";
        const data = await request(`/api/admin/appointments?${parameters}`);
        document.querySelector("#total").textContent = data.stats.total ?? 0;
        document.querySelector("#pending").textContent = data.stats.pending ?? 0;
        document.querySelector("#confirmed").textContent = data.stats.confirmed ?? 0;
        document.querySelector("#cancelled").textContent = data.stats.cancelled ?? 0;

        rows.innerHTML = data.appointments.length ? data.appointments.map((appointment) => `
            <tr>
              <td><strong>${escapeHtml(appointment.name)}</strong><br><small>${escapeHtml(appointment.phone)}</small></td>
              <td>${escapeHtml(appointment.service)}</td>
              <td>${escapeHtml(appointment.appointment_date)}</td>
              <td><span class="status ${escapeHtml(appointment.status)}">${escapeHtml(appointment.status)}</span></td>
              <td><div class="actions">
                <button class="confirm" data-id="${appointment.id}" data-status="confirmed" ${appointment.status !== "requested" ? "disabled" : ""}>Confirm</button>
                <button class="cancel" data-id="${appointment.id}" data-status="cancelled" ${appointment.status === "cancelled" ? "disabled" : ""}>Cancel</button>
              </div></td>
            </tr>`).join("") : '<tr><td colspan="5" class="empty">No appointments match these filters.</td></tr>';
    } catch (error) {
        message.textContent = error.message;
    }
}

async function updateAppointment(button) {
    button.disabled = true;
    try {
        await request(`/api/admin/appointments/${encodeURIComponent(button.dataset.id)}/status`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
            body: JSON.stringify({ status: button.dataset.status }),
        });
        await loadAppointments();
        message.textContent = "Appointment updated.";
    } catch (error) {
        message.textContent = error.message;
        button.disabled = false;
    }
}

rows.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-status]");
    if (button) updateAppointment(button);
});

[search, statusFilter, from, to].forEach((control) => control.addEventListener("input", () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadAppointments, 250);
}));

document.querySelector("#logout").addEventListener("click", async () => {
    try {
        await request("/api/admin/logout", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
            body: "{}",
        });
        window.location.replace("/admin/");
    } catch (error) {
        message.textContent = error.message;
    }
});

document.querySelector("#today").textContent = new Intl.DateTimeFormat(undefined, {
    dateStyle: "long",
}).format(new Date());

(async () => {
    try {
        const session = await request("/api/admin/session");
        csrfToken = session.csrfToken;
        await loadAppointments();
    } catch (error) {
        message.textContent = error.message;
    }
})();
