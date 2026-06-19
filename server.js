const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// MENYURUH NODE.JS MENAMPILKAN INDEX.HTML DARI FOLDER PUBLIC
app.use(express.static(path.join(__dirname, 'public')));

// KONEKSI DATABASE (Lebih aman dan standar produksi)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Wajib untuk Supabase
    }
});

// Tes koneksi agar Anda tahu apakah sudah berhasil atau belum di log Railway
pool.connect((err, client, done) => {
    if (err) {
        console.error('Gagal terhubung ke database:', err.stack);
    } else {
        console.log('Berhasil terhubung ke Supabase!');
    }
    done();
});

// OTOMATIS BUAT TABEL USERS (Jika Belum Ada)
pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL
    );
`).then(() => console.log("Tabel users siap.")).catch(console.error);

// Session Memori untuk User Online
const activeUsers = new Map();

setInterval(() => {
    const now = Date.now();
    for (let [user, data] of activeUsers.entries()) {
        if (now - data.lastSeen > 15000) activeUsers.delete(user);
    }
}, 5000);

// --- ENDPOINT AUTENTIKASI ---
app.post('/api/login', async (req, res) => {
    const { username, password, type } = req.body;
    try {
        if (type === 'admin') {
            if (username === 'rangga123' && password === '2005') {
                activeUsers.set(username, { role: 'admin', lastSeen: Date.now() });
                return res.json({ status: 'Success', data: { username: username, role: 'admin' } });
            } else {
                return res.status(401).json({ error: 'Kredensial Admin Salah!' });
            }
        } else {
            if (username === 'rangga123') return res.status(403).json({ error: 'Username ini khusus Admin!' });

            const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            
            if (result.rows.length > 0) {
                if (result.rows[0].password !== password) {
                    return res.status(401).json({ error: 'Password salah untuk user ini!' });
                }
            } else {
                await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, password, 'user']);
            }
            
            activeUsers.set(username, { role: 'user', lastSeen: Date.now() });
            return res.json({ status: 'Success', data: { username: username, role: 'user' } });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/heartbeat', (req, res) => {
    const { username, role } = req.body;
    if (username) activeUsers.set(username, { role: role, lastSeen: Date.now() });
    res.json({ status: 'OK' });
});

app.get('/api/online-users', (req, res) => {
    const users = Array.from(activeUsers.keys()).map(u => ({ username: u, role: activeUsers.get(u).role }));
    res.json({ status: 'Success', data: users });
});

// --- ENDPOINT DATA SPASIAL ---
app.post('/api/save-feature', async (req, res) => {
    const { tabel, geometry, attr } = req.body;
    try {
        let query, values;
        if (tabel === 'jalan') {
            query = `INSERT INTO jalan (id_jalan, nama_jalan, geom) VALUES ($1, $2, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))) RETURNING id_jalan as id`;
            values = [attr.id, attr.nama_jalan, JSON.stringify(geometry)];
        } else if (tabel === 'landuse') {
            query = `INSERT INTO landuse (id_landuse, penggunaan, geom) VALUES ($1, $2, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))) RETURNING id_landuse as id`;
            values = [attr.id, attr.penggunaan, JSON.stringify(geometry)];
        } else if (tabel === 'wilayah') {
            query = `INSERT INTO wilayah (id_wilayah, nama_kabupaten, nama_bupati, geom) VALUES ($1, $2, $3, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))) RETURNING id_wilayah as id`;
            values = [attr.id, attr.nama_kabupaten, attr.nama_bupati, JSON.stringify(geometry)];
        } else if (tabel === 'tower') {
            query = `INSERT INTO tower (id_tower, id_provider, geom) VALUES ($1, $2, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))) RETURNING id_tower as id`;
            values = [attr.id, attr.id_provider, JSON.stringify(geometry)];
        } else if (['shp_titik', 'shp_garis', 'shp_poligon'].includes(tabel)) {
            query = `INSERT INTO ${tabel} (nama_layer, pengupload, geom) VALUES ($1, 'Admin', ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))) RETURNING id`;
            values = [attr.nama_layer, JSON.stringify(geometry)];
        } else {
            return res.status(400).json({ error: "Tabel tidak didukung" });
        }
        const result = await pool.query(query, values);
        res.json({ status: 'Success', id: result.rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/save-shp', async (req, res) => {
    const { nama_layer, pengupload, features, geom_type } = req.body;
    const client = await pool.connect();
    
    try {
        let successCount = 0;
        await client.query('BEGIN');
        
        for (let f of features) {
            if (!f.geometry) continue;
            let geomType = f.geometry.type || '';
            let targetTabel = '';

            if (geom_type && geom_type !== 'auto') {
                if (geom_type === 'Polygon' && (geomType.includes('Polygon') || geomType.includes('MultiPolygon'))) targetTabel = 'shp_poligon';
                else if (geom_type === 'LineString' && (geomType.includes('LineString') || geomType.includes('MultiLineString') || geomType === 'LineString')) targetTabel = 'shp_garis';
                else if (geom_type === 'Point' && (geomType.includes('Point') || geomType.includes('MultiPoint'))) targetTabel = 'shp_titik';
            } else {
                if (geomType.includes('Polygon') || geomType.includes('MultiPolygon')) targetTabel = 'shp_poligon';
                else if (geomType.includes('LineString') || geomType.includes('MultiLineString') || geomType === 'LineString') targetTabel = 'shp_garis';
                else if (geomType.includes('Point') || geomType.includes('MultiPoint')) targetTabel = 'shp_titik';
            }
            
            if (targetTabel === '') continue;
            
            let query = `INSERT INTO ${targetTabel} (nama_layer, pengupload, properties, geom) VALUES ($1, $2, $3, ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)))`;
            await client.query(query, [nama_layer, pengupload, JSON.stringify(f.properties || {}), JSON.stringify(f.geometry)]);
            successCount++;
        }
        
        if (successCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: "Tipe geometri tidak sesuai." });
        }
        
        await client.query('COMMIT');
        res.json({ status: 'Success', message: `${successCount} fitur disimpan` });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/run-query', async (req, res) => {
    try {
        const queryText = req.body.query;
        if (queryText.toUpperCase().includes('DROP') || queryText.toUpperCase().includes('TRUNCATE') || queryText.toUpperCase().includes('ALTER')) {
            return res.status(403).json({ error: 'Aksi terlarang!' });
        }
        const result = await pool.query(queryText);
        res.json({ status: 'Success', data: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/delete-feature', async (req, res) => {
    const { tabel, id } = req.body;
    try {
        const pkKolom = tabel.startsWith('shp_') ? 'id' : 'id_' + tabel;
        await pool.query(`DELETE FROM ${tabel} WHERE ${pkKolom} = $1`, [id]);
        res.json({ status: 'Success', message: `Data dihapus` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- FITUR FILTER & EXPORT ---
const validCols = ['nama_layer', 'nama_jalan', 'penggunaan', 'nama_kabupaten', 'id_provider'];

function buildWhereClause(reqQuery) {
    const { col, val } = reqQuery;
    if (col && validCols.includes(col) && val && val !== 'ALL') {
        return { clause: `WHERE ${col} = $1`, params: [val] };
    }
    return { clause: '', params: [] };
}

app.get('/api/export-excel/:tabel', async (req, res) => {
    const { tabel } = req.params;
    const tabelValid = ['jalan', 'landuse', 'tower', 'wilayah', 'shp_titik', 'shp_garis', 'shp_poligon', 'users'];
    if (!tabelValid.includes(tabel)) return res.status(400).send('Tabel tidak valid');

    try {
        const { clause, params } = buildWhereClause(req.query);
        let query = `SELECT * FROM ${tabel} ${clause}`;
        if (tabel !== 'users') query = `SELECT *, ST_AsText(geom) as koordinat_wkt FROM ${tabel} ${clause}`;

        const result = await pool.query(query, params);
        if (result.rows.length === 0) return res.status(404).send('Tidak ada data untuk diexport pada pilihan tersebut.');

        const formattedData = result.rows.map(row => {
            let newRow = { ...row };
            delete newRow.geom;
            if (newRow.properties) {
                try {
                    let props = typeof newRow.properties === 'string' ? JSON.parse(newRow.properties) : newRow.properties;
                    for (let key in props) newRow[`attr_${key}`] = props[key];
                } catch (e) {}
                delete newRow.properties;
            }
            return newRow;
        });

        const worksheet = xlsx.utils.json_to_sheet(formattedData);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Data_Export");

        const excelBuffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        const namaFile = req.query.val && req.query.val !== 'ALL' ? `${req.query.val}.xlsx` : `${tabel}_export.xlsx`;

        res.setHeader('Content-Disposition', `attachment; filename="${namaFile}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(excelBuffer);
    } catch (err) {
        res.status(500).send("Gagal mengekspor ke Excel: " + err.message);
    }
});

app.get('/api/export-geojson/:tabel', async (req, res) => {
    const { tabel } = req.params;
    const tabelValid = ['jalan', 'landuse', 'tower', 'wilayah', 'shp_titik', 'shp_garis', 'shp_poligon'];
    if (!tabelValid.includes(tabel)) return res.status(400).send('Tabel tidak valid');

    try {
        const { clause, params } = buildWhereClause(req.query);
        const query = `
            SELECT jsonb_build_object('type', 'FeatureCollection', 'features', COALESCE(jsonb_agg(features.feature), '[]'::jsonb)) as geojson
            FROM (
                SELECT jsonb_build_object('type', 'Feature', 'geometry', ST_AsGeoJSON(geom)::jsonb, 'properties', to_jsonb(inputs) - 'geom') as feature 
                FROM ${tabel} inputs ${clause}
            ) features;
        `;
        const result = await pool.query(query, params);
        const namaFile = req.query.val && req.query.val !== 'ALL' ? `${req.query.val}.json` : `${tabel}_export.json`;
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${namaFile}"`);
        res.send(result.rows[0].geojson);
    } catch (err) {
        res.status(500).send("Gagal mengekspor data: " + err.message);
    }
});

app.get('/api/export-kml/:tabel', async (req, res) => {
    const { tabel } = req.params;
    const tabelValid = ['jalan', 'landuse', 'tower', 'wilayah', 'shp_titik', 'shp_garis', 'shp_poligon'];
    
    if (!tabelValid.includes(tabel)) return res.status(400).send('Tabel tidak valid');

    try {
        const { clause, params } = buildWhereClause(req.query);
        
        const query = `
            SELECT
                '<?xml version="1.0" encoding="UTF-8"?>
                <kml xmlns="http://www.opengis.net/kml/2.2">
                <Document><name>${tabel}</name>' ||
                COALESCE(string_agg(
                    '<Placemark>' ||
                    '<name>' || COALESCE((to_jsonb(inputs)->>'nama_layer'), (to_jsonb(inputs)->>'nama_jalan'), 'Feature') || '</name>' ||
                    '<description><![CDATA[' ||
                        (SELECT string_agg(key || ': ' || value, '<br/>')
                         FROM jsonb_each_text(to_jsonb(inputs) - 'geom')) ||
                    ']]></description>' ||
                    ST_AsKML(geom) ||
                    '</Placemark>'
                , ''), '') ||
                '</Document></kml>' AS kml_data
            FROM ${tabel} inputs ${clause};
        `;

        const result = await pool.query(query, params);
        const namaFile = req.query.val && req.query.val !== 'ALL' ? `${req.query.val}.kml` : `${tabel}_export.kml`;

        res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml');
        res.setHeader('Content-Disposition', `attachment; filename="${namaFile}"`);
        res.send(result.rows[0].kml_data);
    } catch (err) {
        console.error(err);
        res.status(500).send("Gagal mengekspor data: " + err.message);
    }
});

// PORT DINAMIS UNTUK CLOUD
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server WebGIS berjalan di port ${PORT}`));
