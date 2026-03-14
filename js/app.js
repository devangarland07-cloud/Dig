/**
 * DIG Yacht Management Software - Core Kernel v3.0 Alpha
 * Clean Slate Refactor with Robust Local Persistence & User Accountability
 */

// 🚨 DATA PURGE: Resetting all local data for Supabase migration
const DISCOVERY_PURGE_KEYS = [
    'blondie_user_session', 
    'blondie_users', 
    'dig_fleet_settings', 
    'dig_maintenance_v3', 
    'dig_alarms_v1',
    'blondie_demo_reset_v2'
];

DISCOVERY_PURGE_KEYS.forEach(key => localStorage.removeItem(key));
console.warn("LEGACY DATA PURGED. Transitioning to Supabase Backend...");

// Supabase Initialization
const SUPABASE_URL = 'https://gckgpsfebzheyratbtfy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_k-qqjgcb-wIBmNAWdxuqdA_7eYHbGHS';
const supabaseClient = (typeof supabase !== 'undefined') ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

class UserManager {
    constructor() {
        this.currentUser = null;
        this.session = null;
        this.init();
    }

    async init() {
        if (!supabaseClient) return;
        const { data: { session } } = await supabaseClient.auth.getSession();
        this.setSession(session);

        supabaseClient.auth.onAuthStateChange((_event, session) => {
            this.setSession(session);
            if (_event === 'SIGNED_IN') {
                // Potential redirect or UI update
                if (typeof app !== 'undefined') app.init();
            }
        });
    }

    setSession(session) {
        this.session = session;
        this.currentUser = session ? {
            id: session.user.id,
            email: session.user.email,
            name: session.user.user_metadata.full_name || session.user.email
        } : null;
    }

    async signUp(email, password, name) {
        if (!supabaseClient) return false;
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
            options: {
                data: { full_name: name }
            }
        });

        if (error) {
            app.notifyError("Enrollment failed: " + error.message);
            return false;
        }
        return true;
    }

    async login(email, password) {
        if (!supabaseClient) {
            app.notifyError("Connection error: Supabase not initialized.");
            return false;
        }
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            app.notifyError("Entry Denied: " + error.message);
            return false;
        }
        return true;
    }

    async logout() {
        if (supabaseClient) await supabaseClient.auth.signOut();
        this.currentUser = null;
        this.session = null;
        location.reload();
    }

    isAuthenticated() {
        return this.currentUser !== null;
    }
}

const auth = new UserManager();

class SettingsManager {
    constructor() {
        this.fleet = [];
        this.activeVesselId = null;
    }

    async loadSettings() {
        if (!supabaseClient || !auth.currentUser) return;

        // Fetch vessels via joining the membership table
        const { data: members, error: memberError } = await supabaseClient
            .from('vessel_members')
            .select(`
                vessel_id,
                role,
                vessels (
                    id,
                    name,
                    access_code,
                    passcode,
                    backdrop_url,
                    owner_id,
                    created_at
                )
            `)
            .eq('user_id', auth.currentUser.id);
        if (memberError) {
            console.warn("Membership table not found or error. Falling back to legacy owner check:", memberError);
            // LEGACY FALLBACK: If membership table hasn't been created/migrated yet, 
            // still try to load vessels where the user is the direct owner.
            const { data: legacyVessels, error: legacyError } = await supabaseClient
                .from('vessels')
                .select('*')
                .eq('owner_id', auth.currentUser.id);
            
            if (legacyError) {
                console.error("Legacy loading failed:", legacyError);
                return;
            }
            this.fleet = legacyVessels || [];
        } else {
            // Map memberships to vessel objects, adding the role property
            this.fleet = members ? members.filter(m => m.vessels).map(m => ({
                ...m.vessels,
                memberRole: m.role
            })) : [];
        }
        
        // DE-DUPLICATE: Ensure each vessel ID only appears once
        const uniqueFleet = [];
        const seenIds = new Set();
        this.fleet.forEach(v => {
            if (!seenIds.has(v.id)) {
                uniqueFleet.push(v);
                seenIds.add(v.id);
            }
        });
        this.fleet = uniqueFleet;
        
        // Restore active vessel from session storage (tabs/refresh)
        const savedActiveId = sessionStorage.getItem('dig_active_vessel_id');
        this.activeVesselId = savedActiveId || (this.fleet.length > 0 ? this.fleet[0].id : null);
        
        if (this.activeVesselId && !this.fleet.find(v => v.id === this.activeVesselId)) {
            this.activeVesselId = this.fleet.length > 0 ? this.fleet[0].id : null;
        }

        this.applySettings();
        this.renderVesselSelector();
    }

    get activeVessel() {
        return this.fleet.find(v => v.id === this.activeVesselId) || { name: "M/Y EXPLORER", access_code: "000000", passcode: "", backdrop_url: "" };
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

    async saveSettings(vesselName, backdropData, mode = 'edit', passcode = '') {
        if (!supabaseClient || !auth.currentUser) return false;

        let query;
        if (mode === 'new') {
            // Generate a random 6-digit numeric access code
            const accessCode = Math.floor(100000 + Math.random() * 900000).toString();
            
            // If no passcode provided, use default
            const finalPasscode = passcode || 'changeme';

            const { data: newVessel, error: vesselError } = await supabaseClient
                .from('vessels')
                .insert([{ 
                    name: vesselName || 'FLEET ASSET', 
                    access_code: accessCode,
                    passcode: finalPasscode,
                    backdrop_url: backdropData || '', 
                    owner_id: auth.currentUser.id 
                }])
                .select();

            if (vesselError) {
                app.notifyError("Asset Registration Failed: " + vesselError.message);
                return false;
            }

            // Create owner membership
            if (newVessel && newVessel.length > 0) {
                const { error: memberError } = await supabaseClient
                    .from('vessel_members')
                    .insert([{
                        vessel_id: newVessel[0].id,
                        user_id: auth.currentUser.id,
                        role: 'owner'
                    }]);
                
                if (memberError) {
                    app.notifyError("Identity Linkage Failed: " + memberError.message);
                    return false;
                }
                
                this.activeVesselId = newVessel[0].id;
                sessionStorage.setItem('dig_active_vessel_id', this.activeVesselId);
            }
        } else {
            const { error } = await supabaseClient
                .from('vessels')
                .update({ 
                    name: vesselName, 
                    passcode: passcode,
                    backdrop_url: backdropData 
                })
                .eq('id', this.activeVesselId);

            if (error) {
                app.notifyError("Profile Update Failed: " + error.message);
                return false;
            }
        }

        // No additional check needed here as activeVesselId is set above for 'new' mode
        // and persists for 'edit' mode.
        
        await this.loadSettings();
        window.dispatchEvent(new CustomEvent('vesselSwitched', { 
            detail: { vessel_id: this.activeVesselId } 
        }));
        return true;
    }

    async joinVessel(accessCode, passcode) {
        if (!supabaseClient || !auth.currentUser) return false;

        // 1. Verify existence and passcode
        const { data: vessels, error: vesselError } = await supabaseClient
            .from('vessels')
            .select('id, name')
            .eq('access_code', accessCode)
            .eq('passcode', passcode);

        if (vesselError || !vessels || vessels.length === 0) {
            app.notifyError("Authentication Failed: Invalid Access Code or Secure Passcode.");
            return false;
        }

        // 2. Join the vessel
        const { error: joinError } = await supabaseClient
            .from('vessel_members')
            .insert([{
                vessel_id: vessels[0].id,
                user_id: auth.currentUser.id,
                role: 'member'
            }]);

        if (joinError) {
            if (joinError.code === '23505') { // Duplicate unique key
                app.notifyError("Duplicate Entry: You are already a member of this asset.");
            } else {
                app.notifyError("Linkage Failed: " + joinError.message);
            }
            return false;
        }

        this.activeVesselId = vessels[0].id;
        sessionStorage.setItem('dig_active_vessel_id', this.activeVesselId);
        
        await this.loadSettings();
        window.dispatchEvent(new CustomEvent('vesselSwitched', { 
            detail: { vessel_id: this.activeVesselId } 
        }));
        return true;
    }

    async switchVessel(id) {
        if (id === 'add_new') {
            const appInstance = typeof app !== 'undefined' ? app : null;
            if (appInstance) {
                appInstance.openSettingsModal();
                appInstance.setSettingsMode('new');
            }
            this.renderVesselSelector();
            return;
        }
        
        if (this.fleet.find(v => v.id === id)) {
            this.activeVesselId = id;
            sessionStorage.setItem('dig_active_vessel_id', this.activeVesselId);
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
                app.notifyError("CRITICAL ERROR: Vessel Configuration too large for local memory. Please use a smaller image.");
            } else {
                app.notifyError("An error occurred while saving vessel data: " + e.message);
            }
            return false;
        }
    }

    async resetToDefaults() {
        if (!supabaseClient || !this.activeVesselId) return;
        
        const { error } = await supabaseClient
            .from('vessels')
            .update({ backdrop_url: '' })
            .eq('id', this.activeVesselId);
        
        if (error) {
            app.notifyError('Reset failed: ' + error.message);
            return;
        }
        
        await this.loadSettings();
        this.applySettings();
        window.dispatchEvent(new CustomEvent('vesselSwitched'));
        
        const preview = document.getElementById('settings-preview-img-bg');
        if (preview) preview.style.backgroundImage = 'none';
        const filename = document.getElementById('setting-file-name');
        if (filename) filename.innerText = "Click to upload image";
        const fileInput = document.getElementById('setting-backdrop');
        if (fileInput) fileInput.value = '';
    }

    async deleteCurrentVessel() {
        if (this.fleet.length <= 1) {
            app.notifyError("Cannot delete the only vessel in the fleet.");
            app.setSettingsMode('edit'); 
            return;
        }

        const deletedVesselId = this.activeVesselId;

        if (confirm("🚨 CRITICAL ACTION: Permanently purge this vessel and all associated logs/alarms?")) {
            const { error } = await supabaseClient
                .from('vessels')
                .delete()
                .eq('id', deletedVesselId);

            if (error) {
                app.notifyError("Deletion failed: " + error.message);
                return;
            }
            
            await this.loadSettings();
            
            if (this.fleet.length > 0) {
                this.activeVesselId = this.fleet[0].id;
                sessionStorage.setItem('dig_active_vessel_id', this.activeVesselId);
            }
            
            this.applySettings();
            this.renderVesselSelector();
            app.closeSettingsModal();
            window.dispatchEvent(new CustomEvent('vesselSwitched'));
        }
    }

    applySettings() {
        const vessel = this.activeVessel;
        const nameElements = document.querySelectorAll('#sidebar-vessel-name, #mobile-vessel-name-display');
        nameElements.forEach(el => {
            if (el) el.innerText = vessel.name;
        });

        const sidebarBackdrop = document.getElementById('sidebar-backdrop');
        if (sidebarBackdrop) {
            if (vessel.backdrop_url) {
                sidebarBackdrop.style.backgroundImage = `url(${vessel.backdrop_url})`;
                sidebarBackdrop.classList.remove('opacity-0');
            } else {
                sidebarBackdrop.style.backgroundImage = 'none';
                sidebarBackdrop.classList.add('opacity-0');
            }
        }
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
        console.log("DIG Yacht Management Software v3.0 Alpha Initializing (Supabase)...");
        
        // Initial State
        this.logs = [];
        this.alarms = [];
        this.currentView = 'logs';
        this.filters = {
            search: '',
            category: 'All',
            status: 'All' 
        };
        this.editingLogId = null;
        this.editingAlarmId = null;
        this.currentAlarmImage = null;
        this.isSubmitting = false;

        this.init();
    }

    /**
     * Kernel Initialization
     */
    async init() {
        this.setupEventListeners();
        this.applyTheme();
        
        // Wait for session to stabilize
        if (!auth.session) {
            const { data: { session } } = await supabaseClient.auth.getSession();
            if (session) auth.setSession(session);
        }

        window.addEventListener('vesselSwitched', async () => {
            const searchInput = document.getElementById('search-input');
            if (searchInput) searchInput.value = '';
            this.filters.search = '';

            await this.reloadData();
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

        await settingsManager.loadSettings();
        
        if (settingsManager.fleet.length === 0) {
            this.hideLandingUI();
            this.hideAuthUI();
            settingsManager.initUI(this);
            return;
        }

        this.hideLandingUI();
        this.hideAuthUI();
        
        await this.reloadData();
        this.render();
        this.updateDashboard();
        this.updateUserUI();
    }

    async reloadData() {
        this.logs = await this.loadLogs();
        this.alarms = await this.loadAlarms();
    }

    render() {
        const list = document.getElementById('log-list');
        if (!list) return;

        const filtered = this.getFilteredLogs();
        this.sortLogs();
        
        if (filtered.length === 0) {
            list.innerHTML = `
                <div class="col-span-full py-32 flex flex-col items-center justify-center text-slate-600">
                    <svg class="w-16 h-16 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg>
                    <p class="font-black italic uppercase tracking-widest text-sm">No Maintenance History Recorded</p>
                    <p class="hidden md:block text-xs text-slate-500 mt-2">Press <kbd class="px-2 py-1 rounded bg-white/5 border border-white/10 text-azure font-mono text-[10px]">N</kbd> to create your first entry</p>
                </div>
            `;
            return;
        }

        list.innerHTML = filtered.map(log => `
            <div class="glass-compact rounded-[32px] overflow-hidden border border-white/5 hover:border-azure/30 transition-all group scale-in shadow-2xl">
                <div class="p-8">
                    <div class="flex justify-between items-start mb-6">
                        <div class="flex-1">
                            <div class="flex items-center gap-2 mb-2">
                                <span class="px-3 py-1 rounded-full bg-white/5 text-slate-400 text-[8px] font-black uppercase tracking-widest">${log.category}</span>
                                <span class="px-3 py-1 rounded-full ${log.priority === 'Critical' ? 'bg-red-500/10 text-red-500' : 'bg-white/5 text-slate-400'} text-[8px] font-black uppercase tracking-widest">${log.priority}</span>
                            </div>
                            <h3 class="text-white font-black italic uppercase tracking-tight text-xl leading-tight">${log.title}</h3>
                        </div>
                        <div class="flex gap-2">
                             <button onclick="app.editLog('${log.id}')" class="p-2.5 rounded-2xl bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-all border border-white/5 active:scale-95">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                            </button>
                             <button onclick="app.deleteLog('${log.id}')" class="p-2.5 rounded-2xl bg-white/5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-all border border-white/5 active:scale-95">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </button>
                        </div>
                    </div>

                    <div class="space-y-4 mb-8">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center text-azure">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                            </div>
                            <div>
                                <p class="text-[9px] text-slate-500 font-bold uppercase tracking-[0.2em]">Deployment Location</p>
                                <p class="text-white text-xs font-black italic uppercase">${log.location}</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center text-azure">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                            </div>
                            <div>
                                <p class="text-[9px] text-slate-500 font-bold uppercase tracking-[0.2em]">Maintenance Date</p>
                                <p class="text-white text-xs font-black italic uppercase">${log.timestamp}</p>
                            </div>
                        </div>
                    </div>

                    <p class="text-slate-400 text-xs leading-relaxed font-medium mb-8 line-clamp-3">${log.notes || 'No technical notes recorded.'}</p>

                    <div class="pt-6 border-t border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div class="flex items-center gap-2">
                            <div class="w-8 h-8 rounded-full bg-azure/10 border border-azure/20 flex items-center justify-center text-azure font-black italic text-[10px]">${log.logged_by ? log.logged_by[0] : 'U'}</div>
                            <div class="flex flex-col">
                                <span class="text-[8px] text-slate-500 font-bold uppercase tracking-widest leading-none mb-1">Logged By</span>
                                <span class="text-[10px] text-white font-black uppercase tracking-widest">${log.logged_by || 'Unknown Officer'}</span>
                            </div>
                        </div>
                        <button onclick="app.toggleComplete('${log.id}')" class="flex items-center justify-between sm:justify-end gap-3 group/cb bg-white/5 sm:bg-transparent p-3 sm:p-0 rounded-2xl">
                            <div class="flex flex-col items-end text-right">
                                <span class="text-[8px] text-slate-500 font-bold uppercase tracking-widest leading-none mb-1">Status Check</span>
                                <span class="text-[10px] font-black uppercase tracking-widest ${log.completed ? 'text-green-500' : 'text-slate-400 group-hover/cb:text-white'} transition-all">${log.completed ? `Operational ✓ by ${log.completed_by}` : 'Pending Action'}</span>
                            </div>
                            <div class="w-6 h-6 rounded-xl border-2 ${log.completed ? 'border-green-500 bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.3)]' : 'border-white/10'} flex items-center justify-center transition-all">
                                ${log.completed ? '<svg class="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>' : ''}
                            </div>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');
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
        const userName = auth.currentUser?.name || 'Guest User';
        const userNameElements = document.querySelectorAll('#current-user-name, #mobile-user-name');
        userNameElements.forEach(el => el.innerText = userName);
        
        const firstLetter = userName.charAt(0).toUpperCase();
        
        // Update Desktop Avatar
        const desktopAvatar = document.getElementById('user-avatar-desktop');
        if (desktopAvatar) desktopAvatar.innerText = firstLetter;
        
        // Update Mobile Avatar
        const mobileAvatar = document.getElementById('user-avatar-mobile');
        if (mobileAvatar) mobileAvatar.innerText = firstLetter;
    }

    /**
     * Data Layer: LocalStorage Core
     */
    async loadLogs() {
        if (!supabaseClient || !settingsManager.activeVesselId) return [];
        const { data, error } = await supabaseClient
            .from('maintenance_logs')
            .select('*')
            .eq('vessel_id', settingsManager.activeVesselId)
            .order('timestamp', { ascending: false });

        return error ? [] : data;
    }

    async saveLogs() {
        // Obsolete in Supabase - use CRUD methods
        this.updateDashboard();
    }

    async loadAlarms() {
        if (!supabaseClient || !settingsManager.activeVesselId) return [];
        const { data, error } = await supabaseClient
            .from('alarm_events')
            .select('*')
            .eq('vessel_id', settingsManager.activeVesselId)
            .order('date', { ascending: false });

        return error ? [] : data;
    }

    async saveAlarms() {
        // Obsolete in Supabase - use CRUD methods
        this.updateDashboard();
    }

    /**
     * CRUD Operations
     */
    async addLog(formData) {
        if (!supabaseClient) return;

        const logData = {
            vessel_id: settingsManager.activeVesselId,
            title: formData.get('title'),
            location: formData.get('location'),
            category: formData.get('category'),
            priority: formData.get('priority'),
            timestamp: formData.get('date'),
            notes: formData.get('notes'),
            logged_by: auth.currentUser.name
        };

        if (this.editingLogId) {
            // Remove logged_by from update to preserve original creator
            delete logData.logged_by;
            const { error } = await supabaseClient
                .from('maintenance_logs')
                .update(logData)
                .eq('id', this.editingLogId);
            
            if (error) app.notifyError("Update failed: " + error.message);
            this.editingLogId = null;
        } else {
            const { error } = await supabaseClient
                .from('maintenance_logs')
                .insert([logData]);
            
            if (error) { app.notifyError("Recording failed: " + error.message); return; }
        }

        await this.reloadData();
        this.render();
        this.updateDashboard();
        
        // Confirmation toast
        const isEdit = !!logData.id;
        this.notifySuccess(isEdit ? 'Entry Updated ✓' : 'Maintenance Entry Saved ✓');
    }

    editLog(id) {
        const log = this.logs.find(l => l.id === id);
        if (!log) return;

        this.editingLogId = id;
        const modal = document.getElementById('modal-new-entry');
        if (modal) {
            // Update title for edit mode
            const titleEl = modal.querySelector('header h2');
            if (titleEl) titleEl.innerText = 'Edit Maintenance Entry';
            
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

    async deleteLog(id) {
        if (confirm("Permanently purge this entry from the history?")) {
            const { error } = await supabaseClient
                .from('maintenance_logs')
                .delete()
                .eq('id', id);

            if (error) alert("Deletion failed: " + error.message);
            await this.reloadData();
            this.render();
            this.updateDashboard();
        }
    }

    async toggleComplete(id) {
        const log = this.logs.find(l => l.id === id);
        if (log) {
            const newStatus = !log.completed;
            const { error } = await supabaseClient
                .from('maintenance_logs')
                .update({ 
                    completed: newStatus,
                    completed_by: newStatus ? auth.currentUser.name : null 
                })
                .eq('id', id);

            if (error) alert("Sync failed: " + error.message);
            await this.reloadData();
            this.render();
            this.updateDashboard();
        }
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
            const logVesselId = log.vessel_id;
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
            const alarmVesselId = alarm.vessel_id;
            if (alarmVesselId !== settingsManager.activeVesselId) return false;

            const matchesSearch = alarm.title.toLowerCase().includes(this.filters.search.toLowerCase()) ||
                                  (alarm.notes || '').toLowerCase().includes(this.filters.search.toLowerCase());
            
            return matchesSearch;
        }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // Sort by created_at
    }

    /**
     * Dashboard Analytics Engine
     */
    updateDashboard() {
        const vesselLogs = this.logs.filter(l => l.vessel_id === settingsManager.activeVesselId);
        
        const total = vesselLogs.length;
        const completed = vesselLogs.filter(l => l.completed).length;
        const pending = total - completed;
        const critical = vesselLogs.filter(l => l.priority === 'Critical' && !l.completed).length;
        const unacknowledgedAlarms = this.alarms.filter(a => a.vessel_id === settingsManager.activeVesselId && !a.acknowledged).length;

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
            window.myChart.update('none');
        } else {
            this.initCharts(completed, pending);
        }
    }

    initCharts(completed, pending) {
        const ctx = document.getElementById('statusChart');
        if (!ctx) return;

        window.myChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Operational', 'Pending'],
                datasets: [{
                    data: [completed, pending],
                    backgroundColor: ['#22c55e', '#3b82f6'],
                    borderWidth: 0,
                    hoverOffset: 10
                }]
            },
            options: {
                cutout: '80%',
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        enabled: true,
                        backgroundColor: '#0a192f',
                        titleFont: { family: 'Outfit', size: 14 },
                        bodyFont: { family: 'Inter', size: 12 },
                        padding: 12,
                        cornerRadius: 12
                    }
                },
                responsive: true,
                maintainAspectRatio: false
            }
        });
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
        document.getElementById('log-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (this.isSubmitting) return;
            this.isSubmitting = true;
            const submitBtn = e.target.querySelector('button[type="submit"]');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving...'; }
            try {
                await this.addLog(new FormData(e.target));
                this.closeModal();
                e.target.reset();
            } finally {
                this.isSubmitting = false;
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Register Maintenance Record'; }
            }
        });

        // Auth Form Controller
        document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            const isSignUp = e.target.dataset.mode === 'signup';
            
            const submitBtn = e.target.querySelector('button[type="submit"]');
            const originalText = submitBtn?.innerText;
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = `
                    <div class="flex items-center justify-center gap-2">
                        <svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span>Authorizing...</span>
                    </div>
                `;
            }

            let success = false;
            try {
                if (isSignUp) {
                    success = await auth.signUp(formData.get('email'), formData.get('password'), formData.get('name'));
                } else {
                    success = await auth.login(formData.get('email'), formData.get('password'));
                }
            } finally {
                if (!success && submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerText = originalText;
                }
            }

            if (success) {
                this.hideAuthUI();
                this.updateUserUI();
                
                // Critical: Reload settings for the authenticated user
                await settingsManager.loadSettings();
                
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
        document.getElementById('settings-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (this.isSubmitting) return;
            const mode = e.target.dataset.mode || 'edit';
            
            const vesselName = document.getElementById('setting-vessel-name').value;
            const vesselPasscode = document.getElementById('setting-vessel-passcode').value;
            const joinId = document.getElementById('setting-join-vessel-id').value;
            const joinPasscode = document.getElementById('setting-join-vessel-passcode').value;
            const fileInput = document.getElementById('setting-backdrop');
            
            // Manual Validation based on mode
            if (mode === 'join') {
                if (!joinId || !joinPasscode) {
                    app.notifyError("Access Code and Target Passcode are required to join an asset.");
                    return;
                }
            } else {
                if (!vesselName.trim()) {
                    app.notifyError("Asset Name is required.");
                    return;
                }
                if (mode === 'edit' && !vesselPasscode) {
                    app.notifyError("Security Passcode is required to update an asset.");
                    return;
                }
            }

            this.isSubmitting = true;
            const submitBtn = e.target.querySelector('button[type="submit"]');
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving...'; }

            try {
                const getBackdrop = () => {
                    return new Promise((resolve) => {
                        if (fileInput.files && fileInput.files[0]) {
                            const reader = new FileReader();
                            reader.onload = (event) => resolve(event.target.result);
                            reader.readAsDataURL(fileInput.files[0]);
                        } else {
                            resolve(mode === 'edit' ? settingsManager.activeVessel.backdrop_url || '' : '');
                        }
                    });
                };

                const backdrop = await getBackdrop();

                let wasSuccessful = false;
                if (mode === 'join') {
                    wasSuccessful = await settingsManager.joinVessel(joinId, joinPasscode);
                } else {
                    wasSuccessful = await settingsManager.saveSettings(vesselName, backdrop, mode, vesselPasscode);
                }

                if (wasSuccessful) {
                    this.notifySuccess(mode === 'join' ? 'Vessel Joined Successfully ✓' : 'Profile Updated ✓');
                    this.closeSettingsModal();
                }
            } finally {
                this.isSubmitting = false;
                if (submitBtn) { 
                    submitBtn.disabled = false; 
                    submitBtn.textContent = mode === 'join' ? 'Authenticate & Join' : 
                                           (mode === 'new' ? 'Register & Launch Fleet' : 'Save Configurations'); 
                }
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
            alarmForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                if (this.isSubmitting) return;
                this.isSubmitting = true;
                const submitBtn = alarmForm.querySelector('button[type="submit"]');
                if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving...'; }
                try {
                    await this.addAlarmEvent(new FormData(alarmForm));
                    alarmForm.reset();
                    const preview = document.getElementById('alarm-preview-container');
                    if (preview) preview.classList.add('hidden');
                    const fileName = document.getElementById('alarm-file-name');
                    if (fileName) fileName.innerText = "Click to upload photo of alarm";
                } finally {
                    this.isSubmitting = false;
                    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Register Safety Alarm Event'; }
                }
            });
        }
        
        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            // Esc closes any open modal
            if (e.key === 'Escape') {
                this.closeModal();
                this.closeAlarmModal();
                if (settingsManager.fleet.length > 0) this.closeSettingsModal();
            }
            // 'N' opens new entry (only when no modal is open and no input is focused)
            if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = document.activeElement?.tagName?.toLowerCase();
                if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
                    const anyModalOpen = document.querySelector('#modal-new-entry.flex, #modal-alarm-entry.flex, #modal-settings.flex, #auth-overlay.flex, #landing-overlay.flex');
                    if (!anyModalOpen) {
                        e.preventDefault();
                        this.openModal();
                    }
                }
            }
        });
        
        // Online/Offline Detection
        const updateOnlineStatus = () => {
            const indicator = document.querySelector('.bg-green-500.rounded-full:not(.animate-ping)');
            const pingEl = document.querySelector('.animate-ping');
            const label = indicator?.closest('.glass-compact')?.querySelector('.italic');
            if (navigator.onLine) {
                if (indicator) { indicator.classList.remove('bg-red-500'); indicator.classList.add('bg-green-500'); }
                if (pingEl) { pingEl.classList.remove('bg-red-500'); pingEl.classList.add('bg-green-500'); }
                if (label) label.innerText = 'Online';
            } else {
                if (indicator) { indicator.classList.remove('bg-green-500'); indicator.classList.add('bg-red-500'); }
                if (pingEl) { pingEl.classList.remove('bg-green-500'); pingEl.classList.add('bg-red-500'); }
                if (label) label.innerText = 'Offline';
            }
        };
        window.addEventListener('online', updateOnlineStatus);
        window.addEventListener('offline', updateOnlineStatus);
        updateOnlineStatus();
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
        
        // Update search placeholder based on view
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            if (viewName === 'alarms') searchInput.placeholder = 'Filter through alarm events...';
            else if (viewName === 'dashboard') searchInput.placeholder = 'Search vessel analytics...';
            else searchInput.placeholder = 'Filter through asset logs...';
        }
    }

    openModal() {
        this.editingLogId = null; // reset edit state
        const modal = document.getElementById('modal-new-entry');
        if (modal) {
            // Ensure app is defined globally for onclicks
            window.app = this;
            
            // Update title for new mode
            const titleEl = modal.querySelector('header h2');
            if (titleEl) titleEl.innerText = 'New Maintenance Entry';
            
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
            // Ensure app is defined globally for onclicks
            window.app = this;
            this.setSettingsMode('edit');
        }
    }

    closeSettingsModal() {
        const modal = document.getElementById('modal-settings');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            
            // Navigate to logs/dashboard if shutting modal
            if (this.currentView !== 'logs' && this.currentView !== 'dashboard') {
                this.switchView('logs');
            }
        }
    }

    copyAccessCode() {
        const idInput = document.getElementById('setting-vessel-access-code');
        if (idInput) {
            idInput.select();
            document.execCommand('copy');
            this.notifySuccess('Access Code Copied to Clipboard ✓');
        }
    }

    togglePasscodeVisibility() {
        const passInput = document.getElementById('setting-vessel-passcode');
        const joinPassInput = document.getElementById('setting-join-vessel-passcode');
        
        if (passInput) {
            passInput.type = passInput.type === 'password' ? 'text' : 'password';
        }
        if (joinPassInput) {
            joinPassInput.type = joinPassInput.type === 'password' ? 'text' : 'password';
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
        document.getElementById('tab-join-vessel').className = mode === 'join' ? styleActive : styleInactive;

        // Force UI state based on onboarding necessity
        if (settingsManager.fleet.length === 0) {
            document.getElementById('settings-tabs-container')?.classList.remove('hidden');
            document.getElementById('tab-edit-vessel')?.classList.add('opacity-50', 'pointer-events-none');
        } else {
            document.getElementById('settings-tabs-container')?.classList.remove('hidden');
            document.getElementById('tab-edit-vessel')?.classList.remove('opacity-50', 'pointer-events-none');
        }
        document.getElementById('settings-close-btn')?.classList.remove('hidden');

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
            
            const activeVessel = settingsManager.activeVessel;
            if (nameInput) nameInput.value = activeVessel.name;
            const idInput = document.getElementById('setting-vessel-access-code');
            if (idInput) idInput.value = activeVessel.access_code;
            const passInput = document.getElementById('setting-vessel-passcode');
            if (passInput) passInput.value = activeVessel.passcode;

            document.getElementById('vessel-main-fields')?.classList.remove('hidden');
            document.getElementById('vessel-backdrop-fields')?.classList.remove('hidden');
            document.getElementById('settings-asset-code-container')?.classList.remove('hidden');
            document.getElementById('join-asset-fields')?.classList.add('hidden');

            const preview = document.getElementById('settings-preview-img-bg');
            if (preview) preview.style.backgroundImage = `url(${settingsManager.activeVessel.backdrop_url})`;
            const fileName = document.getElementById('setting-file-name');
            if (fileName) fileName.innerText = "Click to upload image";
        } else if (mode === 'join') {
            if (title) title.innerText = "Join Fleet Asset";
            if (desc) desc.innerText = "Enter the 6-digit Access Code and Secure Passcode.";
            if (submitBtn) submitBtn.innerText = "Authenticate & Join";
            if (deleteContainer) deleteContainer.classList.add('hidden');
            
            document.getElementById('vessel-main-fields')?.classList.add('hidden');
            document.getElementById('vessel-backdrop-fields')?.classList.add('hidden');
            document.getElementById('settings-asset-code-container')?.classList.add('hidden');
            document.getElementById('join-asset-fields')?.classList.remove('hidden');

            const preview = document.getElementById('settings-preview-img-bg');
            if (preview) preview.style.backgroundImage = "none";
            const fileName = document.getElementById('setting-file-name');
            if (fileName) fileName.innerText = "Click to upload image";
            const fileInput = document.getElementById('setting-backdrop');
            if (fileInput) fileInput.value = "";
        } else { // mode === 'new'
            if (title) title.innerText = "Register Vessel ID";
            if (desc) desc.innerText = "Assign a unique ID and name to commission your vessel.";
            if (submitBtn) submitBtn.innerText = "Register & Launch Fleet";
            if (deleteContainer) deleteContainer.classList.add('hidden');
            
            if (nameInput) {
                nameInput.value = "";
                nameInput.placeholder = "e.g. M/Y EXPLORER";
            }

            document.getElementById('vessel-main-fields')?.classList.remove('hidden');
            document.getElementById('vessel-backdrop-fields')?.classList.remove('hidden');
            document.getElementById('settings-asset-code-container')?.classList.add('hidden');
            document.getElementById('join-asset-fields')?.classList.add('hidden');
            
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
        const vesselLogs = this.logs.filter(l => l.vessel_id === settingsManager.activeVesselId);
        if (vesselLogs.length === 0) {
            app.notifyError("No logs available for export in the current vessel.");
            return;
        }

        const headers = ["Title", "Location", "Category", "Priority", "Date", "Status", "Notes", "Completed By"];
        const csvRows = vesselLogs.map(log => [
            `"${log.title.replace(/"/g, '""')}"`,
            `"${(log.location || '').replace(/"/g, '""')}"`,
            log.category,
            log.priority,
            log.timestamp,
            log.completed ? "Yes" : "No",
            `"${(log.notes || "").replace(/"/g, '""').replace(/\n/g, ' ')}"`,
            `"${log.completed_by || 'N/A'}"`
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
                // Compress image before storing
                const img = new Image();
                img.onload = () => {
                    const maxDim = 800;
                    let w = img.width, h = img.height;
                    if (w > maxDim || h > maxDim) {
                        const ratio = Math.min(maxDim / w, maxDim / h);
                        w = Math.round(w * ratio);
                        h = Math.round(h * ratio);
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    this.currentAlarmImage = canvas.toDataURL('image/jpeg', 0.7);
                    
                    const previewImg = document.getElementById('alarm-preview-img');
                    const previewContainer = document.getElementById('alarm-preview-container');
                    if (previewImg && previewContainer) {
                        previewImg.src = this.currentAlarmImage;
                        previewContainer.classList.remove('hidden');
                    }
                };
                img.src = e.target.result;
                
                const fileName = document.getElementById('alarm-file-name');
                if (fileName) fileName.innerText = input.files[0].name;
            };
            reader.readAsDataURL(input.files[0]);
        }
    }

    async addAlarmEvent(formData) {
        if (!supabaseClient) return;

        const alarmData = {
            vessel_id: settingsManager.activeVesselId,
            title: formData.get('title'),
            category: formData.get('category'),
            date: formData.get('date'),
            time: formData.get('time'),
            notes: formData.get('notes'),
            image_url: this.currentAlarmImage
        };

        if (this.editingAlarmId) {
            const { error } = await supabaseClient
                .from('alarm_events')
                .update(alarmData)
                .eq('id', this.editingAlarmId);
            
            if (error) app.notifyError("Update failed: " + error.message);
            this.editingAlarmId = null;
        } else {
            const { error } = await supabaseClient
                .from('alarm_events')
                .insert([{ ...alarmData, logged_by: auth.currentUser.name }]);
            
            if (error) app.notifyError("Alert recording failed: " + error.message);
        }

        await this.reloadData();
        this.closeAlarmModal();
        if (this.currentView === 'alarms') this.renderAlarms();
        
        // Notify user
        this.notifySuccess(this.editingAlarmId ? 'Alarm Event Updated ✓' : 'Safety Alarm Registered ✓');
    }

    editAlarm(id) {
        this.openAlarmModal(id);
    }

    async toggleAcknowledgeAlarm(id) {
        const alarm = this.alarms.find(a => a.id === id);
        if (alarm) {
            const newStatus = !alarm.acknowledged;
            const { error } = await supabaseClient
                .from('alarm_events')
                .update({ 
                    acknowledged: newStatus,
                    acknowledged_by: newStatus ? auth.currentUser.name : null 
                })
                .eq('id', id);

            if (error) app.notifyError("Acknowledgment failed: " + error.message);
            await this.reloadData();
            if (this.currentView === 'alarms') this.renderAlarms();
            this.updateDashboard();
        }
    }



    async deleteAlarm(id) {
        if (confirm("🚨 DATA PURGE: Securely delete this alarm record?")) {
            const { error } = await supabaseClient
                .from('alarm_events')
                .delete()
                .eq('id', id);

            if (error) app.notifyError("Purge failed: " + error.message);
            await this.reloadData();
            if (this.currentView === 'alarms') this.renderAlarms();
            this.updateDashboard();
        }
    }

    renderAlarms() {
        const list = document.getElementById('alarm-list');
        if (!list) return;

        // Update alarm badge on sidebar nav
        const unacknowledgedCount = this.alarms.filter(a => !a.acknowledged).length;
        const alarmNavBtn = document.querySelector('.nav-btn[data-view="alarms"]');
        if (alarmNavBtn) {
            let badge = alarmNavBtn.querySelector('.alarm-badge-count');
            if (unacknowledgedCount > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'alarm-badge-count ml-auto px-2 py-0.5 rounded-full bg-rose-600 text-white text-[9px] font-black';
                    alarmNavBtn.appendChild(badge);
                }
                badge.innerText = unacknowledgedCount;
            } else if (badge) {
                badge.remove();
            }
        }

        const filtered = this.getFilteredAlarms();
        
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
                ${alarm.image_url ? `
                    <div class="h-48 relative overflow-hidden">
                        <img src="${alarm.image_url}" class="w-full h-full object-cover group-hover:scale-110 transition-all duration-700">
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
                    <div class="pt-6 border-t border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div class="flex items-center gap-2">
                            <div class="w-6 h-6 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-500 font-black italic text-[10px]">${alarm.logged_by ? alarm.logged_by[0] : 'U'}</div>
                            <div class="flex flex-col">
                                <span class="text-[8px] text-slate-500 font-bold uppercase tracking-widest leading-none mb-1">Logged By</span>
                                <span class="text-[10px] text-white font-black uppercase tracking-widest">${alarm.logged_by || 'Unknown'}</span>
                            </div>
                        </div>
                        ${alarm.acknowledged ? `
                            <div class="flex items-center justify-between sm:justify-end gap-3 bg-azure/5 sm:bg-transparent p-3 sm:p-0 rounded-2xl">
                                <div class="flex flex-col items-end text-right">
                                    <span class="text-[8px] text-slate-500 font-bold uppercase tracking-widest leading-none mb-1">Accountability</span>
                                    <span class="text-[10px] text-azure font-black uppercase tracking-widest">Acknowledged by ${alarm.acknowledged_by}</span>
                                </div>
                                <svg class="w-4 h-4 text-azure" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path></svg>
                            </div>
                        ` : `
                            <button onclick="app.toggleAcknowledgeAlarm('${alarm.id}')" class="bg-rose-500 hover:bg-rose-600 px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest text-white transition-all active:scale-95 shadow-lg shadow-rose-500/20">Mark Resolved</button>
                        `}
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
        this.notifySuccess('Vessel Profile Saved ✓');
    }
    
    notifySuccess(message) {
        const toast = document.createElement('div');
        toast.className = 'fixed bottom-8 right-8 bg-green-500 text-white px-6 py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] shadow-2xl z-[500] animate-fade-in sm:px-8';
        toast.innerText = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.5s ease';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }

    notifyError(message) {
        const toast = document.createElement('div');
        toast.className = 'fixed bottom-8 right-8 bg-rose-600 text-white px-6 py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] shadow-2xl z-[600] animate-fade-in sm:px-8 border-2 border-white/20';
        toast.innerHTML = `
            <div class="flex items-center gap-3">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"></path></svg>
                <span>${message}</span>
            </div>
        `;
        document.body.appendChild(toast);
        // Error toasts stay longer
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.5s ease';
            setTimeout(() => toast.remove(), 500);
        }, 6000);
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
        // Center text plugin for percentage display
        const centerTextPlugin = {
            id: 'centerText',
            afterDraw(chart) {
                const { width, height, ctx: c } = chart;
                c.save();
                const data = chart.data.datasets[0].data;
                const total = data.reduce((a, b) => a + b, 0);
                const completed = data[0] || 0;
                const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
                
                // Draw label
                c.font = 'black 10px Outfit';
                c.fillStyle = '#64748b'; // slate-500
                c.textAlign = 'center';
                c.textBaseline = 'middle';
                c.letterSpacing = '2px';
                c.fillText('READINESS', width / 2, height / 2 - 18);
                
                // Draw Percentage
                c.font = 'bold 32px Outfit';
                c.fillStyle = '#ffffff';
                c.letterSpacing = '0px';
                c.fillText(pct + '%', width / 2, height / 2 + 10);
                c.restore();
            }
        };
        
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
                        titleFont: { family: 'Outfit', weight: 'bold' },
                        bodyFont: { family: 'Inter' },
                        padding: 12,
                        cornerRadius: 16
                    }
                }
            },
            plugins: [centerTextPlugin]
        });
        app.updateDashboard();
    }
});
