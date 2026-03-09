// API Base URL - auto-detects Railway URL
const API_BASE = window.location.origin + '/api';

// Global state
let currentInvestigations = [];
let currentFilters = {
    search: '',
    team: '',
    status: ''
};
let refreshInterval = null;

// Thresholds (hours)
const OVERDUE_HOURS  = 36;
const WARNING_HOURS  = 24;
const MS_PER_HOUR    = 3_600_000;
const MAX_FINDING_DISPLAY_LENGTH = 55;

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    checkConnection();
    loadInvestigations();
    loadStats();
    setupEventListeners();
    startAutoRefresh();

    // Set environment badge
    const isRailway = window.location.hostname.includes('railway.app');
    document.getElementById('environment-badge').textContent =
        isRailway ? 'railway' : 'development';
});

// ─── Auto-refresh ─────────────────────────────────────────
function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => {
        loadInvestigations(true);
        loadStats(true);
    }, 15000); // 15-second live refresh
}

// ─── Connection check ──────────────────────────────────────
async function checkConnection() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();
        updateConnectionStatus(true, `${data.database}`);
    } catch (error) {
        updateConnectionStatus(false, 'Disconnected');
        setTimeout(checkConnection, 5000);
    }
}

function updateConnectionStatus(connected, text) {
    const statusDot  = document.querySelector('.status-dot');
    const statusText = document.getElementById('statusText');
    const liveBadge  = document.getElementById('liveBadge');

    if (connected) {
        statusDot.classList.add('connected');
        statusDot.classList.remove('error');
        statusText.textContent = `Connected · ${text}`;
        if (liveBadge) liveBadge.style.display = '';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('error');
        statusText.textContent = 'Disconnected - retrying...';
        if (liveBadge) liveBadge.style.display = 'none';
    }
}

// ─── Toast ─────────────────────────────────────────────────
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 3500);
}

// ─── Load investigations ───────────────────────────────────
async function loadInvestigations(silent = false) {
    try {
        const response = await fetch(`${API_BASE}/investigations`);
        if (!response.ok) throw new Error('Failed to load');
        currentInvestigations = await response.json();
        applyFilters();
        if (!silent) showToast('Data loaded successfully', 'success');
    } catch (error) {
        console.error('Error loading investigations:', error);
        if (!silent) showToast('Failed to load investigations', 'error');
    }
}

// ─── Load statistics ───────────────────────────────────────
async function loadStats(silent = false) {
    try {
        const response = await fetch(`${API_BASE}/stats`);
        if (!response.ok) throw new Error('Failed to load stats');
        const stats = await response.json();

        document.getElementById('totalLPN').textContent      = stats.total;
        document.getElementById('hrpCount').textContent      = stats.byTeam.HRP;
        document.getElementById('dispatchCount').textContent = stats.byTeam.Dispatch;
        document.getElementById('claimsCount').textContent   = stats.byTeam.Claims;
        document.getElementById('cityCount').textContent     = stats.byTeam.CityFloor;
        document.getElementById('returnsCount').textContent  = stats.byTeam.Returns;

        const unresolvedEl = document.getElementById('unresolvedCount');
        const overdueEl    = document.getElementById('overdueCount');
        const resolvedEl   = document.getElementById('resolvedCount');

        if (unresolvedEl) unresolvedEl.textContent = stats.unresolved ?? 0;
        if (overdueEl)    overdueEl.textContent    = stats.overdue    ?? 0;
        if (resolvedEl)   resolvedEl.textContent   = stats.byStatus?.Resolved ?? 0;

        const lastUpdated = new Date(stats.lastUpdated);
        document.getElementById('lastUpdated').textContent =
            lastUpdated.toLocaleTimeString();

    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// ─── Event listeners ───────────────────────────────────────
function setupEventListeners() {
    document.getElementById('manualEntryForm').addEventListener('submit', handleManualSubmit);
    document.getElementById('uploadBtn').addEventListener('click', handleFileUpload);
    document.getElementById('downloadTemplateBtn').addEventListener('click', downloadTemplate);

    document.getElementById('searchInput').addEventListener('input', (e) => {
        currentFilters.search = e.target.value;
        applyFilters();
    });

    document.querySelectorAll('.filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentFilters.team = pill.dataset.team;
            applyFilters();
        });
    });

    document.getElementById('statusFilter').addEventListener('change', (e) => {
        currentFilters.status = e.target.value;
        applyFilters();
    });

    document.getElementById('clearFiltersBtn').addEventListener('click', clearFilters);

    document.querySelector('.close-modal').addEventListener('click', () => {
        document.getElementById('historyModal').style.display = 'none';
    });

    window.addEventListener('click', (e) => {
        if (e.target === document.getElementById('historyModal')) {
            document.getElementById('historyModal').style.display = 'none';
        }
    });
}

// ─── Manual form submit ─────────────────────────────────────
async function handleManualSubmit(e) {
    e.preventDefault();

    const lpn = document.getElementById('lpnInput').value.trim();
    if (!lpn) { showToast('LPN is required', 'error'); return; }

    const team    = document.getElementById('teamSelect').value;
    const status  = document.getElementById('statusSelect').value;
    const finding = document.getElementById('findingInput').value.trim() || 'No initial finding';
    const wms     = document.getElementById('wmsInput').value.trim()     || '—';
    const city    = document.getElementById('cityInput').value.trim()    || '—';
    const owner   = document.getElementById('ownerInput').value.trim()   || team;

    try {
        const response = await fetch(`${API_BASE}/investigations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lpn, team, status, finding, wms, city, owner })
        });

        if (!response.ok) throw new Error('Failed to save');

        document.getElementById('lpnInput').value    = 'LPN-';
        document.getElementById('findingInput').value = '';
        document.getElementById('wmsInput').value    = '';
        document.getElementById('cityInput').value   = '';
        document.getElementById('ownerInput').value  = '';

        await loadInvestigations();
        await loadStats();
        showToast('Investigation added successfully');

    } catch (error) {
        console.error('Error adding investigation:', error);
        showToast('Failed to add investigation', 'error');
    }
}

// ─── File upload ────────────────────────────────────────────
async function handleFileUpload() {
    const fileInput = document.getElementById('excelFile');
    const file = fileInput.files[0];
    if (!file) { showToast('Please select a file', 'error'); return; }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data     = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const sheet    = workbook.Sheets[workbook.SheetNames[0]];
            const rows     = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            const headers   = rows[0] || [];
            const lpnIdx    = headers.findIndex(h => h?.toString().toLowerCase().includes('lpn'));
            const teamIdx   = headers.findIndex(h => h?.toString().toLowerCase().includes('team'));
            const statusIdx = headers.findIndex(h => h?.toString().toLowerCase().includes('status'));
            const findIdx   = headers.findIndex(h => h?.toString().toLowerCase().includes('finding'));
            const wmsIdx    = headers.findIndex(h => h?.toString().toLowerCase().includes('wms'));
            const cityIdx   = headers.findIndex(h => h?.toString().toLowerCase().includes('city'));
            const ownerIdx  = headers.findIndex(h => h?.toString().toLowerCase().includes('owner'));

            if (lpnIdx === -1 || teamIdx === -1) {
                showToast('File must contain LPN and Team columns', 'error');
                return;
            }

            const investigations = [];
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || !row[lpnIdx]) continue;
                investigations.push({
                    lpn:     String(row[lpnIdx]  || '').trim(),
                    team:    String(row[teamIdx]  || '').trim(),
                    status:  String(row[statusIdx]|| 'New').trim(),
                    finding: String(row[findIdx]  || '').trim() || 'Bulk imported',
                    wms:     String(row[wmsIdx]   || '—').trim(),
                    city:    String(row[cityIdx]  || '—').trim(),
                    owner:   String(row[ownerIdx] || row[teamIdx] || '').trim()
                });
            }

            if (investigations.length === 0) {
                showToast('No valid records found', 'error');
                return;
            }

            const response = await fetch(`${API_BASE}/investigations/bulk`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(investigations)
            });

            if (!response.ok) throw new Error('Upload failed');

            fileInput.value = '';
            await loadInvestigations();
            await loadStats();
            showToast(`Successfully uploaded ${investigations.length} records`);

        } catch (error) {
            console.error('Upload error:', error);
            showToast('Failed to upload file', 'error');
        }
    };
    reader.readAsArrayBuffer(file);
}

// ─── Download template ──────────────────────────────────────
function downloadTemplate() {
    const headers   = ['LPN', 'Team', 'Status', 'Finding', 'WMS', 'City', 'Owner'];
    const sampleRow = ['LPN-1234', 'HRP', 'New', 'Sample finding', 'chute 12', 'pending', 'HRP'];
    const csvContent = [headers.join(','), sampleRow.join(',')].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url  = window.URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'lpn_template.csv'; a.click();
    window.URL.revokeObjectURL(url);
}

// ─── Filters ────────────────────────────────────────────────
function applyFilters() {
    let filtered = [...currentInvestigations];

    if (currentFilters.search) {
        const search = currentFilters.search.toLowerCase();
        filtered = filtered.filter(i =>
            (i.lpn    || '').toLowerCase().includes(search) ||
            (i.finding|| '').toLowerCase().includes(search) ||
            (i.owner  || '').toLowerCase().includes(search) ||
            (i.wms    || '').toLowerCase().includes(search) ||
            (i.city   || '').toLowerCase().includes(search)
        );
    }

    if (currentFilters.team)   filtered = filtered.filter(i => i.team   === currentFilters.team);
    if (currentFilters.status) filtered = filtered.filter(i => i.status === currentFilters.status);

    renderTable(filtered);
    document.getElementById('recordCount').textContent = `${filtered.length} records`;
}

function clearFilters() {
    document.getElementById('searchInput').value  = '';
    document.getElementById('statusFilter').value = '';
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    document.querySelector('.filter-pill[data-team=""]').classList.add('active');
    currentFilters = { search: '', team: '', status: '' };
    applyFilters();
}

// ─── Age helpers ─────────────────────────────────────────────
function getAgeHours(inv) {
    const ref = inv.created_at || inv.updated_at || inv.timestamp;
    if (!ref) return 0;
    return (Date.now() - new Date(ref).getTime()) / MS_PER_HOUR;
}

function formatAge(hours) {
    if (hours < 1)  return '< 1h';
    if (hours < 24) return `${Math.floor(hours)}h`;
    const days    = Math.floor(hours / 24);
    const remHrs  = Math.floor(hours % 24);
    return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

function ageBadgeClass(status, hours) {
    const resolved = status === 'Resolved' || status === 'Returned';
    if (resolved)               return 'age-ok';
    if (hours >= OVERDUE_HOURS) return 'age-over';
    if (hours >= WARNING_HOURS) return 'age-warn';
    return '';
}

// ─── Render table ────────────────────────────────────────────
function renderTable(investigations) {
    const tbody = document.getElementById('tableBody');

    if (investigations.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="loading-row">No investigations found</td></tr>';
        return;
    }

    tbody.innerHTML = investigations.map(inv => {
        const statusClass   = inv.status.toLowerCase().replace(/\s+/g, '');
        const ageHours      = getAgeHours(inv);
        const ageFormatted  = formatAge(ageHours);
        const ageCls        = ageBadgeClass(inv.status, ageHours);
        const isResolved    = inv.status === 'Resolved' || inv.status === 'Returned';
        const isOverdue     = !isResolved && ageHours >= OVERDUE_HOURS;
        const isWarning     = !isResolved && !isOverdue && ageHours >= WARNING_HOURS;

        const rowClass = isResolved ? 'row-resolved'
                       : isOverdue  ? 'row-overdue'
                       : isWarning  ? 'row-warning'
                       : '';

        const findingText = (inv.finding || '').substring(0, MAX_FINDING_DISPLAY_LENGTH)
            + ((inv.finding || '').length > MAX_FINDING_DISPLAY_LENGTH ? '…' : '');

        return `
            <tr class="${rowClass}" data-id="${inv.id}">
                <td>${inv.id}</td>
                <td class="lpn-cell"><strong>${inv.lpn}</strong></td>
                <td><span class="team-badge">${inv.team}</span></td>
                <td><span class="status-badge status-${statusClass}">${inv.status}</span></td>
                <td title="${(inv.finding || '').replace(/"/g, '&quot;')}">${findingText}</td>
                <td>${inv.wms || '—'}</td>
                <td>${inv.city || '—'}</td>
                <td>${inv.owner || '—'}</td>
                <td><span class="age-badge ${ageCls}">${ageFormatted}</span></td>
                <td>${inv.timestamp || '—'}</td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn" onclick="showHistory(${inv.id})">📋 History</button>
                        <button class="action-btn" onclick="showUpdateForm(${inv.id})">✏️ Update</button>
                    </div>
                    <div id="update-form-${inv.id}" style="display:none;" class="update-form">
                        <div class="update-form-grid">
                            <div class="update-field">
                                <span class="update-label">Finding</span>
                                <input type="text" id="finding-${inv.id}" class="update-input"
                                       placeholder="New finding…">
                            </div>
                            <div class="update-field">
                                <span class="update-label">WMS</span>
                                <input type="text" id="wms-${inv.id}" class="update-input"
                                       placeholder="WMS result">
                            </div>
                            <div class="update-field">
                                <span class="update-label">City Ack</span>
                                <input type="text" id="city-${inv.id}" class="update-input"
                                       placeholder="City acknowledgement">
                            </div>
                            <div class="update-field">
                                <span class="update-label">Owner</span>
                                <input type="text" id="owner-${inv.id}" class="update-input"
                                       placeholder="Assign owner">
                            </div>
                        </div>
                        <select id="status-${inv.id}" class="update-select">
                            <option value="">Keep status</option>
                            <option value="New">New</option>
                            <option value="In progress">In progress</option>
                            <option value="Awaiting City">Awaiting City</option>
                            <option value="Resolved">Resolved</option>
                            <option value="Claim raised">Claim raised</option>
                            <option value="Returned">Returned</option>
                        </select>
                        <button class="update-submit" onclick="updateInvestigation(${inv.id})">
                            ✔ Submit Update
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// ─── Show history modal ──────────────────────────────────────
async function showHistory(id) {
    try {
        const response = await fetch(`${API_BASE}/investigations/${id}/history`);
        if (!response.ok) throw new Error('Failed to load history');
        const history = await response.json();

        const historyContent = document.getElementById('historyContent');
        if (!history || history.length === 0) {
            historyContent.innerHTML =
                '<p style="text-align:center;color:var(--text-muted);">No history available</p>';
        } else {
            historyContent.innerHTML = history.map(h => `
                <div class="history-item">
                    <div class="history-action">${h.action}</div>
                    ${h.finding ? `<div class="history-finding">${h.finding}</div>` : ''}
                    <div class="history-meta">
                        by ${h.user || 'System'} &middot; ${new Date(h.timestamp).toLocaleString()}
                    </div>
                </div>
            `).join('');
        }

        document.getElementById('historyModal').style.display = 'block';

    } catch (error) {
        console.error('Error loading history:', error);
        showToast('Failed to load history', 'error');
    }
}

// ─── Toggle update form ──────────────────────────────────────
function showUpdateForm(id) {
    const form = document.getElementById(`update-form-${id}`);
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
}

// ─── Submit update ───────────────────────────────────────────
async function updateInvestigation(id) {
    const finding = document.getElementById(`finding-${id}`).value.trim();
    const wms     = document.getElementById(`wms-${id}`).value.trim();
    const city    = document.getElementById(`city-${id}`).value.trim();
    const owner   = document.getElementById(`owner-${id}`).value.trim();
    const status  = document.getElementById(`status-${id}`).value;

    if (!finding && !wms && !city && !owner && !status) {
        showToast('Enter at least one field to update', 'error');
        return;
    }

    const updateData = {
        action: finding || 'Field update',
        user: 'Current User'
    };

    if (finding) updateData.finding = finding;
    if (wms)     updateData.wms     = wms;
    if (city)    updateData.city    = city;
    if (owner)   updateData.owner   = owner;
    if (status)  updateData.status  = status;

    try {
        const response = await fetch(`${API_BASE}/investigations/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData)
        });

        if (!response.ok) throw new Error('Update failed');

        // Clear fields
        document.getElementById(`update-form-${id}`).style.display = 'none';
        ['finding', 'wms', 'city', 'owner'].forEach(f => {
            const el = document.getElementById(`${f}-${id}`);
            if (el) el.value = '';
        });
        document.getElementById(`status-${id}`).value = '';

        await loadInvestigations(true);
        await loadStats(true);
        showToast('Investigation updated successfully');

    } catch (error) {
        console.error('Update error:', error);
        showToast('Failed to update investigation', 'error');
    }
}

// ─── Expose to global scope for onclick handlers ─────────────
window.showHistory        = showHistory;
window.showUpdateForm     = showUpdateForm;
window.updateInvestigation = updateInvestigation;
