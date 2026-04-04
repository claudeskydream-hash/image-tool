# AI Image Studio - 后台全局队列接入文档

## 概述

AI Image Studio 采用前后端分离架构，前端由 Nginx 提供静态页面，后端为 Node.js 服务（端口 `8000`），负责用户认证、队列管理和图片生成调度。

```
用户浏览器  ──▶  Nginx (:80)  ──▶  Node.js 后端 (:8000)  ──▶  图片生成后端 (:7860)
                 │                    │
                 ├─ 静态页面           ├─ 用户认证 / IP 绑定
                 ├─ /api/* 代理转发    ├─ 全局队列管理
                 └─ /users/* 代理转发  ├─ 任务调度
                                      └─ 图片文件存储
```

## 系统架构

### 目录结构

```
C:/NginxData/
├── index.html              # 前端页面（登录 + 生图 + 队列）
├── server/
│   ├── server.js           # Node.js 后端主程序
│   ├── package.json
│   └── start.bat           # 启动脚本
├── users/                  # 用户数据目录
│   ├── {用户名}/
│   │   ├── info.json       # 用户信息（用户名、IP、注册时间）
│   │   ├── img_xxx_0.png   # 生成的图片
│   │   └── ...
│   └── ...
└── doc/
    └── backend-queue-api.md  # 本文档
```

### 服务依赖

| 服务 | 端口 | 说明 |
|------|------|------|
| Nginx | 80 | 静态页面 + 反向代理 |
| Node.js 后端 | 8000 | API 服务、队列管理 |
| 图片生成后端 | 7860 | Stable Diffusion WebUI API（需单独部署） |

---

## 全局队列机制

### 队列规则

| 规则 | 限制值 | 说明 |
|------|--------|------|
| 单用户最大并发 | **3** | 同一用户同时最多 3 个任务在队列中（排队中 + 生成中） |
| 全局最大并发 | **50** | 所有用户合计最多 50 个活跃任务 |
| 单次生成数量 | **1~4** | 每次请求可生成 1~4 张图片 |

### 队列状态流转

```
              ┌─────────┐
              │  queued  │  ← 任务入队
              └────┬─────┘
                   │ 开始处理
              ┌────▼─────┐
              │processing │  ← 调用图片生成后端
              └────┬─────┘
                   │
           ┌───────┴───────┐
           │               │
      ┌────▼─────┐   ┌────▼────┐
      │   done   │   │ failed  │
      └──────────┘   └─────────┘
```

- **queued** — 已入队，等待处理
- **processing** — 正在调用图片生成 API
- **done** — 生成完成，图片已保存
- **failed** — 生成失败，记录错误信息

### 队列数据结构

```javascript
{
    id: Number,           // 队列自增 ID
    username: String,     // 所属用户
    ip: String,           // 用户 IP
    prompt: String,       // 提示词
    width: Number,        // 图片宽度
    height: Number,       // 图片高度
    numImages: Number,    // 生成数量
    status: String,       // queued | processing | done | failed
    createdAt: Number,    // 入队时间戳
    result: [String],     // 完成后的图片 URL 列表
    error: String,        // 失败时的错误信息
}
```

---

## API 接口文档

基础地址：`http://{服务器IP}/api/`

所有接口返回 JSON 格式数据。

### 1. 登录认证

#### POST /api/login

用户登录，用户名与 IP 绑定。

**请求体：**
```json
{
    "username": "myName"
}
```

**成功响应 (200)：**
```json
{
    "success": true,
    "token": "a1b2c3d4...",    // 64 位 hex token
    "username": "myName"
}
```

**失败响应 (400)：**
```json
{
    "error": "请输入用户名"
}
```

```json
{
    "error": "该IP已绑定用户 \"existingUser\"，请使用该用户名登录",
    "boundUser": "existingUser"
}
```

**规则：**
- 用户名不能为空，支持中文、英文、数字、下划线、连字符、空格
- 最长 30 字符
- 同一 IP 只能绑定一个用户名
- 同一用户名只能被一个 IP 使用
- 登录后在 `users/{用户名}/` 创建用户文件夹
- Token 用于后续所有需要认证的接口

---

#### GET /api/check-ip

检测当前 IP 是否已绑定用户（无需认证）。

**响应 (200)：**
```json
{
    "ip": "192.168.1.100",
    "hasUser": true,
    "username": "myName",
    "userDirExists": true
}
```

---

#### GET /api/check-session

验证当前 session 是否有效。

**请求头：**
```
Authorization: Bearer {token}
```

**成功响应 (200)：**
```json
{
    "username": "myName",
    "ip": "192.168.1.100"
}
```

**失败响应 (401)：**
```json
{
    "error": "未登录"
}
```

---

### 2. 队列管理

#### POST /api/generate

提交生图任务到队列。

**请求头：**
```
Authorization: Bearer {token}
Content-Type: application/json
```

**请求体：**
```json
{
    "prompt": "a cute cat on a windowsill",
    "width": 512,
    "height": 512,
    "num_images": 1
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| prompt | string | 是 | - | 图片生成提示词 |
| width | number | 否 | 512 | 图片宽度 |
| height | number | 否 | 512 | 图片高度 |
| num_images | number | 否 | 1 | 生成数量，最大 4 |

**成功响应 (200)：**
```json
{
    "success": true,
    "queueId": 7,
    "position": 3,
    "globalQueueLength": 12
}
```

| 字段 | 说明 |
|------|------|
| queueId | 任务 ID，用于后续查询结果 |
| position | 当前在全局队列中的排名 |
| globalQueueLength | 当前全局队列总长度 |

**队列出错响应 (429)：**
```json
{
    "error": "世界队列已满 (50/50)，请稍后再试"
}
```

```json
{
    "error": "你的队列已满 (3/3)，请等待当前任务完成"
}
```

---

#### GET /api/queue-status

查询当前用户的队列状态。

**请求头：**
```
Authorization: Bearer {token}
```

**响应 (200)：**
```json
{
    "globalQueueLength": 12,
    "userQueueLength": 2,
    "maxUserQueue": 3,
    "maxGlobalQueue": 50,
    "userCanQueue": true,
    "items": [
        {
            "id": 7,
            "prompt": "a cute cat...",
            "status": "processing",
            "position": 2,
            "createdAt": 1743100000000
        },
        {
            "id": 5,
            "prompt": "a sunset...",
            "status": "queued",
            "position": 8,
            "createdAt": 1743099900000
        }
    ]
}
```

| 字段 | 说明 |
|------|------|
| globalQueueLength | 全局活跃任务数（不含已完成） |
| userQueueLength | 当前用户的总任务数（含已完成） |
| userCanQueue | 用户是否还能提交新任务 |
| items[].position | 全局排名（已完成为 0） |

---

#### GET /api/result/{queueId}

查询指定任务的结果。

**请求头：**
```
Authorization: Bearer {token}
```

**响应 (200)：**
```json
{
    "id": 7,
    "status": "done",
    "prompt": "a cute cat...",
    "width": 512,
    "height": 512,
    "images": [
        "/users/myName/img_1743100000000_0.png"
    ],
    "error": null
}
```

status 为 `failed` 时：
```json
{
    "id": 7,
    "status": "failed",
    "prompt": "...",
    "width": 512,
    "height": 512,
    "images": [],
    "error": "connect ECONNREFUSED 127.0.0.1:7860"
}
```

---

#### GET /api/global-queue

查询全局队列概况（无需认证）。

**响应 (200)：**
```json
{
    "totalActive": 12,
    "maxGlobal": 50,
    "maxPerUser": 3
}
```

---

#### GET /api/user-images

获取当前用户的所有历史图片。

**请求头：**
```
Authorization: Bearer {token}
```

**响应 (200)：**
```json
{
    "images": [
        "/users/myName/img_1743100000000_0.png",
        "/users/myName/img_1743099900000_0.png"
    ]
}
```

图片按文件名倒序排列（最新在前）。

---

### 3. 图片文件访问

#### GET /users/{username}/{filename}

直接访问用户生成的图片文件，由后端提供静态文件服务，Nginx 反向代理。

**示例：**
```
GET /users/myName/img_1743100000000_0.png
```

支持格式：`.png`、`.jpg`、`.jpeg`、`.webp`

---

## 接入第三方图片生成后端

当前后端默认对接 **Stable Diffusion WebUI** 的 API（`http://127.0.0.1:7860/sdapi/v1/txt2img`）。

### 切换为其他后端

修改 `server.js` 中的 `processQueueItem` 函数：

```javascript
async function processQueueItem(item, username) {
    item.status = 'processing';
    const userDir = getUserDir(username);

    try {
        // ======= 在此处修改你的图片生成 API 地址和参数 =======
        const resp = await fetch('http://127.0.0.1:7860/sdapi/v1/txt2img', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: item.prompt,
                width: item.width,
                height: item.height,
                batch_size: item.numImages,
                steps: 20,
            }),
            signal: AbortSignal.timeout(300000),  // 5分钟超时
        });
        // ======================================================

        if (!resp.ok) throw new Error(`Backend HTTP ${resp.status}`);
        const data = await resp.json();

        // ======= 根据你的后端返回格式解析图片 =======
        const images = data.images || [];
        // ============================================

        if (images.length === 0) throw new Error('Backend returned no images');

        // 保存图片到用户目录
        const savedImages = [];
        for (let i = 0; i < images.length; i++) {
            const imgData = images[i];
            // SD WebUI 返回 base64，如有 data:image/png;base64, 前缀则去除
            const base64 = imgData.includes(',')
                ? imgData.split(',')[1]
                : imgData;
            const filename = `img_${Date.now()}_${i}.png`;
            fs.writeFileSync(
                path.join(userDir, filename),
                Buffer.from(base64, 'base64')
            );
            savedImages.push(`/users/${username}/${filename}`);
        }

        item.status = 'done';
        item.result = savedImages;
    } catch (err) {
        console.error(`Queue ${item.id} error:`, err.message);
        item.status = 'failed';
        item.error = err.message;
    }
}
```

### 常见后端对接示例

#### ComfyUI

```javascript
// ComfyUI 需要先提交 workflow 再轮询结果
const resp = await fetch('http://127.0.0.1:8188/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        prompt: { /* ComfyUI workflow JSON */ }
    }),
});
const { prompt_id } = await resp.json();
// 然后轮询 /history/{prompt_id} 获取结果
```

#### DALL-E / OpenAI API

```javascript
const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk-xxx',
    },
    body: JSON.stringify({
        model: 'dall-e-3',
        prompt: item.prompt,
        size: `${item.width}x${item.height}`,
        n: item.numImages,
        response_format: 'b64_json',
    }),
});
const data = await resp.json();
const images = data.data.map(d => d.b64_json);
```

---

## 前端轮询机制

前端使用定时轮询获取队列和结果状态：

| 轮询项 | 间隔 | 接口 | 说明 |
|--------|------|------|------|
| 用户队列状态 | 3 秒 | `GET /api/queue-status` | 更新队列面板排名和状态 |
| 全局队列概况 | 5 秒 | `GET /api/global-queue` | 更新导航栏队列计数 |
| 单任务结果 | 3 秒 | `GET /api/result/{id}` | 仅对排队中/处理中的任务轮询，完成后自动停止 |

---

## 认证机制

```
登录 ──▶ 获得 token（64位 hex）──▶ 存入 localStorage
                                      │
每次请求 ──▶ Authorization: Bearer {token} ──▶ 后端验证
```

- Token 存储在服务端内存中（`sessions` Map）
- 服务重启后所有 Token 失效，用户需重新登录
- IP 绑定关系也存储在内存中

---

## Nginx 配置参考

```nginx
server {
    listen 80;
    server_name localhost;

    # 前端静态页面
    location / {
        root C:/NginxData;
        index index.html;
    }

    # API 代理
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
        proxy_connect_timeout 10s;
    }

    # 用户图片代理
    location /users/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## 启动与维护

### 启动服务

```bash
# 1. 确保 Nginx 已启动
cd C:\nginx
nginx.exe

# 2. 启动后端（方式一：双击 bat）
C:\NginxData\server\start.bat

# 2. 启动后端（方式二：命令行）
cd C:\NginxData\server
node server.js
```

### 重启后端

`Ctrl+C` 终止当前进程后重新启动即可。注意：内存中的 session 和队列会丢失。

### 配置参数

在 `server.js` 文件顶部修改：

```javascript
const PORT = 8000;              // 后端监听端口
const MAX_USER_QUEUE = 3;       // 单用户最大并发数
const MAX_GLOBAL_QUEUE = 50;    // 全局最大并发数
```

---

## 错误码参考

| HTTP 状态码 | 含义 | 场景 |
|-------------|------|------|
| 200 | 成功 | 请求处理成功 |
| 400 | 参数错误 | 用户名为空、提示词为空 |
| 401 | 未认证 | Token 无效或过期 |
| 404 | 未找到 | 任务不存在 |
| 429 | 请求过多 | 队列已满（用户或全局） |
| 500 | 服务器错误 | 内部异常 |
