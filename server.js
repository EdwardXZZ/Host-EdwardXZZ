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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== FUNCIONES =====
function cargarBots() {
    return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf-8'));
}

function guardarBots(data) {
    fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
}

const procesos = {};

// ===== FUNCIÓN INTERNA PARA INICIAR BOT =====
function iniciarBot(id) {
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (!bot) return { error: 'Bot no encontrado' };
    if (procesos[id]) return { error: 'Ya está activo' };

    const posiblesScripts = ['index.js', 'bot.js', 'main.js', 'app.js', 'start.js'];
    let scriptPath = null;

    for (const script of posiblesScripts) {
        const fullPath = path.join(bot.carpeta, script);
        if (fs.existsSync(fullPath)) {
            scriptPath = fullPath;
            break;
        }
    }

    if (!scriptPath) {
        io.emit('log', { botId: id, mensaje: '❌ No se encontró archivo principal (index.js, bot.js, main.js)' });
        return { error: 'No se encontró archivo principal' };
    }

    io.emit('log', { botId: id, mensaje: '▶ Iniciando: ' + path.basename(scriptPath) });

    try {
        const proc = spawn('node', [scriptPath], {
            cwd: bot.carpeta,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        procesos[id] = proc;
        bot.estado = 'activo';
        guardarBots(bots);

        proc.stdout.on('data', (data) => {
            const mensaje = data.toString().trim();
            if (mensaje) io.emit('log', { botId: id, mensaje: mensaje });
        });

        proc.stderr.on('data', (data) => {
            const mensaje = data.toString().trim();
            if (mensaje) io.emit('log', { botId: id, mensaje: '❌ ' + mensaje });
        });

        proc.on('close', (code) => {
            delete procesos[id];
            const botsActuales = cargarBots();
            const botActual = botsActuales.find(b => b.id === id);
            if (botActual) {
                botActual.estado = 'apagado';
                guardarBots(botsActuales);
            }
            io.emit('log', { botId: id, mensaje: '⏹ Bot detenido (código ' + code + ')' });
            io.emit('bot_estado', { id, estado: 'apagado' });
        });

        proc.on('error', (err) => {
            delete procesos[id];
            const botsActuales = cargarBots();
            const botActual = botsActuales.find(b => b.id === id);
            if (botActual) {
                botActual.estado = 'apagado';
                guardarBots(botsActuales);
            }
            io.emit('log', { botId: id, mensaje: '❌ Error: ' + err.message });
            io.emit('bot_estado', { id, estado: 'apagado' });
        });

        io.emit('bot_estado', { id, estado: 'activo' });
        return { mensaje: 'Bot iniciado', estado: 'activo' };

    } catch (err) {
        io.emit('log', { botId: id, mensaje: '❌ Error fatal: ' + err.message });
        return { error: err.message };
    }
}

// ===== API =====

// Estadísticas del sistema
app.get('/api/stats', (req, res) => {
    const bots = cargarBots();
    res.json({
        cpu: (os.loadavg()[0] * 100 / os.cpus().length).toFixed(1),
        ram: {
            used: os.totalmem() - os.freemem(),
            total: os.totalmem(),
            percent: ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(1)
        },
        botsTotal: bots.length,
        botsActivos: bots.filter(b => b.estado === 'activo').length,
        uptime: process.uptime()
    });
});

// Listar todos los bots
app.get('/api/bots', (req, res) => {
    res.json(cargarBots());
});

// Crear un nuevo bot
app.post('/api/bots', (req, res) => {
    const { nombre, repoUrl } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

    const id = uuidv4().substring(0, 8);
    const botDir = path.join(BOTS_DIR, id);
    fs.mkdirSync(botDir, { recursive: true });

    const nuevoBot = {
        id,
        nombre,
        repoUrl: repoUrl || '',
        estado: 'apagado',
        creado: new Date().toISOString(),
        carpeta: botDir,
        logs: []
    };

    const bots = cargarBots();
    bots.push(nuevoBot);
    guardarBots(bots);

    if (repoUrl) {
        io.emit('log', { botId: id, mensaje: '📥 Clonando repositorio...' });
        simpleGit(botDir).clone(repoUrl, botDir)
            .then(() => io.emit('log', { botId: id, mensaje: '✅ Repositorio clonado' }))
            .catch(err => io.emit('log', { botId: id, mensaje: '❌ Error al clonar: ' + err.message }));
    }

    io.emit('bot_creado', nuevoBot);
    res.json(nuevoBot);
});

// Iniciar bot
app.post('/api/bots/:id/start', (req, res) => {
    const resultado = iniciarBot(req.params.id);
    if (resultado.error) return res.status(400).json(resultado);
    res.json(resultado);
});

// Detener bot
app.post('/api/bots/:id/stop', (req, res) => {
    const { id } = req.params;

    if (procesos[id]) {
        io.emit('log', { botId: id, mensaje: '⏹ Deteniendo bot...' });
        procesos[id].kill('SIGTERM');
        delete procesos[id];
    }

    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (bot) {
        bot.estado = 'apagado';
        guardarBots(bots);
    }

    io.emit('bot_estado', { id, estado: 'apagado' });
    res.json({ mensaje: 'Bot detenido', estado: 'apagado' });
});

// Reiniciar bot
app.post('/api/bots/:id/restart', async (req, res) => {
    const { id } = req.params;

    io.emit('log', { botId: id, mensaje: '🔄 Reiniciando bot...' });

    // Detener si está activo
    if (procesos[id]) {
        procesos[id].kill('SIGTERM');
        delete procesos[id];
        await new Promise(r => setTimeout(r, 1500));
    }

    // Actualizar estado antes de iniciar
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (bot) {
        bot.estado = 'apagado';
        guardarBots(bots);
    }

    // Iniciar de nuevo usando la función interna
    const resultado = iniciarBot(id);
    if (resultado.error) return res.status(400).json(resultado);
    res.json(resultado);
});

// Reclonar repositorio
app.post('/api/bots/:id/reclone', async (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);

    if (!bot) return res.status(404).json({ error: 'Bot no encontrado' });
    if (!bot.repoUrl) return res.status(400).json({ error: 'No hay URL de repositorio' });

    io.emit('log', { botId: id, mensaje: '📥 Reclonando repositorio...' });

    if (procesos[id]) {
        procesos[id].kill('SIGTERM');
        delete procesos[id];
    }

    if (fs.existsSync(bot.carpeta)) {
        fs.rmSync(bot.carpeta, { recursive: true, force: true });
    }
    fs.mkdirSync(bot.carpeta, { recursive: true });

    bot.estado = 'apagado';
    guardarBots(bots);

    try {
        await simpleGit(bot.carpeta).clone(bot.repoUrl, bot.carpeta);
        io.emit('log', { botId: id, mensaje: '✅ Repositorio reclonado' });
        res.json({ mensaje: 'Repositorio reclonado' });
    } catch (err) {
        io.emit('log', { botId: id, mensaje: '❌ Error: ' + err.message });
        res.status(500).json({ error: err.message });
    }
});

// Eliminar bot
app.delete('/api/bots/:id', (req, res) => {
    const { id } = req.params;

    if (procesos[id]) {
        procesos[id].kill('SIGTERM');
        delete procesos[id];
    }

    let bots = cargarBots();
    const bot = bots.find(b => b.id === id);

    if (bot && fs.existsSync(bot.carpeta)) {
        fs.rmSync(bot.carpeta, { recursive: true, force: true });
    }

    bots = bots.filter(b => b.id !== id);
    guardarBots(bots);

    io.emit('bot_eliminado', id);
    res.json({ mensaje: 'Bot eliminado' });
});

// Listar archivos del bot
app.get('/api/bots/:id/files', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);

    if (!bot || !fs.existsSync(bot.carpeta)) return res.json([]);

    function listarArchivos(dir, base = '') {
        let results = [];
        if (!fs.existsSync(dir)) return results;
        const items = fs.readdirSync(dir);
        items.forEach(item => {
            const fullPath = path.join(dir, item);
            const relative = path.join(base, item);
            try {
                if (fs.statSync(fullPath).isDirectory()) {
                    results = results.concat(listarArchivos(fullPath, relative));
                } else {
                    results.push({ nombre: relative, tamano: fs.statSync(fullPath).size });
                }
            } catch (e) {}
        });
        return results;
    }

    res.json(listarArchivos(bot.carpeta));
});

// Subir archivo al bot
app.post('/api/bots/:id/upload', upload.single('archivo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });
    io.emit('log', { botId: req.params.id, mensaje: '📤 Archivo subido: ' + req.file.originalname });
    res.json({ mensaje: 'Archivo subido', nombre: req.file.originalname });
});

// Limpiar consola
app.post('/api/bots/:id/clearconsole', (req, res) => {
    const { id } = req.params;
    const bots = cargarBots();
    const bot = bots.find(b => b.id === id);
    if (bot) {
        bot.logs = [];
        guardarBots(bots);
    }
    io.emit('console_cleared', id);
    res.json({ mensaje: 'Consola limpiada' });
});

// Ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== WEBSOCKET =====
io.on('connection', (socket) => {
    console.log('🟢 Usuario conectado');
    socket.emit('bots_list', cargarBots());
});

// ===== INICIAR SERVIDOR =====
server.listen(PORT, '0.0.0.0', () => {
    console.log('🤖 Saki Bots corriendo en puerto ' + PORT);
});