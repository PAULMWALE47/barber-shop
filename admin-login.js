const form = document.querySelector("#login-form");
const message = document.querySelector("#message");

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector("button");
    submit.disabled = true;
    message.textContent = "Signing in...";

    try {
        const response = await fetch("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        if (!response.ok) throw new Error((await response.json()).error);
        window.location.replace("/admin/");
    } catch (error) {
        message.textContent = error.message || "Sign in failed.";
        submit.disabled = false;
    }
});
