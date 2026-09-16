// ── SERVICE WORKER PURGE & UNREGISTER ───────────────────────────────────────
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
        for (const registration of registrations) {
            registration.unregister();
        }
    });
}
if ('caches' in window) {
    caches.keys().then(names => {
        for (const name of names) caches.delete(name);
    });
}

// ── LOGOUT HELPERS & SESSION CLEANUP ─────────────────────────────────────────
function purgeClientAuthData() {
    // Expire cookies client-side
    document.cookie = "marketsync_sid=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT;";
    document.cookie = "connect.sid=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT;";
    try {
        sessionStorage.clear();
        localStorage.clear();
    } catch (_) {}
    if ('caches' in window) {
        caches.keys().then(names => {
            for (const name of names) caches.delete(name);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // Intercept any logout button, link, or form submission
    const logoutTriggers = document.querySelectorAll('.logout-trigger, [href*="/logout"], form[action*="/logout"]');
    logoutTriggers.forEach(trigger => {
        trigger.addEventListener('click', () => {
            purgeClientAuthData();
        });
    });

    const logoutForms = document.querySelectorAll('form[action*="/logout"]');
    logoutForms.forEach(form => {
        form.addEventListener('submit', () => {
            purgeClientAuthData();
        });
    });

    // If redirected with ?logged_out=1, wipe state and remove query param from URL
    if (window.location.search.includes('logged_out=1')) {
        purgeClientAuthData();
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }
});

// ── ACTIVE NAV LINK HIGHLIGHT ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const currentPath = window.location.pathname;
    document.querySelectorAll('.nav-link').forEach(link => {
        if (link.getAttribute('href') === currentPath) {
            link.classList.add('active');
            link.style.color = 'var(--green)';
        }
    });
});

// ── AUTO DISMISS FLASH MESSAGES ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const alerts = document.querySelectorAll('.alert');
    alerts.forEach(alert => {
        setTimeout(() => {
            const bsAlert = bootstrap.Alert.getOrCreateInstance(alert);
            bsAlert.close();
        }, 4000);
    });
});