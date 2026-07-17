// ==========================================================
//  TANKS ONLINE - сервер
//  Node.js + ws. Раздаёт клиента (public/) и держит игровое
//  состояние: два независимых режима-комнаты —
//  «Командный бой» (10 минут, песок + кусты) и
//  «Бой насмерть» (бесконечный, классическая карта, без команд).
// ==========================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Версия протокола/клиента. Если у игрока другая версия страницы —
// сервер отклонит подключение, чтобы не смешивать несовместимых клиентов.
const GAME_VERSION = '2.1.0';

// ---------------------- Настройки игры ----------------------
const MAP_W = 3600;
const MAP_H = 2400;

const TANK_RADIUS      = 20;
const TANK_SPEED       = 95;    // px/сек  -> танки медленные
const TANK_ROT_SPEED   = 6;     // рад/сек, поворот корпуса
const TURRET_ROT_SPEED = 12;    // рад/сек, поворот башни

const BULLET_SPEED     = 780;   // px/сек  -> снаряды летят быстро
const BULLET_RADIUS    = 5;
const BULLET_DAMAGE    = 20;    // один снаряд = 20хп
const BULLET_LIFETIME  = 3000;  // мс

const MAX_HP           = 100;   // у танка 100хп (5 попаданий)
const RESPAWN_MS       = 3000;  // возрождение через 3 секунды
const SHOOT_COOLDOWN   = 350;   // мс между выстрелами одного танка

const TICK_MS      = 1000 / 60;
const BROADCAST_MS = 1000 / 20;

// ---------------------- Командный бой ----------------------
const MATCH_DURATION_MS = 10 * 60 * 1000; // 10 минут
const RESET_DELAY_MS    = 12 * 1000;      // пауза перед новым матчем
const TEAM_LABEL = { red: 'Красные', blue: 'Синие' };

// ---------------------- Мод-меню ----------------------
const ADMIN_PASSWORD = 'sbascvxzc';

// ---------------------- Скины: радужные / неоновые цвета ----------------------
const SKIN_PALETTE = [
  { id: 'neon-pink',    hex: '#ff2079' },
  { id: 'neon-green',   hex: '#39ff14' },
  { id: 'neon-cyan',    hex: '#00f7ff' },
  { id: 'neon-yellow',  hex: '#faff00' },
  { id: 'neon-orange',  hex: '#ff8800' },
  { id: 'neon-purple',  hex: '#b026ff' },
  { id: 'neon-red',     hex: '#ff1f4b' },
  { id: 'neon-mint',    hex: '#00ff9d' },
  { id: 'neon-blue',    hex: '#1f6bff' },
  { id: 'neon-magenta', hex: '#ff00e6' },
  { id: 'rainbow-1',    hex: '#ff005c' },
  { id: 'rainbow-2',    hex: '#ff9900' },
  { id: 'rainbow-3',    hex: '#ddff00' },
  { id: 'rainbow-4',    hex: '#00ffb2' },
  { id: 'rainbow-5',    hex: '#00c3ff' },
  { id: 'rainbow-6',    hex: '#7b00ff' },
  { id: 'classic-white',hex: '#f4f4f4' },
  { id: 'classic-gold', hex: '#ffd700' },
];
const SKIN_HEX_SET = new Set(SKIN_PALETTE.map(s => s.hex.toLowerCase()));
const HEX_RE = /^#[0-9a-f]{6}$/i;

function pickSkin(requested) {
  if (typeof requested === 'string' && HEX_RE.test(requested)) {
    if (SKIN_HEX_SET.has(requested.toLowerCase())) return requested.toLowerCase();
  }
  return SKIN_PALETTE[Math.floor(Math.random() * SKIN_PALETTE.length)].hex;
}

// ---------------------- Утилиты столкновений/генерации ----------------------
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function circleRectCollide(cx, cy, r, rect) {
  const closestX = clamp(cx, rect.x, rect.x + rect.w);
  const closestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - closestX, dy = cy - closestY;
  return dx * dx + dy * dy < r * r;
}

function rectsOverlap(a, b, pad) {
  return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x ||
           a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
}

// Пытается разместить прямоугольник без пересечения с уже размещёнными
// объектами (с зазором pad). Если за attempts попыток место не нашлось —
// просто пропускает объект (лучше меньше объектов, чем наложенные друг на друга).
function tryPlace(existing, w, h, rand, pad, attempts) {
  for (let i = 0; i < attempts; i++) {
    const x = 130 + rand() * (MAP_W - 260 - w);
    const y = 130 + rand() * (MAP_H - 260 - h);
    const rect = { x, y, w, h };
    let ok = true;
    for (const o of existing) {
      if (rectsOverlap(rect, o, pad)) { ok = false; break; }
    }
    if (ok) return rect;
  }
  return null;
}

function borderWalls() {
  const wallT = 50;
  return [
    { x: 0, y: 0, w: MAP_W, h: wallT, type: 'wall', solid: true },
    { x: 0, y: MAP_H - wallT, w: MAP_W, h: wallT, type: 'wall', solid: true },
    { x: 0, y: 0, w: wallT, h: MAP_H, type: 'wall', solid: true },
    { x: MAP_W - wallT, y: 0, w: wallT, h: MAP_H, type: 'wall', solid: true },
  ];
}

// ---------------------- Карта 1: «Командный бой» — песок с кустами ----------------------
// Немного объектов, без наложений — иначе лагает и танки застревают/спавнятся внутри.
function generateTeamMap() {
  const rand = seededRandom(20240715);
  const obstacles = borderWalls();

  const SOLID_COUNT = 40;
  for (let i = 0; i < SOLID_COUNT; i++) {
    const type = rand() < 0.5 ? 'wall' : 'crate';
    let w, h;
    if (type === 'wall') { w = 70 + rand() * 130; h = 70 + rand() * 130; }
    else { w = h = 48 + rand() * 20; }
    const rect = tryPlace(obstacles, w, h, rand, 24, 40);
    if (rect) obstacles.push({ ...rect, type, solid: true });
  }

  // кусты: не блокируют движение/пули, только прячут от врагов визуально
  const BUSH_COUNT = 55;
  for (let i = 0; i < BUSH_COUNT; i++) {
    const w = h = 50 + rand() * 36;
    const rect = tryPlace(obstacles, w, h, rand, 4, 30);
    if (rect) obstacles.push({ ...rect, type: 'bush', solid: false });
  }

  return obstacles;
}

// ---------------------- Карта 2: «Бой насмерть» — классика без команд ----------------------
// Как в первой версии игры: стены/ящики/деревья, но заметно меньше объектов, чтобы не лагало.
function generateDmMap() {
  const rand = seededRandom(778899);
  const obstacles = borderWalls();

  const types = ['wall', 'tree', 'crate'];
  const COUNT = 55;
  for (let i = 0; i < COUNT; i++) {
    const type = types[Math.floor(rand() * types.length)];
    let w, h;
    if (type === 'wall') { w = 70 + rand() * 140; h = 70 + rand() * 140; }
    else if (type === 'tree') { w = h = 44 + rand() * 30; }
    else { w = h = 48 + rand() * 20; }
    const rect = tryPlace(obstacles, w, h, rand, 22, 40);
    if (rect) obstacles.push({ ...rect, type, solid: true });
  }

  return obstacles;
}

function angleLerp(a, target, maxDelta) {
  let diff = target - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return target;
  return a + Math.sign(diff) * maxDelta;
}

// ---------------------- Комната (одна игровая инстанция режима) ----------------------
class GameRoom {
  constructor(mode) {
    this.mode = mode;                 // 'team' | 'dm'
    this.hasTeams = mode === 'team';
    this.obstacles = mode === 'team' ? generateTeamMap() : generateDmMap();
    this.solid = this.obstacles.filter(o => o.solid);
    this.bushes = this.obstacles.filter(o => o.type === 'bush');

    this.players = new Map();
    this.bullets = [];
    this.bulletIdCounter = 1;
    this.killFeed = [];

    this.teamCounts = { red: 0, blue: 0 };
    this.teamScore  = { red: 0, blue: 0 };
    this.matchEndAt = this.hasTeams ? Date.now() + MATCH_DURATION_MS : null;
    this.matchOver  = false;
    this.matchWinner = null;

    this.lastTick = Date.now();
    setInterval(() => this.tick(), TICK_MS);
    setInterval(() => this.broadcastState(), BROADCAST_MS);
  }

  collidesSolid(x, y, r) {
    for (const o of this.solid) if (circleRectCollide(x, y, r, o)) return true;
    return false;
  }

  inAnyBush(x, y, r) {
    for (const b of this.bushes) if (circleRectCollide(x, y, r, b)) return true;
    return false;
  }

  // Безопасная точка без объектов: сперва случайные попытки, а если карта
  // плотная — гарантированный перебор по сетке, чтобы никогда не залипнуть.
  findSpawnPoint() {
    for (let i = 0; i < 150; i++) {
      const x = 150 + Math.random() * (MAP_W - 300);
      const y = 150 + Math.random() * (MAP_H - 300);
      if (!this.collidesSolid(x, y, TANK_RADIUS + 10)) return { x, y };
    }
    const step = 80;
    for (let y = 150; y < MAP_H - 150; y += step) {
      for (let x = 150; x < MAP_W - 150; x += step) {
        if (!this.collidesSolid(x, y, TANK_RADIUS + 10)) return { x, y };
      }
    }
    return { x: MAP_W / 2, y: MAP_H / 2 };
  }

  assignTeam() {
    const team = this.teamCounts.red <= this.teamCounts.blue ? 'red' : 'blue';
    this.teamCounts[team]++;
    return team;
  }

  createPlayer(id, name, ws, skinHex) {
    const spawn = this.findSpawnPoint();
    const team = this.hasTeams ? this.assignTeam() : null;
    return {
      id, ws, team,
      name: (name || 'Танк').toString().slice(0, 16) || 'Танк',
      x: spawn.x, y: spawn.y,
      angle: 0, turret: 0,
      hp: MAX_HP, alive: true,
      color: skinHex,
      input: { mx: 0, my: 0 },
      aim: 0,
      lastShot: 0,
      respawnAt: 0,
      kills: 0, deaths: 0,
      hidden: false,
      isAdmin: false, godMode: false, speedBoost: false, rapidFire: false
    };
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.hasTeams && this.teamCounts[p.team] > 0) this.teamCounts[p.team]--;
    this.broadcast({ t: 'chat', text: `${p.name} покинул игру` });
  }

  handleAdmin(p, msg) {
    if (msg.password !== ADMIN_PASSWORD) {
      p.ws.send(JSON.stringify({ t: 'adminAuth', ok: false }));
      return;
    }
    if (!p.isAdmin) {
      p.isAdmin = true;
      p.ws.send(JSON.stringify({ t: 'adminAuth', ok: true }));
    }
    switch (msg.action) {
      case 'god':   p.godMode = !p.godMode; break;
      case 'speed': p.speedBoost = !p.speedBoost; break;
      case 'rapid': p.rapidFire = !p.rapidFire; break;
      case 'heal':  p.hp = MAX_HP; p.alive = true; break;
      case 'teleportCenter': {
        const spot = this.findSpawnPoint(); // безопасная точка, а не жёсткий центр
        p.x = spot.x; p.y = spot.y;
        break;
      }
      default: return;
    }
    p.ws.send(JSON.stringify({ t: 'adminState', god: p.godMode, speed: p.speedBoost, rapid: p.rapidFire }));
  }

  tryShoot(p) {
    if (!p.alive || this.matchOver) return;
    const now = Date.now();
    const cooldown = p.rapidFire ? 90 : SHOOT_COOLDOWN;
    if (now - p.lastShot < cooldown) return;
    p.lastShot = now;
    const dist = TANK_RADIUS + BULLET_RADIUS + 8;
    this.bullets.push({
      id: this.bulletIdCounter++,
      x: p.x + Math.cos(p.aim) * dist,
      y: p.y + Math.sin(p.aim) * dist,
      angle: p.aim,
      ownerId: p.id, ownerName: p.name, ownerTeam: p.team,
      color: p.color, createdAt: now
    });
  }

  startNewMatch() {
    this.teamScore = { red: 0, blue: 0 };
    this.matchEndAt = Date.now() + MATCH_DURATION_MS;
    this.matchOver = false;
    this.matchWinner = null;
    for (const p of this.players.values()) {
      const spawn = this.findSpawnPoint();
      p.x = spawn.x; p.y = spawn.y; p.hp = MAX_HP; p.alive = true;
      p.kills = 0; p.deaths = 0;
    }
    this.bullets.length = 0;
    this.broadcast({ t: 'chat', text: '🏁 Новый командный бой начался! 10 минут на бой.' });
  }

  endMatch() {
    this.matchOver = true;
    if (this.teamScore.red === this.teamScore.blue) this.matchWinner = 'draw';
    else this.matchWinner = this.teamScore.red > this.teamScore.blue ? 'red' : 'blue';
    const text = this.matchWinner === 'draw'
      ? '🤝 Матч окончен! Ничья.'
      : `🏆 Матч окончен! Победила команда «${TEAM_LABEL[this.matchWinner]}»!`;
    this.broadcast({ t: 'chat', text });
    setTimeout(() => this.startNewMatch(), RESET_DELAY_MS);
  }

  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    if (this.hasTeams && !this.matchOver && now >= this.matchEndAt) this.endMatch();

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (!this.matchOver && now >= p.respawnAt) {
          const spawn = this.findSpawnPoint();
          p.x = spawn.x; p.y = spawn.y; p.hp = MAX_HP; p.alive = true;
        }
        continue;
      }
      if (this.matchOver) continue;
      const { mx, my } = p.input;
      const len = Math.hypot(mx, my);
      if (len > 0.05) {
        const nx = mx / len, ny = my / len;
        const targetAngle = Math.atan2(ny, nx);
        p.angle = angleLerp(p.angle, targetAngle, TANK_ROT_SPEED * dt);
        const speedMult = p.speedBoost ? 2 : 1;
        const speed = TANK_SPEED * speedMult * Math.min(len, 1);
        const newX = p.x + nx * speed * dt;
        const newY = p.y + ny * speed * dt;
        if (!this.collidesSolid(newX, p.y, TANK_RADIUS)) p.x = newX;
        if (!this.collidesSolid(p.x, newY, TANK_RADIUS)) p.y = newY;
        p.x = clamp(p.x, TANK_RADIUS, MAP_W - TANK_RADIUS);
        p.y = clamp(p.y, TANK_RADIUS, MAP_H - TANK_RADIUS);
      }
      p.turret = angleLerp(p.turret, p.aim, TURRET_ROT_SPEED * dt);
      p.hidden = this.bushes.length ? this.inAnyBush(p.x, p.y, TANK_RADIUS * 0.6) : false;
    }

    if (!this.matchOver) {
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        if (now - b.createdAt > BULLET_LIFETIME) { this.bullets.splice(i, 1); continue; }
        b.x += Math.cos(b.angle) * BULLET_SPEED * dt;
        b.y += Math.sin(b.angle) * BULLET_SPEED * dt;

        let removed = false;
        for (const o of this.solid) {
          if (circleRectCollide(b.x, b.y, BULLET_RADIUS, o)) { this.bullets.splice(i, 1); removed = true; break; }
        }
        if (removed) continue;

        if (b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) { this.bullets.splice(i, 1); continue; }

        for (const p of this.players.values()) {
          if (!p.alive || p.id === b.ownerId) continue;
          if (this.hasTeams && p.team === b.ownerTeam) continue; // свои не наносят урон союзникам
          const dx = p.x - b.x, dy = p.y - b.y;
          if (dx * dx + dy * dy < (TANK_RADIUS + BULLET_RADIUS) ** 2) {
            this.bullets.splice(i, 1);
            if (!p.godMode) {
              p.hp -= BULLET_DAMAGE;
              if (p.hp <= 0) {
                p.alive = false; p.hp = 0; p.deaths++;
                p.respawnAt = Date.now() + RESPAWN_MS;
                const killer = this.players.get(b.ownerId);
                if (killer) {
                  killer.kills++;
                  if (this.hasTeams) this.teamScore[killer.team]++;
                }
                this.killFeed.push({ killer: killer ? killer.name : '???', victim: p.name, t: Date.now() });
                if (this.killFeed.length > 6) this.killFeed.shift();
              }
            }
            removed = true;
            break;
          }
        }
      }
    }
  }

  broadcastState() {
    const timeLeftMs = this.hasTeams ? (this.matchOver ? 0 : Math.max(0, this.matchEndAt - Date.now())) : null;
    const state = {
      t: 'state',
      players: Array.from(this.players.values()).map(p => ({
        id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle, turret: p.turret,
        hp: p.hp, alive: p.alive, color: p.color, team: p.team,
        kills: p.kills, deaths: p.deaths, hidden: !!p.hidden,
        god: p.godMode, speed: p.speedBoost, rapid: p.rapidFire
      })),
      bullets: this.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, angle: b.angle, ownerId: b.ownerId, color: b.color, team: b.ownerTeam })),
      killFeed: this.killFeed,
      teamScore: this.teamScore,
      timeLeftMs,
      matchOver: this.matchOver,
      matchWinner: this.matchWinner
    };
    this.broadcast(state);
  }

  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const p of this.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
  }
}

const rooms = { team: new GameRoom('team'), dm: new GameRoom('dm') };

// ---------------------- HTTP статика ----------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let id = null;
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.t === 'join') {
      // отклоняем клиентов с другой версией игры, чтобы не смешивать несовместимые протоколы
      if (msg.version !== GAME_VERSION) {
        ws.send(JSON.stringify({ t: 'versionMismatch', serverVersion: GAME_VERSION }));
        ws.close();
        return;
      }
      room = msg.mode === 'dm' ? rooms.dm : rooms.team;
      id = 'p' + Math.random().toString(36).slice(2, 10);
      const skinHex = pickSkin(msg.skin);
      const p = room.createPlayer(id, msg.name, ws, skinHex);
      room.players.set(id, p);
      ws.send(JSON.stringify({
        t: 'welcome', id,
        mode: room.mode,
        map: { w: MAP_W, h: MAP_H },
        obstacles: room.obstacles,
        constants: { tankRadius: TANK_RADIUS, bulletRadius: BULLET_RADIUS, maxHp: MAX_HP },
        team: p.team,
        skinPalette: SKIN_PALETTE,
        matchDurationMs: room.hasTeams ? MATCH_DURATION_MS : null
      }));
      room.broadcast({
        t: 'chat',
        text: room.hasTeams
          ? `${p.name} присоединился к команде «${TEAM_LABEL[p.team]}»`
          : `${p.name} присоединился к бою насмерть`
      });
      return;
    }

    if (!room) return;
    const p = room.players.get(id);
    if (!p) return;

    if (msg.t === 'input') {
      p.input.mx = clamp(+msg.mx || 0, -1, 1);
      p.input.my = clamp(+msg.my || 0, -1, 1);
    } else if (msg.t === 'aim') {
      p.aim = +msg.angle || 0;
    } else if (msg.t === 'shoot') {
      room.tryShoot(p);
    } else if (msg.t === 'changeSkin') {
      p.color = pickSkin(msg.skin);
    } else if (msg.t === 'admin') {
      room.handleAdmin(p, msg);
    }
  });

  ws.on('close', () => {
    if (id && room) room.removePlayer(id);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Tanks Online сервер запущен! (версия ${GAME_VERSION})`);
  console.log(`  Локально:     http://localhost:${PORT}`);
  console.log(`  Для друзей в одной сети: http://<твой-IP>:${PORT}`);
  console.log(`  Режимы: «Командный бой» (10 мин) и «Бой насмерть» (бесконечный)`);
  console.log(`  Мод-меню по паролю "${ADMIN_PASSWORD}"\n`);
});
