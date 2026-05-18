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

// Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(BOTS_DIR, req.params.id, 'uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Funciones
function cargarBots() { return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf-8')); }
function guardarBots(d) { fs.writeFileSync(BOTS_FILE, JSON.stringify(d, null, 2)); }
const procesos = {};

// Stats
app.get('/api/stats', (req, res) => {
    const bots = cargarBots();
    res.json({
        cpu: (os.loadavg()[0] * 100 / os.cpus().length).toFixed(1),
        ram: { used: os.totalmem() - os.freemem(), total: os.totalmem() },
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
    const dir = path.join(BOTS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const nuevo = { id, nombre, repoUrl: repoUrl || '', estado: 'apagado', creado: new Date().toISOString(), carpeta: dir, logs: [] };
    const bots = cargarBots(); bots.push(nuevo); guardarBots(bots);
    if (repoUrl) {
        simpleGit(dir).clone(repoUrl, dir).catch(() => {});
    }
    io.emit('bot_creado', nuevo);
    res.json(nuevo);
});

// Iniciar
app.post('/api/bots/:id/start', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot) return res.status(404).json({ error: 'No encontrado' });
    if (procesos[id]) return res.json({ mensaje: 'Ya activo' });
    const script = path.join(bot.carpeta, 'index.js');
    if (!fs.existsSync(script)) return res.status(400).json({ error: 'No tiene index.js' });
    const proc = spawn('node', [script], { cwd: bot.carpeta });
    procesos[id] = proc;
    bot.estado = 'activo'; guardarBots(bots);
    proc.stdout.on('data', d => io.emit('log', { botId: id, mensaje: d.toString() }));
    proc.on('close', () => { delete procesos[id]; bot.estado = 'apagado'; guardarBots(bots); io.emit('bot_estado', { id, estado: 'apagado' }); });
    io.emit('bot_estado', { id, estado: 'activo' });
    res.json({ mensaje: 'Iniciado' });
});

// Detener
app.post('/api/bots/:id/stop', (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill(); delete procesos[id]; }
    const bots = cargarBots(); const bot = bots.find(b => b.id === id);
    if (bot) { bot.estado = 'apagado'; guardarBots(bots); }
    io.emit('bot_estado', { id, estado: 'apagado' });
    res.json({ mensaje: 'Detenido' });
});

// Reiniciar
app.post('/api/bots/:id/restart', async (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill(); delete procesos[id]; await new Promise(r => setTimeout(r, 1000)); }
    fetch(`http://localhost:${PORT}/api/bots/${id}/start`, { method: 'POST' });
    res.json({ mensaje: 'Reiniciado' });
});

// Reclonar
app.post('/api/bots/:id/reclone', async (req, res) => {
    const { id } = req.params;
    const bots = cargarBots(); const bot = bots.find(b => b.id === id);
    if (!bot || !bot.repoUrl) return res.status(400).json({ error: 'Sin repo' });
    if (procesos[id]) { procesos[id].kill(); delete procesos[id]; }
    fs.rmSync(bot.carpeta, { recursive: true, force: true });
    fs.mkdirSync(bot.carpeta, { recursive: true });
    await simpleGit(bot.carpeta).clone(bot.repoUrl, bot.carpeta);
    res.json({ mensaje: 'Reclonado' });
});

// Eliminar
app.delete('/api/bots/:id', (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill(); delete procesos[id]; }
    const bots = cargarBots(); const bot = bots.find(b => b.id === id);
    if (bot && fs.existsSync(bot.carpeta)) fs.rmSync(bot.carpeta, { recursive: true, force: true });
    guardarBots(bots.filter(b => b.id !== id));
    io.emit('bot_eliminado', id);
    res.json({ mensaje: 'Eliminado' });
});

// Archivos
app.get('/api/bots/:id/files', (req, res) => {
    const bot = cargarBots().find(b => b.id === req.params.id);
    if (!bot || !fs.existsSync(bot.carpeta)) return res.json([]);
    const files = fs.readdirSync(bot.carpeta).map(f => ({ nombre: f, tamano: fs.statSync(path.join(bot.carpeta, f)).size }));
    res.json(files);
});

app.post('/api/bots/:id/upload', upload.single('archivo'), (req, res) => {
    res.json({ mensaje: 'Subido' });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', s => s.emit('bots_list', cargarBots()));

server.listen(PORT, '0.0.0.0', () => console.log(`🤖 Panel en puerto ${PORT}`));
