# AI Image Server

## Project Overview

AI Image Server (`ai-image-server`) is a Node.js HTTP server that provides task queue management for AI image generation. It acts as a central coordinator between users submitting image generation requests and external worker processes that perform the actual AI generation.

**Key Characteristics:**
- Pure Node.js implementation using native `http` module (no Express.js)
- MongoDB for persistent storage of users, tasks, and configuration
- File system storage for generated images
- Session-based authentication with IP binding (one IP = one user)
- Queue-based task management with configurable limits

## Technology Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Node.js | >= 20.19.0 |
| Database | MongoDB | (server) + mongodb driver ^7.1.1 |
| HTTP Server | Node.js native `http` | built-in |
| OS | Windows (primary) | Batch scripts provided |

## Project Structure

```
c:\NginxData\server/
├── server.js           # Main application entry point (~520 lines)
├── package.json        # Project metadata and dependencies
├── package-lock.json   # Locked dependency versions
├── start.bat           # Windows startup script
├── stop.bat            # Windows shutdown script
├── WorkSpace/          # Empty directory (reserved for future use)
└── node_modules/       # npm dependencies

External dependencies:
../users/               # User directories for storing generated images
                       # (created at runtime, outside server directory)
```

## Configuration

### Server Configuration (Hardcoded in `server.js`)

```javascript
const PORT = 8000;
const USERS_DIR = path.join(__dirname, '..', 'users');  // ../users/
const MONGO_URL = 'mongodb://127.0.0.1:27017';
const MONGO_DB = 'ai_image_studio';
```

### Default System Configuration (Stored in MongoDB `config` collection)

| Key | Default | Description |
|-----|---------|-------------|
| `maxUserQueue` | 3 | Max concurrent/pending tasks per user |
| `maxGlobalQueue` | 50 | Max concurrent/pending tasks globally |

## Build and Run Commands

### Prerequisites

1. Install Node.js (>= 20.19.0)
2. Install and start MongoDB on `mongodb://127.0.0.1:27017`

### Installation

```bash
npm install
```

### Start Server

**Via npm:**
```bash
npm start
```

**Via Windows batch (recommended on Windows):**
```bash
start.bat
```
The batch script will:
1. Check and kill any existing process on port 8000
2. Start the server
3. Display server URL (http://127.0.0.1:8000)

### Stop Server

**Via Windows batch:**
```bash
stop.bat
```

**Manual:** Press `Ctrl+C` in the terminal or kill process on port 8000.

## API Endpoints

### User Authentication

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/login` | Login with username, binds IP to user | No |
| GET | `/api/check-session` | Verify session token | Yes |
| GET | `/api/check-ip` | Check if IP has associated user | No |

### Task Management

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/generate` | Submit image generation task | Yes |
| GET | `/api/queue-status` | Get user's queue status | Yes |
| GET | `/api/result/{queueId}` | Get task result by ID | Yes |
| GET | `/api/user-images` | List user's generated images | Yes |
| GET | `/api/global-queue` | Get global queue status | No |

### Worker API (For External Image Generators)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/getImgQueue?limit=N` | Fetch pending tasks (status=1), marks them as processing (status=2) |
| POST | `/api/setImgComp` | Submit completed task results |

### Static Files

| Pattern | Description |
|---------|-------------|
| `/users/{username}/{filename}` | Serve generated images (PNG, JPG, JPEG, WEBP) |

## Task Status Codes

| Status | Meaning | Description |
|--------|---------|-------------|
| 1 | queued | Task waiting in queue |
| 2 | processing | Task being processed by worker |
| 3 | done | Task completed successfully |
| 4 | failed | Task failed with error |

## Database Schema

### Collection: `users`

```javascript
{
  username: String,      // Unique, sanitized (max 30 chars)
  ip: String,            // IP address binding
  lastLogin: Number,     // Timestamp
  createdAt: Number      // Timestamp
}
```

Indexes: `username` (unique), `ip`

### Collection: `img_queue`

```javascript
{
  queueId: Number,       // Auto-incrementing ID
  username: String,      // Task owner
  ip: String,            // User's IP
  prompt: String,        // Generation prompt
  width: Number,         // Image width (default 512)
  height: Number,        // Image height (default 512)
  numImages: Number,     // Number of images (max 4)
  status: Number,        // 1=queued, 2=processing, 3=done, 4=failed
  createdAt: Number,     // Timestamp
  completedAt: Number,   // Timestamp (when done/failed)
  result: Array,         // Array of image paths/URLs
  error: String          // Error message if failed
}
```

Indexes: `queueId` (unique), `status`, `username`, `createdAt`

### Collection: `config`

```javascript
{
  key: String,           // Configuration key
  value: Any,            // Configuration value
  updatedAt: Number      // Timestamp
}
```

Indexes: `key` (unique)

## Authentication

The server uses a simple session-based authentication:

1. **Login Flow:**
   - User sends `POST /api/login` with `{ username }`
   - Server sanitizes username (allows Chinese chars, alphanumeric, `_`, `-`, spaces)
   - Server binds IP to username (one IP = one user, enforced)
   - Server returns `{ token, username }`
   - Token must be included in subsequent requests via `Authorization: Bearer {token}` header

2. **Session Storage:**
   - Sessions stored in-memory (`Map`)
   - Sessions are lost on server restart (non-persistent)
   - IP-to-username mapping is restored from database on startup

3. **IP Binding:**
   - Each IP can only be associated with one username
   - Each username can only be used by one IP
   - Checked on login and enforced throughout

## Worker Integration

External AI image generation workers interact with the server via two endpoints:

### 1. Fetch Tasks

```http
GET /api/getImgQueue?limit=10
```

Response:
```json
{
  "count": 2,
  "tasks": [
    {
      "queueId": 1,
      "username": "user1",
      "ip": "192.168.1.1",
      "prompt": "a cat",
      "width": 512,
      "height": 512,
      "numImages": 1,
      "status": 2,
      "createdAt": 1711523456789
    }
  ]
}
```

Note: Tasks are automatically marked as `status=2` (processing) when fetched.

### 2. Submit Results

```http
POST /api/setImgComp
Content-Type: application/json

{
  "queueId": 1,
  "images": ["base64_encoded_image_or_url", ...]
}
```

Or for failures:
```json
{
  "queueId": 1,
  "error": "Out of memory"
}
```

## Code Style Guidelines

### Naming Conventions
- Variables/functions: camelCase (`handleLogin`, `userByIP`)
- Constants: UPPER_SNAKE_CASE (`PORT`, `DEFAULT_CONFIG`)
- Database collections: snake_case (`img_queue`)

### Comments
- Chinese comments used for business logic explanations
- English comments for technical/config sections

### Error Handling
- Use try-catch in route handlers
- Return JSON error responses with appropriate HTTP status codes
- Log errors to console with `[init]` or `[ERROR]` prefixes

### Async Patterns
- Prefer `async/await` over callbacks
- MongoDB operations are all async

## Security Considerations

1. **No HTTPS**: Server runs HTTP only on localhost (127.0.0.1)
2. **IP Binding**: Users are bound to IP addresses, preventing account sharing
3. **Path Traversal Protection**: Static file serving validates path is within `../users/`
4. **CORS**: Enabled for all origins (`Access-Control-Allow-Origin: *`)
5. **Input Sanitization**: Usernames are sanitized to remove special characters
6. **No Rate Limiting**: No built-in rate limiting (relies on queue limits)

## Development Notes

### Port Conflicts
If port 8000 is in use, the server will exit with error code 1. Use `start.bat` to automatically kill existing processes.

### MongoDB Connection
Server will exit if MongoDB is not available. Check console for:
```
[init] MongoDB 连接完成: mongodb://127.0.0.1:27017/ai_image_studio
```

### Image Storage
- Generated images are saved to `../users/{username}/`
- Filenames: `img_{timestamp}_{index}.png`
- Supports base64 images and URLs from workers

### Session Loss on Restart
Since sessions are stored in-memory, users will need to re-login after server restart. The IP-to-username binding is persistent (stored in DB).

## Testing

No automated test suite is currently included. Manual testing approach:

1. Start MongoDB
2. Run `npm start`
3. Test endpoints with curl or Postman:

```bash
# Login
curl -X POST http://127.0.0.1:8000/api/login \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser"}'

# Check session
curl http://127.0.0.1:8000/api/check-session \
  -H "Authorization: Bearer {token}"

# Submit task
curl -X POST http://127.0.0.1:8000/api/generate \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat", "width": 512, "height": 512, "num_images": 1}'
```
