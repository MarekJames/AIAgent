# YT Shortsmith

A full-stack application for generating short video clips optimized for YouTube Shorts, TikTok, and other platforms. The project uses Next.js for the frontend, Node.js backend services, and Docker for containerized deployment.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start with Docker](#quick-start-with-docker)
- [Local Development Setup](#local-development-setup)
- [Project Structure](#project-structure)
- [Available Scripts](#available-scripts)
- [Environment Configuration](#environment-configuration)
- [API Overview](#api-overview)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### For Docker Deployment (Recommended)
- **Docker Desktop** - [Download & Install](https://www.docker.com/products/docker-desktop)
- **Docker Compose** - Included with Docker Desktop

### For Local Development
- **Node.js** v20+ - [Download & Install](https://nodejs.org/)
- **npm** or **yarn** - Comes with Node.js
- **PostgreSQL** 16+ - [Download & Install](https://www.postgresql.org/download/)
- **Redis** 7+ - [Download & Install](https://redis.io/download/)
- **FFmpeg** - [Download & Install](https://ffmpeg.org/download.html)
- **Python 3.9+** - [Download & Install](https://www.python.org/downloads/)

## Quick Start with Docker

### Step 1: Install Docker
Download and install **Docker Desktop** from [docker.com](https://www.docker.com/products/docker-desktop).

After installation, verify Docker is running:
```bash
docker --version
docker-compose --version
```

### Step 2: Configure Environment
Create a `.env.docker` file in the project root:
```bash
# Copy and customize the environment variables as needed
# See Environment Configuration section below
```

### Step 3: Run Docker Compose
Start all services (PostgreSQL, Redis, app, and workers):
```bash
docker-compose up -d
```

The `-d` flag runs services in detached mode (background).

### Step 4: View Logs
Monitor the application:
```bash
# View all logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f app
docker-compose logs -f worker
docker-compose logs -f db
```

### Step 5: Access the Application
- **Frontend**: http://localhost:5000
- **API**: http://localhost:5000/api

### Step 6: Stop Services
```bash
docker-compose down
```

To also remove volumes (database data):
```bash
docker-compose down -v
```

---

## Local Development Setup

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Set Up Database
Start PostgreSQL locally, then configure your `.env` file with:
```
DATABASE_URL="postgresql://user:password@localhost:5432/yt_shortsmith"
REDIS_URL="redis://localhost:6379"
```

### Step 3: Run Database Migrations
```bash
npm run db:push
```

Or use Prisma migrations:
```bash
npm run migrate
```

### Step 4: Start Development Servers

**Option A: Run both frontend and backend together**
```bash
npm run dev
```

**Option B: Run services separately**

Terminal 1 - Frontend (Next.js):
```bash
npm run dev
```

Terminal 2 - Backend Worker:
```bash
npm run worker
```

Terminal 3 - TikTok Worker (if needed):
```bash
npm run worker:tiktok
```

### Step 5: Access the Application
- **Frontend**: http://localhost:5000
- **API**: http://localhost:5000/api

---

## Project Structure

```
AIAgent/
├── app/                    # Next.js application
│   ├── api/               # API routes
│   ├── components/        # React components
│   └── [pages]/           # Page components
├── src/
│   ├── services/          # Business logic services
│   │   ├── youtube.ts     # YouTube integration
│   │   ├── tiktok.ts      # TikTok integration
│   │   ├── scoring/       # Clip scoring algorithms
│   │   └── detectors/     # ML model-based detectors
│   ├── lib/               # Utility functions
│   ├── server/            # Server-side utilities
│   └── worker*.ts         # Background job workers
├── prisma/                # Database schema
├── models/                # ML model files
├── docker-compose.yml     # Docker services configuration
├── Dockerfile             # Container build configuration
└── package.json           # Node.js dependencies
```

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js development server on port 5000 |
| `npm run build` | Build Next.js application for production |
| `npm start` | Start production server |
| `npm run worker` | Start background job worker |
| `npm run worker:tiktok` | Start TikTok-specific worker |
| `npm run migrate` | Run Prisma migrations |
| `npm run db:push` | Push schema changes to database |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run lint` | Run ESLint |

---

## Environment Configuration

### Docker Environment (`.env.docker`)

```env
# API Keys
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
OPENAI_API_KEY=your_openai_api_key

# AWS (for S3 storage)
AWS_ACCESS_KEY_ID=your_aws_key
AWS_SECRET_ACCESS_KEY=your_aws_secret
AWS_REGION=us-east-1
AWS_BUCKET_NAME=your_bucket_name

# OAuth Callbacks
NEXTAUTH_URL=http://localhost:5000
NEXTAUTH_SECRET=your_secret_key_here

# Session
SESSION_PASSWORD=your_session_password
```

### Local Development (`.env.local`)

Same variables as above, plus database URLs if not using Docker:
```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/yt_shortsmith"
REDIS_URL="redis://localhost:6379"
```

---

## API Overview

### Authentication
- `POST /api/auth/login` - Login endpoint
- `POST /api/auth/logout` - Logout endpoint
- `GET /api/auth/status` - Check authentication status
- `GET /api/auth/google/start` - Start Google OAuth flow
- `GET /api/auth/google/callback` - Google OAuth callback

### Videos
- `GET /api/videos` - List all videos
- `POST /api/videos` - Upload new video
- `GET /api/videos/[id]` - Get video details
- `POST /api/videos/[id]/retry` - Retry video processing
- `POST /api/videos/[id]/cancel` - Cancel video processing
- `POST /api/videos/batch-delete` - Batch delete videos

### Clips
- `GET /api/clips/[id]` - Get clip details
- `POST /api/clips/[id]/update-subs` - Update clip subtitles

### Connections
- `GET /api/me/connections` - List connected accounts

---

## Common Tasks

### View Database
Access PostgreSQL within Docker:
```bash
docker-compose exec db psql -U postgres -d yt_shortsmith
```

### View Redis Data
Access Redis within Docker:
```bash
docker-compose exec redis redis-cli
```

### Rebuild Docker Image
```bash
docker-compose up -d --build
```

### Generate Prisma Schema
```bash
npm run prisma:generate
```

---

## Troubleshooting

### Docker Issues

**Port Already in Use**
```bash
# Change ports in docker-compose.yml or find process using port
# Windows: netstat -ano | findstr :5000
# macOS/Linux: lsof -i :5000
```

**Database Connection Failed**
```bash
# Wait for database to be ready
docker-compose logs db
```

**Out of Memory**
```bash
# Increase Docker memory allocation in Docker Desktop settings
```

### Local Development Issues

**Redis Connection Error**
Ensure Redis is running:
```bash
# macOS
brew services start redis

# Windows (if installed via choco)
redis-server

# or Docker
docker run -d -p 6379:6379 redis:7
```

**FFmpeg Not Found**
Ensure FFmpeg is installed and in PATH:
```bash
ffmpeg -version
```

**Prisma Client Out of Sync**
Regenerate the Prisma client:
```bash
npm run prisma:generate
npm run db:push
```

---

## Performance Notes

- The application uses background workers for video processing
- Consider increasing worker instances for production deployments
- Redis is used for job queuing and caching
- ML models are cached locally in the `models/` directory

---

## Support

For issues or questions, please open an issue on GitHub or contact the development team.
