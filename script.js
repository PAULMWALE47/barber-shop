const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector(".site-nav");
const bookingForm = document.querySelector(".booking-form");
const bookingMessage = document.querySelector(".form-message");
const dateInput = document.querySelector("#date");

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

bookingForm.addEventListener("submit", (event) => {
    event.preventDefault();
    bookingMessage.textContent = "Thanks! This sample form does not send your request yet. Connect a booking service to receive appointments.";
});

document.querySelector("#year").textContent = new Date().getFullYear();
