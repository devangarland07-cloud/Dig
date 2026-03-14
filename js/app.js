/**
 * DIG Yacht Management Software - Core Kernel v3.0 Alpha
 * Clean Slate Refactor with Robust Local Persistence & User Accountability
 */

// Auto-clear legacy data once for a fresh start as requested
if (!localStorage.getItem('blondie_demo_reset_v2')) {
    localStorage.clear();
    localStorage.setItem('blondie_demo_reset_v2', 'true');
    console.log("Memory cleared for a fresh start.");
}

class UserManager {
    constructor() {
        this.currentUser = JSON.parse(localStorage.getItem('blondie_user_session')) || null;
        this.users = JSON.parse(localStorage.getItem('blondie_users')) || [];
    }

    async hashPassword(password) {
        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async signUp(email, password, name) {
        if (this.users.find(u => u.email === email)) {
            alert("This fleet email is already registered. Please login instead.");
            return false;
        }
        const hashedPassword = await this.hashPassword(password);
        const newUser = { email, password: hashedPassword, name };
        this.users.push(newUser);
        localStorage.setItem('blondie_users', JSON.stringify(this.users));
        return this.login(email, password); // login will hash it again
    }

    async login(email, password) {
        const hashedPassword = await this.hashPassword(password);
        const user = this.users.find(u => u.email === email && u.password === hashedPassword);
        
        // Backward compatibility for existing plaintext passwords
        const legacyUser = this.users.find(u => u.email === email && u.password === password);
        const finalUser = user || legacyUser;

        if (finalUser) {
            this.currentUser = finalUser;
            // Upgrade to hash if it was plaintext
            if (legacyUser && !user) {
                finalUser.password = hashedPassword;
                localStorage.setItem('blondie_users', JSON.stringify(this.users));
            }
            localStorage.setItem('blondie_user_session', JSON.stringify(this.currentUser));
            return true;
        }
        alert("Account not found or incorrect access key.\n\nIf you haven't successfully registered yet, please click 'Request New Credentials?'.");
        return false;
    }

    logout() {
        this.currentUser = null;
        localStorage.removeItem('blondie_user_session');
        location.reload();
    }

    isAuthenticated() {
        return this.currentUser !== null;
    }
}

const auth = new UserManager();

class SettingsManager {
    constructor() {
        this.loadSettings();
    }

    loadSettings() {
        const userPrefix = auth.currentUser ? `_${auth.currentUser.email}` : '';
        const stored = JSON.parse(localStorage.getItem('dig_fleet_settings' + userPrefix));
        const oldStored = JSON.parse(localStorage.getItem('blondie_fleet_settings' + userPrefix));
        
        if (stored && stored.fleet && stored.fleet.length > 0) {
            this.fleet = stored.fleet;
            this.activeVesselId = stored.activeVesselId || this.fleet[0].id;
        } else if (oldStored && oldStored.vesselName) {
            this.fleet = [{
                id: 'vsl_' + Date.now(),
                name: oldStored.vesselName || 'FLEET ASSET',
                backdrop: oldStored.backdrop || ''
            }];
            this.activeVesselId = this.fleet[0].id;
        } else {
            this.fleet = [];
            this.activeVesselId = null;
        }
    }

    get activeVessel() {
        if (this.fleet.length === 0) return { name: "M/Y EXPLORER", backdrop: "" };
        return this.fleet.find(v => v.id === this.activeVesselId) || this.fleet[0];
    }

    initUI(appInstance) {
        if (this.fleet.length === 0) {
            // Force the user to create their first asset
            if (appInstance) {
                appInstance.openSettingsModal();
                appInstance.setSettingsMode('new');
            } else if (typeof app !== 'undefined') {
                app.openSettingsModal();
                app.setSettingsMode('new');
            }
            return;
        }
        this.applySettings();
        this.renderVesselSelector();
    }

    saveSettings(vesselName, backdropData, mode = 'edit') {
        const appInstance = typeof app !== 'undefined' ? app : null;
        if (mode === 'new') {
            const newVessel = {
                id: 'vsl_' + Date.now(), // Standardized prefix
                name: vesselName || 'FLEET ASSET',
                backdrop: backdropData || ''
            };
            this.fleet.push(newVessel);
            this.activeVesselId = newVessel.id;
        } else {
            const active = this.activeVessel;
            if (active) {
                active.name = vesselName || active.name;
                if (backdropData !== undefined) active.backdrop = backdropData;
            }
        }
        
        const status = this.persist();
        if (status) {
            this.applySettings();
            this.renderVesselSelector();
            
            // Broadcast change to all listeners (including app kernel)
            window.dispatchEvent(new CustomEvent('vesselSwitched', { 
                detail: { vesselId: this.activeVesselId } 
            }));
            return true;
        }
        return false;
    }

    switchVessel(id) {
        if (id === 'add_new') {
            const appInstance = typeof app !== 'undefined' ? app : null;
            if (appInstance) {
                appInstance.openSettingsModal();
                appInstance.setSettingsMode('new');
            }
            // Reset dropdown visual state back to current active vessel
            this.renderVesselSelector();
            return;
        }
        
        if (this.fleet.find(v => v.id === id)) {
            this.activeVesselId = id;
            this.persist();
            this.applySettings();
            this.renderVesselSelector();
            window.dispatchEvent(new CustomEvent('vesselSwitched'));
        }
    }

    persist() {
        try {
            const data = JSON.stringify({
                fleet: this.fleet,
                activeVesselId: this.activeVesselId
            });
            const userPrefix = auth.currentUser ? `_${auth.currentUser.email}` : '';
            localStorage.setItem('dig_fleet_settings' + userPrefix, data);
            console.log("Fleet parity synchronized. Payload size:", (data.length / 1024).toFixed(2), "KB");
            return true;
        } catch (e) {
            console.error("Storage Error:", e);
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                alert("CRITICAL ERROR: Vessel Configuration too large for local memory.\n\nPlease use a smaller/compressed image for the backdrop.");
            } else {
                alert("An error occurred while saving vessel data. Details: " + e.message);
            }
            return false;
        }
    }

    resetToDefaults() {
        // Only reset the backdrop of the current vessel
        this.activeVessel.backdrop = '';
        this.persist();
        this.applySettings();
        window.dispatchEvent(new CustomEvent('vesselSwitched'));
        
        const preview = document.getElementById('settings-preview-img-bg');
        if (preview) preview.style.backgroundImage = 'none';
        const filename = document.getElementById('setting-file-name');
        if (filename) filename.innerText = "Click to upload image";
        const fileInput = document.getElementById('setting-backdrop');
        if (fileInput) fileInput.value = '';
    }

    deleteCurrentVessel() {
        if (this.fleet.length <= 1) {
            alert("Cannot delete the only vessel in the fleet.");
            app.setSettingsMode('edit'); // reset the delete buttons
            return;
        }

        const deletedVesselId = this.activeVesselId;

        // Remove from fleet array
        this.fleet = this.fleet.filter(v => v.id !== deletedVesselId);
        
        // Find logs for this asset and remove them from localStorage
        const allLogsData = localStorage.getItem('dig_maintenance_v3');
        if (allLogsData) {
            let allLogs = JSON.parse(allLogsData);
            allLogs = allLogs.filter(log => log.vesselId !== deletedVesselId);
            localStorage.setItem('dig_maintenance_v3', JSON.stringify(allLogs));
        }

        // Switch to the first available vessel
        this.activeVesselId = this.fleet[0].id;
        
        this.persist();
        this.applySettings();
        this.renderVesselSelector();
        
        app.closeSettingsModal();
        window.dispatchEvent(new CustomEvent('vesselSwitched'));
    }

    applySettings() {
        const vessel = this.activeVessel;
        const nameElements = document.querySelectorAll('#sidebar-vessel-name, #mobile-vessel-name');
        nameElements.forEach(el => {
            if (el) el.innerText = vessel.name;
        });

        const backdropElements = document.querySelectorAll('img[alt="Marine Backdrop"]');
        backdropElements.forEach(el => {
            if (el) {
                if (vessel.backdrop) {
                    el.src = vessel.backdrop;
                    el.classList.remove('hidden');
                } else {
                    el.src = '';
                    el.classList.add('hidden'); // Show plain block background instead
                }
            }
        });
    }
    
    renderVesselSelector() {
        const selectorContainers = document.querySelectorAll('.vessel-selector-container');
        selectorContainers.forEach(container => {
            const hasActiveVessel = this.fleet.length > 0;
            const options = this.fleet.map(v => `<option value="${v.id}" ${v.id === this.activeVesselId ? 'selected' : ''}>${v.name}</option>`).join('');
            
            container.innerHTML = `
                <select onchange="settingsManager.switchVessel(this.value)" class="form-input bg-white/5 border-white/10 text-white font-bold italic w-full py-2 px-3 text-sm mt-1 cursor-pointer truncate max-w-[180px]">
                    ${!hasActiveVessel ? `<option value="" disabled selected>+ Register New Asset</option>` : ''}
                    ${options}
                    ${hasActiveVessel ? `<option disabled>──────────</option>` : ''}
                    <option value="add_new">+ Register New Asset</option>
                </select>
            `;
        });
    }
}

const settingsManager = new SettingsManager();

class MaintenanceSuite {
    constructor() {
        console.log("DIG Yacht Management Software v3.0 Alpha Initializing...");
        
        // Initial State
        this.logs = this.loadLogs();
        this.alarms = this.loadAlarms();
        this.currentView = 'logs';
        this.filters = {
            search: '',
            category: 'All',
            status: 'All' 
        };
        this.editingLogId = null;
        this.editingAlarmId = null;
        this.currentAlarmImage = null; // Store base64 image data temporary

        // Migration for old logs
        if (this.logs && this.logs.length > 0 && !this.logs[0].vesselId) {
            if (settingsManager.fleet.length > 0) {
                this.logs.forEach(log => {
                    log.vesselId = settingsManager.fleet[0].id;
                });
                this.saveLogs();
            }
        }

        this.init();
    }

    /**
     * Kernel Initialization
     */
    init() {
        this.setupEventListeners();
        this.applyTheme();
        
        window.addEventListener('vesselSwitched', () => {
            const searchInput = document.getElementById('search-input');
            if (searchInput) searchInput.value = '';
            this.filters.search = '';

            if (this.currentView !== 'logs' && this.currentView !== 'dashboard') {
                this.switchView('logs');
            }
            this.render();
            this.updateDashboard();
        });

        if (!auth.isAuthenticated()) {
            this.showLandingUI();
            return;
        }
        
        // If authenticated but no vessels, force commissioning
        if (settingsManager.fleet.length === 0) {
            this.hideLandingUI();
            this.hideAuthUI();
            settingsManager.initUI(this);
            return;
        }

        this.hideLandingUI();
        this.hideAuthUI();
        
        // Ensure UI is synced with existing fleet data
        settingsManager.applySettings();
        settingsManager.renderVesselSelector();
        
        this.render();
        this.updateDashboard();
        this.updateUserUI();
    }

    showLandingUI() {
        document.getElementById('landing-overlay').classList.remove('hidden');
        document.getElementById('landing-overlay').classList.add('flex');
    }

    hideLandingUI() {
        document.getElementById('landing-overlay').classList.add('hidden');
        document.getElementById('landing-overlay').classList.remove('flex');
    }

    closeLandingOpenAuth() {
        this.hideLandingUI();
        this.showAuthUI();
    }

    showAuthUI() {
        document.getElementById('auth-overlay').classList.remove('hidden');
        document.getElementById('auth-overlay').classList.add('flex');
    }

    hideAuthUI() {
        document.getElementById('auth-overlay').classList.add('hidden');
        document.getElementById('auth-overlay').classList.remove('flex');
    }

    updateUserUI() {
        const userNameElements = document.querySelectorAll('#current-user-name, #mobile-user-name');
        userNameElements.forEach(el => el.innerText = auth.currentUser.name);
    }

    /**
     * Data Layer: LocalStorage Core
     */
    loadLogs() {
        try {
            const saved = localStorage.getItem('dig_maintenance_v3');
            if (!saved) return [];
            return JSON.parse(saved);
        } catch (e) {
            console.error("Storage corruption detected. Resetting to secure state.");
            return [];
        }
    }

    saveLogs() {
        try {
            localStorage.setItem('dig_maintenance_v3', JSON.stringify(this.logs));
            this.updateDashboard();
            console.log("Records synchronized. Total entries:", this.logs.length);
        } catch (e) {
            alert("Asset storage limit exceeded. Backup your logs and clear some history.");
        }
    }

    loadAlarms() {
        try {
            const saved = localStorage.getItem('dig_alarms_v1');
            if (!saved) return [];
            return JSON.parse(saved);
        } catch (e) {
            console.error("Alarm storage corruption detected.");
            return [];
        }
    }

    saveAlarms() {
        try {
            localStorage.setItem('dig_alarms_v1', JSON.stringify(this.alarms));
            this.updateDashboard();
        } catch (e) {
            alert("Alarm storage quota exceeded.");
        }
    }

    /**
     * CRUD Operations
     */
    addLog(formData) {
        if (this.editingLogId) {
            const logIndex = this.logs.findIndex(l => l.id === this.editingLogId);
            if (logIndex > -1) {
                this.logs[logIndex] = {
                    ...this.logs[logIndex],
                    title: formData.get('title'),
                    location: formData.get('location'),
                    category: formData.get('category'),
                    priority: formData.get('priority'),
                    timestamp: formData.get('date'),
                    notes: formData.get('notes')
                };
            }
            this.editingLogId = null;
        } else {
            const entry = {
                id: Date.now().toString(),
                vesselId: settingsManager.activeVesselId,
                title: formData.get('title'),
                location: formData.get('location'),
                category: formData.get('category'),
                priority: formData.get('priority'),
                timestamp: formData.get('date'), // Stored as YYYY-MM-DD
                notes: formData.get('notes'),
                completed: false,
                createdBy: auth.currentUser.name,
                createdAt: new Date().toISOString(),
                completedBy: null
            };
            this.logs.unshift(entry);
        }

        this.sortLogs();
        this.saveLogs();
        this.render();
    }

    editLog(id) {
        const log = this.logs.find(l => l.id === id);
        if (!log) return;

        this.editingLogId = id;
        const modal = document.getElementById('modal-new-entry');
        if (modal) {
            modal.querySelector('input[name="title"]').value = log.title;
            modal.querySelector('input[name="location"]').value = log.location;
            modal.querySelector('select[name="category"]').value = log.category;
            modal.querySelector('select[name="priority"]').value = log.priority;
            modal.querySelector('input[name="date"]').value = log.timestamp;
            modal.querySelector('textarea[name="notes"]').value = log.notes || '';
            
            modal.classList.remove('hidden');
            modal.classList.add('flex');
        }
    }

    deleteLog(id) {
        if (confirm("Permanently purge this entry from the history?")) {
            this.logs = this.logs.filter(l => l.id !== id);
            this.saveLogs();
            this.render();
        }
    }

    toggleComplete(id) {
        const log = this.logs.find(l => l.id === id);
        if (log) {
            log.completed = !log.completed;
            log.completedBy = log.completed ? auth.currentUser.name : null;
            this.saveLogs();
            this.render();
        }
    }

    sortLogs() {
        // Precise string-based sorting for YYYY-MM-DD
        this.logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    sortLogs() {
        // Precise string-based sorting for YYYY-MM-DD
        this.logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    /**
     * Intelligence: Filters & Search
     */
    setFilter(key, value) {
        this.filters[key] = value;
        
        // Reset category visuals if status filter is active
        if (key === 'status' && value !== 'All') {
            document.querySelectorAll('.filter-btn').forEach(b => {
                b.classList.remove('bg-azure', 'text-white', 'shadow-lg', 'shadow-azure/20');
                b.classList.add('bg-white/5', 'text-slate-400');
            });
            const allBtn = document.querySelector('[data-category="All"]');
            if (allBtn) {
                 allBtn.classList.add('bg-azure', 'text-white', 'shadow-lg', 'shadow-azure/20');
                 allBtn.classList.remove('bg-white/5', 'text-slate-400');
            }
            this.filters.category = 'All';
        }

        this.render();
    }

    getFilteredLogs() {
        return this.logs.filter(log => {
            // Filter by Active Vessel First
            const logVesselId = log.vesselId || settingsManager.fleet[0].id;
            if (logVesselId !== settingsManager.activeVesselId) return false;

            const matchesSearch = log.title.toLowerCase().includes(this.filters.search.toLowerCase()) || 
                                 (log.notes || '').toLowerCase().includes(this.filters.search.toLowerCase());
            const matchesCategory = this.filters.category === 'All' || log.category === this.filters.category;
            
            let matchesStatus = true;
            if (this.filters.status === 'Pending') matchesStatus = !log.completed;
            else if (this.filters.status === 'Completed') matchesStatus = log.completed;
            else if (this.filters.status === 'Critical') matchesStatus = log.priority === 'Critical' && !log.completed;

            return matchesSearch && matchesCategory && matchesStatus;
        });
    }

    getFilteredAlarms() {
        return this.alarms.filter(alarm => {
            const alarmVesselId = alarm.vesselId || (settingsManager.fleet.length > 0 ? settingsManager.fleet[0].id : null);
            if (alarmVesselId !== settingsManager.activeVesselId) return false;

            const matchesSearch = alarm.title.toLowerCase().includes(this.filters.search.toLowerCase()) ||
                                  (alarm.notes || '').toLowerCase().includes(this.filters.search.toLowerCase());
            
            return matchesSearch;
        }).sort((a, b) => new Date(b.loggedAt) - new Date(a.loggedAt)); // Sort by most recent
    }

    /**
     * Dashboard Analytics Engine
     */
    updateDashboard() {
        const fallbackId = settingsManager.fleet.length > 0 ? settingsManager.fleet[0].id : null;
        const vesselLogs = this.logs.filter(l => (l.vesselId || fallbackId) === settingsManager.activeVesselId);
        
        const total = vesselLogs.length;
        const completed = vesselLogs.filter(l => l.completed).length;
        const pending = total - completed;
        const critical = vesselLogs.filter(l => l.priority === 'Critical' && !l.completed).length;
        const unacknowledgedAlarms = this.alarms.filter(a => a.vesselId === settingsManager.activeVesselId && !a.acknowledged).length;

        const elements = {
            'stat-total': total,
            'stat-pending': pending,
            'stat-completed': completed,
            'stat-critical': critical,
            'stat-alarms': unacknowledgedAlarms
        };

        for (const [id, value] of Object.entries(elements)) {
            const el = document.getElementById(id);
            if (el) el.innerText = value;
        }
        
        const callout = document.getElementById('dashboard-empty-callout');
        if (callout) {
            if (total === 0) callout.classList.remove('hidden');
            else callout.classList.add('hidden');
        }

        // --- Maintenance Efficiency Index ---
        const efficiencyEl = document.getElementById('stat-efficiency');
        if (efficiencyEl) {
            if (total === 0) {
                efficiencyEl.innerText = "N/A";
                efficiencyEl.className = "text-xl font-bold text-slate-500 italic";
            } else {
                const ratio = completed / total;
                if (ratio >= 0.8) {
                    efficiencyEl.innerText = "Optimal";
                    efficiencyEl.className = "text-xl font-bold text-white italic";
                } else if (ratio >= 0.5) {
                    efficiencyEl.innerText = "Stable";
                    efficiencyEl.className = "text-xl font-bold text-slate-400 italic";
                } else {
                    efficiencyEl.innerText = "Critical";
                    efficiencyEl.className = "text-xl font-bold text-red-500 italic";
                }
            }
        }

        // --- Fleet Safety Status ---
        const safetyEl = document.getElementById('stat-safety');
        if (safetyEl) {
            if (critical > 0) {
                safetyEl.innerText = "Alert";
                safetyEl.className = "text-xl font-bold text-red-500 italic animate-pulse";
            } else {
                safetyEl.innerText = "Secured";
                safetyEl.className = "text-xl font-bold text-azure italic";
            }
        }
        
        if (window.myChart) {
            window.myChart.data.datasets[0].data = [completed, pending];
            window.myChart.update('none'); // Animate if preferred, 'none' for instant
        }
    }

    /**
     * Interaction Controllers
     */
    setupEventListeners() {
        // Navigation Control
        document.querySelectorAll('.nav-btn, .nav-btn-mobile').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const view = e.currentTarget.dataset.view;
                this.switchView(view);
            });
        });

        // Live Intelligence Search
        document.getElementById('search-input')?.addEventListener('input', (e) => {
            this.setFilter('search', e.target.value);
        });

        // Operation Filtering
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const cat = e.currentTarget.dataset.category;
                document.querySelectorAll('.filter-btn').forEach(b => {
                    b.classList.remove('bg-azure', 'text-white', 'shadow-lg', 'shadow-azure/20');
                    b.classList.add('bg-white/5', 'text-slate-400');
                });
                e.currentTarget.classList.add('bg-azure', 'text-white', 'shadow-lg', 'shadow-azure/20');
                e.currentTarget.classList.remove('bg-white/5', 'text-slate-400');
                
                // Clear status filter when standard category is clicked
                this.filters.status = 'All';
                this.setFilter('category', cat);
            });
        });

        // Dashboard Click-to-Filter
        document.getElementById('card-total')?.addEventListener('click', () => {
            this.setFilter('status', 'All');
            this.switchView('logs');
        });
        document.getElementById('card-pending')?.addEventListener('click', () => {
            this.setFilter('status', 'Pending');
            this.switchView('logs');
        });
        document.getElementById('card-completed')?.addEventListener('click', () => {
            this.setFilter('status', 'Completed');
            this.switchView('logs');
        });
        document.getElementById('card-critical')?.addEventListener('click', () => {
            this.setFilter('status', 'Critical');
            this.switchView('logs');
        });

        document.getElementById('card-alarms')?.addEventListener('click', () => {
            this.switchView('alarms');
        });

        // Form Controller
        document.getElementById('log-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.addLog(new FormData(e.target));
            this.closeModal();
            e.target.reset();
        });

        // Auth Form Controller
        document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const isSignUp = e.target.dataset.mode === 'signup';
            
            let success = false;
            if (isSignUp) {
                success = await auth.signUp(formData.get('email'), formData.get('password'), formData.get('name'));
            } else {
                success = await auth.login(formData.get('email'), formData.get('password'));
            }

            if (success) {
                this.hideAuthUI();
                this.updateUserUI();
                
                // Critical: Reload settings for the authenticated user
                settingsManager.loadSettings();
                
                // If no vessels, force commissioning modal
                if (settingsManager.fleet.length === 0) {
                    settingsManager.initUI(this);
                } else {
                    this.render();
                    this.updateDashboard();
                }
            }
        });

        // Settings Form Controller
        document.getElementById('settings-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const vesselName = document.getElementById('setting-vessel-name').value;
            const fileInput = document.getElementById('setting-backdrop');
            const mode = e.target.dataset.mode || 'edit';
            
            if (!vesselName.trim()) {
                alert("Please provide a valid vessel name.");
                return;
            }

            const saveAndClose = (backdrop) => {
                const wasSaved = settingsManager.saveSettings(vesselName, backdrop, mode);
                if (wasSaved) {
                    this.notifySave();
                    this.closeSettingsModal();
                }
            };

            if (fileInput.files && fileInput.files[0]) {
                const file = fileInput.files[0];
                
                // Pre-check for sanity (1.5MB reasonable limit for localStorage chunks)
                if (file.size > 1.5 * 1024 * 1024) {
                    alert("Image too large. Please select a file smaller than 1.5MB for better performance.");
                    return;
                }

                const reader = new FileReader();
                reader.onload = (event) => {
                    console.log("Image processed successfully. Saving to fleet...");
                    saveAndClose(event.target.result);
                };
                reader.onerror = () => {
                    alert("Error processing image. Please try a different file.");
                };
                reader.readAsDataURL(file);
            } else {
                // If editing and no new file, preserve existing backdrop. If new, default to empty.
                const existingBackdrop = mode === 'edit' ? settingsManager.activeVessel.backdrop : '';
                saveAndClose(existingBackdrop);
            }
        });

        // Settings Image Preview Controller
        document.getElementById('setting-backdrop')?.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                const reader = new FileReader();
                reader.onload = (event) => {
                    document.getElementById('settings-preview-img-bg').style.backgroundImage = `url(${event.target.result})`;
                    document.getElementById('setting-file-name').innerText = e.target.files[0].name;
                };
                reader.readAsDataURL(e.target.files[0]);
            }
        });

        // Alarm Submission
        const alarmForm = document.getElementById('alarm-form');
        if (alarmForm) {
            alarmForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.addAlarmEvent(new FormData(alarmForm));
                alarmForm.reset();
                const preview = document.getElementById('alarm-preview-container');
                if (preview) preview.classList.add('hidden');
                const fileName = document.getElementById('alarm-file-name');
                if (fileName) fileName.innerText = "Click to upload photo of alarm";
            });
        }
    }

    /**
     * UI Utilities
     */
    switchView(viewName) {
        this.currentView = viewName;
        
        // Update containers
        const views = ['logs', 'dashboard', 'alarms'];
        views.forEach(v => {
            const el = document.getElementById(`view-${v}`);
            if (el) {
                if (v === viewName) {
                    el.classList.remove('hidden');
                    el.classList.add('flex', 'flex-col'); // Layout fix for dashboard
                } else {
                    el.classList.add('hidden');
                    el.classList.remove('flex', 'flex-col');
                }
            }
        });

        // Update Nav UI
        document.querySelectorAll('.nav-btn, .nav-btn-mobile').forEach(btn => {
            const isActive = btn.dataset.view === viewName;
            if (btn.classList.contains('nav-btn')) {
                btn.classList.toggle('bg-white/5', isActive);
                btn.classList.toggle('text-white', isActive);
                btn.classList.toggle('border-white/5', isActive);
                btn.classList.toggle('shadow-inner', isActive);
                btn.classList.toggle('text-slate-400', !isActive);
                const svg = btn.querySelector('svg');
                if (svg) {
                    svg.classList.toggle('text-azure', isActive);
                    svg.classList.toggle('opacity-100', isActive);
                    svg.classList.toggle('opacity-40', !isActive);
                }
            } else {
                btn.classList.toggle('text-azure', isActive);
                btn.classList.toggle('scale-110', isActive);
                btn.classList.toggle('text-slate-500', !isActive);
            }
        });

        if (viewName === 'logs') this.render();
        if (viewName === 'alarms') this.renderAlarms();
        if (viewName === 'dashboard') this.updateDashboard();
    }

    openModal() {
        this.editingLogId = null; // reset edit state
        const modal = document.getElementById('modal-new-entry');
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            
            // Auto-set Date to local current
            const dateInput = modal.querySelector('input[name="date"]');
            if (dateInput) {
                dateInput.value = new Date().toISOString().split('T')[0];
            }
            modal.querySelector('form').reset();
            modal.querySelector('input[name="title"]')?.focus();
        }
    }

    closeModal() {
        this.editingLogId = null;
        const modal = document.getElementById('modal-new-entry');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    openSettingsModal() {
        const modal = document.getElementById('modal-settings');
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            this.setSettingsMode('edit');
        }
    }

    setSettingsMode(mode) {
        const form = document.getElementById('settings-form');
        form.dataset.mode = mode;
        
        const title = document.getElementById('settings-modal-title');
        const desc = document.getElementById('settings-modal-desc');
        const submitBtn = form.querySelector('button[type="submit"]');
        const nameInput = document.getElementById('setting-vessel-name');
        const deleteContainer = document.getElementById('delete-vessel-container');
        const initDeleteBtn = document.getElementById('btn-init-delete');
        const confirmDeleteBtn = document.getElementById('btn-confirm-delete');
        
        const styleActive = "flex-1 py-2 rounded-xl bg-azure text-white text-[10px] font-black tracking-widest uppercase transition-all shadow-md";
        const styleInactive = "flex-1 py-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 text-[10px] font-black tracking-widest uppercase transition-all";
            
        document.getElementById('tab-edit-vessel').className = mode === 'edit' ? styleActive : styleInactive;
        document.getElementById('tab-new-vessel').className = mode === 'new' ? styleActive : styleInactive;

        // Force UI state based on onboarding necessity
        if (settingsManager.fleet.length === 0) {
            document.getElementById('settings-tabs-container')?.classList.add('hidden');
            document.getElementById('settings-close-btn')?.classList.add('hidden');
        } else {
            document.getElementById('settings-tabs-container')?.classList.remove('hidden');
            document.getElementById('settings-close-btn')?.classList.remove('hidden');
        }

        // Reset delete buttons
        if (initDeleteBtn && confirmDeleteBtn) {
            initDeleteBtn.classList.remove('hidden');
            confirmDeleteBtn.classList.add('hidden');
        }

        if (mode === 'edit') {
            if (title) title.innerText = "Vessel Profile";
            if (desc) desc.innerText = "Update the current vessel identity.";
            if (submitBtn) submitBtn.innerText = "Save Configurations";
            if (deleteContainer) deleteContainer.classList.remove('hidden');
            
            if (nameInput) nameInput.value = settingsManager.activeVessel.name;
            const preview = document.getElementById('settings-preview-img-bg');
            if (preview) preview.style.backgroundImage = `url(${settingsManager.activeVessel.backdrop})`;
            const fileName = document.getElementById('setting-file-name');
            if (fileName) fileName.innerText = "Click to upload image";
        } else { // mode === 'new'
            if (title) title.innerText = "Register Vessel ID";
            if (desc) desc.innerText = "Assign a unique ID and name to commission your vessel.";
            if (submitBtn) submitBtn.innerText = "Register & Launch Fleet";
            if (deleteContainer) deleteContainer.classList.add('hidden');
            
            if (nameInput) {
                nameInput.value = "";
                nameInput.placeholder = "e.g. M/Y EXPLORER";
            }
            
            const preview = document.getElementById('settings-preview-img-bg');
            if (preview) preview.style.backgroundImage = "none";
            const fileName = document.getElementById('setting-file-name');
            if (fileName) fileName.innerText = "Click to upload image";
            const fileInput = document.getElementById('setting-backdrop');
            if (fileInput) fileInput.value = "";
        }
    }

    initDeleteVessel() {
        const initBtn = document.getElementById('btn-init-delete');
        const confirmBtn = document.getElementById('btn-confirm-delete');
        if (initBtn && confirmBtn) {
            initBtn.classList.add('hidden');
            confirmBtn.classList.remove('hidden');
        }
    }

    closeSettingsModal() {
        const modal = document.getElementById('modal-settings');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    }

    exportData() {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.logs, null, 2));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", `MY_Blondie_Maintenance_Export_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    }

    exportToCSV() {
        const vesselLogs = this.logs.filter(l => (l.vesselId || settingsManager.fleet[0].id) === settingsManager.activeVesselId);
        if (vesselLogs.length === 0) {
            alert("No logs available for export in the current vessel.");
            return;
        }

        const headers = ["Title", "Location", "Category", "Priority", "Date", "Status", "Notes", "Created By", "Completed By"];
        const csvRows = vesselLogs.map(log => [
            `"${log.title.replace(/"/g, '""')}"`,
            `"${log.location.replace(/"/g, '""')}"`,
            log.category,
            log.priority,
            log.timestamp,
            log.completed ? "Yes" : "No",
            `"${(log.notes || "").replace(/"/g, '""').replace(/\n/g, ' ')}"`,
            `"${log.createdBy}"`,
            `"${log.completedBy || 'N/A'}"`
        ]);

        // Combine headers and rows
        const csvContent = [headers.join(","), ...csvRows.map(row => row.join(","))].join("\n");
        
        // Trigger Download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", `${settingsManager.activeVessel.name.replace(/[^a-z0-9]/gi, '_')}_Maintenance_History_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        console.log("CSV Export successful.");
    }

    applyTheme() {
        // Theme initialization logic
        const savedTheme = localStorage.getItem('blondie_theme') || 'dark';
        document.documentElement.classList.toggle('dark', savedTheme === 'dark');
    }

    openAlarmModal(id = null) {
        const modal = document.getElementById('modal-alarm-entry');
        if (!modal) return;

        const titleEl = document.getElementById('alarm-modal-title');
        const submitBtn = document.getElementById('alarm-submit-btn');
        const form = document.getElementById('alarm-form');

        if (id) {
            const alarm = this.alarms.find(a => a.id === id);
            if (alarm) {
                this.editingAlarmId = id;
                if (titleEl) titleEl.innerText = "Edit Alarm Event";
                if (submitBtn) submitBtn.innerText = "Update Safety Record";

                form.querySelector('input[name="title"]').value = alarm.title;
                form.querySelector('select[name="category"]').value = alarm.category;
                form.querySelector('input[name="date"]').value = alarm.date;
                form.querySelector('input[name="time"]').value = alarm.time;
                form.querySelector('textarea[name="notes"]').value = alarm.notes || '';
                
                this.currentAlarmImage = alarm.image;
                const previewImg = document.getElementById('alarm-preview-img');
                const previewContainer = document.getElementById('alarm-preview-container');
                if (this.currentAlarmImage && previewImg && previewContainer) {
                    previewImg.src = this.currentAlarmImage;
                    previewContainer.classList.remove('hidden');
                } else if (previewContainer) {
                    previewContainer.classList.add('hidden');
                }
            }
        } else {
            this.editingAlarmId = null;
            if (titleEl) titleEl.innerText = "New Alarm Event";
            if (submitBtn) submitBtn.innerText = "Register Safety Alarm Event";
            form.reset();
            
            // Set default date/time
            const now = new Date();
            form.querySelector('input[name="date"]').value = now.toISOString().split('T')[0];
            form.querySelector('input[name="time"]').value = now.toTimeString().split(' ')[0].substring(0, 5);
            
            this.currentAlarmImage = null;
            const previewContainer = document.getElementById('alarm-preview-container');
            if (previewContainer) previewContainer.classList.add('hidden');
        }

        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    closeAlarmModal() {
        const modal = document.getElementById('modal-alarm-entry');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            this.currentAlarmImage = null;
            this.editingAlarmId = null;
            const preview = document.getElementById('alarm-preview-container');
            if (preview) preview.classList.add('hidden');
            const form = document.getElementById('alarm-form');
            if (form) form.reset();
        }
    }

    handleAlarmImageUpload(input) {
        if (input.files && input.files[0]) {
            const reader = new FileReader();
            reader.onload = (e) => {
                this.currentAlarmImage = e.target.result;
                const previewImg = document.getElementById('alarm-preview-img');
                const previewContainer = document.getElementById('alarm-preview-container');
                if (previewImg && previewContainer) {
                    previewImg.src = this.currentAlarmImage;
                    previewContainer.classList.remove('hidden');
                }
                const fileName = document.getElementById('alarm-file-name');
                if (fileName) fileName.innerText = input.files[0].name;
            };
            reader.readAsDataURL(input.files[0]);
        }
    }

    addAlarmEvent(formData) {
        if (this.editingAlarmId) {
            const index = this.alarms.findIndex(a => a.id === this.editingAlarmId);
            if (index > -1) {
                this.alarms[index] = {
                    ...this.alarms[index],
                    title: formData.get('title'),
                    category: formData.get('category'),
                    date: formData.get('date'),
                    time: formData.get('time'),
                    notes: formData.get('notes'),
                    image: this.currentAlarmImage
                };
            }
            this.editingAlarmId = null;
        } else {
            const entry = {
                id: 'alarm_' + Date.now(),
                vesselId: settingsManager.activeVesselId,
                title: formData.get('title'),
                category: formData.get('category'),
                date: formData.get('date'),
                time: formData.get('time'),
                notes: formData.get('notes'),
                image: this.currentAlarmImage,
                loggedBy: auth.currentUser.name,
                loggedAt: new Date().toISOString(),
                acknowledged: false,
                acknowledgedBy: null
            };
            this.alarms.unshift(entry);
        }

        this.saveAlarms();
        this.closeAlarmModal();
        if (this.currentView === 'alarms') this.renderAlarms();
        
        // Notify user
        this.notifyAlarmSaved();
    }

    editAlarm(id) {
        this.openAlarmModal(id);
    }

    toggleAcknowledgeAlarm(id) {
        const alarm = this.alarms.find(a => a.id === id);
        if (alarm) {
            alarm.acknowledged = !alarm.acknowledged;
            alarm.acknowledgedBy = alarm.acknowledged ? auth.currentUser.name : null;
            this.saveAlarms();
            this.renderAlarms();
        }
    }

    deleteAlarm(id) {
        if (confirm("Permanently purge this alarm event?")) {
            this.alarms = this.alarms.filter(a => a.id !== id);
            this.saveAlarms();
            this.renderAlarms();
        }
    }

    renderAlarms() {
        const list = document.getElementById('alarm-list');
        if (!list) return;

        const filtered = this.alarms.filter(a => a.vesselId === settingsManager.activeVesselId);
        
        if (filtered.length === 0) {
            list.innerHTML = `
                <div class="col-span-full py-32 flex flex-col items-center justify-center text-slate-600">
                    <svg class="w-16 h-16 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                    <p class="font-black italic uppercase tracking-widest text-sm">No Safety Alarms Recorded</p>
                </div>
            `;
            return;
        }

        list.innerHTML = filtered.map(alarm => `
            <div class="glass-compact rounded-[32px] overflow-hidden border border-white/5 hover:border-rose-600/30 transition-all group scale-in shadow-2xl">
                ${alarm.image ? `
                    <div class="h-48 relative overflow-hidden">
                        <img src="${alarm.image}" class="w-full h-full object-cover group-hover:scale-110 transition-all duration-700">
                        <div class="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"></div>
                        <div class="absolute bottom-4 left-6">
                            <span class="px-3 py-1 rounded-full bg-rose-600 text-white text-[8px] font-black uppercase tracking-widest">${alarm.category}</span>
                        </div>
                    </div>
                ` : `
                    <div class="h-16 bg-gradient-to-r from-rose-600/20 to-transparent flex items-center px-6">
                         <span class="px-3 py-1 rounded-full bg-rose-600 text-white text-[8px] font-black uppercase tracking-widest">${alarm.category}</span>
                    </div>
                `}
                
                <div class="p-8">
                    <div class="flex justify-between items-start mb-4">
                        <div class="flex-1">
                            <h3 class="text-white font-black italic uppercase tracking-tight text-lg leading-tight mb-1">${alarm.title}</h3>
                            <div class="flex items-center gap-2 text-slate-500 font-bold text-[10px] uppercase tracking-wider">
                                <span>${alarm.date}</span>
                                <span class="w-1 h-1 rounded-full bg-rose-600"></span>
                                <span>${alarm.time}</span>
                            </div>
                        </div>
                        <div class="flex gap-2">
                             <button onclick="event.stopPropagation(); app.editAlarm('${alarm.id}')" class="p-2 rounded-xl bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-all border border-white/5 active:scale-95 flex items-center justify-center">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                            </button>
                            <button onclick="event.stopPropagation(); app.deleteAlarm('${alarm.id}')" class="p-2 rounded-xl bg-white/5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-all border border-white/5 active:scale-95 flex items-center justify-center">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </button>
                        </div>
                    </div>
                    
                    <p class="text-slate-400 text-xs leading-relaxed font-medium mb-6 line-clamp-3">${alarm.notes || 'No description provided'}</p>
                    
                    <div class="pt-6 border-t border-white/5 flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <div class="w-6 h-6 rounded-full bg-white/5 flex items-center justify-center text-azure font-black italic text-[8px]">${alarm.loggedBy[0]}</div>
                            <span class="text-[9px] text-slate-500 font-black uppercase tracking-widest">${alarm.loggedBy}</span>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    notifyAlarmSaved() {
        const toast = document.createElement('div');
        toast.className = 'fixed bottom-8 right-8 bg-rose-600 text-white px-6 py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] shadow-2xl z-[500] animate-fade-in sm:px-8';
        toast.innerText = 'Alarm Event Recorded ✓';
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.5s ease';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }

    notifySave() {
        // ...Existing notifySave logic
        const toast = document.createElement('div');
        toast.className = 'fixed bottom-8 right-8 bg-green-500 text-white px-6 py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] shadow-2xl z-[500] animate-fade-in sm:px-8';
        toast.innerText = 'Vessel Profile Saved ✓';
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.5s ease';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }
}

/**
 * Kernel Launch
 */
const app = new MaintenanceSuite();

/**
 * Visualization Infrastructure
 */
window.addEventListener('load', () => {
    const ctx = document.getElementById('statusChart');
    if (ctx && typeof Chart !== 'undefined') {
        window.myChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Completed', 'Operational Deficit'],
                datasets: [{
                    data: [0, 0],
                    backgroundColor: ['#22c55e', '#3b82f6'],
                    borderWidth: 0,
                    hoverOffset: 20
                }]
            },
            options: {
                cutout: '80%',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: true,
                        backgroundColor: '#0a192f',
                        titleFont: { family: 'General Sans', weight: 'bold' },
                        bodyFont: { family: 'General Sans' },
                        padding: 12,
                        cornerRadius: 16
                    }
                }
            }
        });
        app.updateDashboard();
    }
});
