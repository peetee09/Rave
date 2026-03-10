const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============= DATABASE CONFIGURATION =============
// Railway managed PostgreSQL uses self-signed certificates; rejectUnauthorized
// is intentionally set to false for its TLS setup. Certificate pinning or
// a trusted CA bundle should be used if switching to a different provider.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false
});

const getTimestamp = () =>
    new Date().toLocaleString('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).replace(',', '');

// ============= VALIDATION HELPERS =============
const VALID_TEAMS      = new Set(['HRP', 'Dispatch', 'Claims', 'CityFloor', 'Returns']);
const VALID_STATUSES   = new Set(['New', 'In progress', 'Awaiting City', 'Resolved', 'Claim raised', 'Returned']);
const VALID_PRIORITIES = new Set(['Low', 'Medium', 'High', 'Critical']);

function validateInvestigation(body, { requireBase = true } = {}) {
    const errors = [];
    if (requireBase) {
        if (!body.lpn || !String(body.lpn).trim())
            errors.push('LPN is required');
        if (!body.team || !VALID_TEAMS.has(body.team))
            errors.push(`Team must be one of: ${[...VALID_TEAMS].join(', ')}`);
    }
    if (body.lpn   != null && String(body.lpn).length   > 255)
        errors.push('LPN must be 255 characters or fewer');
    if (body.team  != null && !VALID_TEAMS.has(body.team))
        errors.push(`Team must be one of: ${[...VALID_TEAMS].join(', ')}`);
    if (body.status   != null && !VALID_STATUSES.has(body.status))
        errors.push(`Status must be one of: ${[...VALID_STATUSES].join(', ')}`);
    if (body.priority != null && !VALID_PRIORITIES.has(body.priority))
        errors.push(`Priority must be one of: ${[...VALID_PRIORITIES].join(', ')}`);
    if (body.finding != null && String(body.finding).length > 1000)
        errors.push('Finding must be 1000 characters or fewer');
    if (body.wms  != null && String(body.wms).length  > 500)
        errors.push('WMS must be 500 characters or fewer');
    if (body.city != null && String(body.city).length > 500)
        errors.push('City acknowledgement must be 500 characters or fewer');
    if (body.owner != null && String(body.owner).length > 255)
        errors.push('Owner must be 255 characters or fewer');
    return errors;
}

// Returns a positive integer ID or null for invalid params
function parseId(param) {
    const n = parseInt(param, 10);
    return Number.isNaN(n) || n <= 0 ? null : n;
}

// Escape a value for safe CSV inclusion
function escapeCSV(val) {
    if (val == null) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r'))
        return `"${str.replace(/"/g, '""')}"`;
    return str;
}

// ============= SCHEMA INITIALIZATION =============
const initializeDatabase = async () => {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS investigations (
                id          SERIAL PRIMARY KEY,
                lpn         VARCHAR(255) NOT NULL,
                team        VARCHAR(100) NOT NULL,
                status      VARCHAR(100) NOT NULL DEFAULT 'New',
                priority    VARCHAR(20)  NOT NULL DEFAULT 'Medium',
                finding     TEXT,
                wms         TEXT,
                city        TEXT,
                owner       VARCHAR(255),
                timestamp   VARCHAR(50),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        // Migrate: add priority column to existing deployments
        await client.query(`
            ALTER TABLE investigations
            ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'Medium'
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS investigation_history (
                id                 SERIAL PRIMARY KEY,
                investigation_id   INTEGER NOT NULL
                                   REFERENCES investigations(id) ON DELETE CASCADE,
                action             TEXT NOT NULL,
                finding            TEXT,
                user_name          VARCHAR(255),
                timestamp          TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id    SERIAL PRIMARY KEY,
                name  VARCHAR(255) NOT NULL,
                team  VARCHAR(100) NOT NULL,
                role  VARCHAR(100) NOT NULL DEFAULT 'investigator'
            )
        `);

        const { rows } = await client.query('SELECT COUNT(*) FROM users');
        if (parseInt(rows[0].count, 10) === 0) {
            await client.query(`
                INSERT INTO users (name, team, role) VALUES
                ('HRP User',        'HRP',       'investigator'),
                ('Dispatch User',   'Dispatch',  'investigator'),
                ('Claims User',     'Claims',    'investigator'),
                ('City Floor User', 'CityFloor', 'investigator'),
                ('Returns User',    'Returns',   'investigator')
            `);
            console.log('✅ Users seeded');
        }

        // Performance indexes (safe to re-run)
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_team       ON investigations(team)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_status     ON investigations(status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_priority   ON investigations(priority)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_lpn        ON investigations(lpn)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_created_at ON investigations(created_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_inv_updated_at ON investigations(updated_at DESC)`);

        console.log('✅ Database schema ready');
    } finally {
        client.release();
    }
};

// ============= MIDDLEWARE =============
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

// ============= RATE LIMITING =============
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300,                  // max requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

// Apply to all /api routes
app.use('/api', apiLimiter);

// ============= HELPERS =============
const rowToInvestigation = (row) => ({
    id:         row.id,
    lpn:        row.lpn,
    team:       row.team,
    status:     row.status,
    priority:   row.priority   || 'Medium',
    finding:    row.finding,
    wms:        row.wms,
    city:       row.city,
    owner:      row.owner,
    timestamp:  row.timestamp,
    created_at: row.created_at,
    updated_at: row.updated_at
    // History is fetched via GET /api/investigations/:id/history
});

// ============= API ENDPOINTS =============

// Health check (critical for Railway)
app.get('/api/health', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT COUNT(*) FROM investigations');
        const count = parseInt(rows[0].count, 10);
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || 'development',
            database: `active (${count} records)`,
            version: '1.0.0'
        });
    } catch (error) {
        console.error('Health check error:', error);
        res.status(503).json({ status: 'error', error: error.message });
    }
});

// Get all investigations
app.get('/api/investigations', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM investigations ORDER BY id DESC'
        );
        res.json(rows.map(rowToInvestigation));
    } catch (error) {
        console.error('Error in GET /investigations:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single investigation by ID
app.get('/api/investigations/:id', async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid investigation ID' });

        const { rows } = await pool.query(
            'SELECT * FROM investigations WHERE id = $1',
            [id]
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'Investigation not found' });
        }
        res.json(rowToInvestigation(rows[0]));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create new investigation
app.post('/api/investigations', async (req, res) => {
    try {
        const errors = validateInvestigation(req.body, { requireBase: true });
        if (errors.length) return res.status(400).json({ errors });

        const {
            lpn,
            team,
            status   = 'New',
            priority = 'Medium',
            finding,
            wms,
            city,
            owner
        } = req.body;
        const timestamp = getTimestamp();

        const { rows } = await pool.query(
            `INSERT INTO investigations (lpn, team, status, priority, finding, wms, city, owner, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [lpn, team, status, priority, finding, wms, city, owner || team, timestamp]
        );

        const inv = rows[0];

        await pool.query(
            `INSERT INTO investigation_history (investigation_id, action, user_name)
             VALUES ($1, $2, $3)`,
            [inv.id, 'Created', owner || team || 'System']
        );

        res.status(201).json(rowToInvestigation(inv));
    } catch (error) {
        console.error('Error in POST /investigations:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update investigation
app.put('/api/investigations/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid investigation ID' });

        const errors = validateInvestigation(req.body, { requireBase: false });
        if (errors.length) return res.status(400).json({ errors });

        await client.query('BEGIN');

        const { rows: existing } = await client.query(
            'SELECT * FROM investigations WHERE id = $1',
            [id]
        );

        if (existing.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Investigation not found' });
        }

        const old = existing[0];
        const timestamp = getTimestamp();

        const { rows } = await client.query(
            `UPDATE investigations
             SET lpn       = COALESCE($1, lpn),
                 team      = COALESCE($2, team),
                 status    = COALESCE($3, status),
                 priority  = COALESCE($4, priority),
                 finding   = COALESCE($5, finding),
                 wms       = COALESCE($6, wms),
                 city      = COALESCE($7, city),
                 owner     = COALESCE($8, owner),
                 timestamp = $9,
                 updated_at = NOW()
             WHERE id = $10
             RETURNING *`,
            [
                req.body.lpn      ?? null,
                req.body.team     ?? null,
                req.body.status   ?? null,
                req.body.priority ?? null,
                req.body.finding  ?? null,
                req.body.wms      ?? null,
                req.body.city     ?? null,
                req.body.owner    ?? null,
                timestamp,
                id
            ]
        );

        if (req.body.action || req.body.finding || req.body.wms || req.body.city || req.body.owner || req.body.status || req.body.priority) {
            await client.query(
                `INSERT INTO investigation_history (investigation_id, action, finding, user_name)
                 VALUES ($1, $2, $3, $4)`,
                [
                    id,
                    req.body.action || 'Updated',
                    req.body.finding || null,
                    req.body.user || req.body.team || old.owner || 'System'
                ]
            );
        }

        await client.query('COMMIT');
        res.json(rowToInvestigation(rows[0]));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error in PUT /investigations:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Delete investigation
app.delete('/api/investigations/:id', async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid investigation ID' });

        const { rowCount } = await pool.query(
            'DELETE FROM investigations WHERE id = $1',
            [id]
        );

        if (rowCount === 0) {
            return res.status(404).json({ error: 'Investigation not found' });
        }

        res.status(204).send();
    } catch (error) {
        console.error('Error in DELETE /investigations:', error);
        res.status(500).json({ error: error.message });
    }
});

// Bulk upload investigations
app.post('/api/investigations/bulk', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const items = Array.isArray(req.body) ? req.body : [];
        if (items.length === 0) {
            return res.status(400).json({ error: 'Request body must be a non-empty array' });
        }

        const timestamp = getTimestamp();
        const created = [];

        for (const item of items) {
            const errors = validateInvestigation(item, { requireBase: true });
            if (errors.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `Row validation failed: ${errors.join('; ')}`, item });
            }

            const { rows } = await client.query(
                `INSERT INTO investigations (lpn, team, status, priority, finding, wms, city, owner, timestamp)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING *`,
                [
                    item.lpn,
                    item.team,
                    item.status   || 'New',
                    item.priority || 'Medium',
                    item.finding,
                    item.wms,
                    item.city,
                    item.owner || item.team,
                    timestamp
                ]
            );

            const inv = rows[0];

            await client.query(
                `INSERT INTO investigation_history (investigation_id, action, user_name)
                 VALUES ($1, $2, $3)`,
                [inv.id, 'Bulk Created', item.owner || item.team || 'System']
            );

            created.push(rowToInvestigation(inv));
        }

        await client.query('COMMIT');
        res.status(201).json(created);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error in POST /investigations/bulk:', error);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
                COUNT(*)                                                        AS total,
                COUNT(*) FILTER (WHERE team = 'HRP')                           AS hrp,
                COUNT(*) FILTER (WHERE team = 'Dispatch')                      AS dispatch,
                COUNT(*) FILTER (WHERE team = 'Claims')                        AS claims,
                COUNT(*) FILTER (WHERE team = 'CityFloor')                     AS cityfloor,
                COUNT(*) FILTER (WHERE team = 'Returns')                       AS returns,
                COUNT(*) FILTER (WHERE status = 'New')                         AS new,
                COUNT(*) FILTER (WHERE status = 'In progress')                 AS inprogress,
                COUNT(*) FILTER (WHERE status = 'Awaiting City')               AS awaitingcity,
                COUNT(*) FILTER (WHERE status = 'Resolved')                    AS resolved,
                COUNT(*) FILTER (WHERE status = 'Claim raised')                AS claimraised,
                COUNT(*) FILTER (WHERE status = 'Returned')                    AS returned,
                COUNT(*) FILTER (
                    WHERE status NOT IN ('Resolved', 'Returned')
                )                                                               AS unresolved,
                COUNT(*) FILTER (
                    WHERE status NOT IN ('Resolved', 'Returned')
                      AND created_at < NOW() - INTERVAL '36 hours'
                )                                                               AS overdue,
                MAX(updated_at)                                                 AS last_updated
            FROM investigations
        `);

        const r = rows[0];
        res.json({
            total: parseInt(r.total, 10),
            byTeam: {
                HRP:       parseInt(r.hrp, 10),
                Dispatch:  parseInt(r.dispatch, 10),
                Claims:    parseInt(r.claims, 10),
                CityFloor: parseInt(r.cityfloor, 10),
                Returns:   parseInt(r.returns, 10)
            },
            byStatus: {
                New:             parseInt(r.new, 10),
                'In progress':   parseInt(r.inprogress, 10),
                'Awaiting City': parseInt(r.awaitingcity, 10),
                Resolved:        parseInt(r.resolved, 10),
                'Claim raised':  parseInt(r.claimraised, 10),
                Returned:        parseInt(r.returned, 10)
            },
            unresolved:  parseInt(r.unresolved, 10),
            overdue:     parseInt(r.overdue, 10),
            lastUpdated: r.last_updated || new Date().toISOString(),
            version: '1.0.0'
        });
    } catch (error) {
        console.error('Error in GET /stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get history for an investigation
app.get('/api/investigations/:id/history', async (req, res) => {
    try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid investigation ID' });

        const { rowCount } = await pool.query(
            'SELECT 1 FROM investigations WHERE id = $1',
            [id]
        );
        if (rowCount === 0) {
            return res.status(404).json({ error: 'Investigation not found' });
        }

        const { rows } = await pool.query(
            `SELECT action, finding, user_name AS "user", timestamp
             FROM investigation_history
             WHERE investigation_id = $1
             ORDER BY timestamp ASC`,
            [id]
        );

        res.json(rows);
    } catch (error) {
        console.error('Error in GET /history:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get all users
app.get('/api/users', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
        res.json(rows);
    } catch (error) {
        console.error('Error in GET /users:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search investigations
app.get('/api/search', async (req, res) => {
    try {
        const { q, team, status } = req.query;

        let query = 'SELECT * FROM investigations WHERE TRUE';
        const params = [];

        if (q) {
            params.push(`%${q}%`);
            const idx = params.length;
            query += ` AND (
                lpn     ILIKE $${idx} OR
                finding ILIKE $${idx} OR
                owner   ILIKE $${idx} OR
                wms     ILIKE $${idx} OR
                city    ILIKE $${idx}
            )`;
        }

        if (team) {
            params.push(team);
            query += ` AND team = $${params.length}`;
        }

        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }

        query += ' ORDER BY id DESC';

        const { rows } = await pool.query(query, params);
        res.json(rows.map(rowToInvestigation));
    } catch (error) {
        console.error('Error in GET /search:', error);
        res.status(500).json({ error: error.message });
    }
});

// CSV export (respects same filters as search)
app.get('/api/export', async (req, res) => {
    try {
        const { q, team, status, priority } = req.query;

        let query = 'SELECT * FROM investigations WHERE TRUE';
        const params = [];

        if (q) {
            params.push(`%${q}%`);
            const idx = params.length;
            query += ` AND (
                lpn     ILIKE $${idx} OR
                finding ILIKE $${idx} OR
                owner   ILIKE $${idx} OR
                wms     ILIKE $${idx} OR
                city    ILIKE $${idx}
            )`;
        }
        if (team) {
            params.push(team);
            query += ` AND team = $${params.length}`;
        }
        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }
        if (priority) {
            params.push(priority);
            query += ` AND priority = $${params.length}`;
        }

        query += ' ORDER BY id';

        const { rows } = await pool.query(query, params);

        const CSV_HEADERS = ['ID', 'LPN', 'Team', 'Priority', 'Status', 'Finding', 'WMS', 'City Ack', 'Owner', 'Timestamp', 'Created At', 'Updated At'];
        const csvRows = [
            CSV_HEADERS.join(','),
            ...rows.map(r => [
                r.id, r.lpn, r.team, r.priority, r.status,
                r.finding, r.wms, r.city, r.owner,
                r.timestamp, r.created_at, r.updated_at
            ].map(escapeCSV).join(','))
        ];

        const filename = `investigations-${new Date().toISOString().split('T')[0]}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvRows.join('\r\n'));
    } catch (error) {
        console.error('Error in GET /export:', error);
        res.status(500).json({ error: error.message });
    }
});

// Database backup endpoint
app.get('/api/backup', async (req, res) => {
    try {
        const [invResult, usersResult] = await Promise.all([
            pool.query('SELECT * FROM investigations ORDER BY id'),
            pool.query('SELECT * FROM users ORDER BY id')
        ]);

        res.json({
            investigations: invResult.rows.map(rowToInvestigation),
            users: usersResult.rows,
            metadata: {
                lastUpdated: new Date().toISOString(),
                version: '1.0.0',
                environment: process.env.NODE_ENV || 'development'
            },
            backupTimestamp: new Date().toISOString()
        });
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
initializeDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`🚀 LPN Investigation System deployed successfully`);
            console.log(`📡 Server running on port: ${PORT}`);
            console.log(`🗄️  Database: PostgreSQL (Railway managed)`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🔗 Local URL: http://localhost:${PORT}`);
            console.log(`📊 API available at: http://localhost:${PORT}/api`);
        });
    })
    .catch((err) => {
        console.error('❌ Failed to initialize database:', err);
        process.exit(1);
    });
