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

// Start auto-refresh
function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => {
        loadInvestigations(true);
        loadStats(true);
    }, 30000); // Refresh every 30 seconds
}

// Check server connection
async function checkConnection() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();
        updateConnectionStatus(true, `${data.investigations} records`);
        console.log('Server health:', data);
    } catch (error) {
        updateConnectionStatus(false, 'Disconnected');
        console.error('Connection error:', error);
        setTimeout(checkConnection, 5000);
    }
}

function updateConnectionStatus(connected, text) {
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.getElementById('statusText');
    
    if (connected) {
        statusDot.classList.add('connected');
        statusDot.classList.remove('error');
        statusText.textContent = `Connected · ${text}`;
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('error');
        statusText.textContent = 'Disconnected - retrying...';
    }
}

// Show toast notification
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Load all investigations
async function loadInvestigations(silent = false) {
    try {
        const response = await fetch(`${API_BASE}/investigations`);
        if (!response.ok) throw new Error('Failed to load');
        const data = await response.json();
        currentInvestigations = data;
        applyFilters();
        if (!silent) showToast('Data loaded successfully', 'success');
    } catch (error) {
        console.error('Error loading investigations:', error);
        if (!silent) showToast('Failed to load investigations', 'error');
    }
}

// Load statistics
async function loadStats(silent = false) {
    try {
        const response = await fetch(`${API_BASE}/stats`);
        if (!response.ok) throw new Error('Failed to load stats');
        const stats = await response.json();
        
        document.getElementById('totalLPN').textContent = stats.total;
        document.getElementById('hrpCount').textContent = stats.byTeam.HRP;
        document.getElementById('dispatchCount').textContent = stats.byTeam.Dispatch;
        document.getElementById('claimsCount').textContent = stats.byTeam.Claims;
        document.getElementById('cityCount').textContent = stats.byTeam.CityFloor;
        document.getElementById('returnsCount').textContent = stats.byTeam.Returns;
        
        const lastUpdated = new Date(stats.lastUpdated);
        document.getElementById('lastUpdated').textContent = 
            lastUpdated.toLocaleTimeString();
        
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// Setup event listeners
function setupEventListeners() {
    // Manual entry form
    document.getElementById('manualEntryForm').addEventListener('submit', handleManualSubmit);
    
    // Upload button
    document.getElementById('uploadBtn').addEventListener('click', handleFileUpload);
    
    // Download template
    document.getElementById('downloadTemplateBtn').addEventListener('click', downloadTemplate);
    
    // Search input
    document.getElementById('searchInput').addEventListener('input', (e) => {
        currentFilters.search = e.target.value;
        applyFilters();
    });
    
    // Team filters
    document.querySelectorAll('.filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentFilters.team = pill.dataset.team;
            applyFilters();
        });
    });
    
    // Status filter
    document.getElementById('statusFilter').addEventListener('change', (e) => {
        currentFilters.status = e.target.value;
        applyFilters();
    });
    
    // Clear filters
    document.getElementById('clearFiltersBtn').addEventListener('click', clearFilters);
    
    // Modal close
    document.querySelector('.close-modal').addEventListener('click', () => {
        document.getElementById('historyModal').style.display = 'none';
    });
    
    // Click outside modal
    window.addEventListener('click', (e) => {
        if (e.target === document.getElementById('historyModal')) {
            document.getElementById('historyModal').style.display = 'none';
        }
    });
}

// Handle manual form submission
async function handleManualSubmit(e) {
    e.preventDefault();
    
    const lpn = document.getElementById('lpnInput').value.trim();
    if (!lpn) {
        showToast('LPN is required', 'error');
        return;
    }
    
    const team = document.getElementById('teamSelect').value;
    const status = document.getElementById('statusSelect').value;
    const finding = document.getElementById('findingInput').value.trim() || 'No initial finding';
    const wms = document.getElementById('wmsInput').value.trim() || '—';
    const city = document.getElementById('cityInput').value.trim() || '—';
    const owner = document.getElementById('ownerInput').value.trim() || team;
    
    const newInvestigation = {
        lpn, team, status, finding, wms, city, owner
    };
    
    try {
        const response = await fetch(`${API_BASE}/investigations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newInvestigation)
        });
        
        if (!response.ok) throw new Error('Failed to save');
        
        // Clear form
        document.getElementById('lpnInput').value = 'LPN-';
        document.getElementById('findingInput').value = '';
        document.getElementById('wmsInput').value = '';
        document.getElementById('cityInput').value = '';
        document.getElementById('ownerInput').value = '';
        
        // Reload data
        await loadInvestigations();
        await loadStats();
        showToast('Investigation added successfully');
        
    } catch (error) {
        console.error('Error adding investigation:', error);
        showToast('Failed to add investigation', 'error');
    }
}

// Handle file upload
async function handleFileUpload() {
    const fileInput = document.getElementById('excelFile');
    const file = fileInput.files[0];
    
    if (!file) {
        showToast('Please select a file', 'error');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
            
            // Parse headers
            const headers = rows[0] || [];
            const lpnIdx = headers.findIndex(h => 
                h?.toString().toLowerCase().includes('lpn'));
            const teamIdx = headers.findIndex(h => 
                h?.toString().toLowerCase().includes('team'));
            const statusIdx = headers.findIndex(h => 
                h?.toString().toLowerCase().includes('status'));
            const findingIdx = headers.findIndex(h => 
                h?.toString().toLowerCase().includes('finding'));
            const wmsIdx = headers.findIndex(h => 
                h?.toString().toLowerCase().includes('wms'));
            const cityIdx = headers.findIndex(h => 
                h?.toString().toLowerCase().includes('city'));
            const ownerIdx = headers.findIndex(h => 
                h?.toString().toLowerCase().includes('owner'));
            
            if (lpnIdx === -1 || teamIdx === -1) {
                showToast('File must contain LPN and Team columns', 'error');
                return;
            }
            
            const investigations = [];
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || !row[lpnIdx]) continue;
                
                investigations.push({
                    lpn: String(row[lpnIdx] || '').trim(),
                    team: String(row[teamIdx] || '').trim(),
                    status: String(row[statusIdx] || 'New').trim(),
                    finding: String(row[findingIdx] || '').trim() || 'Bulk imported',
                    wms: String(row[wmsIdx] || '—').trim(),
                    city: String(row[cityIdx] || '—').trim(),
                    owner: String(row[ownerIdx] || row[teamIdx] || '').trim()
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

// Download template CSV
function downloadTemplate() {
    const headers = ['LPN', 'Team', 'Status', 'Finding', 'WMS', 'City', 'Owner'];
    const sampleRow = ['LPN-1234', 'HRP', 'New', 'Sample finding', 'chute 12', 'pending', 'HRP'];
    
    const csvContent = [
        headers.join(','),
        sampleRow.join(',')
    ].join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lpn_template.csv';
    a.click();
    window.URL.revokeObjectURL(url);
}

// Apply filters and render table
function applyFilters() {
    let filtered = [...currentInvestigations];
    
    if (currentFilters.search) {
        const search = currentFilters.search.toLowerCase();
        filtered = filtered.filter(i => 
            i.lpn.toLowerCase().includes(search) ||
            i.finding.toLowerCase().includes(search) ||
            i.owner.toLowerCase().includes(search) ||
            (i.wms && i.wms.toLowerCase().includes(search))
        );
    }
    
    if (currentFilters.team) {
        filtered = filtered.filter(i => i.team === currentFilters.team);
    }
    
    if (currentFilters.status) {
        filtered = filtered.filter(i => i.status === currentFilters.status);
    }
    
    renderTable(filtered);
    document.getElementById('recordCount').textContent = `${filtered.length} records`;
}

// Clear all filters
function clearFilters() {
    document.getElementById('searchInput').value = '';
    document.getElementById('statusFilter').value = '';
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    document.querySelector('.filter-pill[data-team=""]').classList.add('active');
    
    currentFilters = { search: '', team: '', status: '' };
    applyFilters();
}

// Render table with data
function renderTable(investigations) {
    const tbody = document.getElementById('tableBody');
    
    if (investigations.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="loading-row">No investigations found</td></tr>';
        return;
    }
    
    tbody.innerHTML = investigations.map(inv => {
        const statusClass = inv.status.toLowerCase().replace(/\s+/g, '');
        
        return `
            <tr data-id="${inv.id}">
                <td>${inv.id}</td>
                <td><strong>${inv.lpn}</strong></td>
                <td><span class="team-badge">${inv.team}</span></td>
                <td><span class="status-badge status-${statusClass}">${inv.status}</span></td>
                <td>${inv.finding.substring(0, 50)}${inv.finding.length > 50 ? '...' : ''}</td>
                <td>${inv.wms}</td>
                <td>${inv.city}</td>
                <td>${inv.owner}</td>
                <td>${inv.timestamp}</td>
                <td>
                    <div class="action-buttons">
                        <button class="action-btn" onclick="showHistory(${inv.id})">📋 History</button>
                        <button class="action-btn" onclick="showUpdateForm(${inv.id})">✏️ Update</button>
                    </div>
                    <div id="update-form-${inv.id}" style="display:none;" class="update-form">
                        <input type="text" id="finding-${inv.id}" class="update-input" 
                               placeholder="New finding">
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
                            Submit Update
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// Show investigation history
async function showHistory(id) {
    try {
        const response = await fetch(`${API_BASE}/investigations/${id}/history`);
        if (!response.ok) throw new Error('Failed to load history');
        const history = await response.json();
        
        const historyContent = document.getElementById('historyContent');
        if (!history || history.length === 0) {
            historyContent.innerHTML = '<p style="text-align:center; color:var(--gray-500);">No history available</p>';
        } else {
            historyContent.innerHTML = history.map(h => `
                <div class="history-item">
                    <div class="history-action">${h.action}</div>
                    <div class="history-meta">
                        by ${h.user || 'System'} · ${new Date(h.timestamp).toLocaleString()}
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

// Show update form
function showUpdateForm(id) {
    const form = document.getElementById(`update-form-${id}`);
    form.style.display = form.style.display === 'none' ? 'flex' : 'none';
}

// Update investigation
async function updateInvestigation(id) {
    const finding = document.getElementById(`finding-${id}`).value.trim();
    const status = document.getElementById(`status-${id}`).value;
    
    if (!finding && !status) {
        showToast('Enter a finding or select a status', 'error');
        return;
    }
    
    const updateData = {
        action: finding || 'Status update',
        user: 'Current User' // In production, this would come from auth
    };
    
    if (finding) updateData.finding = finding;
    if (status) updateData.status = status;
    
    try {
        const response = await fetch(`${API_BASE}/investigations/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateData)
        });
        
        if (!response.ok) throw new Error('Update failed');
        
        // Hide form
        document.getElementById(`update-form-${id}`).style.display = 'none';
        document.getElementById(`finding-${id}`).value = '';
        document.getElementById(`status-${id}`).value = '';
        
        // Reload data
        await loadInvestigations(true);
        await loadStats(true);
        showToast('Investigation updated successfully');
        
    } catch (error) {
        console.error('Update error:', error);
        showToast('Failed to update investigation', 'error');
    }
}

// Make functions global for onclick handlers
window.showHistory = showHistory;
window.showUpdateForm = showUpdateForm;
window.updateInvestigation = updateInvestigation;
