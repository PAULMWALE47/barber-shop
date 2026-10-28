(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mode = document.body.dataset.voiceNavigation || "public";
    const panel = document.createElement("section");
    panel.className = "voice-navigation";
    panel.setAttribute("aria-label", "Voice navigation");
    panel.innerHTML = `
        <p class="voice-navigation-title">Voice navigation</p>
        <button class="voice-navigation-toggle" type="button" aria-pressed="false">Start listening</button>
        <p class="voice-navigation-status" role="status" aria-live="polite">Microphone is off.</p>
        <p class="voice-navigation-help">Say “go to services”, “go to booking”, or “go to contact”.</p>
        <p class="voice-navigation-privacy">After you turn it on, voice commands stay active until you turn them off. Your browser’s speech service may process audio; Crown Cuts does not store it.</p>
    `;
    document.body.append(panel);

    const toggle = panel.querySelector(".voice-navigation-toggle");
    const status = panel.querySelector(".voice-navigation-status");
    const help = panel.querySelector(".voice-navigation-help");

    if (!SpeechRecognition) {
        toggle.disabled = true;
        status.textContent = "Voice navigation is not supported in this browser. Try a current version of Chrome or Edge.";
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = false;
    const preferenceKey = "crown-cuts-voice-navigation";
    let shouldListen = false;
    let isStarting = false;
    let restartTimer;

    if (mode === "admin") {
        help.textContent = "Say “show pending”, “show confirmed”, “search for [name or phone]”, or “clear search”.";
    }

    function navigatePublic(command) {
        const destinations = [
            { terms: ["home", "top", "start"], selector: "#home" },
            { terms: ["services", "service", "cuts"], selector: "#services" },
            { terms: ["story", "about", "our story"], selector: "#about" },
            { terms: ["gallery", "photos", "looks"], selector: "#gallery" },
            { terms: ["booking", "book", "appointment", "appointments"], selector: "#booking" },
            { terms: ["contact", "shop"], selector: "#contact" },
        ];
        const destination = destinations.find(({ terms }) => terms.some((term) =>
            command === term || command.includes(` ${term}`) || command.includes(`${term} `)));
        if (!destination) return false;

        document.querySelector(destination.selector)?.scrollIntoView({ behavior: "smooth" });
        status.textContent = `Opening ${destination.terms[0]}.`;
        return true;
    }

    function navigateAdmin(command) {
        const normalized = command
            .replace(/^(go to|open|show|navigate to|filter by)\s+/, "")
            .replace(/\s+appointments?$/, "")
            .trim();
        const filter = document.querySelector("#status-filter");
        const search = document.querySelector("#search");

        if (["", "all", "dashboard", "top"].includes(normalized)) {
            filter.value = "";
            filter.dispatchEvent(new Event("input", { bubbles: true }));
            document.querySelector(".panel")?.scrollIntoView({ behavior: "smooth" });
            status.textContent = "Showing all appointments.";
            return true;
        }

        const statuses = [
            { words: ["pending", "requested"], value: "requested" },
            { words: ["confirmed", "booked"], value: "confirmed" },
            { words: ["cancelled", "canceled"], value: "cancelled" },
        ];
        const selectedStatus = statuses.find(({ words }) => words.includes(normalized));
        if (selectedStatus) {
            filter.value = selectedStatus.value;
            filter.dispatchEvent(new Event("input", { bubbles: true }));
            status.textContent = `Showing ${selectedStatus.words[0]} appointments.`;
            return true;
        }

        if (normalized.startsWith("search for ")) {
            const query = normalized.slice("search for ".length).trim();
            if (!query) return false;
            search.value = query;
            search.dispatchEvent(new Event("input", { bubbles: true }));
            status.textContent = `Searching appointments for ${query}.`;
            return true;
        }

        if (["clear search", "clear filters"].includes(normalized)) {
            search.value = "";
            filter.value = "";
            document.querySelector("#from").value = "";
            document.querySelector("#to").value = "";
            [search, filter].forEach((control) =>
                control.dispatchEvent(new Event("input", { bubbles: true })));
            status.textContent = "Search and filters cleared.";
            return true;
        }

        return false;
    }

    recognition.addEventListener("result", (event) => {
        const command = event.results[0][0].transcript.toLowerCase().trim().replace(/[.!?]/g, "");
        const handled = mode === "admin" ? navigateAdmin(command) : navigatePublic(command);
        if (!handled) status.textContent = `Didn't recognize “${command}”. Try one of the suggested commands.`;
    });

    recognition.addEventListener("error", (event) => {
        const messages = {
            "not-allowed": "Microphone access was denied. Allow microphone access in your browser settings to use voice navigation.",
            "service-not-allowed": "The browser did not allow speech recognition. Check its microphone and speech permissions.",
            "no-speech": "No speech was detected. Select Start listening and try again.",
            "audio-capture": "No microphone was found. Connect a microphone and try again.",
            "network": "Voice recognition is unavailable right now. Check your connection and try again.",
        };
        status.textContent = messages[event.error] || "Voice recognition stopped. Select Start listening to try again.";
        if (["not-allowed", "service-not-allowed", "audio-capture"].includes(event.error)) {
            shouldListen = false;
            localStorage.removeItem(preferenceKey);
            toggle.setAttribute("aria-pressed", "false");
            toggle.textContent = "Start listening";
        }
    });

    recognition.addEventListener("end", () => {
        isStarting = false;
        if (!shouldListen) {
            toggle.setAttribute("aria-pressed", "false");
            toggle.textContent = "Start listening";
            if (status.textContent === "Listening…") status.textContent = "Microphone is off.";
            return;
        }

        status.textContent = "Voice navigation is on. Say a command at any time.";
        clearTimeout(restartTimer);
        restartTimer = setTimeout(startRecognition, 800);
    });

    function startRecognition() {
        if (!shouldListen || isStarting) return;
        try {
            isStarting = true;
            recognition.start();
            toggle.setAttribute("aria-pressed", "true");
            toggle.textContent = "Turn voice navigation off";
            status.textContent = "Voice navigation is on. Say a command at any time.";
        } catch {
            isStarting = false;
            shouldListen = false;
            localStorage.removeItem(preferenceKey);
            toggle.setAttribute("aria-pressed", "false");
            toggle.textContent = "Start listening";
            status.textContent = "Could not start voice recognition. Wait a moment, then try again.";
        }
    }

    toggle.addEventListener("click", () => {
        if (shouldListen) {
            shouldListen = false;
            localStorage.removeItem(preferenceKey);
            clearTimeout(restartTimer);
            recognition.stop();
            status.textContent = "Stopping microphone…";
            return;
        }

        shouldListen = true;
        localStorage.setItem(preferenceKey, "on");
        startRecognition();
    });

    if (localStorage.getItem(preferenceKey) === "on") {
        shouldListen = true;
        startRecognition();
    }
})();
