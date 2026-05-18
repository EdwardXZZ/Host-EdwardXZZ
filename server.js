const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const simpleGit = require('simple-git');
const multer = require('multer');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const BOTS_DIR = path.join(__dirname, 'bots');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

// Crear carpetas
[DATA_DIR, BOTS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (!fs.existsSync(BOTS_FILE)) fs.writeFileSync(BOTS_FILE, JSON.stringify([], null, 2));

// Configurar multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const botId = req.params.id;
        const uploadDir = path.join(BOTS_DIR, botId, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/bots', express.static(BOTS_DIR));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== FUNCIONES =====
function cargarBots() {
    return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf-8'));
}

function guardarBots(data) {
    fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
}

function agregarLog(botId, tipo, mensaje) {
    const bots = cargarBots();
    const bot = bots.find(b => b.id === botId);
    if (bot) {
        bot.logs = bot.logs || [];
        bot.logs.push({ fecha: new Date().toISOString(), tipo, mensaje });
        if (bot.logs.length > 500) bot.logs = bot.logs.slice(-500);
        guardarBots(bots);
    }
}

const procesos = {};

// ===== API =====

// Stats del sistema
app.get('/api/stats', (req, res) => {
    const cpu = (os.loadavg()[0] * 100 / os.cpus().length).toFixed(1);
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const bots = cargarBots();
    res.json({
        cpu: parseFloat(cpu),
        ram: { total: totalMem, used: usedMem, percent: ((usedMem / totalMem) * 100).toFixed(1) },
        botsTotal: bots.length,
        botsActivos: bots.filter(b => b.estado === 'activo').length,
        uptime: process.uptime()
    });
});

// Listar bots
app.get('/api/bots', (req, res) => res.json(cargarBots()));

// Crear bot
app.post('/api/bots', (req, res) => {
    const { nombre, repoUrl } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

    const id = uuidv4().substring(0, 8);
    const botDir = path.join(BOTS_DIR, id);
    fs.mkdirSync(botDir, { recursive: true });

    const nuevo = {
        id, nombre, repoUrl: repoUrl || '', estado: 'apagado',
        creado: new Date().toISOString(), carpeta: botDir, logs: []
    };

    const bots = cargarBots();
    bots.push(nuevo);
    guardarBots(bots);

    if (repoUrl) {
        simpleGit(botDir).clone(repoUrl, botDir).then(() => {
            agregarLog(id, 'info', '✅ Repo clonado');
            io.emit('log', { botId: id, tipo: 'success', mensaje: '✅ Repo clonado' });
        }).catch(err => {
            agregarLog(id, 'error', '❌ Error: ' + err.message);
        });
    }

    io.emit('bot_creado', nuevo);
    res.json(nuevo);
});

// Iniciar bot
app.post('/api/bots/:id/start', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot) return res.status(404).json({ error: 'No encontrado' });
    if (procesos[id]) return res.json({ mensaje: 'Ya activo' });

    const scriptPath = path.join(bot.carpeta, 'bot.js') || path.join(bot.carpeta, 'index.js');
    if (!fs.existsSync(scriptPath)) return res.status(400).json({ error: 'No se encontró bot.js o index.js' });

    try {
        const proc = spawn('node', [scriptPath], { cwd: bot.carpeta, stdio: ['pipe', 'pipe', 'pipe'] });
        procesos[id] = proc;
        bot.estado = 'activo';
        guardarBots(bots);

        proc.stdout.on('data', d => {
            const msg = d.toString().trim();
            io.emit('log', { botId: id, tipo: 'log', mensaje: msg });
            agregarLog(id, 'log', msg);
        });
        proc.stderr.on('data', d => {
            io.emit('log', { botId: id, tipo: 'error', mensaje: d.toString() });
        });
        proc.on('close', () => {
            delete procesos[id];
            bot.estado = 'apagado';
            guardarBots(bots);
            io.emit('bot_estado', { id, estado: 'apagado' });
        });

        io.emit('bot_estado', { id, estado: 'activo' });
        res.json({ mensaje: 'Iniciado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Detener bot
app.post('/api/bots/:id/stop', (req, res) => {
    const { id } = req.params;
    if (procesos[id]) {
        procesos[id].kill('SIGTERM');
        delete procesos[id];
        const bots = cargarBots();
        const bot = bots.find(b => b.id === id);
        if (bot) { bot.estado = 'apagado'; guardarBots(bots); }
        io.emit('bot_estado', { id, estado: 'apagado' });
    }
    res.json({ mensaje: 'Detenido' });
});

// Reiniciar bot
app.post('/api/bots/:id/restart', async (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; await new Promise(r => setTimeout(r, 1500)); }
    fetch(`http://localhost:${PORT}/api/bots/${id}/start`, { method: 'POST' });
    res.json({ mensaje: 'Reiniciado' });
});

// Reclonar repo
app.post('/api/bots/:id/reclone', async (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot) return res.status(404).json({ error: 'No encontrado' });
    if (!bot.repoUrl) return res.status(400).json({ error: 'No hay URL de repo' });

    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
    fs.rmSync(bot.carpeta, { recursive: true, force: true });
    fs.mkdirSync(bot.carpeta, { recursive: true });

    try {
        await simpleGit(bot.carpeta).clone(bot.repoUrl, bot.carpeta);
        agregarLog(id, 'info', '✅ Repo reclonado');
        io.emit('log', { botId: id, tipo: 'success', mensaje: '✅ Repo reclonado' });
        res.json({ mensaje: 'Reclonado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminar bot
app.delete('/api/bots/:id', (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (bot && fs.existsSync(bot.carpeta)) fs.rmSync(bot.carpeta, { recursive: true, force: true });
    guardarBots(bots.filter(b => b.id !== id));
    io.emit('bot_eliminado', id);
    res.json({ mensaje: 'Eliminado' });
});

// Listar archivos del bot
app.get('/api/bots/:id/files', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot || !fs.existsSync(bot.carpeta)) return res.json([]);

    function listar(dir, base = '') {
        let results = [];
        const items = fs.readdirSync(dir);
        items.forEach(item => {
            const full = path.join(dir, item);
            const rel = path.join(base, item);
            if (fs.statSync(full).isDirectory()) results = results.concat(listar(full, rel));
            else results.push({ nombre: rel, tamano: fs.statSync(full).size });
        });
        return results;
    }
    res.json(listar(bot.carpeta));
});

// Subir archivo
app.post('/api/bots/:id/upload', upload.single('archivo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió' });
    res.json({ mensaje: 'Subido', nombre: req.file.originalname });
});

// Limpiar consola
app.post('/api/bots/:id/clearconsole', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (bot) { bot.logs = []; guardarBots(bots); }
    io.emit('console_cleared', id);
    res.json({ mensaje: 'Consola limpiada' });
});

// Ruta principal
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== WEBSOCKET =====
io.on('connection', socket => {
    console.log('🟢 Conectado');
    socket.emit('bots_list', cargarBots());
});

// ===== INICIAR =====
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🤖 Saki Bots corriendo en puerto ${PORT}`);
    console.log(`🧠 RAM: 1 GB | Bots: ilimitado`);
});
