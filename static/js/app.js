// Global State Management
let bots = [];
let selectedBotId = null;
let logSocket = null;
let metricsInterval = null;
let botRefreshInterval = null;

let currentUser = { username: "", role: "user" };
let activeFilePath = null;
let aceEditor = null;

// Metrics Chart.js variables
let cpuChart = null;
let ramChart = null;
let metricsPollInterval = null;
let cpuDataHistory = [];
let ramDataHistory = [];
let chartLabels = [];

// Initialize Page
document.addEventListener("DOMContentLoaded", () => {
    if (document.getElementById("dashboard-page")) {
        if (history.state === null) {
            history.replaceState({ view: "dashboard" }, "", "");
        }
        
        window.addEventListener("popstate", (event) => {
            const state = event.state;
            if (state && state.view === "workspace") {
                document.getElementById("dashboard-view").style.display = "none";
                document.getElementById("workspace-view").style.display = "block";
                selectBot(state.botId, true);
            } else {
                showDashboardViewInternal();
            }
        });

        initDashboard();
    }
});

async function initDashboard() {
    // 1. Fetch current user role & authenticate
    await fetchCurrentUser();
    
    // 2. Fetch list of bots
    await fetchBots(true);
    fetchMetrics();
    
    // Restore workspace view if history state was workspace
    if (history.state && history.state.view === "workspace") {
        const botId = history.state.botId;
        if (bots.some(b => b.id === botId)) {
            viewBotWorkspace(botId);
        } else {
            history.replaceState({ view: "dashboard" }, "", "");
        }
    }
    
    // 3. Setup global polling
    metricsInterval = setInterval(fetchMetrics, 5000);
    botRefreshInterval = setInterval(() => fetchBots(false), 3000);

    // 4. Initialize Ace Editor + file manager + console input
    initAceEditor();
    fmBindEvents();
    bindConsoleInput();

    // 5. Setup Event Listeners
    document.getElementById("btn-add-bot")?.addEventListener("click", openAddBotModal);
    document.getElementById("add-bot-form")?.addEventListener("submit", handleAddBot);
    document.getElementById("env-add-row")?.addEventListener("click", addEnvRow);
    document.getElementById("btn-save-env")?.addEventListener("click", saveEnvVariables);
    document.getElementById("form-install-package")?.addEventListener("submit", handleInstallPackage);
    document.getElementById("btn-install-reqs")?.addEventListener("click", handleInstallRequirements);
    document.getElementById("btn-save-reqs")?.addEventListener("click", () => saveRequirements(true));
    
    // Admin listeners
    document.getElementById("btn-save-settings")?.addEventListener("click", saveAdminSettings);
    document.getElementById("form-change-password")?.addEventListener("submit", handleAdminChangePassword);

    // Setup Hacker-style 3D Type Toggles in Modal
    setupTypeToggles();

    // Setup 3D Scroll Reveal IntersectionObserver
    applyScrollReveal();
}

// Fetch Current User
async function fetchCurrentUser() {
    try {
        const res = await fetch("/api/me");
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        const data = await res.json();
        currentUser = data;
        
        document.getElementById("header-user-badge").textContent = `Operator: ${data.username} [${data.role.toUpperCase()}]`;
        updateBotLimitBadge();
        
        // If admin, show navigation tabs and load admin panel
        if (data.role === "admin") {
            document.getElementById("main-nav-tabs").style.display = "flex";
            const ownerGroup = document.getElementById("modal-owner-group");
            if (ownerGroup) ownerGroup.style.display = "block";
            fetchAdminData();
        }
    } catch (err) {
        console.error("Error fetching me details:", err);
    }
}

// Switch Main Dashboard Tabs (APPLICATIONS / ADMIN PANEL)
function switchMainTab(element, tabId) {
    document.querySelectorAll(".main-tab-content").forEach(el => {
        el.style.display = "none";
    });
    document.querySelectorAll("#main-nav-tabs .tab").forEach(tab => {
        tab.classList.remove("active");
    });

    document.getElementById(`tab-content-${tabId}`).style.display = "block";
    
    if (element) {
        element.classList.add("active");
    } else {
        const tabEl = document.querySelector(`#main-nav-tabs .tab[onclick*="${tabId}"]`);
        if (tabEl) tabEl.classList.add("active");
    }

    if (tabId === "admin-panel-tab") {
        fetchAdminData();
    } else {
        fetchBots(true);
    }
}

// Setup Hacker-style Source Type 3D Toggle Picker
function setupTypeToggles() {
    const toggles = document.querySelectorAll("#modal-type-toggles .btn-toggle");
    const hiddenInput = document.getElementById("source_type");
    
    toggles.forEach(toggle => {
        toggle.addEventListener("click", () => {
            toggles.forEach(t => t.classList.remove("active"));
            toggle.classList.add("active");
            
            const type = toggle.getAttribute("data-type");
            hiddenInput.value = type;
            toggleSourceTypeFields(type);
        });
    });
}

function toggleSourceTypeFields(type) {
    const fileGroup = document.getElementById("modal-file-group");
    const gitGroup = document.getElementById("modal-git-group");
    const pasteGroup = document.getElementById("modal-paste-group");

    fileGroup.style.display = "none";
    gitGroup.style.display = "none";
    pasteGroup.style.display = "none";

    document.getElementById("zip_file").required = false;
    document.getElementById("git_url").required = false;
    document.getElementById("paste_code").required = false;

    if (type === "zip") {
        fileGroup.style.display = "block";
        document.getElementById("zip_file").required = true;
    } else if (type === "git") {
        gitGroup.style.display = "block";
        document.getElementById("git_url").required = true;
    } else if (type === "paste") {
        pasteGroup.style.display = "block";
        document.getElementById("paste_code").required = true;
    }
}

// Fetch Stats & System Metrics
async function fetchMetrics() {
    try {
        const res = await fetch("/api/metrics");
        if (res.ok) {
            const data = await res.json();
            document.getElementById("metric-total-bots").textContent = data.total_bots;
            document.getElementById("metric-running-bots").textContent = data.running_bots;
            document.getElementById("metric-cpu").textContent = `${data.cpu_usage.toFixed(1)}%`;
            document.getElementById("metric-ram").textContent = `${data.ram_usage.toFixed(1)}%`;
        }
    } catch (err) {
        console.error("Error fetching metrics:", err);
    }
}

// Fetch Bots List
async function fetchBots(initial = false) {
    try {
        const res = await fetch("/api/bots");
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        const data = await res.json();
        
        const botsChanged = JSON.stringify(bots) !== JSON.stringify(data);
        bots = data;
        updateBotLimitBadge();

        if (botsChanged || initial) {
            renderBotsGrid();
            renderSidebarList();
            
            if (selectedBotId) {
                const currentBot = bots.find(b => b.id === selectedBotId);
                if (currentBot) {
                    updateWorkspaceBotDetails(currentBot);
                }
            }
        }
    } catch (err) {
        console.error("Error fetching bots:", err);
    }
}

// Render Grid of Bots on Main Dashboard View
function renderBotsGrid() {
    const grid = document.getElementById("bots-grid");
    if (!grid) return;

    if (bots.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.886A2 2 0 0 1 8.18 10.18L2.293 12.09a2 2 0 0 0 0 3.82l5.886 1.912a2 2 0 0 1 1.912 1.912l1.912 5.886a2 2 0 0 0 3.82 0l1.912-5.886a2 2 0 0 1 1.912-1.912l5.886-1.912a2 2 0 0 0 0-3.82l-5.886-1.912a2 2 0 0 1-1.912-1.912L13.91 3a2 2 0 0 0-3.82 0Z"/></svg>
                <h3>No bots hosted yet</h3>
                <p>Upload a Python project ZIP file, clone a Git repository, or paste your scripts directly.</p>
                <button class="btn btn-primary" onclick="openAddBotModal()">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Host New Bot
                </button>
            </div>
        `;
        return;
    }

    grid.innerHTML = bots.map(bot => `
        <div class="bot-card scroll-reveal" onclick="viewBotWorkspace('${bot.id}')">
            <div class="bot-card-header">
                <div>
                    <h4 class="bot-title">${escapeHTML(bot.name)}</h4>
                    <div class="bot-source">
                        ${bot.source_type === 'git' ? `
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
                            Git Repository
                        ` : bot.source_type === 'zip' ? `
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                            ZIP Archive
                        ` : `
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                            Pasted Script
                        `}
                        &bull; <span class="badge-owner" style="font-size: 0.65rem; border: none; padding: 0;">${escapeHTML(bot.owner)}</span>
                    </div>
                </div>
                <span class="bot-status-badge status-${bot.status}">${bot.status}</span>
            </div>
            
            <div class="bot-card-body">
                <div class="bot-meta-item">
                    Entrypoint: <span>${escapeHTML(bot.entrypoint)}</span>
                </div>
                <div class="bot-meta-item">
                    Auto Restart: <span>${bot.auto_restart ? 'YES' : 'NO'}</span>
                </div>
                <div class="bot-meta-item">
                    Environment Vars: <span>${Object.keys(bot.env_vars).length} vars</span>
                </div>
                ${bot.bot_telegram_name ? `
                    <div class="bot-meta-item" style="margin-top: 0.5rem; padding: 0.4rem; background: rgba(0, 255, 102, 0.05); border: 1px dashed rgba(0, 255, 102, 0.2); border-radius: 4px; display: flex; flex-direction: column; gap: 0.15rem;">
                        <div style="font-size: 0.72rem; color: var(--text-main); font-weight: bold; display: flex; align-items: center; gap: 0.25rem;">
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                            Telegram Details
                        </div>
                        <div style="font-size: 0.68rem; color: var(--text-muted);">Name: <span style="color: var(--accent);">${escapeHTML(bot.bot_telegram_name)}</span></div>
                        <div style="font-size: 0.68rem; color: var(--text-muted);">Username: <a href="https://t.me/${escapeHTML(bot.bot_username)}" target="_blank" style="color: var(--primary-light); text-decoration: underline;">@${escapeHTML(bot.bot_username)}</a></div>
                    </div>
                ` : ''}
            </div>

            <div class="bot-card-actions" onclick="event.stopPropagation()">
                ${bot.status === 'running' ? `
                    <button class="btn btn-secondary btn-icon" title="Stop Bot" onclick="controlBot('${bot.id}', 'stop')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/></svg>
                    </button>
                ` : `
                    <button class="btn btn-primary btn-icon" title="Start Bot" onclick="controlBot('${bot.id}', 'start')" ${bot.status === 'installing' ? 'disabled' : ''}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </button>
                `}
                <button class="btn btn-secondary btn-icon" title="Restart Bot" onclick="controlBot('${bot.id}', 'restart')" ${bot.status === 'installing' ? 'disabled' : ''}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                </button>
                <button class="btn btn-secondary" onclick="viewBotWorkspace('${bot.id}')">
                    Manage
                </button>
            </div>
        </div>
    `).join("");
    applyScrollReveal();
}

// Render Sidebar List inside Workspace View
function renderSidebarList() {
    const list = document.getElementById("sidebar-bots-list");
    if (!list) return;

    list.innerHTML = bots.map(bot => `
        <div class="sidebar-item ${bot.id === selectedBotId ? 'active' : ''}" onclick="selectBot('${bot.id}')">
            <div style="max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                <strong style="font-size: 0.8125rem; font-family: 'Fira Code', monospace;">${escapeHTML(bot.name)}</strong>
            </div>
            <span class="bot-status-badge status-${bot.status}" style="font-size: 0.6rem; padding: 0.15rem 0.4rem;">${bot.status}</span>
        </div>
    `).join("");
}

function viewBotWorkspace(botId) {
    document.getElementById("dashboard-view").style.display = "none";
    document.getElementById("workspace-view").style.display = "block";
    selectBot(botId);
}

function showDashboardView() {
    if (history.state && history.state.view === "workspace") {
        history.back();
    } else {
        showDashboardViewInternal();
    }
}

function showDashboardViewInternal() {
    closeLogSocket();
    stopMetricsPolling();
    selectedBotId = null;
    document.getElementById("workspace-view").style.display = "none";
    document.getElementById("dashboard-view").style.display = "block";
    fetchBots(true);
}

// Select Bot inside Workspace
function selectBot(botId, preventStateUpdate = false) {
    selectedBotId = botId;
    renderSidebarList();

    const bot = bots.find(b => b.id === botId);
    if (!bot) return;

    // Reset tabs
    switchTab('console');

    // Populate Details
    updateWorkspaceBotDetails(bot);

    // Open the live console stream (server sends the latest lines first)
    setupLogWebSocket(botId);

    // Setup Env variables
    loadEnvVariables(bot.env_vars);

    // Load requirements.txt
    loadRequirements(botId);
    
    // Reset the file manager to the bot's root folder
    fmInit(botId);

    // Setup performance metrics charts
    setupMetricsCharts(botId);

    // Handle history state updates
    if (!preventStateUpdate) {
        if (history.state && history.state.view === "workspace") {
            if (history.state.botId !== botId) {
                history.replaceState({ view: "workspace", botId: botId }, "", "");
            }
        } else {
            history.pushState({ view: "workspace", botId: botId }, "", "");
        }
    }
}

function updateWorkspaceBotDetails(bot) {
    document.getElementById("ws-bot-name").textContent = bot.name;
    document.getElementById("ws-bot-owner-badge").textContent = `Owner: ${bot.owner}`;
    
    const tgBadge = document.getElementById("ws-bot-telegram-badge");
    if (tgBadge) {
        if (bot.bot_telegram_name && bot.bot_username) {
            tgBadge.innerHTML = `🤖 ${escapeHTML(bot.bot_telegram_name)} (<a href="https://t.me/${escapeHTML(bot.bot_username)}" target="_blank" style="color: var(--accent); text-decoration: underline;">@${escapeHTML(bot.bot_username)}</a>)`;
            tgBadge.style.display = "inline-block";
        } else {
            tgBadge.style.display = "none";
        }
    }
    
    const badge = document.getElementById("ws-bot-status-badge");
    badge.className = `bot-status-badge status-${bot.status}`;
    badge.textContent = bot.status;

    const startBtn = document.getElementById("ws-btn-start");
    const stopBtn = document.getElementById("ws-btn-stop");
    const restartBtn = document.getElementById("ws-btn-restart");

    if (bot.status === "running") {
        startBtn.style.display = "none";
        stopBtn.style.display = "inline-flex";
    } else {
        startBtn.style.display = "inline-flex";
        stopBtn.style.display = "none";
        
        if (bot.status === "installing") {
            startBtn.disabled = true;
            restartBtn.disabled = true;
        } else {
            startBtn.disabled = false;
            restartBtn.disabled = false;
        }
    }
}

// Switch workspace tabs
function switchTab(tabId) {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.classList.remove("active");
    });
    document.querySelectorAll(".tab-content").forEach(content => {
        content.classList.remove("active");
    });

    document.querySelector(`.tab[onclick="switchTab('${tabId}')"]`).classList.add("active");
    document.getElementById(`tab-${tabId}`).classList.add("active");

    if (tabId === 'files') {
        if (aceEditor) aceEditor.resize();
        if (selectedBotId && fm.loadedFor === selectedBotId && !fm.editing) fmLoad();
    }
    if (tabId === 'console') {
        const term = document.getElementById("terminal-console");
        if (term) term.scrollTop = term.scrollHeight;
    }
}

// Add Bot Modal
function openAddBotModal() {
    document.getElementById("add-bot-modal").classList.add("open");
    
    // Default to ZIP
    const firstToggle = document.querySelector("#modal-type-toggles button[data-type='zip']");
    if (firstToggle) firstToggle.click();
}

function closeAddBotModal() {
    document.getElementById("add-bot-modal").classList.remove("open");
    document.getElementById("add-bot-form").reset();
}

// Add Bot Form
async function handleAddBot(e) {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating...";

    const formData = new FormData(e.target);

    const overlay = document.getElementById("creation-loading-overlay");
    const progressBar = document.getElementById("creation-progress-bar");
    const terminalLogs = document.getElementById("creation-terminal-logs");
    
    if (overlay) overlay.style.display = "flex";
    if (progressBar) progressBar.style.width = "0%";
    if (terminalLogs) {
        terminalLogs.innerHTML = `
            <div>&gt; [SYS] Handshaking with Railway container...</div>
            <div>&gt; [SYS] Creating isolated user directory...</div>
        `;
    }

    let progress = 0;
    const progressInterval = setInterval(() => {
        progress += Math.floor(Math.random() * 12) + 6;
        if (progress > 95) progress = 95;
        if (progressBar) progressBar.style.width = `${progress}%`;
        
        if (terminalLogs) {
            if (progress > 20 && terminalLogs.children.length === 2) {
                terminalLogs.innerHTML += `<div>&gt; [SYS] Checking virtual environment availability...</div>`;
                terminalLogs.scrollTop = terminalLogs.scrollHeight;
            } else if (progress > 45 && terminalLogs.children.length === 3) {
                terminalLogs.innerHTML += `<div>&gt; [SYS] Sandboxing directory and setting unprivileged UID...</div>`;
                terminalLogs.scrollTop = terminalLogs.scrollHeight;
            } else if (progress > 70 && terminalLogs.children.length === 4) {
                terminalLogs.innerHTML += `<div>&gt; [SYS] Verifying Bot Token credentials with Telegram API...</div>`;
                terminalLogs.scrollTop = terminalLogs.scrollHeight;
            }
        }
    }, 450);

    try {
        const res = await fetch("/api/bots", {
            method: "POST",
            body: formData
        });

        if (res.ok) {
            clearInterval(progressInterval);
            if (progressBar) progressBar.style.width = "100%";
            if (terminalLogs) {
                terminalLogs.innerHTML += `<div style="color: var(--accent);">&gt; [SUCCESS] Bot created successfully. Handover to runtime manager.</div>`;
                terminalLogs.scrollTop = terminalLogs.scrollHeight;
            }
            setTimeout(() => {
                closeAddBotModal();
                if (overlay) overlay.style.display = "none";
                fetchBots(true);
            }, 600);
        } else {
            clearInterval(progressInterval);
            if (overlay) overlay.style.display = "none";
            const err = await res.json();
            alert(`Error: ${err.detail || "Failed to add bot"}`);
        }
    } catch (err) {
        clearInterval(progressInterval);
        if (overlay) overlay.style.display = "none";
        console.error(err);
        alert("Failed to connect to server.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Host Bot";
    }
}

// Control Bot processes
async function controlBot(botId, action) {
    try {
        const res = await fetch(`/api/bots/${botId}/${action}`, {
            method: "POST"
        });
        if (res.ok) {
            fetchBots(false);
        } else {
            const err = await res.json();
            alert(`Failed: ${err.detail}`);
        }
    } catch (err) {
        console.error(err);
        alert("Failed to connect to server.");
    }
}

function handleWSControlBot(action) {
    if (!selectedBotId) return;
    controlBot(selectedBotId, action);
}

// Delete Bot
async function deleteSelectedBot() {
    if (!selectedBotId) return;
    const bot = bots.find(b => b.id === selectedBotId);
    if (!bot) return;

    if (!confirm(`Are you absolutely sure you want to delete '${bot.name}'? This will delete all code, packages, and logs.`)) {
        return;
    }

    try {
        const res = await fetch(`/api/bots/${selectedBotId}`, {
            method: "DELETE"
        });

        if (res.ok) {
            showDashboardView();
        } else {
            const err = await res.json();
            alert(`Error: ${err.detail || "Failed to delete bot"}`);
        }
    } catch (err) {
        console.error(err);
    }
}

// =====================================================================
// CONSOLE: live log stream (WebSocket), ANSI colours, command input
// =====================================================================

const CONSOLE_MAX_LINES = 1500;
let consoleCurrent = "";        // incomplete last line
let consoleLiveEl = null;       // element showing the incomplete last line
let consoleReconnectTimer = null;
const consoleHistory = [];
let consoleHistoryPos = 0;

const ANSI_FG = {
    30: "#6b7280", 31: "#ff5c7a", 32: "#39ff14", 33: "#fbbf24", 34: "#60a5fa", 35: "#c084fc", 36: "#22d3ee", 37: "#e5e7eb",
    90: "#9ca3af", 91: "#ff8099", 92: "#86efac", 93: "#fde047", 94: "#93c5fd", 95: "#d8b4fe", 96: "#67e8f9", 97: "#ffffff",
};

function ansiToHtml(raw) {
    // keep only what follows the last carriage return (progress bars rewrite the line)
    const crIdx = raw.lastIndexOf("\r");
    if (crIdx !== -1 && crIdx < raw.length - 1) raw = raw.slice(crIdx + 1);
    raw = raw.replace(/\r/g, "");
    // drop non-colour escape sequences (cursor moves etc.)
    raw = raw.replace(/\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g, "");

    let html = "", color = null, bold = false, open = false;
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0, m;
    const flush = (text) => {
        if (!text) return;
        const esc = escapeHTML(text);
        if (color || bold) html += `<span style="${color ? `color:${color};` : ""}${bold ? "font-weight:700;" : ""}">${esc}</span>`;
        else html += esc;
    };
    while ((m = re.exec(raw)) !== null) {
        flush(raw.slice(last, m.index));
        last = re.lastIndex;
        const codes = (m[1] === "" ? "0" : m[1]).split(";").map(Number);
        for (const c of codes) {
            if (c === 0) { color = null; bold = false; }
            else if (c === 1) bold = true;
            else if (c === 22) bold = false;
            else if (c === 39) color = null;
            else if (ANSI_FG[c]) color = ANSI_FG[c];
        }
    }
    flush(raw.slice(last));
    return html;
}

function consoleMakeLine(text) {
    const div = document.createElement("div");
    div.className = "console-line";
    if (text.startsWith("> ")) div.classList.add("cmd");
    div.innerHTML = ansiToHtml(text) || "&nbsp;";
    return div;
}

function appendConsole(text) {
    const term = document.getElementById("terminal-console");
    if (!term || !text) return;
    const stick = term.scrollHeight - term.scrollTop - term.clientHeight < 60;

    const parts = (consoleCurrent + text).split("\n");
    consoleCurrent = parts.pop();                 // text after the last newline
    if (consoleLiveEl) { consoleLiveEl.remove(); consoleLiveEl = null; }

    const frag = document.createDocumentFragment();
    parts.forEach(p => frag.appendChild(consoleMakeLine(p)));
    term.appendChild(frag);
    if (consoleCurrent) { consoleLiveEl = consoleMakeLine(consoleCurrent); term.appendChild(consoleLiveEl); }

    while (term.childElementCount > CONSOLE_MAX_LINES) term.removeChild(term.firstChild);
    if (stick) term.scrollTop = term.scrollHeight;
}

function resetConsole() {
    const term = document.getElementById("terminal-console");
    if (term) term.innerHTML = "";
    consoleCurrent = "";
    consoleLiveEl = null;
}

function setWsState(text, live) {
    const el = document.getElementById("console-ws-state");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("live", !!live);
}

// Server sends the last 300 lines first, then follows the log file live.
function setupLogWebSocket(botId) {
    closeLogSocket();
    resetConsole();
    setWsState("connecting...", false);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/bots/${botId}/logs/ws`);
    logSocket = ws;

    ws.onopen = () => setWsState("live", true);
    ws.onmessage = (event) => appendConsole(event.data);
    ws.onerror = () => setWsState("error", false);
    ws.onclose = () => {
        if (logSocket !== ws) return;             // we closed it on purpose
        setWsState("disconnected - retrying...", false);
        consoleReconnectTimer = setTimeout(() => {
            if (selectedBotId === botId && logSocket === ws) setupLogWebSocket(botId);
        }, 2500);
    };
}

function closeLogSocket() {
    if (consoleReconnectTimer) { clearTimeout(consoleReconnectTimer); consoleReconnectTimer = null; }
    if (logSocket) {
        const ws = logSocket;
        logSocket = null;
        ws.close();
    }
}

function clearConsole() {
    resetConsole();
}

// "Reconnect": reopens the stream, which re-sends the latest lines
function refreshConsoleLogs() {
    if (!selectedBotId) return;
    setupLogWebSocket(selectedBotId);
}

async function sendConsoleCommand(text) {
    if (!selectedBotId || !text.trim()) return;
    try {
        const res = await fetch(`/api/bots/${selectedBotId}/command`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: text }),
        });
        if (!res.ok) {
            let msg = "Command failed.";
            try { const d = await res.json(); if (d.detail) msg = d.detail; } catch (e) {}
            appendConsole(`\x1b[31m[panel] ${msg}\x1b[0m\n`);
        }
    } catch (err) {
        appendConsole("\x1b[31m[panel] Could not reach server.\x1b[0m\n");
    }
}

function bindConsoleInput() {
    const input = document.getElementById("console-command");
    if (!input) return;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const v = input.value;
            if (!v.trim()) return;
            consoleHistory.push(v);
            consoleHistoryPos = consoleHistory.length;
            input.value = "";
            sendConsoleCommand(v);
        } else if (e.key === "ArrowUp") {
            if (consoleHistoryPos > 0) { consoleHistoryPos--; input.value = consoleHistory[consoleHistoryPos]; }
            e.preventDefault();
        } else if (e.key === "ArrowDown") {
            if (consoleHistoryPos < consoleHistory.length - 1) { consoleHistoryPos++; input.value = consoleHistory[consoleHistoryPos]; }
            else { consoleHistoryPos = consoleHistory.length; input.value = ""; }
            e.preventDefault();
        }
    });
}

// ---- stat cards on the right of the console --------------------------------

function formatUptime(sec) {
    if (!sec || sec < 1) return "0s";
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

function updateConsoleStats(metrics) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("stat-file", metrics.entrypoint || "-");
    set("stat-uptime", metrics.running ? formatUptime(metrics.uptime) : "Offline");
    set("stat-cpu", `${(metrics.cpu || 0).toFixed(2)}%`);
    set("stat-ram", `${(metrics.ram || 0).toFixed(2)} MiB`);
    set("stat-disk", fmFormatBytes(metrics.disk || 0));
    set("console-run-file", metrics.entrypoint || "-");
    const dot = document.getElementById("console-run-dot");
    if (dot) dot.className = `run-dot ${metrics.status || ""}`;
}


// Env Variables Manager
function loadEnvVariables(envVars) {
    const list = document.getElementById("env-variables-list");
    if (!list) return;

    list.innerHTML = "";
    Object.entries(envVars).forEach(([key, val]) => {
        addEnvRowWithValue(key, val);
    });

    if (Object.keys(envVars).length === 0) {
        addEnvRow();
    }
}

function addEnvRow() {
    addEnvRowWithValue("", "");
}

function addEnvRowWithValue(key, value) {
    const list = document.getElementById("env-variables-list");
    const row = document.createElement("div");
    row.className = "env-row";
    row.innerHTML = `
        <input type="text" class="form-control env-key text-green" placeholder="Variable Name" value="${escapeHTML(key)}" required style="font-family: 'Fira Code', monospace;">
        <input type="text" class="form-control env-value text-green" placeholder="Value" value="${escapeHTML(value)}" required style="font-family: 'Fira Code', monospace;">
        <button type="button" class="btn btn-danger btn-icon" onclick="this.parentElement.remove()" style="padding: 0.5rem;">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
    `;
    list.appendChild(row);
}

async function saveEnvVariables() {
    if (!selectedBotId) return;

    const rows = document.querySelectorAll("#env-variables-list .env-row");
    const env_vars = {};
    let valid = true;

    rows.forEach(row => {
        const key = row.querySelector(".env-key").value.trim();
        const val = row.querySelector(".env-value").value.trim();
        if (key) {
            env_vars[key] = val;
        } else {
            valid = false;
        }
    });

    if (!valid) {
        alert("Environment variable name cannot be empty.");
        return;
    }

    const saveBtn = document.getElementById("btn-save-env");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
        const res = await fetch(`/api/bots/${selectedBotId}/env`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(env_vars)
        });

        if (res.ok) {
            const bot = bots.find(b => b.id === selectedBotId);
            if (bot) bot.env_vars = env_vars;
            alert("Environment variables updated successfully!");
        } else {
            const err = await res.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (err) {
        console.error(err);
        alert("Failed to save variables.");
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Variables";
    }
}

// Single Package Pip install
async function handleInstallPackage(e) {
    e.preventDefault();
    if (!selectedBotId) return;

    const input = document.getElementById("package_name");
    const name = input.value.trim();
    if (!name) return;

    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Installing...";

    try {
        const res = await fetch(`/api/bots/${selectedBotId}/install`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ package_name: name })
        });

        if (res.ok) {
            input.value = "";
            switchTab('console');
            alert(`Installing '${name}' in the background. Check console logs for progress!`);
            fetchBots(false);
        } else {
            const err = await res.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (err) {
        console.error(err);
        alert("Failed to install package.");
    } finally {
        btn.disabled = false;
        btn.textContent = "Install Package";
    }
}

// requirements.txt saving and installing
async function handleInstallRequirements() {
    if (!selectedBotId) return;

    const btn = document.getElementById("btn-install-reqs");
    btn.disabled = true;

    // First save
    const saved = await saveRequirements(false);
    if (!saved) {
        btn.disabled = false;
        return;
    }

    try {
        const res = await fetch(`/api/bots/${selectedBotId}/install-requirements`, {
            method: "POST"
        });

        if (res.ok) {
            switchTab('console');
            alert("Installing requirements.txt in the background. Check console logs for progress!");
            fetchBots(false);
        } else {
            const err = await res.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (err) {
        console.error(err);
        alert("Failed to start requirements installation.");
    } finally {
        btn.disabled = false;
    }
}

async function loadRequirements(botId) {
    const area = document.getElementById("requirements_content");
    if (!area) return;
    area.value = "Loading requirements.txt...";
    try {
        const res = await fetch(`/api/bots/${botId}/requirements`);
        if (res.ok) {
            const data = await res.json();
            area.value = data.requirements;
        } else {
            area.value = "Error loading requirements.txt";
        }
    } catch (err) {
        console.error(err);
        area.value = "Error loading requirements.txt";
    }
}

async function saveRequirements(showNotification = true) {
    if (!selectedBotId) return false;
    const content = document.getElementById("requirements_content").value;
    try {
        const res = await fetch(`/api/bots/${selectedBotId}/requirements`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requirements: content })
        });
        if (res.ok) {
            if (showNotification) alert("requirements.txt saved successfully!");
            return true;
        } else {
            alert("Failed to save requirements.txt");
            return false;
        }
    } catch (err) {
        console.error(err);
        alert("Error saving requirements.");
        return false;
    }
}

// =====================================================================
// FILE MANAGER (Pterodactyl-style) + code editor
// =====================================================================

const fm = {
    path: "",
    entries: [],
    selected: new Set(),
    startup: "",
    maxUploadMb: 200,
    editing: null,        // { path, dirty }
    menuIndex: -1,
    loadedFor: null,
};

const FM_ICON_DIR = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>`;
const FM_ICON_FILE = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const FM_ICON_ARCHIVE = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;

function fmApi(suffix) { return `/api/bots/${selectedBotId}/fm/${suffix}`; }

async function fmRequest(url, method, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) { window.location.href = "/login"; throw new Error("Not authenticated"); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (!res.ok) {
        const detail = data && data.detail ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : `Request failed (${res.status})`;
        throw new Error(detail);
    }
    return data;
}

function fmToast(message, type = "ok") {
    const box = document.getElementById("fm-toasts");
    if (!box) return;
    const el = document.createElement("div");
    el.className = `fm-toast ${type === "error" ? "error" : ""}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), type === "error" ? 6000 : 3500);
}

function fmFormatBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${i === 0 ? v : v.toFixed(2)} ${u[i]}`;
}

function fmFormatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "less than a minute ago";
    if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
    return d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

const fmJoin = (...p) => p.filter(Boolean).map(x => x.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");

// ---- generic dialog (replaces prompt/confirm/alert) -----------------

function fmModal({ title, bodyHTML = "", confirmText = "OK", danger = false, onOpen = null, collect = null }) {
    return new Promise(resolve => {
        const overlay = document.getElementById("fm-modal");
        const body = document.getElementById("fm-modal-body");
        const okBtn = document.getElementById("fm-modal-ok");
        const cancelBtn = document.getElementById("fm-modal-cancel");
        document.getElementById("fm-modal-title").textContent = title;
        body.innerHTML = bodyHTML;
        okBtn.textContent = confirmText;
        okBtn.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
        okBtn.style.flex = "1";
        overlay.classList.add("open");
        if (onOpen) onOpen(body);
        const first = body.querySelector("input[type=text]");
        if (first) setTimeout(() => { first.focus(); first.select(); }, 50);

        const close = (value) => {
            overlay.classList.remove("open");
            okBtn.onclick = cancelBtn.onclick = overlay.onclick = null;
            document.removeEventListener("keydown", onKey, true);
            resolve(value);
        };
        const submit = () => {
            const value = collect ? collect(body) : true;
            if (value === undefined) return;       // validation failed, keep dialog open
            close(value);
        };
        const onKey = (e) => {
            if (e.key === "Escape") { e.stopPropagation(); close(null); }
            else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); e.stopPropagation(); submit(); }
        };
        okBtn.onclick = submit;
        cancelBtn.onclick = () => close(null);
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
        document.addEventListener("keydown", onKey, true);
    });
}

function fmAskText(title, label, value = "", confirmText = "OK", hint = "") {
    return fmModal({
        title, confirmText,
        bodyHTML: `<div class="form-group" style="margin-bottom:0;"><label>${escapeHTML(label)}</label>
                   <input type="text" class="form-control" id="fm-dlg-input" value="${escapeHTML(value)}" autocomplete="off" spellcheck="false">
                   ${hint ? `<p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.4rem;">${hint}</p>` : ""}</div>`,
        collect: (b) => { const v = b.querySelector("#fm-dlg-input").value.trim(); return v ? v : undefined; },
    });
}

function fmConfirm(title, message, confirmText = "Delete") {
    return fmModal({
        title, confirmText, danger: true,
        bodyHTML: `<div class="fm-modal-msg">${message}</div>`,
    }).then(v => v === true);
}

// ---- init / load / render -------------------------------------------

function fmInit(botId) {
    fm.path = "";
    fm.entries = [];
    fm.selected.clear();
    fm.editing = null;
    fm.loadedFor = botId;
    fmShowList();
    fmLoad("");
}

function fmShowList() {
    document.getElementById("fm-list-view").style.display = "block";
    document.getElementById("fm-editor-view").style.display = "none";
    fmUpdateBulkBar();
}

async function fmLoad(path = fm.path) {
    if (!selectedBotId) return;
    const list = document.getElementById("fm-list");
    if (!list) return;
    if (!fm.entries.length) list.innerHTML = `<div class="fm-loading">Loading files...</div>`;
    try {
        const data = await fmRequest(`${fmApi("list")}?path=${encodeURIComponent(path)}`, "GET");
        fm.path = data.path || "";
        fm.entries = data.entries || [];
        fm.startup = data.startup || "";
        fm.maxUploadMb = data.max_upload_mb || 200;
        fm.selected.clear();
        fmRender();
    } catch (err) {
        list.innerHTML = `<div class="fm-empty">Could not load files: ${escapeHTML(err.message)}</div>`;
    }
}

function fmRenderBreadcrumb() {
    const bc = document.getElementById("fm-breadcrumb");
    const parts = fm.path ? fm.path.split("/") : [];
    let html = `<span class="sep">/</span><a data-path="" class="${parts.length ? "" : "cur"}">container</a><span class="sep">/</span>`;
    let acc = "";
    parts.forEach((p, i) => {
        acc = fmJoin(acc, p);
        const last = i === parts.length - 1;
        html += `<a data-path="${escapeHTML(acc)}" class="${last ? "cur" : ""}">${escapeHTML(p)}</a><span class="sep">/</span>`;
    });
    bc.innerHTML = html;
}

function fmRender() {
    fmRenderBreadcrumb();
    const list = document.getElementById("fm-list");
    if (!fm.entries.length) {
        list.innerHTML = `<div class="fm-empty">This directory is empty. Use <b>Upload</b> or <b>New File</b> to add something.</div>`;
    } else {
        list.innerHTML = fm.entries.map((e, i) => {
            const icon = e.is_dir ? FM_ICON_DIR : (e.is_archive ? FM_ICON_ARCHIVE : FM_ICON_FILE);
            const isStartup = !e.is_dir && fmJoin(fm.path, e.name) === fm.startup;
            return `
            <div class="fm-row" data-i="${i}">
                <label class="fm-check"><input type="checkbox" class="fm-sel" data-i="${i}"></label>
                <div class="fm-icon ${e.is_dir ? "dir" : ""}">${icon}</div>
                <div class="fm-name" title="${escapeHTML(e.name)}">${escapeHTML(e.name)}${isStartup ? `<span class="fm-badge">startup</span>` : ""}</div>
                <div class="fm-size">${e.is_dir ? "" : fmFormatBytes(e.size)}</div>
                <div class="fm-date" title="${escapeHTML(new Date(e.modified).toLocaleString())}">${escapeHTML(fmFormatDate(e.modified))}</div>
                <button type="button" class="fm-more" data-i="${i}" title="Options">&#8943;</button>
            </div>`;
        }).join("");
    }
    document.getElementById("fm-select-all").checked = false;
    fmUpdateBulkBar();
}

function fmUpdateBulkBar() {
    const bar = document.getElementById("fm-bulkbar");
    if (!bar) return;
    const n = fm.selected.size;
    const visible = n > 0 && document.getElementById("fm-list-view").style.display !== "none";
    bar.style.display = visible ? "flex" : "none";
    document.getElementById("fm-bulk-count").textContent = `${n} selected`;
    document.querySelectorAll("#fm-list .fm-row").forEach(row => {
        const on = fm.selected.has(Number(row.dataset.i));
        row.classList.toggle("selected", on);
        const cb = row.querySelector(".fm-sel");
        if (cb) cb.checked = on;
    });
}

function fmSelectedNames() {
    return [...fm.selected].map(i => fm.entries[i]).filter(Boolean).map(e => e.name);
}

// ---- row menu ---------------------------------------------------------

function fmOpenMenu(index, x, y) {
    const e = fm.entries[index];
    if (!e) return;
    fm.menuIndex = index;
    const items = [
        ["rename", "&#9998;", "Rename"],
        ["move", "&#10140;", "Move"],
        ["chmod", "&#128274;", "Permissions"],
        ["copy", "&#10697;", "Copy"],
        ["archive", "&#128230;", "Archive"],
    ];
    if (e.is_archive) items.push(["unarchive", "&#128194;", "Unarchive"]);
    if (!e.is_dir && e.name.toLowerCase().endsWith(".py")) items.push(["startup", "&#9654;", "Set as Startup File"]);
    items.push(["download", "&#8681;", "Download"]);
    const menu = document.getElementById("fm-menu");
    menu.innerHTML = items.map(([k, ic, label]) => `<button type="button" data-act="${k}"><span class="mi">${ic}</span>${label}</button>`).join("")
        + `<div class="fm-menu-sep"></div><button type="button" class="danger" data-act="delete"><span class="mi">&#128465;</span>Delete</button>`;
    menu.style.display = "block";
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}

function fmCloseMenu() {
    const menu = document.getElementById("fm-menu");
    if (menu) menu.style.display = "none";
}

async function fmRunAction(act, index) {
    const e = fm.entries[index];
    if (!e) return;
    try {
        if (act === "rename") {
            const v = await fmAskText("Rename", "New name", e.name, "Rename");
            if (!v || v === e.name) return;
            await fmRequest(fmApi("rename"), "POST", { path: fm.path, old: e.name, new: v });
            fmToast(`Renamed to ${v}`);
        } else if (act === "move") {
            await fmMoveFlow([e.name]);
            return;
        } else if (act === "chmod") {
            await fmChmodFlow(e);
            return;
        } else if (act === "copy") {
            const r = await fmRequest(fmApi("copy"), "POST", { path: fm.path, name: e.name });
            fmToast(`Copied as ${r.name}`);
        } else if (act === "archive") {
            const r = await fmRequest(fmApi("archive"), "POST", { path: fm.path, items: [e.name] });
            fmToast(`Created ${r.name}`);
        } else if (act === "unarchive") {
            fmToast("Extracting...");
            await fmRequest(fmApi("unarchive"), "POST", { path: fm.path, name: e.name });
            fmToast(`Extracted ${e.name}`);
        } else if (act === "startup") {
            const r = await fmRequest(fmApi("startup"), "POST", { path: fmJoin(fm.path, e.name) });
            fmToast(`Startup file set to ${r.entrypoint}. Restart the bot to run it.`);
            await fetchBots(false);
        } else if (act === "download") {
            fmDownload(fmJoin(fm.path, e.name));
            return;
        } else if (act === "delete") {
            const ok = await fmConfirm("Delete", `Delete <b>${escapeHTML(e.name)}</b>${e.is_dir ? " and everything inside it" : ""}? This cannot be undone.`);
            if (!ok) return;
            await fmRequest(fmApi("delete"), "POST", { path: fm.path, items: [e.name] });
            fmToast(`Deleted ${e.name}`);
        }
        await fmLoad();
    } catch (err) {
        fmToast(err.message, "error");
    }
}

function fmDownload(path) {
    const a = document.createElement("a");
    a.href = `${fmApi("download")}?path=${encodeURIComponent(path)}`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function fmMoveFlow(names) {
    const dest = await fmAskText(
        names.length > 1 ? `Move ${names.length} items` : "Move",
        "Move to folder",
        fm.path || "/",
        "Move",
        "Path inside the container. Use <code>/</code> for the root, e.g. <code>data/backups</code>. Missing folders are created."
    );
    if (dest === null || dest === undefined) return;
    try {
        await fmRequest(fmApi("move"), "POST", { path: fm.path, items: names, destination: dest === "/" ? "" : dest });
        fmToast("Moved");
        await fmLoad();
    } catch (err) {
        fmToast(err.message, "error");
    }
}

async function fmChmodFlow(entry) {
    const cur = entry.mode || "644";
    const bits = ["r", "w", "x"];
    const rows = ["Owner", "Group", "Public"];
    const digits = cur.slice(-3).split("").map(Number);
    let grid = `<div class="fm-perm-grid"><span></span><span class="h">Read</span><span class="h">Write</span><span class="h">Execute</span>`;
    rows.forEach((r, ri) => {
        grid += `<span>${r}</span>`;
        [4, 2, 1].forEach((bit, bi) => {
            grid += `<input type="checkbox" data-row="${ri}" data-bit="${bit}" ${(digits[ri] & bit) ? "checked" : ""}>`;
        });
    });
    grid += `</div>`;
    const result = await fmModal({
        title: `Permissions: ${entry.name}`, confirmText: "Update",
        bodyHTML: `<div class="form-group" style="margin-bottom:0;"><label>File mode (octal)</label>
                   <input type="text" class="form-control" id="fm-mode-input" value="${escapeHTML(cur)}" maxlength="4" autocomplete="off">
                   ${grid}
                   ${entry.is_dir ? `<label style="display:flex;gap:0.5rem;align-items:center;margin-top:1rem;font-size:0.8125rem;"><input type="checkbox" id="fm-mode-rec" style="accent-color:var(--accent)"> Apply to everything inside</label>` : ""}</div>`,
        onOpen: (b) => {
            const input = b.querySelector("#fm-mode-input");
            const boxes = [...b.querySelectorAll(".fm-perm-grid input")];
            const fromBoxes = () => {
                const d = [0, 0, 0];
                boxes.forEach(c => { if (c.checked) d[Number(c.dataset.row)] += Number(c.dataset.bit); });
                input.value = d.join("");
            };
            boxes.forEach(c => c.addEventListener("change", fromBoxes));
            input.addEventListener("input", () => {
                if (/^[0-7]{3,4}$/.test(input.value)) {
                    const d = input.value.slice(-3).split("").map(Number);
                    boxes.forEach(c => { c.checked = !!(d[Number(c.dataset.row)] & Number(c.dataset.bit)); });
                }
            });
        },
        collect: (b) => {
            const mode = b.querySelector("#fm-mode-input").value.trim();
            if (!/^[0-7]{3,4}$/.test(mode)) { fmToast("Mode must be octal, like 644 or 755.", "error"); return undefined; }
            return { mode, recursive: !!b.querySelector("#fm-mode-rec")?.checked };
        },
    });
    if (!result) return;
    try {
        await fmRequest(fmApi("chmod"), "POST", { path: fm.path, items: [entry.name], mode: result.mode, recursive: result.recursive });
        fmToast(`Permissions set to ${result.mode}`);
        await fmLoad();
    } catch (err) {
        fmToast(err.message, "error");
    }
}

// ---- toolbar actions ----------------------------------------------------

async function fmCreateDirectory() {
    const name = await fmAskText("Create Directory", "Directory name", "", "Create");
    if (!name) return;
    try {
        await fmRequest(fmApi("mkdir"), "POST", { path: fm.path, name });
        fmToast(`Created ${name}/`);
        await fmLoad();
    } catch (err) { fmToast(err.message, "error"); }
}

async function fmCreateFile() {
    const name = await fmAskText("New File", "File name", "", "Create", "You can use sub-folders, e.g. <code>utils/helper.py</code>.");
    if (!name) return;
    try {
        const r = await fmRequest(fmApi("newfile"), "POST", { path: fm.path, name });
        fmToast(`Created ${name}`);
        await fmOpenEditor(r.path);
    } catch (err) { fmToast(err.message, "error"); }
}

// ---- upload (button, drag & drop, folders, progress) ---------------------

function fmUploadBatch(batch, path, onProgress) {
    return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append("path", path);
        batch.forEach(it => form.append("files", it.file, it.relPath));
        const xhr = new XMLHttpRequest();
        xhr.open("POST", fmApi("upload"));
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded); };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return resolve();
            let msg = `Upload failed (${xhr.status})`;
            try { const d = JSON.parse(xhr.responseText); if (d.detail) msg = typeof d.detail === "string" ? d.detail : msg; } catch (e) {}
            reject(new Error(msg));
        };
        xhr.onerror = () => reject(new Error("Network error during upload."));
        xhr.send(form);
    });
}

async function fmUploadItems(items) {
    if (!selectedBotId || !items.length) return;
    const limit = fm.maxUploadMb * 1024 * 1024;
    const tooBig = items.filter(i => i.file.size > limit);
    if (tooBig.length) {
        fmToast(`${tooBig.length} file(s) skipped: larger than ${fm.maxUploadMb} MB (${tooBig[0].relPath})`, "error");
        items = items.filter(i => i.file.size <= limit);
        if (!items.length) return;
    }

    // batches of up to 20 files / ~50 MB so a big folder never makes one giant request
    const batches = [];
    let cur = [], curSize = 0;
    items.forEach(it => {
        if (cur.length && (cur.length >= 20 || curSize + it.file.size > 50 * 1024 * 1024)) { batches.push(cur); cur = []; curSize = 0; }
        cur.push(it); curSize += it.file.size;
    });
    if (cur.length) batches.push(cur);

    const total = items.reduce((a, i) => a + i.file.size, 0) || 1;
    const panel = document.getElementById("fm-upload-panel");
    const bar = document.getElementById("fm-upload-bar");
    const title = document.getElementById("fm-upload-title");
    const sub = document.getElementById("fm-upload-sub");
    panel.style.display = "block";
    title.textContent = `Uploading ${items.length} file${items.length > 1 ? "s" : ""}...`;
    bar.style.width = "0%";

    const targetPath = fm.path;
    let done = 0, failed = false;
    try {
        for (const batch of batches) {
            const batchSize = batch.reduce((a, i) => a + i.file.size, 0);
            await fmUploadBatch(batch, targetPath, (loaded) => {
                const overall = Math.min(total, done + Math.min(loaded, batchSize));
                bar.style.width = (overall / total * 100).toFixed(1) + "%";
                sub.textContent = `${fmFormatBytes(overall)} / ${fmFormatBytes(total)}`;
            });
            done += batchSize;
        }
        bar.style.width = "100%";
        fmToast(`Uploaded ${items.length} file${items.length > 1 ? "s" : ""}`);
    } catch (err) {
        failed = true;
        fmToast(err.message, "error");
    } finally {
        setTimeout(() => { panel.style.display = "none"; }, failed ? 500 : 900);
        if (selectedBotId && fm.path === targetPath) await fmLoad();
    }
}

// Read a dropped DataTransfer, descending into folders
async function fmCollectDropped(dt) {
    const out = [];
    const readEntry = (entry, prefix) => new Promise(resolve => {
        if (entry.isFile) {
            entry.file(f => { out.push({ file: f, relPath: prefix + f.name }); resolve(); }, () => resolve());
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const all = [];
            const readBatch = () => reader.readEntries(async (batch) => {
                if (!batch.length) {
                    for (const child of all) await readEntry(child, prefix + entry.name + "/");
                    resolve();
                } else { all.push(...batch); readBatch(); }
            }, () => resolve());
            readBatch();
        } else resolve();
    });
    const entries = [];
    for (const item of dt.items || []) {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
    }
    if (entries.length) {
        for (const e of entries) await readEntry(e, "");
    } else {
        [...(dt.files || [])].forEach(f => out.push({ file: f, relPath: f.name }));
    }
    return out;
}

// ---- code editor -----------------------------------------------------------

function initAceEditor() {
    const container = document.getElementById("fm-editor");
    if (!container || typeof ace === "undefined") return;

    aceEditor = ace.edit("fm-editor");
    aceEditor.setTheme("ace/theme/tomorrow_night_eighties");
    aceEditor.session.setMode("ace/mode/python");
    aceEditor.setReadOnly(true);
    aceEditor.setShowPrintMargin(false);
    aceEditor.session.on("change", () => { if (fm.editing && !fm.editing.loading) fm.editing.dirty = true; });

    aceEditor.commands.addCommand({
        name: "saveFile",
        bindKey: { win: "Ctrl-S", mac: "Command-S" },
        exec: function () { fmSaveEditor(false); }
    });
}

function fmAceMode(path) {
    const ext = path.split(".").pop().toLowerCase();
    const map = { py: "python", json: "json", js: "javascript", md: "markdown", html: "html", css: "css",
                  yml: "yaml", yaml: "yaml", sh: "sh", ini: "ini", toml: "toml", xml: "xml", sql: "sql", env: "text", txt: "text" };
    return "ace/mode/" + (map[ext] || "text");
}

async function fmOpenEditor(path) {
    if (!selectedBotId || !aceEditor) return;
    try {
        const res = await fetch(`/api/bots/${selectedBotId}/files/read?path=${encodeURIComponent(path)}`);
        if (!res.ok) {
            let msg = "Could not open file.";
            try { const d = await res.json(); if (d.detail) msg = d.detail; } catch (e) {}
            throw new Error(msg);
        }
        const data = await res.json();
        fm.editing = { path, dirty: false, loading: true };
        aceEditor.session.setMode(fmAceMode(path));
        aceEditor.setValue(data.content, -1);
        aceEditor.setReadOnly(false);
        aceEditor.session.getUndoManager().reset();
        fm.editing.loading = false;

        document.getElementById("fm-editor-path").textContent = "/" + path;
        document.getElementById("fm-list-view").style.display = "none";
        document.getElementById("fm-editor-view").style.display = "block";
        document.getElementById("fm-editor-save-restart").style.display = path.endsWith(".py") ? "inline-flex" : "none";
        fmUpdateBulkBar();
        aceEditor.resize();
        aceEditor.focus();
    } catch (err) {
        fmToast(err.message, "error");
    }
}

async function fmSaveEditor(restart) {
    if (!selectedBotId || !fm.editing) return;
    const btn = document.getElementById("fm-editor-save");
    btn.disabled = true;
    try {
        await fmRequest(`/api/bots/${selectedBotId}/files/write`, "POST", { path: fm.editing.path, content: aceEditor.getValue() });
        fm.editing.dirty = false;
        fmToast(`Saved ${fm.editing.path}`);
        if (restart) handleWSControlBot("restart");
    } catch (err) {
        fmToast(err.message, "error");
    } finally {
        btn.disabled = false;
    }
}

async function fmCloseEditor() {
    if (fm.editing && fm.editing.dirty) {
        const ok = await fmModal({
            title: "Unsaved changes", confirmText: "Discard", danger: true,
            bodyHTML: `<div class="fm-modal-msg">You have unsaved changes in <b>${escapeHTML(fm.editing.path)}</b>. Leave without saving?</div>`,
        });
        if (!ok) return;
    }
    fm.editing = null;
    aceEditor.setReadOnly(true);
    fmShowList();
    fmLoad();
}

// ---- event wiring (called once from initDashboard) ---------------------------

function fmBindEvents() {
    const list = document.getElementById("fm-list");
    if (!list) return;

    document.getElementById("fm-btn-mkdir").addEventListener("click", fmCreateDirectory);
    document.getElementById("fm-btn-newfile").addEventListener("click", fmCreateFile);
    document.getElementById("fm-btn-upload").addEventListener("click", () => document.getElementById("fm-upload-input").click());
    document.getElementById("fm-upload-input").addEventListener("change", (e) => {
        const items = [...e.target.files].map(f => ({ file: f, relPath: f.name }));
        e.target.value = "";
        fmUploadItems(items);
    });

    document.getElementById("fm-breadcrumb").addEventListener("click", (e) => {
        const a = e.target.closest("a[data-path]");
        if (a) fmLoad(a.dataset.path);
    });

    document.getElementById("fm-select-all").addEventListener("change", (e) => {
        fm.selected.clear();
        if (e.target.checked) fm.entries.forEach((_, i) => fm.selected.add(i));
        fmUpdateBulkBar();
    });

    list.addEventListener("click", (e) => {
        const row = e.target.closest(".fm-row");
        if (!row) return;
        const i = Number(row.dataset.i);
        if (e.target.closest(".fm-check")) {
            const cb = row.querySelector(".fm-sel");
            // click on the label toggles the checkbox itself; sync state next tick
            setTimeout(() => { cb.checked ? fm.selected.add(i) : fm.selected.delete(i); fmUpdateBulkBar(); }, 0);
            return;
        }
        if (e.target.closest(".fm-more")) {
            e.stopPropagation();
            const r = e.target.closest(".fm-more").getBoundingClientRect();
            fmOpenMenu(i, r.right - 190, r.bottom + 4);
            return;
        }
        const entry = fm.entries[i];
        if (entry.is_dir) fmLoad(fmJoin(fm.path, entry.name));
        else if (entry.editable) fmOpenEditor(fmJoin(fm.path, entry.name));
        else fmToast(`${entry.name} can't be edited here. Use Options → Download.`, "error");
    });

    list.addEventListener("contextmenu", (e) => {
        const row = e.target.closest(".fm-row");
        if (!row) return;
        e.preventDefault();
        fmOpenMenu(Number(row.dataset.i), e.clientX, e.clientY);
    });

    document.getElementById("fm-menu").addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const idx = fm.menuIndex;
        fmCloseMenu();
        fmRunAction(btn.dataset.act, idx);
    });
    document.addEventListener("click", (e) => { if (!e.target.closest("#fm-menu")) fmCloseMenu(); });
    document.addEventListener("scroll", fmCloseMenu, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") fmCloseMenu(); });

    // bulk actions
    document.getElementById("fm-bulk-archive").addEventListener("click", async () => {
        try {
            const r = await fmRequest(fmApi("archive"), "POST", { path: fm.path, items: fmSelectedNames() });
            fmToast(`Created ${r.name}`);
            await fmLoad();
        } catch (err) { fmToast(err.message, "error"); }
    });
    document.getElementById("fm-bulk-move").addEventListener("click", () => fmMoveFlow(fmSelectedNames()));
    document.getElementById("fm-bulk-delete").addEventListener("click", async () => {
        const names = fmSelectedNames();
        const ok = await fmConfirm("Delete", `Delete <b>${names.length}</b> selected item${names.length > 1 ? "s" : ""}? This cannot be undone.`);
        if (!ok) return;
        try {
            await fmRequest(fmApi("delete"), "POST", { path: fm.path, items: names });
            fmToast(`Deleted ${names.length} item${names.length > 1 ? "s" : ""}`);
            await fmLoad();
        } catch (err) { fmToast(err.message, "error"); }
    });

    // drag & drop upload (files or folders)
    const zone = document.getElementById("fm-dropzone");
    let dragDepth = 0;
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
    zone.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; zone.classList.add("dragging"); });
    zone.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    zone.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) zone.classList.remove("dragging"); });
    zone.addEventListener("drop", async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        zone.classList.remove("dragging");
        const items = await fmCollectDropped(e.dataTransfer);
        fmUploadItems(items);
    });

    // editor buttons
    document.getElementById("fm-editor-back").addEventListener("click", fmCloseEditor);
    document.getElementById("fm-editor-save").addEventListener("click", () => fmSaveEditor(false));
    document.getElementById("fm-editor-save-restart").addEventListener("click", () => fmSaveEditor(true));
}


// --- Live Performance Metrics (Chart.js Integration) ---

function setupMetricsCharts(botId) {
    stopMetricsPolling();
    
    // Clear data history
    cpuDataHistory = Array(15).fill(0);
    ramDataHistory = Array(15).fill(0);
    chartLabels = Array(15).fill("");
    
    // Initialize Chart instances
    initMetricsCharts();
    
    // Start Polling loop
    pollBotMetrics(botId);
    metricsPollInterval = setInterval(() => pollBotMetrics(botId), 2000);
}

function initMetricsCharts() {
    const ctxCpu = document.getElementById("chart-cpu")?.getContext("2d");
    const ctxRam = document.getElementById("chart-ram")?.getContext("2d");
    
    if (!ctxCpu || !ctxRam) return;
    
    // Destroy existing chart if initialized
    if (cpuChart) cpuChart.destroy();
    if (ramChart) ramChart.destroy();
    
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            y: {
                beginAtZero: true,
                grid: { color: "rgba(26, 35, 61, 0.5)" },
                ticks: { color: "#9ca3af" }
            },
            x: {
                grid: { display: false },
                ticks: { display: false }
            }
        },
        plugins: {
            legend: { display: false }
        },
        animation: { duration: 0 } // No animation for real-time responsiveness
    };
    
    cpuChart = new Chart(ctxCpu, {
        type: 'line',
        data: {
            labels: chartLabels,
            datasets: [{
                data: cpuDataHistory,
                borderColor: '#00ff66',
                borderWidth: 2,
                tension: 0.2,
                fill: false
            }]
        },
        options: chartOptions
    });
    
    ramChart = new Chart(ctxRam, {
        type: 'line',
        data: {
            labels: chartLabels,
            datasets: [{
                data: ramDataHistory,
                borderColor: '#8b5cf6',
                borderWidth: 2,
                tension: 0.2,
                fill: false
            }]
        },
        options: chartOptions
    });
}

async function pollBotMetrics(botId) {
    try {
        const res = await fetch(`/api/bots/${botId}/metrics`);
        if (res.ok) {
            const metrics = await res.json();
            updateConsoleStats(metrics);
            
            // Push values
            cpuDataHistory.push(metrics.cpu);
            cpuDataHistory.shift();
            
            ramDataHistory.push(metrics.ram);
            ramDataHistory.shift();
            
            chartLabels.push(new Date().toLocaleTimeString().split(" ")[0]);
            chartLabels.shift();
            
            // Update charts
            if (cpuChart) {
                cpuChart.data.datasets[0].data = cpuDataHistory;
                cpuChart.update();
            }
            if (ramChart) {
                ramChart.data.datasets[0].data = ramDataHistory;
                ramChart.update();
            }
        }
    } catch (err) {
        console.error("Error polling bot metrics:", err);
    }
}

function stopMetricsPolling() {
    if (metricsPollInterval) {
        clearInterval(metricsPollInterval);
        metricsPollInterval = null;
    }
}

// --- Admin Controls Panel ---

async function fetchAdminData() {
    if (currentUser.role !== "admin") return;
    
    try {
        // 1. Fetch Users
        const resUsers = await fetch("/api/admin/users");
        if (resUsers.ok) {
            const users = await resUsers.json();
            renderAdminUsers(users);
            populateOwnerDropdown(users);
        }
        
        // 2. Fetch Settings
        const resSettings = await fetch("/api/admin/settings");
        if (resSettings.ok) {
            const settings = await resSettings.json();
            document.getElementById("admin-auto-approve-toggle").checked = settings.auto_approve;
        }
    } catch (err) {
        console.error("Error fetching admin data:", err);
    }
}

function renderAdminUsers(users) {
    const tbody = document.getElementById("admin-users-table-body");
    if (!tbody) return;
    
    tbody.innerHTML = users.map(u => {
        let statusClass = "status-stopped"; // pending (grey)
        if (u.status === "approved") statusClass = "status-running"; // green
        if (u.status === "banned") statusClass = "status-error"; // red
        
        const isSelf = u.username === currentUser.username;
        const regDate = (u.registered_at && u.registered_at !== "unknown") ? new Date(u.registered_at).toLocaleString() : "Unknown";
        
        return `
            <tr>
                <td>
                    <a href="javascript:void(0)" onclick="openUserManageModal('${escapeHTML(u.username)}')" style="color: var(--primary-light); text-decoration: underline; font-weight: bold; display: inline-block; transition: color 0.2s;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--primary-light)'">
                        ${escapeHTML(u.username)}
                    </a> 
                    ${isSelf ? '<span style="font-size:0.65rem; color:var(--accent); font-family:\'Fira Code\', monospace;">[YOU]</span>' : ''}
                </td>
                <td><span class="badge-owner" style="font-size:0.65rem;">${u.role.toUpperCase()}</span></td>
                <td><span class="bot-status-badge ${statusClass}" style="font-size:0.65rem; padding: 0.15rem 0.4rem;">${u.status}</span></td>
                <td><span style="font-family: 'Fira Code', monospace; color: var(--accent);">${escapeHTML(u.ip_address)}</span></td>
                <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(u.device_name)}">${escapeHTML(u.device_name)}</td>
                <td style="color: var(--text-muted);">${regDate}</td>
                <td style="cursor: pointer;" onclick="openUserManageModal('${escapeHTML(u.username)}')">
                    <span class="badge-owner" style="font-size:0.65rem; border-color: var(--accent); color: var(--accent); cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='rgba(0, 255, 102, 0.15)'" onmouseout="this.style.background='transparent'">
                        ${u.bots_count} / ${u.role === 'admin' ? 'Infinite' : u.bot_limit} bots
                    </span>
                </td>
                <td>
                    ${!isSelf ? `
                        <div style="display:flex; gap:0.25rem;">
                            ${u.status === 'pending' ? `
                                <button class="btn btn-accent" style="padding: 0.25rem 0.5rem; font-size: 0.65rem;" onclick="adminApproveUser('${u.username}')">Approve</button>
                            ` : ''}
                            ${u.status === 'approved' ? `
                                <button class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.65rem;" onclick="adminBanUser('${u.username}')">Ban</button>
                            ` : ''}
                            ${u.status === 'banned' ? `
                                <button class="btn btn-accent" style="padding: 0.25rem 0.5rem; font-size: 0.65rem;" onclick="adminUnbanUser('${u.username}')">Unban</button>
                            ` : ''}
                            <button class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.65rem; background: transparent; border-color: var(--danger);" onclick="adminDeleteUser('${u.username}')">Delete</button>
                        </div>
                    ` : '<span style="color: var(--text-dark);">No Actions</span>'}
                </td>
            </tr>
        `;
    }).join("");
}

async function adminApproveUser(username) {
    if (!confirm(`Approve user '${username}' access to host bots?`)) return;
    try {
        const res = await fetch(`/api/admin/users/${username}/approve`, { method: "POST" });
        if (res.ok) {
            fetchAdminData();
        } else {
            alert("Failed to approve user.");
        }
    } catch (err) {
        console.error(err);
    }
}

async function adminBanUser(username) {
    if (!confirm(`Are you sure you want to BAN user '${username}'? They will be locked out immediately.`)) return;
    try {
        const res = await fetch(`/api/admin/users/${username}/ban`, { method: "POST" });
        if (res.ok) {
            fetchAdminData();
        } else {
            alert("Failed to ban user.");
        }
    } catch (err) {
        console.error(err);
    }
}

async function adminUnbanUser(username) {
    if (!confirm(`Restore access for banned user '${username}'?`)) return;
    try {
        const res = await fetch(`/api/admin/users/${username}/unban`, { method: "POST" });
        if (res.ok) {
            fetchAdminData();
        } else {
            alert("Failed to unban user.");
        }
    } catch (err) {
        console.error(err);
    }
}

async function adminDeleteUser(username) {
    if (!confirm(`CRITICAL WARNING: Are you sure you want to DELETE user '${username}'? This will delete all of their hosted bot files permanently.`)) return;
    try {
        const res = await fetch(`/api/admin/users/${username}`, { method: "DELETE" });
        if (res.ok) {
            fetchAdminData();
        } else {
            alert("Failed to delete user.");
        }
    } catch (err) {
        console.error(err);
    }
}

async function saveAdminSettings() {
    const autoApprove = document.getElementById("admin-auto-approve-toggle").checked;
    const btn = document.getElementById("btn-save-settings");
    btn.disabled = true;
    
    try {
        const res = await fetch("/api/admin/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ auto_approve: autoApprove })
        });
        
        if (res.ok) {
            alert("Settings updated successfully!");
        } else {
            alert("Failed to save settings.");
        }
    } catch (err) {
        console.error(err);
    } finally {
        btn.disabled = false;
    }
}

async function handleAdminChangePassword(e) {
    e.preventDefault();
    const input = document.getElementById("admin_new_password");
    const val = input.value.trim();
    if (!val) return;
    
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    
    try {
        const res = await fetch("/api/admin/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ new_password: val })
        });
        
        if (res.ok) {
            alert("Password changed successfully!");
            input.value = "";
        } else {
            alert("Failed to change password.");
        }
    } catch (err) {
        console.error(err);
    } finally {
        btn.disabled = false;
    }
}

// Utility functions
function escapeHTML(str) {
    if (!str) return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// --- 3D Scroll Reveal IntersectionObserver ---
function applyScrollReveal() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add("revealed");
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.05 });

    document.querySelectorAll(".scroll-reveal").forEach(el => observer.observe(el));
}

// --- Quota / Bot Limit Badges ---
function updateBotLimitBadge() {
    const botCount = bots.length;
    const limit = currentUser.bot_limit || 3;
    const isInfinite = currentUser.role === "admin";
    
    const limitText = isInfinite ? "Infinite" : limit;
    
    const badge = document.getElementById("bot-limit-badge");
    if (badge) {
        badge.textContent = `Bots: ${botCount} / ${limitText}`;
    }
    
    const modalBadge = document.getElementById("modal-bot-limit-badge");
    if (modalBadge) {
        modalBadge.textContent = isInfinite 
            ? `Quota: ${botCount} / Infinite bots used`
            : `Quota: ${botCount} / ${limit} bots used`;
    }
}

// --- Dynamic Owner Dropdown Populator ---
function populateOwnerDropdown(users) {
    const selectEl = document.getElementById("bot_owner");
    if (!selectEl) return;
    
    const approved = users.filter(u => u.status === "approved");
    selectEl.innerHTML = approved.map(u => `
        <option value="${escapeHTML(u.username)}" ${u.username === currentUser.username ? 'selected' : ''}>
            ${escapeHTML(u.username)} (${u.role.toUpperCase()})
        </option>
    `).join("");
}

// --- User Management Modal Logic ---
let selectedManageUser = "";

async function openUserManageModal(username) {
    selectedManageUser = username;
    document.getElementById("manage-user-title").textContent = `Manage Operator: ${username}`;
    
    const limitInput = document.getElementById("manage-user-limit-input");
    
    try {
        const resUsers = await fetch("/api/admin/users");
        if (resUsers.ok) {
            const users = await resUsers.json();
            const u = users.find(x => x.username === username);
            if (u && limitInput) {
                limitInput.value = u.bot_limit;
            }
        }
    } catch (err) {
        console.error("Error fetching user for modal:", err);
    }
    
    await fetchAndRenderUserBots(username);
    
    document.getElementById("user-manage-modal").classList.add("open");
}

function closeUserManageModal() {
    document.getElementById("user-manage-modal").classList.remove("open");
}

async function saveUserLimit() {
    if (!selectedManageUser) return;
    const limitInput = document.getElementById("manage-user-limit-input");
    const limit = parseInt(limitInput.value);
    if (isNaN(limit) || limit < 0) {
        alert("Please enter a valid positive number.");
        return;
    }
    
    try {
        const res = await fetch(`/api/admin/users/${selectedManageUser}/limit`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bot_limit: limit })
        });
        if (res.ok) {
            alert(`Successfully updated bot limit for ${selectedManageUser} to ${limit}!`);
            fetchAdminData();
        } else {
            const err = await res.json();
            alert(`Error: ${err.detail || "Failed to update limit."}`);
        }
    } catch (err) {
        console.error("Error saving user limit:", err);
        alert("Network error.");
    }
}

async function fetchAndRenderUserBots(username) {
    const listContainer = document.getElementById("manage-user-bots-list");
    if (!listContainer) return;
    
    listContainer.innerHTML = `<div style="color: var(--text-muted); font-size: 0.8125rem;">Loading bot instances...</div>`;
    
    try {
        const res = await fetch(`/api/admin/users/${username}/bots`);
        if (res.ok) {
            const userBots = await res.json();
            if (userBots.length === 0) {
                listContainer.innerHTML = `<div style="color: var(--text-muted); font-size: 0.8125rem;">No bots hosted by this user.</div>`;
                return;
            }
            
            listContainer.innerHTML = userBots.map(bot => {
                const statusClass = bot.status === "running" ? "status-running" : "status-stopped";
                return `
                    <div class="manage-bot-item">
                        <div>
                            <strong style="color: var(--text-main); font-size: 0.875rem;">${escapeHTML(bot.name)}</strong>
                            <span class="bot-status-badge ${statusClass}" style="font-size: 0.65rem; margin-left: 0.5rem; padding: 0.1rem 0.3rem;">${bot.status}</span>
                            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">
                                ID: ${escapeHTML(bot.id)} &bull; Entrypoint: ${escapeHTML(bot.entrypoint)}
                            </div>
                        </div>
                        <div style="display: flex; gap: 0.5rem; align-items: center;">
                            ${bot.status === 'running' ? `
                                <button class="btn btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.65rem;" onclick="controlUserBot('${bot.id}', 'stop')">Stop</button>
                            ` : `
                                <button class="btn btn-accent" style="padding: 0.25rem 0.5rem; font-size: 0.65rem;" onclick="controlUserBot('${bot.id}', 'start')">Start</button>
                            `}
                            <button class="btn btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.65rem;" onclick="controlUserBot('${bot.id}', 'restart')">Restart</button>
                            <button class="btn btn-primary" style="padding: 0.25rem 0.5rem; font-size: 0.65rem;" onclick="manageUserBotWorkspace('${bot.id}')">Manage</button>
                        </div>
                    </div>
                `;
            }).join("");
        } else {
            listContainer.innerHTML = `<div style="color: var(--danger); font-size: 0.8125rem;">Failed to retrieve user bots.</div>`;
        }
    } catch (err) {
        console.error("Error fetching user bots:", err);
        listContainer.innerHTML = `<div style="color: var(--danger); font-size: 0.8125rem;">Network error.</div>`;
    }
}

async function controlUserBot(botId, action) {
    try {
        const res = await fetch(`/api/bots/${botId}/${action}`, { method: "POST" });
        if (res.ok) {
            if (selectedManageUser) {
                await fetchAndRenderUserBots(selectedManageUser);
            }
            fetchBots(false);
        } else {
            const err = await res.json();
            alert(`Error: ${err.detail || "Failed to control bot."}`);
        }
    } catch (err) {
        console.error("Error controlling user bot:", err);
    }
}

function manageUserBotWorkspace(botId) {
    closeUserManageModal();
    viewBotWorkspace(botId);
}
