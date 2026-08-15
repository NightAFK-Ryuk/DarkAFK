const express = require('express');
const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');

// Crash guards for Railway container stability
process.on('uncaughtException', (err) => {
  console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('CRITICAL UNHANDLED REJECTION:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const BOTS_FILE = './bots_db.json';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = new Map();

function loadBotsDb() {
  try {
    if (fs.existsSync(BOTS_FILE)) return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error loading bots db:', err);
  }
  return {};
}

function saveBotsDb(data) {
  try {
    fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving bots db:', err);
  }
}

function isUsernameTaken(username) {
  const db = loadBotsDb();
  if (db[username]) return true;
  if (activeBots.has(username)) return true;
  return false;
}

function generateUniqueUsername(letterCount, numCount) {
  const total = letterCount + numCount;
  if (total > 12) {
    throw new Error('Max limit is 12');
  }

  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  let candidate = '';

  do {
    let lPart = '';
    for (let i = 0; i < letterCount; i++) {
      lPart += letters[Math.floor(Math.random() * letters.length)];
    }
    let nPart = '';
    for (let i = 0; i < numCount; i++) {
      nPart += numbers[Math.floor(Math.random() * numbers.length)];
    }
    candidate = (lPart + nPart).split('').sort(() => 0.5 - Math.random()).join('');
    
    if (!isNaN(candidate[0])) {
      const prefix = letters[Math.floor(Math.random() * letters.length)];
      candidate = prefix + candidate.slice(1);
    }
  } while (isUsernameTaken(candidate));

  return candidate;
}

function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  const parts = proxyStr.trim().split(':');
  if (parts.length >= 4) {
    return { host: parts[0], port: parseInt(parts[1], 10), userId: parts[2], password: parts.slice(3).join(':') };
  } else if (parts.length === 2) {
    return { host: parts[0], port: parseInt(parts[1], 10) };
  }
  return null;
}

function createSocksConnect(proxyConfig, targetHost, targetPort) {
  return (clientInstance) => {
    const options = {
      proxy: { host: proxyConfig.host, port: proxyConfig.port, type: 5 },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 15000
    };
    if (proxyConfig.userId && proxyConfig.password) {
      options.proxy.userId = proxyConfig.userId;
      options.proxy.password = proxyConfig.password;
    }
    SocksClient.createConnection(options)
      .then((info) => {
        clientInstance.setSocket(info.socket);
        clientInstance.emit('connect');
      })
      .catch((err) => {
        try {
          clientInstance.emit('error', new Error(`SOCKS5 Error: ${err.message}`));
        } catch (e) {
          console.error('Socks error emission failed:', e.message);
        }
      });
  };
}

function formatUptime(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `${hours}h ${minutes}m ${seconds}s`;
}

function startBotInstance(options) {
  const { username, password, proxyInput, mcVersion, host, port, hffaEnabled, hffaTarget } = options;
  const proxyConfig = parseProxy(proxyInput);

  const botOpts = {
    host,
    port,
    username,
    password: password || undefined,
    version: mcVersion || '1.8.9',
    viewDistance: 16,
    checkTimeoutInterval: 120000
  };

  if (proxyConfig) {
    botOpts.connect = createSocksConnect(proxyConfig, host, port);
  }

  let bot;
  try {
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    console.error(`[${username}] Initialization error:`, err.message);
    scheduleReconnect(options);
    return;
  }

  let instanceData = activeBots.get(username) || {
    bot: null,
    startTime: Date.now(),
    afkInterval: null,
    hffaInterval: null,
    followInterval: null,
    reconnectTimer: null,
    chatLogs: [],
    options
  };

  instanceData.bot = bot;
  activeBots.set(username, instanceData);

  const allBots = loadBotsDb();
  allBots[username] = options;
  saveBotsDb(allBots);

  // Reliable chat capture
  bot.on('message', (jsonMsg) => {
    try {
      const textMessage = typeof jsonMsg.toMotd === 'function' ? jsonMsg.toMotd() : jsonMsg.toString();
      if (textMessage && textMessage.trim().length > 0) {
        instanceData.chatLogs.push(textMessage);
        if (instanceData.chatLogs.length > 50) instanceData.chatLogs.shift();
      }
    } catch (e) {
      console.error('Message parse error:', e.message);
    }
  });

  bot.once('spawn', () => {
    console.log(`[Bot ${username}] Successfully connected and spawned.`);

    if (password) {
      setTimeout(() => {
        if (bot && bot.entity) bot.chat(`/register ${password} ${password}`);
      }, 1500);
      setTimeout(() => {
        if (bot && bot.entity) bot.chat(`/login ${password}`);
      }, 3500);
    }

    if (instanceData.afkInterval) clearInterval(instanceData.afkInterval);
    instanceData.afkInterval = setInterval(() => {
      if (bot && bot.entity) {
        try {
          bot.swingArm('right');
          const yaw = (Math.random() - 0.5) * 0.4;
          const pitch = (Math.random() - 0.5) * 0.4;
          bot.look(bot.entity.yaw + yaw, bot.entity.pitch + pitch, false);
        } catch (e) {}
      }
    }, 40000);

    if (hffaEnabled) {
      setTimeout(async () => {
        try {
          const armorSlots = ['head', 'torso', 'legs', 'feet'];
          for (const slot of armorSlots) {
            if (bot) await bot.unequip(slot).catch(() => {});
          }
        } catch (e) {}
      }, 3000);

      if (instanceData.hffaInterval) clearInterval(instanceData.hffaInterval);
      instanceData.hffaInterval = setInterval(() => {
        if (bot && bot.entity) bot.chat('/play hardcoreffa');
      }, 60000);

      if (hffaTarget) {
        if (instanceData.followInterval) clearInterval(instanceData.followInterval);
        instanceData.followInterval = setInterval(() => {
          try {
            if (bot && bot.entity && bot.players[hffaTarget] && bot.players[hffaTarget].entity) {
              const targetEntity = bot.players[hffaTarget].entity;
              bot.lookAt(targetEntity.position.offset(0, targetEntity.height, 0));
              bot.setControlState('forward', true);
              if (bot.entity.position.distanceTo(targetEntity.position) < 3) {
                bot.setControlState('forward', false);
              }
            } else if (bot) {
              bot.setControlState('forward', false);
            }
          } catch (e) {}
        }, 1000);
      }
    }
  });

  const handleDisconnect = (err) => {
    if (instanceData.afkInterval) clearInterval(instanceData.afkInterval);
    if (instanceData.hffaInterval) clearInterval(instanceData.hffaInterval);
    if (instanceData.followInterval) clearInterval(instanceData.followInterval);
    console.log(`[Bot ${username}] Disconnected. Reason:`, err ? err.message || err : 'Unknown');
    scheduleReconnect(options);
  };

  bot.on('kicked', handleDisconnect);
  bot.on('error', handleDisconnect);
  bot.on('end', handleDisconnect);
}

function scheduleReconnect(options) {
  const { username } = options;
  let instanceData = activeBots.get(username);
  if (instanceData) {
    if (instanceData.reconnectTimer) clearTimeout(instanceData.reconnectTimer);
    instanceData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(username)) startBotInstance(options);
    }, 25000);
  }
}

app.post('/api/generate-username', (req, res) => {
  const { letters, numbers } = req.body;
  const lCount = parseInt(letters, 10) || 0;
  const nCount = parseInt(numbers, 10) || 0;

  if (lCount + nCount > 12) {
    return res.status(400).json({ error: 'Max limit is 12' });
  }

  try {
    const username = generateUniqueUsername(lCount, nCount);
    res.json({ success: true, username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/spawn', (req, res) => {
  const { server, username, password, proxy, version, hffaEnabled, hffaTarget } = req.body;
  if (!server || !username) return res.status(400).json({ error: 'Server and username required' });

  if (activeBots.has(username) || isUsernameTaken(username)) {
    return res.status(400).json({ error: 'Bot with this username is already active or registered' });
  }

  const [host, portRaw] = server.split(':');
  const port = parseInt(portRaw, 10) || 25565;

  const options = {
    username,
    password: password || '',
    proxyInput: proxy || '',
    mcVersion: version || '1.8.9',
    host,
    port,
    hffaEnabled: !!hffaEnabled,
    hffaTarget: hffaTarget || ''
  };

  startBotInstance(options);
  res.json({ success: true, message: `Deploying bot ${username}...` });
});

app.post('/api/disconnect', (req, res) => {
  const { username } = req.body;

  if (username === 'all') {
    activeBots.forEach((data) => {
      if (data.reconnectTimer) clearTimeout(data.reconnectTimer);
      if (data.afkInterval) clearInterval(data.afkInterval);
      if (data.hffaInterval) clearInterval(data.hffaInterval);
      if (data.followInterval) clearInterval(data.followInterval);
      if (data.bot) try { data.bot.quit(); } catch(e){}
    });
    activeBots.clear();
    saveBotsDb({});
    return res.json({ success: true, message: 'Disconnected all bots.' });
  }

  const botData = activeBots.get(username);
  if (!botData) return res.status(404).json({ error: 'Bot not found' });

  if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
  if (botData.afkInterval) clearInterval(botData.afkInterval);
  if (botData.hffaInterval) clearInterval(botData.hffaInterval);
  if (botData.followInterval) clearInterval(botData.followInterval);
  if (botData.bot) try { botData.bot.quit(); } catch(e){}
  activeBots.delete(username);

  const allBots = loadBotsDb();
  delete allBots[username];
  saveBotsDb(allBots);

  res.json({ success: true, message: `Disconnected ${username}` });
});

app.get('/api/status', (req, res) => {
  const statuses = [];
  activeBots.forEach((data, username) => {
    const { bot, startTime, options, chatLogs } = data;
    
    let health = 'N/A';
    let food = 'N/A';
    let ping = 'N/A';

    if (bot) {
      if (typeof bot.health === 'number') {
        health = bot.health.toFixed(1);
      }
      if (typeof bot.food === 'number') {
        food = bot.food.toFixed(1);
      }
      if (bot.players && bot.players[username] && typeof bot.players[username].ping === 'number') {
        ping = bot.players[username].ping;
      } else if (bot.player && typeof bot.player.ping === 'number') {
        ping = bot.player.ping;
      }
    }

    statuses.push({
      username,
      host: `${options.host}:${options.port}`,
      uptime: formatUptime(Date.now() - startTime),
      health,
      food,
      ping,
      proxy: options.proxyInput ? options.proxyInput.split(':')[0] : 'Direct Connection',
      hffaActive: !!options.hffaEnabled,
      chatLogs: chatLogs.slice(-15)
    });
  });
  res.json(statuses);
});

app.post('/api/chat', (req, res) => {
  const { username, message } = req.body;
  if (username === 'all') {
    activeBots.forEach((data) => { if (data.bot) try { data.bot.chat(message); } catch(e){} });
    return res.json({ success: true });
  }
  const data = activeBots.get(username);
  if (!data || !data.bot) return res.status(404).json({ error: 'Bot offline' });
  try { data.bot.chat(message); } catch(e){}
  res.json({ success: true });
});

app.post('/api/move', (req, res) => {
  const { username, direction, duration = 1000 } = req.body;
  const targets = username === 'all' ? Array.from(activeBots.values()) : [activeBots.get(username)].filter(Boolean);

  targets.forEach((data) => {
    if (data && data.bot) {
      try {
        data.bot.setControlState(direction, true);
        setTimeout(() => { if(data.bot) data.bot.setControlState(direction, false); }, duration);
      } catch(e){}
    }
  });
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dark AFK] Running on port ${PORT}`);

  const savedBots = loadBotsDb();
  for (const [username, config] of Object.entries(savedBots)) {
    console.log(`[Auto-Restore] Restarting stored bot instance: ${username}`);
    startBotInstance(config);
  }
});

