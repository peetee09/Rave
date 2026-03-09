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
                finding     TEXT,
                wms         TEXT,
                city        TEXT,
                owner       VARCHAR(255),
                timestamp   VARCHAR(50),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
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
    id:        row.id,
    lpn:       row.lpn,
    team:      row.team,
    status:    row.status,
    finding:   row.finding,
    wms:       row.wms,
    city:      row.city,
    owner:     row.owner,
    timestamp: row.timestamp
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
        const id = parseInt(req.params.id, 10);
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
        const { lpn, team, status = 'New', finding, wms, city, owner } = req.body;
        const timestamp = getTimestamp();

        const { rows } = await pool.query(
            `INSERT INTO investigations (lpn, team, status, finding, wms, city, owner, timestamp)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [lpn, team, status, finding, wms, city, owner || team, timestamp]
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
        await client.query('BEGIN');

        const id = parseInt(req.params.id, 10);
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
                 finding   = COALESCE($4, finding),
                 wms       = COALESCE($5, wms),
                 city      = COALESCE($6, city),
                 owner     = COALESCE($7, owner),
                 timestamp = $8,
                 updated_at = NOW()
             WHERE id = $9
             RETURNING *`,
            [
                req.body.lpn    ?? null,
                req.body.team   ?? null,
                req.body.status   ?? null,
                req.body.finding  ?? null,
                req.body.wms    ?? null,
                req.body.city   ?? null,
                req.body.owner  ?? null,
                timestamp,
                id
            ]
        );

        if (req.body.action || req.body.finding) {
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
        const id = parseInt(req.params.id, 10);
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
        const timestamp = getTimestamp();
        const created = [];

        for (const item of items) {
            const { rows } = await client.query(
                `INSERT INTO investigations (lpn, team, status, finding, wms, city, owner, timestamp)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [
                    item.lpn,
                    item.team,
                    item.status || 'New',
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
        const id = parseInt(req.params.id, 10);

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
