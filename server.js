const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
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

[DATA_DIR, BOTS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (!fs.existsSync(BOTS_FILE)) fs.writeFileSync(BOTS_FILE, JSON.stringify([], null, 2));

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

function cargarBots() { return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf-8')); }
function guardarBots(d) { fs.writeFileSync(BOTS_FILE, JSON.stringify(d, null, 2)); }
const procesos = {};

function iniciarBot(id) {
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot) return { error: 'Bot no encontrado' };
    if (procesos[id]) return { error: 'Ya está activo' };

    // ===== INSTALAR DEPENDENCIAS AUTOMÁTICAMENTE =====
    const packageJson = path.join(bot.carpeta, 'package.json');
    const nodeModules = path.join(bot.carpeta, 'node_modules');
    if (fs.existsSync(packageJson) && !fs.existsSync(nodeModules)) {
        io.emit('log', { botId: id, mensaje: '📦 Instalando dependencias...' });
        try {
            execSync('npm install --production', { cwd: bot.carpeta, stdio: 'pipe' });
            io.emit('log', { botId: id, mensaje: '✅ Dependencias instaladas' });
        } catch (e) {
            io.emit('log', { botId: id, mensaje: '❌ Error: ' + e.message });
            return { error: 'Error al instalar dependencias' };
        }
    }

    const posiblesScripts = ['index.js', 'bot.js', 'main.js', 'app.js', 'start.js'];
    let scriptPath = null;
    for (const s of posiblesScripts) {
        const fp = path.join(bot.carpeta, s);
        if (fs.existsSync(fp)) { scriptPath = fp; break; }
    }
    if (!scriptPath) {
        io.emit('log', { botId: id, mensaje: '❌ No se encontró index.js, bot.js, ni main.js' });
        return { error: 'No se encontró archivo principal' };
    }

    io.emit('log', { botId: id, mensaje: '▶ Iniciando: ' + path.basename(scriptPath) });
    try {
        const proc = spawn('node', [scriptPath], { cwd: bot.carpeta, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
        procesos[id] = proc;
        bot.estado = 'activo'; guardarBots(bots);
        proc.stdout.on('data', d => { const m = d.toString().trim(); if (m) io.emit('log', { botId: id, mensaje: m }); });
        proc.stderr.on('data', d => { const m = d.toString().trim(); if (m) io.emit('log', { botId: id, mensaje: '❌ ' + m }); });
        proc.on('close', code => {
            delete procesos[id];
            const ba = cargarBots(); const bt = ba.find(b => b.id === id);
            if (bt) { bt.estado = 'apagado'; guardarBots(ba); }
            io.emit('log', { botId: id, mensaje: '⏹ Bot detenido (código ' + code + ')' });
            io.emit('bot_estado', { id, estado: 'apagado' });
        });
        proc.on('error', err => {
            delete procesos[id];
            io.emit('log', { botId: id, mensaje: '❌ Error: ' + err.message });
            io.emit('bot_estado', { id, estado: 'apagado' });
        });
        io.emit('bot_estado', { id, estado: 'activo' });
        return { mensaje: 'Iniciado', estado: 'activo' };
    } catch (e) {
        return { error: e.message };
    }
}

app.get('/api/stats', (req, res) => {
    const bots = cargarBots();
    res.json({
        cpu: (os.loadavg()[0] * 100 / os.cpus().length).toFixed(1),
        ram: { used: os.totalmem() - os.freemem(), total: os.totalmem(), percent: ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(1) },
        botsTotal: bots.length, botsActivos: bots.filter(b => b.estado === 'activo').length, uptime: process.uptime()
    });
});

app.get('/api/bots', (req, res) => res.json(cargarBots()));

app.post('/api/bots', (req, res) => {
    const { nombre, repoUrl } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
    const id = uuidv4().substring(0, 8);
    const dir = path.join(BOTS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const nuevo = { id, nombre, repoUrl: repoUrl || '', estado: 'apagado', creado: new Date().toISOString(), carpeta: dir, logs: [] };
    const bots = cargarBots(); bots.push(nuevo); guardarBots(bots);
    if (repoUrl) {
        io.emit('log', { botId: id, mensaje: '📥 Clonando...' });
        simpleGit(dir).clone(repoUrl, dir).then(() => io.emit('log', { botId: id, mensaje: '✅ Repo clonado' })).catch(e => io.emit('log', { botId: id, mensaje: '❌ ' + e.message }));
    }
    io.emit('bot_creado', nuevo);
    res.json(nuevo);
});

app.post('/api/bots/:id/start', (req, res) => {
    const r = iniciarBot(req.params.id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
});

app.post('/api/bots/:id/stop', (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
    const bots = cargarBots(); const bot = bots.find(b => b.id === id);
    if (bot) { bot.estado = 'apagado'; guardarBots(bots); }
    io.emit('bot_estado', { id, estado: 'apagado' });
    res.json({ mensaje: 'Detenido' });
});

app.post('/api/bots/:id/restart', async (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; await new Promise(r => setTimeout(r, 1500)); }
    const r = iniciarBot(id);
    if (r.error) return res.status(400).json(r);
    res.json(r);
});

app.post('/api/bots/:id/reclone', async (req, res) => {
    const { id } = req.params;
    const bots = cargarBots(); const bot = bots.find(b => b.id === id);
    if (!bot || !bot.repoUrl) return res.status(400).json({ error: 'Sin repo' });
    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
    if (fs.existsSync(bot.carpeta)) fs.rmSync(bot.carpeta, { recursive: true, force: true });
    fs.mkdirSync(bot.carpeta, { recursive: true });
    try {
        await simpleGit(bot.carpeta).clone(bot.repoUrl, bot.carpeta);
        io.emit('log', { botId: id, mensaje: '✅ Reclonado' });
        res.json({ mensaje: 'Reclonado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bots/:id', (req, res) => {
    const { id } = req.params;
    if (procesos[id]) { procesos[id].kill('SIGTERM'); delete procesos[id]; }
    let bots = cargarBots(); const bot = bots.find(b => b.id === id);
    if (bot && fs.existsSync(bot.carpeta)) fs.rmSync(bot.carpeta, { recursive: true, force: true });
    guardarBots(bots.filter(b => b.id !== id));
    io.emit('bot_eliminado', id);
    res.json({ mensaje: 'Eliminado' });
});

app.get('/api/bots/:id/files', (req, res) => {
    const bot = cargarBots().find(b => b.id === req.params.id);
    if (!bot || !fs.existsSync(bot.carpeta)) return res.json([]);
    const files = fs.readdirSync(bot.carpeta).map(f => ({ nombre: f, tamano: fs.statSync(path.join(bot.carpeta, f)).size }));
    res.json(files);
});

app.post('/api/bots/:id/upload', upload.single('archivo'), (req, res) => res.json({ mensaje: 'Subido' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

io.on('connection', s => s.emit('bots_list', cargarBots()));

server.listen(PORT, '0.0.0.0', () => console.log('🤖 Panel en puerto ' + PORT));