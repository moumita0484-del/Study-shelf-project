const semesterNames = {
    1: "1st Semester",
    2: "2nd Semester",
    3: "3rd Semester"
};

const API = (location.protocol === "file:" || location.port === "5500")
    ? "http://127.0.0.1:8000/api"
    : "/api";
let courses = [];

async function loadCourses() {
    try {
        const res = await fetch(`${API}/courses`);
        const data = await res.json();

        // ডাটাবেসের নাম → আপনার JS যে নাম চেনে
        courses = data.map(c => ({
            id: c.course_id,
            code: c.course_code,
            semester: parseInt(c.semester),   // "1st Semester" → 1
            name: c.course_name
        }));
    } catch (error) {
        showToast("Could not load courses from server.");
    }
    renderAll();
}

async function loadResources() {
    try {
        const res = await fetch(`${API}/resources`);
        resources = await res.json();
    } catch (error) {
        showToast("Could not load materials from server.");
    }
    renderAll();
}

const $ = (id) => document.getElementById(id);

function readStorage(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : fallback;
    } catch (error) {
        return fallback;
    }
}

function saveStorage(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

let accounts = readStorage("edupulse_accounts", {});
let resources = [];
let bookmarks = {};
let currentUser = null;
let activePage = "dashboard";

let toastTimer;

function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 2800);
}

function showMessage(element, message, success = false) {
    element.textContent = message;
    element.classList.toggle("success", success);
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function hashPassword(password) {
    if (window.crypto && window.crypto.subtle) {
        const bytes = new TextEncoder().encode(password);
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hash))
            .map(byte => byte.toString(16).padStart(2, "0"))
            .join("");
    }

    // Local demo fallback only. Real authentication belongs on the backend.
    return "demo:" + password;
}

function getUserBookmarks() {
    if (!currentUser) return [];
    const list = bookmarks[currentUser.studentId];
    return Array.isArray(list) ? list : [];
}

async function loadBookmarks() {
    if (!currentUser) return;

    try {
        const res = await fetch(
            `${API}/bookmarks/${encodeURIComponent(currentUser.studentId)}`
        );
        const data = await res.json();
        bookmarks[currentUser.studentId] = Array.isArray(data) ? data : [];
    } catch (error) {
        showToast("Could not load bookmarks from server.");
    }
}

function getVisibleResources() {
    return resources.filter(item => item.status === "Approved");
}

function getCourseByName(name) {
    return courses.find(course => course.name === name);
}

function getSemesterName(semester) {
    return semesterNames[semester] || `${semester} Semester`;
}

function renderCourses() {
    const selectedSemester = $("courseSemester").value;

    const filtered = courses.filter(course =>
        selectedSemester === "all" ||
        String(course.semester) === selectedSemester
    );

    $("courseGrid").innerHTML = filtered.map(course => `
        <article class="course-card">
            <div class="course-icon">▤</div>
            <h3>${escapeHTML(course.name)}</h3>
            <p>${escapeHTML(getSemesterName(course.semester))}</p>
            <button type="button"
                data-course-resource="${course.id}">
                View resources →
            </button>
        </article>
    `).join("");

    if (!filtered.length) {
        $("courseGrid").innerHTML =
            '<div class="empty-state">No courses found.</div>';
    }

    $("courseCount").textContent = courses.length;
}

function renderShareCourseOptions() {
    const semester = $("shareSemester").value;
    const select = $("shareCourse");

    const filtered = courses.filter(course =>
        semester !== "" && String(course.semester) === semester
    );

    select.innerHTML =
        '<option value="">Select course</option>' +
        filtered.map(course => `
            <option value="${escapeHTML(course.name)}">
                ${escapeHTML(course.name)}
            </option>
        `).join("");
}

function renderResources(targetId, list) {
    const target = $(targetId);

    if (!list.length) {
        target.innerHTML =
            '<div class="empty-state">No materials found yet.</div>';
        return;
    }

    target.innerHTML = list.map(item => {
        const isSaved = getUserBookmarks().includes(item.id);

        return `
            <article class="resource-card">
                <div class="resource-card-top">
                    <div>
                        <span class="resource-type">
                            ${escapeHTML(item.type)}
                        </span>
                        <h3>${escapeHTML(item.title)}</h3>
                    </div>
                </div>

                <div class="resource-meta">
                    <div>Course: ${escapeHTML(item.course)}</div>
                    <div>Semester: ${escapeHTML(
                        getSemesterName(item.semester)
                    )}</div>
                    <div>Shared by: ${escapeHTML(item.owner || "Student")}</div>
                    ${item.exam && item.exam !== "Not specified"
                        ? `<div>Exam: ${escapeHTML(item.exam)}</div>` : ""}
                    ${item.year
                        ? `<div>Year: ${escapeHTML(item.year)}</div>` : ""}
                </div>

                <div class="resource-actions">
                    ${item.link ? `
                        <button type="button" class="small-btn"
                            data-open-link="${escapeHTML(item.id)}">
                            Open link ↗
                        </button>` : ""}

                    <button type="button"
                        class="small-btn ${isSaved ? "saved" : ""}"
                        data-bookmark="${escapeHTML(item.id)}">
                        ${isSaved ? "★ Saved" : "☆ Bookmark"}
                    </button>
                </div>
            </article>
        `;
    }).join("");
}

function renderResourceFilters() {
    const search = $("resourceSearch").value.trim().toLowerCase();
    const semester = $("resourceSemester").value;
    const type = $("resourceType").value;

    const filtered = getVisibleResources().filter(item => {
        const matchesSearch =
            item.title.toLowerCase().includes(search) ||
            item.course.toLowerCase().includes(search) ||
            (item.owner || "").toLowerCase().includes(search);

        const matchesSemester =
            semester === "all" ||
            String(item.semester) === semester;

        const matchesType = type === "all" || item.type === type;

        return matchesSearch && matchesSemester && matchesType;
    });

    renderResources("resourceGrid", filtered);
}

function renderBookmarks() {
    const savedIds = getUserBookmarks();
    const savedResources = getVisibleResources().filter(item =>
        savedIds.includes(item.id)
    );

    renderResources("bookmarkGrid", savedResources);
    $("bookmarkCount").textContent = savedResources.length;
}

function renderDashboard() {
    const approved = getVisibleResources();

    $("resourceCount").textContent = approved.length;
    $("courseCount").textContent = courses.length;
    $("bookmarkCount").textContent = getUserBookmarks().length;

    renderResources(
        "recentResources",
        [...approved].sort((a, b) => b.created - a.created).slice(0, 4)
    );
}

function renderAll() {
    renderCourses();
    renderShareCourseOptions();
    renderResourceFilters();
    renderBookmarks();
    renderDashboard();
}

function openPage(pageName) {
    const page = $(pageName + "Page");
    if (!page) return;

    document.querySelectorAll(".page-section").forEach(section => {
        section.classList.add("hidden");
    });

    page.classList.remove("hidden");
    activePage = pageName;

    document.querySelectorAll(".nav-item").forEach(button => {
        button.classList.toggle(
            "active",
            button.dataset.page === pageName
        );
    });

    const titles = {
        dashboard: "Dashboard",
        courses: "My Courses",
        resources: "Study Resources",
        share: "Share Materials",
        bookmarks: "My Bookmarks"
    };

    $("pageTitle").textContent = titles[pageName] || "EduPulse";

    if (pageName === "courses") renderCourses();
    if (pageName === "resources") renderResourceFilters();
    if (pageName === "bookmarks") renderBookmarks();
}

async function enterDashboard(account) {
    currentUser = account;

    $("loginPage").classList.add("hidden");
    $("appPage").classList.remove("hidden");

    $("userName").textContent = account.studentId;
    $("userBatch").textContent =
        `${account.batch} · ${getSemesterName(account.semester)}`;
    $("userAvatar").textContent =
        account.studentId.charAt(0).toUpperCase();
    $("topUserName").textContent = account.studentId;

    await loadBookmarks();
    renderAll();
    openPage("dashboard");
}
$("loginForm").addEventListener("submit", async event => {
    event.preventDefault();

    const studentId = $("studentId").value.trim();
    const email = $("email").value.trim().toLowerCase();
    const batch = $("batch").value.trim();
    const semester = Number($("loginSemester").value);
    const password = $("password").value;
    const message = $("loginMessage");

    if (!validEmail(email)) {
        showMessage(message, "Please enter a valid email address.");
        return;
    }

    if (!studentId || !batch || !semester || !password) {
        showMessage(message, "Please fill in all fields.");
        return;
    }

    if (password.length < 6) {
        showMessage(message, "Password must be at least 6 characters.");
        return;
    }

    try {
        const res = await fetch(`${API}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                student_roll: studentId,
                email: email,
                batch: batch,
                semester: semester,
                password: password
            })
        });

        const data = await res.json();

        if (!res.ok) {
            showMessage(message, data.detail || "Login failed. Please try again.");
            return;
        }

        await enterDashboard({
            studentId: data.student_roll,
            dbId: data.student_id,
            email: data.email,
            batch: data.batch,
            semester: data.semester
        });

        showToast(data.message === "Account created"
            ? "Account created successfully!"
            : "Welcome back!");
    } catch (error) {
        showMessage(message, "Cannot connect to the server. Is it running?");
    }
});

document.querySelectorAll(".nav-item").forEach(button => {
    button.addEventListener("click", () => {
        openPage(button.dataset.page);
    });
});

document.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => {
        openPage(button.dataset.go);
    });
});

document.querySelectorAll("[data-semester]").forEach(button => {
    button.addEventListener("click", () => {
        $("courseSemester").value = button.dataset.semester;
        renderCourses();
        openPage("courses");
    });
});

$("courseSemester").addEventListener("change", renderCourses);

$("shareSemester").addEventListener("change", () => {
    renderShareCourseOptions();
});

$("resourceSearch").addEventListener("input", renderResourceFilters);
$("resourceSemester").addEventListener("change", renderResourceFilters);
$("resourceType").addEventListener("change", renderResourceFilters);

$("courseGrid").addEventListener("click", event => {
    const button = event.target.closest("[data-course-resource]");
    if (!button) return;

    const course = courses.find(item =>
        item.id === Number(button.dataset.courseResource)
    );

    if (course) {
        $("resourceSearch").value = "";
        $("resourceSemester").value = String(course.semester);
        $("resourceType").value = "all";
        renderResourceFilters();
        openPage("resources");
        $("resourceSearch").value = course.name;
        renderResourceFilters();
    }
});

document.addEventListener("click", async event => {
    const bookmarkButton = event.target.closest("[data-bookmark]");

    if (bookmarkButton) {
        if (!currentUser) return;

        const id = bookmarkButton.dataset.bookmark;
        const saved = getUserBookmarks();

        try {
            const res = await fetch(`${API}/bookmarks/toggle`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    student_roll: currentUser.studentId,
                    resource_id: Number(id)
                })
            });

            const data = await res.json();

            if (!res.ok) {
                showToast(data.detail || "Could not update bookmark.");
                return;
            }

            if (data.saved) {
                bookmarks[currentUser.studentId] = [...saved, id];
                showToast("Added to bookmarks.");
            } else {
                bookmarks[currentUser.studentId] =
                    saved.filter(item => item !== id);
                showToast("Removed from bookmarks.");
            }

            renderAll();
        } catch (error) {
            showToast("Cannot connect to the server. Is it running?");
        }
        return;
    }

    const linkButton = event.target.closest("[data-open-link]");

    if (linkButton) {
        const item = resources.find(resource =>
            resource.id === linkButton.dataset.openLink
        );

        if (!item || !item.link) return;

        try {
            const url = new URL(item.link);
            if (url.protocol === "http:" || url.protocol === "https:") {
                window.open(url.href, "_blank", "noopener,noreferrer");
            } else {
                showToast("This link is not allowed.");
            }
        } catch {
            showToast("Please check the resource link.");
        }
    }
});

$("shareForm").addEventListener("submit", async event => {
    event.preventDefault();

    if (!currentUser) return;

    const title = $("materialTitle").value.trim();
    const semester = Number($("shareSemester").value);
    const courseName = $("shareCourse").value;
    const type = $("materialType").value;
    const exam = $("examType").value;
    const year = $("materialYear").value.trim();
    const link = $("materialLink").value.trim();

    const message = $("shareMessage");

    if (!title || !semester || !courseName || !type) {
        showMessage(message, "Please complete all required fields.");
        return;
    }

    const course = getCourseByName(courseName);

    if (!course || course.semester !== semester) {
        showMessage(
            message,
            "Please select a course from the chosen semester."
        );
        return;
    }

    if (link) {
        try {
            const url = new URL(link);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                showMessage(message, "Please enter a valid web link.");
                return;
            }
        } catch {
            showMessage(message, "Please enter a valid web link.");
            return;
        }
    }

    try {
        const res = await fetch(`${API}/resources`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                title: title,
                student_roll: currentUser.studentId,
                course_id: course.id,
                type: type,
                exam: exam,
                year: year,
                link: link
            })
        });

        const data = await res.json();

        if (!res.ok) {
            showMessage(message, data.detail || "Could not save the material.");
            return;
        }

        $("shareForm").reset();
        await loadResources();

        showMessage(message, "Material added successfully!", true);
        showToast("Your material has been saved to the database.");
    } catch (error) {
        showMessage(message, "Cannot connect to the server. Is it running?");
    }
});

$("themeToggle").addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");

    const isDark = document.body.classList.contains("dark-mode");
    localStorage.setItem("edupulse_dark_mode", String(isDark));
});

if (localStorage.getItem("edupulse_dark_mode") === "true") {
    document.body.classList.add("dark-mode");
}

$("logoutBtn").addEventListener("click", () => {
    currentUser = null;

    $("loginForm").reset();
    $("loginMessage").textContent = "";

    $("appPage").classList.add("hidden");
    $("loginPage").classList.remove("hidden");

    showToast("You have logged out.");
});

loadCourses();
loadResources();