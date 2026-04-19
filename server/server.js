const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// --- Logger ---
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function getLogger(username) {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logFile = path.join(LOGS_DIR, `${username || 'system'}_${dateStr}.log`);

    function write(level, msg) {
        const ts = new Date().toISOString();
        const line = `[${ts}] [${level}] ${msg}\n`;
        fs.appendFileSync(logFile, line, 'utf8');
        if (level === 'ERROR') console.error(line.trimEnd());
        else if (level === 'WARN') console.warn(line.trimEnd());
        else console.log(line.trimEnd());
    }

    return {
        info:  (msg) => write('INFO',  msg),
        warn:  (msg) => write('WARN',  msg),
        error: (msg) => write('ERROR', msg),
    };
}

// --- Config ---
const PORT = 8000;
const USERS_DIR = path.join(__dirname, '..', 'users');

// MongoDB config
const MONGO_URL = 'mongodb://127.0.0.1:27017';
const MONGO_DB = 'ai_image_studio';

// Ensure users directory exists
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

// --- In-memory state (sessions only, token 不持久化) ---
const sessions = new Map();       // token -> { username, ip, createdAt }
const adminSessions = new Map();  // token -> { createdAt }
const userByIP = new Map();       // ip -> username (启动时从DB恢复)

// --- SSE 推送通道：username -> Set<res> ---
const sseClients = new Map();

function sseSend(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseBroadcast(username, event, data) {
    const clients = sseClients.get(username);
    if (!clients || clients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch(e) { clients.delete(res); }
    }
    getLogger(username).info(`SSE 推送: event=${event} clients=${clients.size}`);
}

// --- SSE 连接处理：前端通过 GET /api/sse?token=xxx 建立 ---
function handleSSEConnect(req, res) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const token = params.get('token') || req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);

    if (!session) {
        return json(res, 401, { error: '未登录' });
    }

    const username = session.username;

    // SSE 响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    // 注册客户端
    if (!sseClients.has(username)) sseClients.set(username, new Set());
    sseClients.get(username).add(res);

    // 发送连接成功事件
    sseSend(res, 'connected', { username, time: Date.now() });

    getLogger(username).info(`SSE 客户端连接，当前 clients: ${sseClients.get(username).size}`);

    // 心跳，每 30 秒
    const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch(e) { clearInterval(heartbeat); }
    }, 30000);

    // 客户端断开时清理
    req.on('close', () => {
        clearInterval(heartbeat);
        const clients = sseClients.get(username);
        if (clients) {
            clients.delete(res);
            if (clients.size === 0) sseClients.delete(username);
        }
        getLogger(username).info(`SSE 客户端断开，剩余 clients: ${clients ? clients.size : 0}`);
    });
}

// --- Admin 管理员路由 ---
let adminLastAttempt = 0; // 上次登录尝试时间戳（服务端冷却）

async function handleAdminLogin(req, res) {
    const now = Date.now();
    const cooldown = 5000;

    if (now - adminLastAttempt < cooldown) {
        const remain = Math.ceil((cooldown - (now - adminLastAttempt)) / 1000);
        return json(res, 429, { error: `请${remain}秒后再试`, cooldown: remain });
    }

    adminLastAttempt = now;

    let body;
    try {
        body = await parseBody(req);
    } catch (err) {
        return json(res, 400, { error: '请求数据格式错误' });
    }

    const inputUser = (body.username || '').trim();
    const inputPass = body.password || '';

    if (!inputUser || !inputPass) {
        return json(res, 400, { error: '请输入用户名和密码' });
    }

    const adminUser = await getConfig('adminUser');
    const adminPassword = await getConfig('adminPassword');

    if (inputUser !== adminUser || inputPass !== adminPassword) {
        return json(res, 401, { error: '用户名或密码错误' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, { createdAt: Date.now() });

    json(res, 200, { success: true, token });
}

function handleAdminCheck(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token || !adminSessions.has(token)) {
        return json(res, 401, { error: '未登录' });
    }
    json(res, 200, { valid: true });
}

async function handleAdminRecharge(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token || !adminSessions.has(token)) {
        return json(res, 401, { error: '未登录' });
    }

    let body;
    try {
        body = await parseBody(req);
    } catch (err) {
        return json(res, 400, { error: '请求数据格式错误' });
    }

    const username = sanitizeUsername(body.username || '');
    const amount = parseInt(body.amount);

    if (!username) {
        return json(res, 400, { error: '请输入用户名' });
    }
    if (!amount || amount <= 0) {
        return json(res, 400, { error: '充值数量必须大于0' });
    }

    const log = getLogger('admin');
    try {
        const user = await usersCol.findOne({ username });
        if (!user) {
            return json(res, 404, { error: `用户 "${username}" 不存在` });
        }

        await usersCol.updateOne({ username }, { $inc: { money: amount } });
        const updated = await usersCol.findOne({ username }, { projection: { money: 1 } });

        // 写入充值记录
        await rechargeLogCol.insertOne({
            username,
            amount,
            balanceAfter: updated.money,
            operator: 'admin',
            createdAt: Date.now(),
        });

        log.info(`充值: 用户 "${username}" +${amount}，余额 ${updated.money}`);

        json(res, 200, { success: true, username, amount, balance: updated.money });
    } catch (err) {
        log.error(`充值失败: ${err.message}`);
        return json(res, 500, { error: '充值失败' });
    }
}

// --- MongoDB ---
let db = null;
let usersCol = null;       // users 集合
let queueCol = null;       // img_queue 集合
let configCol = null;      // config 集合
let rechargeLogCol = null; // recharge_log 集合
let refImagesCol = null;  // ref_images 集合（参考图）
let chatSessionsCol = null; // chat_sessions 集合（图生图会话）
let queueCounter = 0;

// --- 默认系统配置 ---
const DEFAULT_CONFIG = {
    maxUserQueue: 3,
    maxGlobalQueue: 50,
    maxImagesPerUser: 20,
    defaultMoney: 50,
    adminUser: 'admin',
    adminPassword: '1111',
};

async function initMongo() {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    db = client.db(MONGO_DB);

    // ========== 1. 初始化 users 集合 ==========
    usersCol = db.collection('users');
    await usersCol.createIndex({ username: 1 }, { unique: true });
    await usersCol.createIndex({ ip: 1 });
    console.log('[init] users 集合已就绪（username 唯一索引 + ip 索引）');

    // 恢复 IP → username 映射到内存
    const allUsers = await usersCol.find({}, { projection: { username: 1, ip: 1 } }).toArray();
    for (const u of allUsers) {
        if (u.ip) userByIP.set(u.ip, u.username);
    }
    console.log(`[init] 已恢复 ${allUsers.length} 个用户 IP 绑定`);

    // ========== 2. 初始化 img_queue 集合 ==========
    queueCol = db.collection('img_queue');
    await queueCol.createIndex({ queueId: 1 }, { unique: true });
    await queueCol.createIndex({ status: 1 });
    await queueCol.createIndex({ username: 1 });
    await queueCol.createIndex({ createdAt: 1 });
    console.log('[init] img_queue 集合已就绪（queueId 唯一索引 + status/username/createdAt 索引）');

    // 恢复 queueCounter
    const lastDoc = await queueCol.find().sort({ queueId: -1 }).limit(1).toArray();
    if (lastDoc.length > 0) queueCounter = lastDoc[0].queueId;
    console.log(`[init] queueCounter 起始值: ${queueCounter}`);

    // ========== 启动恢复：重置卡死任务 ==========
    // 服务器重启时，所有 status=2（生成中）的任务说明 Worker 已断开，重置回 status=1 重新排队
    const stuckResult = await queueCol.updateMany(
        { status: 2 },
        { $set: { status: 1, error: null, completedAt: null } }
    );
    if (stuckResult.modifiedCount > 0) {
        getLogger('system').warn(`启动恢复：重置 ${stuckResult.modifiedCount} 个卡死任务（status=2→1）`);
        console.log(`[init] 启动恢复：重置 ${stuckResult.modifiedCount} 个卡死任务`);
    } else {
        console.log('[init] 启动恢复：无卡死任务');
    }

    // ========== 3. 初始化 config 集合 ==========
    configCol = db.collection('config');
    await configCol.createIndex({ key: 1 }, { unique: true });

    // 如果配置不存在则写入默认值
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
        const exists = await configCol.findOne({ key });
        if (!exists) {
            await configCol.insertOne({ key, value, updatedAt: Date.now() });
        }
    }
    console.log('[init] config 集合已就绪（默认配置已确保存在）');

    // ========== 4. 初始化 recharge_log 集合 ==========
    rechargeLogCol = db.collection('recharge_log');
    await rechargeLogCol.createIndex({ username: 1 });
    await rechargeLogCol.createIndex({ createdAt: -1 });
    console.log('[init] recharge_log 集合已就绪');

    // ========== 5. 初始化 ref_images 集合（参考图） ==========
    refImagesCol = db.collection('ref_images');
    await refImagesCol.createIndex({ username: 1 });
    await refImagesCol.createIndex({ uploadedAt: -1 });
    console.log('[init] ref_images 集合已就绪');

    // ========== 6. 初始化 chat_sessions 集合（图生图会话） ==========
    chatSessionsCol = db.collection('chat_sessions');
    await chatSessionsCol.createIndex({ username: 1 });
    await chatSessionsCol.createIndex({ sessionId: 1 }, { unique: true });
    await chatSessionsCol.createIndex({ updatedAt: -1 });
    console.log('[init] chat_sessions 集合已就绪');

    // 从 DB 加载配置覆盖内存变量
    await loadConfig();

    console.log(`[init] MongoDB 连接完成: ${MONGO_URL}/${MONGO_DB}`);
    const log = getLogger('system');
    log.info('MongoDB 初始化完成，3 个集合已就绪');
}

async function loadConfig() {
    const configs = await configCol.find({}).toArray();
    for (const c of configs) {
        if (c.key === 'maxUserQueue' && typeof c.value === 'number') {
            // 重新赋值需要通过导出函数来覆盖，这里直接修改全局
        }
    }
}

// 获取配置的便捷函数
async function getConfig(key) {
    const doc = await configCol.findOne({ key });
    return doc ? doc.value : DEFAULT_CONFIG[key];
}

// --- Helpers ---
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            if (!body || body.trim() === '') {
                return resolve({});
            }
            // 去除 UTF-8 BOM 和前后空白
            let cleaned = body.replace(/^\uFEFF/, '').trim();
            try { resolve(JSON.parse(cleaned)); }
            catch (e) {
                console.error(`JSON 解析失败，原始 body: "${cleaned.slice(0, 200)}"`);
                reject(new Error('请求数据格式错误'));
            }
        });
        req.on('error', (e) => reject(e));
    });
}

function getClientIP(req) {
    return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '127.0.0.1';
}

function json(res, code, data) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
}

function sanitizeUsername(name) {
    const cleaned = name.replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9_\-\s]/g, '').trim();
    return cleaned.substring(0, 30);
}

function getUserDir(username) {
    return path.join(USERS_DIR, username);
}

// --- Routes ---
async function handleLogin(req, res) {
    let body;
    try {
        body = await parseBody(req);
    } catch (err) {
        return json(res, 400, { error: '请求数据格式错误' });
    }

    const ip = getClientIP(req);
    let username = sanitizeUsername(body.username || '');

    if (!username) {
        return json(res, 400, { error: '请输入用户名' });
    }

    const log = getLogger(username);
    const userDir = getUserDir(username);

    // 检查该 IP 是否已绑定其他用户（优先查 DB）
    const existingUser = userByIP.get(ip);
    if (existingUser && existingUser !== username) {
        log.warn(`登录拒绝: IP ${ip} 已绑定用户 "${existingUser}"，尝试使用 "${username}"`);
        return json(res, 400, { error: `该IP已绑定用户 "${existingUser}"，请使用该用户名登录`, boundUser: existingUser });
    }

    // 检查用户名是否被其他 IP 占用（查 DB）
    let dbUser;
    try {
        dbUser = await usersCol.findOne({ username });
    } catch (err) {
        log.error(`查询用户表失败: ${err.message}`);
        return json(res, 500, { error: '数据库查询失败' });
    }
    if (dbUser && dbUser.ip && dbUser.ip !== ip) {
        log.warn(`登录拒绝: 用户名 "${username}" 已被 IP ${dbUser.ip} 占用，当前 IP ${ip}`);
        return json(res, 400, { error: `用户名 "${username}" 已被其他IP使用` });
    }

    // 创建用户目录
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
        log.info(`创建用户目录: ${userDir}`);
    }

    // 写入/更新 users 表（upsert）
    const now = Date.now();
    const defaultMoney = await getConfig('defaultMoney');
    try {
        const upResult = await usersCol.updateOne(
            { username },
            { $set: { ip, lastLogin: now }, $setOnInsert: { createdAt: now, money: defaultMoney } },
            { upsert: true }
        );
        if (upResult.upsertedCount > 0) {
            log.info(`新用户注册成功，写入 users 表，IP: ${ip}`);
        } else {
            log.info(`用户登录成功，更新 users 表，IP: ${ip}`);
        }
    } catch (err) {
        log.error(`写入 users 表失败: ${err.message}`);
        return json(res, 500, { error: '数据库写入失败' });
    }

    // 创建 session（内存，重启失效）
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username, ip, createdAt: now });
    userByIP.set(ip, username);

    log.info(`登录完成，session 已创建`);

    // 获取金币余额
    const userDoc = await usersCol.findOne({ username }, { projection: { money: 1 } });
    json(res, 200, { success: true, token, username, money: userDoc ? (userDoc.money || 0) : defaultMoney });
}

function handleCheckSession(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) {
        getLogger('system').warn('check-session 失败: token 无效或已过期');
        return json(res, 401, { error: '未登录' });
    }
    json(res, 200, { username: session.username, ip: session.ip });
}

async function handleUserInfo(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    try {
        const userDoc = await usersCol.findOne({ username: session.username }, { projection: { money: 1 } });
        json(res, 200, {
            username: session.username,
            money: userDoc ? (userDoc.money || 0) : 0,
        });
    } catch (err) {
        return json(res, 500, { error: '查询失败' });
    }
}

async function handleCheckIP(req, res) {
    const ip = getClientIP(req);
    const existingUser = userByIP.get(ip);

    let username = existingUser || null;
    if (!username) {
        try {
            const dbUser = await usersCol.findOne({ ip });
            if (dbUser) username = dbUser.username;
        } catch (err) {
            getLogger('system').error(`check-ip 查询数据库失败: ${err.message}`);
        }
    }

    const dir = username ? getUserDir(username) : null;

    json(res, 200, {
        ip,
        hasUser: !!username,
        username,
        userDirExists: dir ? fs.existsSync(dir) : false,
    });
}

async function handleQueueStatus(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    const log = getLogger(session.username);
    try {
        const userItems = await queueCol.find({ username: session.username }).sort({ queueId: -1 }).toArray();
        const globalActive = await queueCol.countDocuments({ status: { $in: [1, 2] } });
    const maxUserQueue = await getConfig('maxUserQueue');
    const maxGlobalQueue = await getConfig('maxGlobalQueue');

    json(res, 200, {
        globalQueueLength: globalActive,
        userQueueLength: userItems.length,
        maxUserQueue,
        maxGlobalQueue,
        userCanQueue: userItems.length < maxUserQueue && globalActive < maxGlobalQueue,
        items: userItems.map(item => {
            return {
                id: item.queueId,
                dbId: item._id.toString(),
                prompt: item.prompt,
                status: item.status === 1 ? 'queued' : item.status === 2 ? 'processing' : item.status === 3 ? 'done' : 'failed',
                position: item.status === 3 ? 0 : item.queueId,
                createdAt: item.createdAt,
            };
        }),
    });
    } catch (err) {
        log.error(`查询队列状态失败: ${err.message}`);
        return json(res, 500, { error: '查询队列失败' });
    }
}

async function handleGenerate(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    const log = getLogger(session.username);
    const body = await parseBody(req);
    const prompt = (body.prompt || '').trim();
    if (!prompt) return json(res, 400, { error: '请输入提示词' });

    const width = parseInt(body.width) || 512;
    const height = parseInt(body.height) || 512;
    const numImages = Math.min(parseInt(body.num_images) || 1, 4);
    const initImage = body.initImage || null; // 图生图原图完整 URL
    const mode = body.mode || 'text2img';     // text2img | img2img
    const model = body.model || 'z-image';    // z-image | flux2klein
    const sessionId = body.sessionId || null;  // 关联的聊天会话 ID

    // 计算金币消耗：1024x1024 每张2金币，其他每张1金币
    const costPerImage = (width >= 1024 && height >= 1024) ? 2 : 1;
    const totalCost = costPerImage * numImages;

    try {
        const maxUserQueue = await getConfig('maxUserQueue');
        const maxGlobalQueue = await getConfig('maxGlobalQueue');
        const maxImagesPerUser = await getConfig('maxImagesPerUser');

        // Check global queue limit
        const globalActive = await queueCol.countDocuments({ status: { $in: [1, 2] } });
        if (globalActive >= maxGlobalQueue) {
            log.warn(`生图拒绝: 世界队列已满 (${globalActive}/${maxGlobalQueue})`);
            return json(res, 429, { error: `世界队列已满 (${globalActive}/${maxGlobalQueue})，请稍后再试` });
        }

        // Check user queue limit
        const userActive = await queueCol.countDocuments({ username: session.username, status: { $in: [1, 2] } });
        if (userActive >= maxUserQueue) {
            log.warn(`生图拒绝: 用户队列已满 (${userActive}/${maxUserQueue})`);
            return json(res, 429, { error: `你的队列已满 (${userActive}/${maxUserQueue})，请等待当前任务完成` });
        }

        // Check user total images limit（按实际图片张数统计，而非任务数）
        const doneAgg = await queueCol.aggregate([
            { $match: { username: session.username, status: 3 } },
            { $group: { _id: null, total: { $sum: '$numImages' } } }
        ]).toArray();
        const userDoneImages = doneAgg[0]?.total ?? 0;

        const activeAgg = await queueCol.aggregate([
            { $match: { username: session.username, status: { $in: [1, 2] } } },
            { $group: { _id: null, total: { $sum: '$numImages' } } }
        ]).toArray();
        const userQueuedImages = activeAgg[0]?.total ?? 0;

        const totalAfterSubmit = userDoneImages + userQueuedImages + numImages;
        if (maxImagesPerUser > 0 && totalAfterSubmit > maxImagesPerUser) {
            log.warn(`生图拒绝: 用户图片总数将超出上限 (已有${userDoneImages}+队列${userQueuedImages}+本次${numImages}=${totalAfterSubmit} > ${maxImagesPerUser})`);
            return json(res, 429, { error: `图片总数将超出限制 (已有${userDoneImages}+队列${userQueuedImages}+本次${numImages}=${totalAfterSubmit}/${maxImagesPerUser})，请删除旧图后再试` });
        }

        // Check user money
        const userDoc = await usersCol.findOne({ username: session.username });
        const userMoney = userDoc ? (userDoc.money || 0) : 0;
        if (userMoney < totalCost) {
            log.warn(`生图拒绝: 金币不足 (当前${userMoney}, 需要${totalCost})`);
            return json(res, 429, { error: `金币不足！当前 ${userMoney} 金币，本次需要 ${totalCost} 金币 (${costPerImage}/张 x ${numImages}张)` });
        }

        // Deduct money
        const deductResult = await usersCol.updateOne(
            { username: session.username, money: { $gte: totalCost } },
            { $inc: { money: -totalCost } }
        );
        if (deductResult.modifiedCount === 0) {
            log.warn(`生图拒绝: 金币扣除失败 (并发冲突)`);
            return json(res, 429, { error: '金币不足，请重试' });
        }

        // Insert into MongoDB with status=1 (queuing)
        queueCounter++;
        const doc = {
            queueId: queueCounter,
            username: session.username,
            ip: session.ip,
            prompt,
            width,
            height,
            numImages,
            initImage,
            mode,
            model,
            sessionId,
            status: 1,
            createdAt: Date.now(),
            result: [],
            error: null,
            completedAt: null,
        };

        const insertResult = await queueCol.insertOne(doc);

        log.info(`生图任务已提交 queueId=${doc.queueId} mode=${mode} model=${model} prompt="${prompt.slice(0, 50)}" size=${width}x${height} num=${numImages} cost=${totalCost}`);

        // 获取最新金币余额
        const updatedUser = await usersCol.findOne({ username: session.username }, { projection: { money: 1 } });

        json(res, 200, {
            success: true,
            queueId: doc.queueId,
            dbId: insertResult.insertedId.toString(),
            position: globalActive + 1,
            globalQueueLength: globalActive + 1,
            moneyLeft: updatedUser ? updatedUser.money : 0,
        });
    } catch (err) {
        log.error(`生图任务提交失败: ${err.message}`);
        return json(res, 500, { error: '提交生图任务失败' });
    }
}

// --- 参考图上传/查询/删除 ---

// POST /api/upload-ref-image — 上传参考图
async function handleUploadRefImage(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    const log = getLogger(session.username);
    const username = session.username;
    const userDir = getUserDir(username);
    const refDir = path.join(userDir, 'ref');

    try {
        const body = await parseBody(req);
        const imageData = body.image;
        if (!imageData) return json(res, 400, { error: '请提供图片数据' });

        // 解析 base64（支持 data:image/xxx;base64, 前缀）
        const matches = imageData.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
        if (!matches || !matches[2]) return json(res, 400, { error: '图片格式不支持，请使用 PNG/JPG/WEBP' });

        const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const base64Data = matches[2];
        const buffer = Buffer.from(base64Data, 'base64');

        // 限制 10MB
        if (buffer.length > 10 * 1024 * 1024) {
            return json(res, 400, { error: '图片大小不能超过 10MB' });
        }

        // 确保 ref 目录存在
        if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });

        const filename = `ref_${Date.now()}.${ext}`;
        const filepath = path.join(refDir, filename);
        fs.writeFileSync(filepath, buffer);

        const url = `/users/${username}/ref/${filename}`;

        // 写入数据库
        await refImagesCol.insertOne({
            username,
            filename,
            url,
            uploadedAt: Date.now(),
        });

        log.info(`参考图上传: ${filename} (${(buffer.length / 1024).toFixed(1)}KB)`);
        json(res, 200, { success: true, url, filename });
    } catch (err) {
        log.error(`参考图上传失败: ${err.message}`);
        json(res, 500, { error: '上传失败' });
    }
}

// GET /api/ref-images — 获取当前用户的参考图列表
async function handleGetRefImages(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    try {
        const images = await refImagesCol.find(
            { username: session.username },
            { projection: { _id: 0, url: 1, filename: 1, uploadedAt: 1 } }
        ).sort({ uploadedAt: -1 }).toArray();
        json(res, 200, { images });
    } catch (err) {
        json(res, 500, { error: '查询失败' });
    }
}

// POST /api/delete-ref-image — 删除参考图
async function handleDeleteRefImage(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    const log = getLogger(session.username);
    try {
        const body = await parseBody(req);
        const filename = body.filename;
        if (!filename) return json(res, 400, { error: '请提供文件名' });

        // 安全检查：文件名不能包含路径分隔符
        if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
            return json(res, 400, { error: '非法文件名' });
        }

        // 从数据库删除
        const delResult = await refImagesCol.deleteOne({
            username: session.username,
            filename,
        });
        if (delResult.deletedCount === 0) return json(res, 404, { error: '图片不存在' });

        // 从文件系统删除
        const filepath = path.join(getUserDir(session.username), 'ref', filename);
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

        log.info(`参考图删除: ${filename}`);
        json(res, 200, { success: true });
    } catch (err) {
        log.error(`参考图删除失败: ${err.message}`);
        json(res, 500, { error: '删除失败' });
    }
}

// --- 图生图会话 CRUD ---

// GET /api/chat-sessions — 获取用户会话列表
async function handleGetChatSessions(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    try {
        // 用聚合管道只取必要字段，避免 $size 逐文档计算
        const list = await chatSessionsCol.aggregate([
            { $match: { username: session.username } },
            { $sort: { updatedAt: -1 } },
            { $limit: 50 },
            { $project: { _id: 0, sessionId: 1, name: 1, createdAt: 1, updatedAt: 1, messageCount: { $size: '$messages' } } }
        ]).toArray();
        json(res, 200, { sessions: list });
    } catch (err) {
        json(res, 500, { error: '查询失败' });
    }
}

// GET /api/chat-session/:id — 获取单个会话详情（含消息）
async function handleGetChatSession(req, res, sessionId) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    try {
        const doc = await chatSessionsCol.findOne(
            { sessionId, username: session.username },
            { projection: { _id: 0 } }
        );
        if (!doc) return json(res, 404, { error: '会话不存在' });
        json(res, 200, doc);
    } catch (err) {
        json(res, 500, { error: '查询失败' });
    }
}

// POST /api/chat-session — 创建新会话
async function handleCreateChatSession(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    try {
        const body = await parseBody(req);
        const sessionId = 'sess_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        const now = Date.now();
        const doc = {
            sessionId,
            username: session.username,
            name: body.name || new Date(now).toLocaleString('zh-CN'),
            messages: [],
            currentInitImage: null,
            createdAt: now,
            updatedAt: now,
        };
        await chatSessionsCol.insertOne(doc);
        json(res, 200, { success: true, sessionId, name: doc.name });
    } catch (err) {
        json(res, 500, { error: '创建失败' });
    }
}

// PUT /api/chat-session/:id — 更新会话（追加消息、改名、更新参考图）
async function handleUpdateChatSession(req, res, sessionId) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    try {
        const body = await parseBody(req);
        const update = { updatedAt: Date.now() };

        if (body.name) update.name = body.name;
        if (body.currentInitImage !== undefined) update.currentInitImage = body.currentInitImage;
        if (body.messages) update.messages = body.messages;
        if (body.appendMessage) {
            // 追加单条消息
            await chatSessionsCol.updateOne(
                { sessionId, username: session.username },
                { $push: { messages: body.appendMessage }, $set: { updatedAt: Date.now() } }
            );
            // 如果是第一条用户消息，更新会话名
            const doc = await chatSessionsCol.findOne({ sessionId }, { projection: { messages: { $slice: 2 } } });
            if (doc && doc.messages.length <= 2 && body.appendMessage.role === 'user' && body.appendMessage.text) {
                const name = body.appendMessage.text.slice(0, 12);
                await chatSessionsCol.updateOne({ sessionId }, { $set: { name } });
            }
            json(res, 200, { success: true });
            return;
        }

        await chatSessionsCol.updateOne(
            { sessionId, username: session.username },
            { $set: update }
        );
        json(res, 200, { success: true });
    } catch (err) {
        json(res, 500, { error: '更新失败' });
    }
}

// DELETE /api/chat-session/:id — 删除会话
async function handleDeleteChatSession(req, res, sessionId) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    try {
        // 先查出会话文档，提取所有图片路径
        const doc = await chatSessionsCol.findOne({ sessionId, username: session.username });
        if (doc && doc.messages) {
            const relativePaths = new Set(); // 统一转为相对路径 /users/...
            for (const msg of doc.messages) {
                if (msg.imageUrl) relativePaths.add(toRelativePath(msg.imageUrl));
                if (msg.images && Array.isArray(msg.images)) msg.images.forEach(u => relativePaths.add(toRelativePath(u)));
            }
            if (doc.initImage) relativePaths.add(toRelativePath(doc.initImage));

            // 删除文件 + ref_images 记录
            for (const relPath of relativePaths) {
                try {
                    const filePath = path.join(USERS_DIR, relPath.replace(/^\/users\//, ''));
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (_) {}
                try {
                    await refImagesCol.deleteOne({ url: relPath, username: session.username });
                } catch (_) {}
            }
        }
        // 删除 queue 中该会话相关的未完成任务
        try {
            await queueCol.deleteMany({ sessionId, username: session.username, status: { $in: [1, 2] } });
        } catch (_) {}
        // 删除会话文档
        await chatSessionsCol.deleteOne({ sessionId, username: session.username });
        json(res, 200, { success: true });
    } catch (err) {
        json(res, 500, { error: '删除失败' });
    }
}

// 将完整 URL 或相对路径统一转为 /users/... 相对路径
function toRelativePath(url) {
    if (!url) return '';
    // http://192.168.x.x/users/xxx/...  →  /users/xxx/...
    try {
        const parsed = new URL(url, 'http://dummy');
        return parsed.pathname;
    } catch (_) {
        return url.startsWith('/') ? url : '/' + url;
    }
}

// --- GET /api/getImgQueue ---
// External worker calls this to fetch pending tasks (status=1) and mark them as status=2
// Uses findOneAndUpdate (atomic) to prevent duplicate pickup by multiple workers
async function handleGetImgQueue(req, res) {
    const log = getLogger('system');
    const limit = parseInt(req.url.split('?')[1]?.split('limit=')[1]) || 10;

    try {
        const pending = [];
        for (let i = 0; i < limit; i++) {
            const doc = await queueCol.findOneAndUpdate(
                { status: 1 },
                { $set: { status: 2 } },
                { sort: { createdAt: 1 }, returnDocument: 'before' }
            );
            if (!doc) break;
            pending.push(doc);
        }

        if (pending.length === 0) {
            return json(res, 200, { tasks: [] });
        }

        const ids = pending.map(t => t.queueId);
        log.info(`getImgQueue: 取出 ${pending.length} 个任务 (queueId: ${ids.join(',')}) 状态改为生成中`);

        const tasks = pending.map(t => ({
            queueId: t.queueId,
            username: t.username,
            ip: t.ip,
            prompt: t.prompt,
            width: t.width,
            height: t.height,
            numImages: t.numImages,
            initImage: t.initImage || null,
            mode: t.mode || 'text2img',
            model: t.model || 'z-image',
            status: 2,
            createdAt: t.createdAt,
        }));

        json(res, 200, { count: tasks.length, tasks });
    } catch (err) {
        log.error(`getImgQueue 失败: ${err.message}`);
        return json(res, 500, { error: '获取队列失败' });
    }
}

// --- POST /api/setImgComp ---
// External worker calls this when image generation is complete
// Body: { queueId, images: ["base64_or_url"...], error?: "..." }
async function handleSetImgComp(req, res) {
    const body = await parseBody(req);
    const queueId = parseInt(body.queueId);

    if (!queueId) {
        return json(res, 400, { error: '缺少 queueId' });
    }

    let doc;
    try {
        doc = await queueCol.findOne({ queueId });
    } catch (err) {
        getLogger('system').error(`setImgComp 查询失败 queueId=${queueId}: ${err.message}`);
        return json(res, 500, { error: '数据库查询失败' });
    }

    if (!doc) {
        return json(res, 404, { error: '任务不存在' });
    }

    const log = getLogger(doc.username);

    if (body.error) {
        try {
            await queueCol.updateOne(
                { queueId },
                { $set: { status: 4, error: body.error, completedAt: Date.now() } }
            );
            log.error(`setImgComp: 任务 queueId=${queueId} 生成失败: ${body.error}`);
        } catch (err) {
            log.error(`setImgComp 更新失败状态写入DB失败: ${err.message}`);
        }

        // SSE 推送失败通知
        sseBroadcast(doc.username, 'task_failed', { queueId, error: body.error });

        return json(res, 200, { success: true, queueId, status: 'failed' });
    }

    // Success - save images
    const images = body.images || [];
    if (images.length === 0) {
        await queueCol.updateOne(
            { queueId },
            { $set: { status: 4, error: 'No images returned', completedAt: Date.now() } }
        );
        log.error(`setImgComp: 任务 queueId=${queueId} 未返回图片`);

        sseBroadcast(doc.username, 'task_failed', { queueId, error: '未返回图片' });

        return json(res, 200, { success: true, queueId, status: 'failed' });
    }

    const userDir = getUserDir(doc.username);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    try {
        const savedImages = [];
        for (let i = 0; i < images.length; i++) {
            const imgData = images[i];
            if (imgData.startsWith('http://') || imgData.startsWith('https://')) {
                savedImages.push(imgData);
            } else {
                const base64 = imgData.includes(',') ? imgData.split(',')[1] : imgData;
                const filename = `img_${Date.now()}_${i}.png`;
                const filepath = path.join(userDir, filename);
                fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
                savedImages.push(`/users/${doc.username}/${filename}`);
            }
        }

        await queueCol.updateOne(
            { queueId },
            { $set: { status: 3, result: savedImages, completedAt: Date.now() } }
        );

        log.info(`setImgComp: 任务 queueId=${queueId} 完成，保存 ${savedImages.length} 张图片`);

        // === SSE 推送通知前端 ===
        sseBroadcast(doc.username, 'task_done', {
            queueId,
            images: savedImages,
        });

        json(res, 200, { success: true, queueId, status: 'done', images: savedImages });
    } catch (err) {
        log.error(`setImgComp: 任务 queueId=${queueId} 保存图片失败: ${err.message}`);

        // 也推送失败通知
        sseBroadcast(doc.username, 'task_failed', {
            queueId,
            error: err.message,
        });

        return json(res, 500, { error: '保存图片失败' });
    }
}

async function handleDeleteImage(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    const body = await parseBody(req);
    const imagePath = body.path;
    if (!imagePath) return json(res, 400, { error: '缺少图片路径' });

    // 安全检查：路径必须在用户目录下
    const filename = path.basename(imagePath);
    const userDir = getUserDir(session.username);
    const fullPath = path.join(userDir, filename);
    if (!fullPath.startsWith(userDir)) return json(res, 403, { error: '非法路径' });

    const log = getLogger(session.username);
    try {
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            log.info(`删除图片: ${filename}`);
        }
        // 尝试清理对应的已完成队列记录（按结果中包含该文件名匹配）
        try {
            await queueCol.deleteMany({
                username: session.username,
                status: 3,
                result: imagePath
            });
        } catch(e) {}
        json(res, 200, { success: true });
    } catch (err) {
        log.error(`删除图片失败: ${err.message}`);
        return json(res, 500, { error: '删除失败' });
    }
}

async function handleDeleteAllImages(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    const log = getLogger(session.username);
    const userDir = getUserDir(session.username);

    try {
        let deleted = 0;
        if (fs.existsSync(userDir)) {
            const files = fs.readdirSync(userDir).filter(f =>
                f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.webp')
            );
            for (const f of files) {
                try { fs.unlinkSync(path.join(userDir, f)); deleted++; } catch(e) {}
            }
        }
        // 清理 ref 子目录
        const refDir = path.join(userDir, 'ref');
        if (fs.existsSync(refDir)) {
            const refFiles = fs.readdirSync(refDir).filter(f =>
                f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.webp')
            );
            for (const f of refFiles) {
                try { fs.unlinkSync(path.join(refDir, f)); deleted++; } catch(e) {}
            }
        }

        // 清除该用户所有已完成的队列记录，重置图片数量限制
        const queueResult = await queueCol.deleteMany({ username: session.username, status: 3 });
        // 清除 ref_images 记录
        try { await refImagesCol.deleteMany({ username: session.username }); } catch(e) {}
        log.info(`一键删除: 清除 ${deleted} 张图片文件，清除 ${queueResult.deletedCount} 条已完成队列记录`);

        json(res, 200, { success: true, deleted });
    } catch (err) {
        log.error(`一键删除失败: ${err.message}`);
        return json(res, 500, { error: '删除失败' });
    }
}

async function handleGetResult(req, res, queueId) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    const doc = await queueCol.findOne({ queueId: parseInt(queueId) });
    if (!doc || doc.username !== session.username) {
        return json(res, 404, { error: '任务不存在' });
    }

    const statusStr = doc.status === 1 ? 'queued' : doc.status === 2 ? 'processing' : doc.status === 3 ? 'done' : 'failed';

    json(res, 200, {
        id: doc.queueId,
        dbId: doc._id.toString(),
        status: statusStr,
        prompt: doc.prompt,
        width: doc.width,
        height: doc.height,
        images: doc.result || [],
        error: doc.error || null,
    });
}

async function handleUserImages(req, res) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    const session = sessions.get(token);
    if (!session) return json(res, 401, { error: '未登录' });

    const userDir = getUserDir(session.username);
    if (!fs.existsSync(userDir)) return json(res, 200, { images: [] });

    const files = fs.readdirSync(userDir)
        .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.webp'))
        .sort()
        .reverse()
        .map(f => `/users/${session.username}/${f}`);

    json(res, 200, { images: files });
}

// --- Static file serving for user images ---
function serveStaticFile(req, res) {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);

    // 用户图片
    if (urlPath.startsWith('/users/')) {
        const filePath = path.join(__dirname, '..', urlPath);
        if (!filePath.startsWith(path.join(__dirname, '..', 'users'))) {
            return json(res, 403, { error: 'Forbidden' });
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
            return true;
        }
    }

    // 视频下载
    if (urlPath.startsWith('/api/video-file/')) {
        const filename = path.basename(urlPath);
        const filePath = path.join(VIDEO_DIR, filename);
        if (!filePath.startsWith(VIDEO_DIR)) return json(res, 403, { error: 'Forbidden' });
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const videoMimes = {
                '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
                '.webm': 'video/webm', '.m4v': 'video/mp4', '.ts': 'video/mp2t',
                '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp'
            };
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
                'Content-Type': videoMimes[ext] || 'application/octet-stream',
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
            });
            fs.createReadStream(filePath).pipe(res);
            return true;
        }
    }
    return false;
}

// --- Video management ---
const VIDEO_DIR = 'C:\\ClaudeWorkSpace\\download';
const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.mpg', '.mpeg', '.3gp'];

function handleGetVideos(req, res) {
    if (!fs.existsSync(VIDEO_DIR)) return json(res, 200, { videos: [] });

    const files = fs.readdirSync(VIDEO_DIR)
        .filter(f => VIDEO_EXTS.includes(path.extname(f).toLowerCase()))
        .map(f => {
            const stat = fs.statSync(path.join(VIDEO_DIR, f));
            return {
                name: f,
                size: stat.size,
                date: stat.mtime.toISOString(),
            };
        })
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    json(res, 200, { videos: files });
}

async function handleDeleteVideo(req, res) {
    const body = await parseBody(req);
    const filename = body.name;
    if (!filename) return json(res, 400, { error: '缺少文件名' });

    // 安全检查：只取文件名，防止路径遍历
    const safeName = path.basename(filename);
    const fullPath = path.join(VIDEO_DIR, safeName);
    if (!fullPath.startsWith(VIDEO_DIR)) return json(res, 403, { error: '非法路径' });

    try {
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            json(res, 200, { success: true });
        } else {
            json(res, 404, { error: '文件不存在' });
        }
    } catch (err) {
        json(res, 500, { error: '删除失败: ' + err.message });
    }
}

async function handleDeleteAllVideos(req, res) {
    if (!fs.existsSync(VIDEO_DIR)) return json(res, 200, { success: true, deleted: 0 });

    try {
        const files = fs.readdirSync(VIDEO_DIR)
            .filter(f => VIDEO_EXTS.includes(path.extname(f).toLowerCase()));
        let deleted = 0;
        for (const f of files) {
            try { fs.unlinkSync(path.join(VIDEO_DIR, f)); deleted++; } catch(e) {}
        }
        json(res, 200, { success: true, deleted });
    } catch (err) {
        json(res, 500, { error: '删除失败: ' + err.message });
    }
}

// --- Global queue status (public) ---
async function handleGlobalQueue(req, res) {
    const active = await queueCol.countDocuments({ status: { $in: [1, 2] } });
    const maxGlobal = await getConfig('maxGlobalQueue');
    const maxPerUser = await getConfig('maxUserQueue');
    json(res, 200, {
        totalActive: active,
        maxGlobal,
        maxPerUser,
    });
}

// --- Server ---
const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        return res.end();
    }

    try {
        // Static files
        if (serveStaticFile(req, res)) return;

        // API routes
        if (url === '/api/login' && method === 'POST') return await handleLogin(req, res);
        if (url === '/api/check-session' && method === 'GET') return handleCheckSession(req, res);
        if (url === '/api/user-info' && method === 'GET') return await handleUserInfo(req, res);
        if (url === '/api/check-ip' && method === 'GET') return await handleCheckIP(req, res);
        if (url === '/api/queue-status' && method === 'GET') return await handleQueueStatus(req, res);
        if (url === '/api/generate' && method === 'POST') return await handleGenerate(req, res);
        if (url === '/api/global-queue' && method === 'GET') return await handleGlobalQueue(req, res);
        if (url === '/api/user-images' && method === 'GET') return await handleUserImages(req, res);
        if (url === '/api/getImgQueue' && method === 'GET') return await handleGetImgQueue(req, res);
        if (url === '/api/setImgComp' && method === 'POST') return await handleSetImgComp(req, res);
        if (url === '/api/sse' && method === 'GET') return handleSSEConnect(req, res);
        if (url.startsWith('/api/result/') && method === 'GET') return await handleGetResult(req, res, url.split('/').pop());
        if (url === '/api/delete-image' && method === 'POST') return await handleDeleteImage(req, res);
        if (url === '/api/delete-all-images' && method === 'POST') return await handleDeleteAllImages(req, res);
        if (url === '/api/upload-ref-image' && method === 'POST') return await handleUploadRefImage(req, res);
        if (url === '/api/ref-images' && method === 'GET') return await handleGetRefImages(req, res);
        if (url === '/api/delete-ref-image' && method === 'POST') return await handleDeleteRefImage(req, res);

        // Chat session routes
        if (url === '/api/chat-sessions' && method === 'GET') return await handleGetChatSessions(req, res);
        if (url === '/api/chat-session' && method === 'POST') return await handleCreateChatSession(req, res);
        if (url.startsWith('/api/chat-session/') && method === 'GET') return await handleGetChatSession(req, res, url.split('/').pop());
        if (url.startsWith('/api/chat-session/') && method === 'PUT') return await handleUpdateChatSession(req, res, url.split('/').pop());
        if (url.startsWith('/api/chat-session/') && method === 'DELETE') return await handleDeleteChatSession(req, res, url.split('/').pop());

        // Video management routes
        if (url === '/api/videos' && method === 'GET') return handleGetVideos(req, res);
        if (url === '/api/delete-video' && method === 'POST') return await handleDeleteVideo(req, res);
        if (url === '/api/delete-all-videos' && method === 'POST') return await handleDeleteAllVideos(req, res);

        // Admin routes
        if (url === '/api/admin-login' && method === 'POST') return await handleAdminLogin(req, res);
        if (url === '/api/admin-check' && method === 'GET') return handleAdminCheck(req, res);
        if (url === '/api/admin-recharge' && method === 'POST') return await handleAdminRecharge(req, res);

        json(res, 404, { error: 'Not found' });
    } catch (err) {
        console.error('Server error:', err);
        getLogger('system').error(`未捕获请求错误 ${method} ${url}: ${err.message}`);
        json(res, 500, { error: '服务器内部错误' });
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n[ERROR] Port ${PORT} is already in use!`);
        console.error(`Please close the process using port ${PORT}, or run start.bat again.`);
        console.error(`You can also run: netstat -ano | findstr :8000`);
        process.exit(1);
    }
    throw err;
});

// --- Start ---
initMongo().then(() => {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`AI Image Server running on http://127.0.0.1:${PORT}`);
        console.log(`MongoDB: ${MONGO_URL}/${MONGO_DB}`);
        console.log(`Press Ctrl+C to stop.`);
    });
}).catch(err => {
    const log = getLogger('system');
    log.error(`MongoDB 连接失败: ${err.message}`);
    console.error('Please ensure MongoDB is running at', MONGO_URL);
    process.exit(1);
});

// --- 全局错误处理：防止未捕获异常导致进程崩溃 ---
process.on('uncaughtException', (err) => {
    console.error('[FATAL] 未捕获异常:', err);
    try { getLogger('system').error(`未捕获异常: ${err.message}\n${err.stack}`); } catch(e) {}
    // 不退出进程，保持服务运行
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[ERROR] 未处理的 Promise 拒绝:', reason);
    try { getLogger('system').error(`未处理的 Promise 拒绝: ${reason}`); } catch(e) {}
    // 不退出进程，保持服务运行
});
