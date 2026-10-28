const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector(".site-nav");
const bookingForm = document.querySelector(".booking-form");
const bookingMessage = document.querySelector(".form-message");
const cancelAppointmentButton = document.querySelector("#cancel-appointment");
const dateInput = document.querySelector("#date");
let cancellationDetails = null;

function closeMenu() {
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open navigation");
    navigation.classList.remove("is-open");
}

menuButton.addEventListener("click", () => {
    const isOpen = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!isOpen));
    menuButton.setAttribute("aria-label", isOpen ? "Open navigation" : "Close navigation");
    navigation.classList.toggle("is-open", !isOpen);
});

navigation.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeMenu);
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closeMenu();
    }
});

const today = new Date();
const localToday = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
].join("-");
dateInput.min = localToday;

bookingForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = bookingForm.querySelector("button[type='submit']");
    const formData = new FormData(bookingForm);
    submitButton.disabled = true;
    bookingMessage.textContent = "Saving your appointment request...";

    try {
        const response = await fetch("/api/appointments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: formData.get("name"),
                phone: formData.get("phone"),
                service: formData.get("service"),
                appointmentDate: formData.get("date"),
            }),
        });
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "We could not save your request.");
        }

        bookingMessage.textContent = `Thank you! ${result.message}`;
        cancellationDetails = {
            id: result.id,
            token: result.cancellationToken,
        };
        cancelAppointmentButton.hidden = false;
        cancelAppointmentButton.disabled = false;
        cancelAppointmentButton.textContent = "Cancel this appointment";
        bookingForm.reset();
    } catch (error) {
        bookingMessage.textContent = error.message;
    } finally {
        submitButton.disabled = false;
    }
});

cancelAppointmentButton.addEventListener("click", async () => {
    if (!cancellationDetails || !window.confirm("Are you sure you want to cancel this appointment?")) return;

    cancelAppointmentButton.disabled = true;
    bookingMessage.textContent = "Cancelling your appointment...";

    try {
        const response = await fetch(`/api/appointments/${encodeURIComponent(cancellationDetails.id)}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cancellationToken: cancellationDetails.token }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "We could not cancel this appointment.");

        bookingMessage.textContent = result.message;
        cancelAppointmentButton.textContent = "Appointment cancelled";
        cancellationDetails = null;
    } catch (error) {
        bookingMessage.textContent = error.message;
        cancelAppointmentButton.disabled = false;
    }
});

document.querySelector("#year").textContent = new Date().getFullYear();
