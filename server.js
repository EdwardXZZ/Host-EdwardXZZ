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
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(BOTS_FILE)) fs.writeFileSync(BOTS_FILE, '[]');

// Funciones
function cargarBots() {
    try {
        return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf-8'));
    } catch (e) {
        return [];
    }
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

    // Instalar dependencias si existe package.json
    const packageJson = path.join(bot.carpeta, 'package.json');
    if (fs.existsSync(packageJson)) {
        try {
            execSync('npm install --production', { cwd: bot.carpeta, stdio: 'pipe' });
            console.log('📦 Dependencias instaladas para bot ' + id);
        } catch (e) {
            console.log('⚠️ Error instalando dependencias: ' + e.message);
        }
    }

    // Buscar archivo principal
    const scripts = ['index.js', 'bot.js', 'main.js', 'app.js', 'start.js'];
    let scriptPath = null;
    
    for (const s of scripts) {
        const fp = path.join(bot.carpeta, s);
        if (fs.existsSync(fp)) {
            scriptPath = fp;
            break;
        }
    }

    if (!scriptPath) {
        return { error: 'No se encontró index.js, bot.js, ni main.js' };
    }

    console.log('▶ Iniciando bot ' + id + ': ' + path.basename(scriptPath));

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
            const msg = data.toString().trim();
            if (msg) console.log('[' + id + '] ' + msg);
        });

        proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.log('[' + id + '] ❌ ' + msg);
        });

        proc.on('close', (code) => {
            delete procesos[id];
            const actual = cargarBots().find(b => b.id === id);
            if (actual) {
                actual.estado = 'apagado';
                guardarBots(cargarBots().map(b => b.id === id ? actual : b));
            }
            console.log('[' + id + '] ⏹ Detenido (código ' + code + ')');
        });

        proc.on('error', (err) => {
            delete procesos[id];
            console.log('[' + id + '] ❌ Error: ' + err.message);
        });

        return { mensaje: 'Bot iniciado', estado: 'activo' };

    } catch (e) {
        return { error: e.message };
    }
}

// Servidor HTTP
const server = http.createServer((req, res) => {
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

    // Página principal
    if (url === '/' && method === 'GET') {
        const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    // API Stats
    if (url === '/api/stats' && method === 'GET') {
        const bots = cargarBots();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            cpu: (os.loadavg()[0] * 100 / os.cpus().length).toFixed(1),
            ram: {
                used: usedMem,
                total: totalMem,
                percent: ((usedMem / totalMem) * 100).toFixed(1)
            },
            botsTotal: bots.length,
            botsActivos: bots.filter(b => b.estado === 'activo').length,
            uptime: process.uptime()
        }));
        return;
    }

    // Listar bots
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
                const botDir = path.join(BOTS_DIR, id);
                fs.mkdirSync(botDir, { recursive: true });
                
                const nuevo = {
                    id,
                    nombre,
                    repoUrl: repoUrl || '',
                    estado: 'apagado',
                    creado: new Date().toISOString(),
                    carpeta: botDir
                };
                
                const bots = cargarBots();
                bots.push(nuevo);
                guardarBots(bots);
                
                if (repoUrl) {
                    console.log('📥 Clonando repo para bot ' + id);
                    simpleGit(botDir).clone(repoUrl, botDir).catch(e => {
                        console.log('❌ Error clonando: ' + e.message);
                    });
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
    const match = url.match(/^\/api\/bots\/([a-zA-Z0-9]+)\/(start|stop|restart|reclone|delete|files)$/);
    
    if (match) {
        const id = match[1];
        const action = match[2];

        // START
        if (action === 'start' && method === 'POST') {
            const resultado = iniciarBot(id);
            res.writeHead(resultado.error ? 400 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(resultado));
            return;
        }

        // STOP
        if (action === 'stop' && method === 'POST') {
            if (procesos[id]) {
                procesos[id].kill('SIGTERM');
                delete procesos[id];
            }
            const bots = cargarBots();
            const bot = bots.find(b => b.id === id);
            if (bot) {
                bot.estado = 'apagado';
                guardarBots(bots);
            }
            console.log('⏹ Bot ' + id + ' detenido');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mensaje: 'Detenido', estado: 'apagado' }));
            return;
        }

        // RESTART
        if (action === 'restart' && method === 'POST') {
            if (procesos[id]) {
                procesos[id].kill('SIGTERM');
                delete procesos[id];
            }
            setTimeout(() => iniciarBot(id), 1500);
            console.log('🔄 Reiniciando bot ' + id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mensaje: 'Reiniciando' }));
            return;
        }

        // RECLONE
        if (action === 'reclone' && method === 'POST') {
            const bots = cargarBots();
            const bot = bots.find(b => b.id === id);
            
            if (!bot || !bot.repoUrl) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Sin repositorio' }));
                return;
            }
            
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
            
            simpleGit(bot.carpeta).clone(bot.repoUrl, bot.carpeta).then(() => {
                console.log('✅ Bot ' + id + ' reclonado');
            }).catch(e => {
                console.log('❌ Error reclonando: ' + e.message);
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mensaje: 'Reclonado' }));
            return;
        }

        // DELETE
        if (action === 'delete' && method === 'DELETE') {
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
            
            console.log('🗑 Bot ' + id + ' eliminado');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mensaje: 'Eliminado' }));
            return;
        }

        // FILES
        if (action === 'files' && method === 'GET') {
            const bot = cargarBots().find(b => b.id === id);
            
            if (!bot || !fs.existsSync(bot.carpeta)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
                return;
            }
            
            const archivos = fs.readdirSync(bot.carpeta).map(f => {
                const fp = path.join(bot.carpeta, f);
                return {
                    nombre: f,
                    tamano: fs.statSync(fp).isFile() ? fs.statSync(fp).size : 0
                };
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(archivos));
            return;
        }
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('🤖 Saki Bots corriendo en puerto ' + PORT);
    console.log('🧠 RAM total: ' + (os.totalmem() / 1073741824).toFixed(1) + ' GB');
});