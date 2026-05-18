const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const simpleGit = require('simple-git');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const BOTS_DIR = path.join(__dirname, 'bots');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

// Crear carpetas
[DATA_DIR, BOTS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (!fs.existsSync(BOTS_FILE)) fs.writeFileSync(BOTS_FILE, JSON.stringify([], null, 2));

// ===== FUNCIONES =====
function cargarBots() {
    return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf-8'));
}

function guardarBots(data) {
    fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
}

const procesos = {};

function iniciarBot(id) {
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot) return { error: 'Bot no encontrado' };
    if (procesos[id]) return { error: 'Ya está activo' };

    // Instalar dependencias automáticamente
    const packageJson = path.join(bot.carpeta, 'package.json');
    const nodeModules = path.join(bot.carpeta, 'node_modules');
    if (fs.existsSync(packageJson) && !fs.existsSync(nodeModules)) {
        try {
            execSync('npm install --production', { cwd: bot.carpeta, stdio: 'pipe' });
        } catch (e) {}
    }

    const posiblesScripts = ['index.js', 'bot.js', 'main.js', 'app.js', 'start.js'];
    let scriptPath = null;
    for (const s of posiblesScripts) {
        const fp = path.join(bot.carpeta, s);
        if (fs.existsSync(fp)) { scriptPath = fp; break; }
    }
    if (!scriptPath) {
        return { error: 'No se encontró archivo principal' };
    }

    try {
        const proc = spawn('node', [scriptPath], {
            cwd: bot.carpeta,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        procesos[id] = proc;
        bot.estado = 'activo';
        guardarBots(bots);

        proc.on('close', (code) => {
            delete procesos[id];
            const ba = cargarBots();
            const bt = ba.find(b => b.id === id);
            if (bt) { bt.estado = 'apagado'; guardarBots(ba); }
        });

        proc.on('error', (err) => {
            delete procesos[id];
        });

        return { mensaje: 'Iniciado', estado: 'activo' };
    } catch (e) {
        return { error: e.message };
    }
}

// ===== SERVIDOR HTTP PURO =====
const server = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const url = req.url;
    const method = req.method;

    // Ruta principal
    if (url === '/' && method === 'GET') {
        const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }

    // API Stats
    if (url === '/api/stats' && method === 'GET') {
        const bots = cargarBots();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            cpu: (os.loadavg()[0] * 100 / os.cpus().length).toFixed(1),
            ram: {
                used: os.totalmem() - os.freemem(),
                total: os.totalmem(),
                percent: ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(1)
            },
            botsTotal: bots.length,
            botsActivos: bots.filter(b => b.estado === 'activo').length,
            uptime: process.uptime()
        }));
        return;
    }

    // API Bots
    if (url === '/api/bots' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cargarBots()));
        return;
    }

    // Crear bot
    if (url === '/api/bots' && method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { nombre, repoUrl } = JSON.parse(body);
                if (!nombre) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Nombre requerido' }));
                    return;
                }
                const id = uuidv4().substring(0, 8);
                const dir = path.join(BOTS_DIR, id);
                fs.mkdirSync(dir, { recursive: true });
                const nuevo = { id, nombre, repoUrl: repoUrl || '', estado: 'apagado', creado: new Date().toISOString(), carpeta: dir, logs: [] };
                const bots = cargarBots(); bots.push(nuevo); guardarBots(bots);
                if (repoUrl) {
                    simpleGit(dir).clone(repoUrl, dir).catch(() => {});
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(nuevo));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Acciones de bots: /api/bots/:id/:action
    const botMatch = url.match(/^\/api\/bots\/([a-zA-Z0-9]+)\/(start|stop|restart|reclone|delete|files|upload|clearconsole)$/);
    if (botMatch) {
        const id = botMatch[1];
        const action = botMatch[2];

        if (action === 'start' && method === 'POST') {
            const r = iniciarBot(id);
            res.writeHead(r.error ? 400 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(r));
            return;
        }

        if (action === 'stop' && method === 'POST') {
            if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
            const bots = cargarBots(); const bot = bots.find(b => b.id === id);
            if (bot) { bot.estado = 'apagado'; guardarBots(bots); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mensaje: 'Detenido' }));
            return;
        }

        if (action === 'restart' && method === 'POST') {
            if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
            setTimeout(() => {
                iniciarBot(id);
            }, 1500);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mensaje: 'Reiniciando' }));
            return;
        }

        if (action === 'reclone' && method === 'POST') {
            const bots = cargarBots(); const bot = bots.find(b => b.id === id);
            if (bot && bot.repoUrl) {
                if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
                if (fs.existsSync(bot.carpeta)) fs.rmSync(bot.carpeta, { recursive: true, force: true });
                fs.mkdirSync(bot.carpeta, { recursive: true });
                simpleGit(bot.carpeta).clone(bot.repoUrl, bot.carpeta).catch(() => {});
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ mensaje: 'Reclonado' }));
            } else {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Sin repo' }));
            }
            return;
        }

        if (action === 'delete' && method === 'DELETE') {
            if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
            let bots = cargarBots(); const bot = bots.find(b => b.id === id);
            if (bot && fs.existsSync(bot.carpeta)) fs.rmSync(bot.carpeta, { recursive: true, force: true });
            guardarBots(bots.filter(b => b.id !== id));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mensaje: 'Eliminado' }));
            return;
        }

        if (action === 'files' && method === 'GET') {
            const bot = cargarBots().find(b => b.id === id);
            if (bot && fs.existsSync(bot.carpeta)) {
                const files = fs.readdirSync(bot.carpeta).map(f => ({
                    nombre: f,
                    tamano: fs.statSync(path.join(bot.carpeta, f)).size
                }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(files));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
            }
            return;
        }

        if (action === 'clearconsole' && method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mensaje: 'OK' }));
            return;
        }
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
});

// ===== INICIAR =====
server.listen(PORT, '0.0.0.0', () => {
    console.log('🤖 Saki Bots corriendo en puerto ' + PORT);
});