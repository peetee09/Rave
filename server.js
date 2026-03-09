const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============= PERSISTENT STORAGE CONFIGURATION =============
// For Railway: Use mounted volume if available
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH 
    ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'database.json')
    : path.join(__dirname, 'database.json');

// Ensure database directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log(`📁 Created database directory: ${dbDir}`);
}

// ============= MIDDLEWARE =============
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// ============= DATABASE HELPERS =============
const initializeDatabase = () => {
    if (!fs.existsSync(DB_PATH)) {
        const initialData = {
            investigations: [
                {
                    id: 1,
                    lpn: 'LPN-4821',
                    team: 'HRP',
                    status: 'In progress',
                    finding: 'FD lock, chute scan #12',
                    wms: 'chute 14 / 09:22',
                    city: 'pending',
                    owner: 'HRP',
                    timestamp: new Date().toLocaleString('en-CA', { 
                        year: 'numeric', 
                        month: '2-digit', 
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false 
                    }).replace(',', ''),
                    history: [
                        { 
                            action: 'System initialized', 
                            user: 'System', 
                            timestamp: new Date().toISOString() 
                        }
                    ]
                },
                {
                    id: 2,
                    lpn: 'CARTON-723X',
                    team: 'CityFloor',
                    status: 'Awaiting City',
                    finding: 'City non‑ack, label mismatch',
                    wms: 'WCS: no scan',
                    city: 'non‑ack',
                    owner: 'CityFloor',
                    timestamp: new Date().toLocaleString('en-CA', { 
                        year: 'numeric', 
                        month: '2-digit', 
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false 
                    }).replace(',', ''),
                    history: [
                        { 
                            action: 'System initialized', 
                            user: 'System', 
                            timestamp: new Date().toISOString() 
                        }
                    ]
                }
            ],
            users: [
                { id: 1, name: 'HRP User', team: 'HRP', role: 'investigator' },
                { id: 2, name: 'Dispatch User', team: 'Dispatch', role: 'investigator' },
                { id: 3, name: 'Claims User', team: 'Claims', role: 'investigator' },
                { id: 4, name: 'City Floor User', team: 'CityFloor', role: 'investigator' },
                { id: 5, name: 'Returns User', team: 'Returns', role: 'investigator' }
            ],
            metadata: {
                lastUpdated: new Date().toISOString(),
                version: '1.0.0',
                environment: process.env.NODE_ENV || 'development'
            }
        };
        fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
        console.log('✅ Database initialized with sample data');
    }
};

// File locking mechanism to prevent race conditions
const lockFile = (callback) => {
    const lockPath = `${DB_PATH}.lock`;
    const lockId = crypto.randomBytes(16).toString('hex');
    
    const tryLock = () => {
        try {
            fs.writeFileSync(lockPath, lockId, { flag: 'wx' });
            callback();
            fs.unlinkSync(lockPath);
        } catch (err) {
            if (err.code === 'EEXIST') {
                setTimeout(tryLock, 100);
            } else {
                console.error('Lock error:', err);
                callback(new Error('Could not acquire lock'));
            }
        }
    };
    
    tryLock();
};

const readDB = () => {
    try {
        const data = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading database:', error);
        return null;
    }
};

const writeDB = (data) => {
    try {
        data.metadata.lastUpdated = new Date().toISOString();
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing database:', error);
        return false;
    }
};

// Initialize database on startup
initializeDatabase();

// ============= API ENDPOINTS =============

// Health check (critical for Railway)
app.get('/api/health', (req, res) => {
    const db = readDB();
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        database: db ? `active (${db.investigations.length} records)` : 'error',
        version: db?.metadata?.version || 'unknown'
    });
});

// Get all investigations
app.get('/api/investigations', (req, res) => {
    try {
        const db = readDB();
        if (!db) {
            return res.status(500).json({ error: 'Database unavailable' });
        }
        res.json(db.investigations);
    } catch (error) {
        console.error('Error in GET /investigations:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single investigation by ID
app.get('/api/investigations/:id', (req, res) => {
    try {
        const db = readDB();
        if (!db) {
            return res.status(500).json({ error: 'Database unavailable' });
        }
        const investigation = db.investigations.find(i => i.id === parseInt(req.params.id));
        if (!investigation) {
            return res.status(404).json({ error: 'Investigation not found' });
        }
        res.json(investigation);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create new investigation
app.post('/api/investigations', (req, res) => {
    lockFile((err) => {
        if (err) {
            return res.status(503).json({ error: 'System busy, try again' });
        }
        
        try {
            const db = readDB();
            if (!db) {
                return res.status(500).json({ error: 'Database unavailable' });
            }
            
            const newId = db.investigations.length > 0 
                ? Math.max(...db.investigations.map(i => i.id)) + 1 
                : 1;
            
            const timestamp = new Date().toLocaleString('en-CA', { 
                year: 'numeric', 
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false 
            }).replace(',', '');
            
            const newInvestigation = {
                id: newId,
                ...req.body,
                timestamp: timestamp,
                history: [
                    { 
                        action: 'Created', 
                        user: req.body.owner || req.body.team || 'System', 
                        timestamp: new Date().toISOString() 
                    }
                ]
            };
            
            db.investigations.push(newInvestigation);
            
            if (writeDB(db)) {
                res.status(201).json(newInvestigation);
            } else {
                res.status(500).json({ error: 'Failed to save to database' });
            }
        } catch (error) {
            console.error('Error in POST /investigations:', error);
            res.status(500).json({ error: error.message });
        }
    });
});

// Update investigation
app.put('/api/investigations/:id', (req, res) => {
    lockFile((err) => {
        if (err) {
            return res.status(503).json({ error: 'System busy, try again' });
        }
        
        try {
            const db = readDB();
            if (!db) {
                return res.status(500).json({ error: 'Database unavailable' });
            }
            
            const index = db.investigations.findIndex(i => i.id === parseInt(req.params.id));
            
            if (index === -1) {
                return res.status(404).json({ error: 'Investigation not found' });
            }
            
            const oldData = db.investigations[index];
            const timestamp = new Date().toLocaleString('en-CA', { 
                year: 'numeric', 
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false 
            }).replace(',', '');
            
            const updatedData = {
                ...oldData,
                ...req.body,
                id: oldData.id,
                timestamp: timestamp
            };
            
            // Add to history if there's a new action or finding
            if (req.body.action || req.body.finding) {
                if (!updatedData.history) updatedData.history = [];
                updatedData.history.push({
                    action: req.body.action || 'Updated',
                    finding: req.body.finding || '',
                    user: req.body.user || req.body.team || 'System',
                    timestamp: new Date().toISOString()
                });
            }
            
            db.investigations[index] = updatedData;
            
            if (writeDB(db)) {
                res.json(updatedData);
            } else {
                res.status(500).json({ error: 'Failed to save to database' });
            }
        } catch (error) {
            console.error('Error in PUT /investigations:', error);
            res.status(500).json({ error: error.message });
        }
    });
});

// Delete investigation
app.delete('/api/investigations/:id', (req, res) => {
    lockFile((err) => {
        if (err) {
            return res.status(503).json({ error: 'System busy, try again' });
        }
        
        try {
            const db = readDB();
            if (!db) {
                return res.status(500).json({ error: 'Database unavailable' });
            }
            
            const index = db.investigations.findIndex(i => i.id === parseInt(req.params.id));
            
            if (index === -1) {
                return res.status(404).json({ error: 'Investigation not found' });
            }
            
            db.investigations.splice(index, 1);
            
            if (writeDB(db)) {
                res.status(204).send();
            } else {
                res.status(500).json({ error: 'Failed to save to database' });
            }
        } catch (error) {
            console.error('Error in DELETE /investigations:', error);
            res.status(500).json({ error: error.message });
        }
    });
});

// Bulk upload investigations
app.post('/api/investigations/bulk', (req, res) => {
    lockFile((err) => {
        if (err) {
            return res.status(503).json({ error: 'System busy, try again' });
        }
        
        try {
            const db = readDB();
            if (!db) {
                return res.status(500).json({ error: 'Database unavailable' });
            }
            
            const timestamp = new Date().toLocaleString('en-CA', { 
                year: 'numeric', 
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false 
            }).replace(',', '');
            
            const nextId = db.investigations.length > 0 
                ? Math.max(...db.investigations.map(i => i.id)) + 1 
                : 1;
            
            const newInvestigations = req.body.map((item, index) => ({
                id: nextId + index,
                ...item,
                timestamp: timestamp,
                history: [
                    { 
                        action: 'Bulk Created', 
                        user: item.owner || item.team || 'System', 
                        timestamp: new Date().toISOString() 
                    }
                ]
            }));
            
            db.investigations.push(...newInvestigations);
            
            if (writeDB(db)) {
                res.status(201).json(newInvestigations);
            } else {
                res.status(500).json({ error: 'Failed to save to database' });
            }
        } catch (error) {
            console.error('Error in POST /investigations/bulk:', error);
            res.status(500).json({ error: error.message });
        }
    });
});

// Get statistics
app.get('/api/stats', (req, res) => {
    try {
        const db = readDB();
        if (!db) {
            return res.status(500).json({ error: 'Database unavailable' });
        }
        
        const investigations = db.investigations;
        
        const stats = {
            total: investigations.length,
            byTeam: {
                HRP: investigations.filter(i => i.team === 'HRP').length,
                Dispatch: investigations.filter(i => i.team === 'Dispatch').length,
                Claims: investigations.filter(i => i.team === 'Claims').length,
                CityFloor: investigations.filter(i => i.team === 'CityFloor').length,
                Returns: investigations.filter(i => i.team === 'Returns').length
            },
            byStatus: {
                New: investigations.filter(i => i.status === 'New').length,
                'In progress': investigations.filter(i => i.status === 'In progress').length,
                'Awaiting City': investigations.filter(i => i.status === 'Awaiting City').length,
                Resolved: investigations.filter(i => i.status === 'Resolved').length,
                'Claim raised': investigations.filter(i => i.status === 'Claim raised').length,
                Returned: investigations.filter(i => i.status === 'Returned').length
            },
            lastUpdated: db.metadata.lastUpdated,
            version: db.metadata.version
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Error in GET /stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get history for an investigation
app.get('/api/investigations/:id/history', (req, res) => {
    try {
        const db = readDB();
        if (!db) {
            return res.status(500).json({ error: 'Database unavailable' });
        }
        
        const investigation = db.investigations.find(i => i.id === parseInt(req.params.id));
        if (!investigation) {
            return res.status(404).json({ error: 'Investigation not found' });
        }
        res.json(investigation.history || []);
    } catch (error) {
        console.error('Error in GET /history:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all users
app.get('/api/users', (req, res) => {
    try {
        const db = readDB();
        if (!db) {
            return res.status(500).json({ error: 'Database unavailable' });
        }
        res.json(db.users);
    } catch (error) {
        console.error('Error in GET /users:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search investigations
app.get('/api/search', (req, res) => {
    try {
        const db = readDB();
        if (!db) {
            return res.status(500).json({ error: 'Database unavailable' });
        }
        
        const { q, team, status } = req.query;
        
        let results = db.investigations;
        
        if (q) {
            const query = q.toLowerCase();
            results = results.filter(i => 
                i.lpn.toLowerCase().includes(query) ||
                i.finding.toLowerCase().includes(query) ||
                i.owner.toLowerCase().includes(query) ||
                (i.wms && i.wms.toLowerCase().includes(query)) ||
                (i.city && i.city.toLowerCase().includes(query))
            );
        }
        
        if (team) {
            results = results.filter(i => i.team === team);
        }
        
        if (status) {
            results = results.filter(i => i.status === status);
        }
        
        res.json(results);
    } catch (error) {
        console.error('Error in GET /search:', error);
        res.status(500).json({ error: error.message });
    }
});

// Database backup endpoint
app.get('/api/backup', (req, res) => {
    try {
        const db = readDB();
        if (!db) {
            return res.status(500).json({ error: 'Database unavailable' });
        }
        
        const backup = {
            ...db,
            backupTimestamp: new Date().toISOString()
        };
        
        res.json(backup);
    } catch (error) {
        console.error('Error in GET /backup:', error);
        res.status(500).json({ error: error.message });
    }
});

// Root redirect
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ============= START SERVER =============
app.listen(PORT, () => {
    console.log(`🚀 LPN Investigation System deployed successfully`);
    console.log(`📡 Server running on port: ${PORT}`);
    console.log(`💾 Database path: ${DB_PATH}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Local URL: http://localhost:${PORT}`);
    console.log(`📊 API available at: http://localhost:${PORT}/api`);
});
