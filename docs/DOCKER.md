# Docker Documentation

Career-Ops is fully containerized with Docker, supporting OpenAI API integration out of the box.

## Quick Start

### 1. Clone and Configure

```bash
git clone https://github.com/santifer/career-ops.git
cd career-ops

# Copy environment template
cp .env.example .env

# Edit .env with your OpenAI API key
# OPENAI_API_KEY=sk-proj-your-key-here
```

### 2. Create Your CV

Create `cv.md` in the project root with your CV in markdown format. This is the source of truth for all evaluations and PDF generation.

### 3. Configure Profile and Portals

```bash
# Copy configuration templates
cp config/profile.example.yml config/profile.yml
cp templates/portals.example.yml portals.yml

# Edit with your personal details
# Edit portals.yml with companies you want to track
```

### 4. Start with Docker Compose

```bash
# Build and start all services
docker compose up -d --build

# Check health
docker compose ps

# View logs
docker compose logs -f career-ops
```

### 5. Verify Installation

```bash
# Health check
curl http://localhost:3000/health

# Test evaluation
curl -X POST http://localhost:3000/api/evaluate \
  -H "Content-Type: application/json" \
  -d '{"urlOrJD": "https://jobs.example.com/job-123"}'
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    docker-compose.yml                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  career-ops  │  │   dashboard  │  │  batch-worker    │  │
│  │  (API:3000)  │  │   (TUI)      │  │  (scalable)      │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                  │                    │            │
│  ┌──────▼──────────────────▼────────────────────▼────────┐  │
│  │              Shared Volumes                           │  │
│  │  /app/data  /app/reports  /app/output  /app/config   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  Environment: OPENAI_API_KEY, BRIGHTDATA_*, etc.            │
└─────────────────────────────────────────────────────────────┘
```

## Services

### 1. career-ops (Main API)

The main application server providing REST API for job evaluation, PDF generation, and auto-apply.

**Port:** 3000 (configurable via `PORT` env var)

**Endpoints:**
- `GET /health` - Health check
- `POST /api/evaluate` - Evaluate a job offer
- `POST /api/auto-apply` - Full auto-apply with form filling
- `GET /api/reports` - List generated reports
- `GET /api/output/:file` - Access generated files

### 2. dashboard (Go TUI - Optional)

Terminal-based dashboard for browsing your pipeline.

**Start with:** `docker compose --profile dashboard up -d`

### 3. batch-worker (Optional)

Background worker for batch processing of multiple job offers.

**Start with:** `docker compose --profile batch up -d`

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENAI_API_KEY` | Your OpenAI API key | `sk-proj-...` |

### OpenAI Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_MODEL` | OpenAI model to use | `gpt-4o` |
| `OPENAI_MAX_TOKENS` | Maximum tokens per response | `8192` |
| `OPENAI_TEMPERATURE` | Response randomness (0-1) | `0.7` |

### Application Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Node.js environment | `production` |
| `PORT` | API server port | `3000` |
| `LOG_LEVEL` | Logging level | `info` |
| `RATE_LIMIT_RPM` | Rate limit (requests/min) | `60` |

### Playwright Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PLAYWRIGHT_HEADLESS` | Run browser headless | `true` |
| `PLAYWRIGHT_BROWSERS_PATH` | Browser install path | `/ms-playwright` |

### Bright Data Proxy (Optional)

For bypassing bot protection on job portals.

| Variable | Description | Example |
|----------|-------------|---------|
| `BRIGHTDATA_HOST` | Proxy host | `brd.superproxy.io` |
| `BRIGHTDATA_PORT` | Proxy port | `33335` |
| `BRIGHTDATA_USERNAME` | Proxy username | `brd-customer-xxx-zone-yyy` |
| `BRIGHTDATA_PASSWORD` | Proxy password | `your-password` |

### Batch Processing

| Variable | Description | Default |
|----------|-------------|---------|
| `BATCH_PARALLEL` | Parallel workers | `1` |
| `BATCH_MAX_RETRIES` | Max retry attempts | `2` |

## Usage Examples

### Evaluate a Job Offer

```bash
curl -X POST http://localhost:3000/api/evaluate \
  -H "Content-Type: application/json" \
  -d '{"urlOrJD": "https://jobs.lever.co/company/job-id"}'
```

### Auto-Apply to a Job

```bash
curl -X POST http://localhost:3000/api/auto-apply \
  -H "Content-Type: application/json" \
  -d '{
    "urlOrJD": "https://jobs.lever.co/company/job-id",
    "autoFill": true
  }'
```

### Generate a Tailored CV

```bash
curl -X POST http://localhost:3000/api/pdf \
  -H "Content-Type: application/json" \
  -d '{"company": "Example Corp", "role": "Senior Engineer"}'
```

### Scan Job Portals

```bash
curl -X POST http://localhost:3000/api/scan
```

## Volume Mounts

The following directories are mounted for persistence and customization:

| Host Path | Container Path | Access | Purpose |
|-----------|---------------|--------|---------|
| `./data` | `/app/data` | rw | Application data |
| `./reports` | `/app/reports` | rw | Evaluation reports |
| `./output` | `/app/output` | rw | Generated PDFs/screenshots |
| `./config` | `/app/config` | rw | Configuration files |
| `./modes` | `/app/modes` | ro | Claude mode definitions |
| `./templates` | `/app/templates` | ro | CV and portal templates |
| `./fonts` | `/app/fonts` | ro | Fonts for PDF generation |
| `./batch` | `/app/batch` | rw | Batch processing files |
| `./portals.yml` | `/app/portals.yml` | ro | Portal scanner config |
| `./cv.md` | `/app/cv.md` | ro | Your CV |

## Docker Profiles

Use Docker Compose profiles to start specific service combinations:

```bash
# Main API only (default)
docker compose up -d

# With dashboard
docker compose --profile dashboard up -d

# With batch worker
docker compose --profile batch up -d

# All services
docker compose --profile dashboard --profile batch up -d
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker compose logs career-ops

# Validate environment
node scripts/validate-env.js

# Rebuild
docker compose down && docker compose up -d --build
```

### OpenAI API errors

```bash
# Verify API key is set
docker compose exec career-ops env | grep OPENAI

# Test API connectivity
docker compose exec career-ops node -e "
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  openai.models.list().then(m => console.log('API OK')).catch(e => console.error(e));
"
```

### Permission issues

```bash
# Fix ownership
sudo chown -R $(id -u):$(id -g) data reports output config
```

### Port already in use

```bash
# Change port in .env
PORT=3001

# Or override on command line
PORT=3001 docker compose up -d
```

### Browser/Playwright issues

```bash
# Rebuild without cache
docker compose build --no-cache

# Check browser installation
docker compose exec career-ops ls -la /ms-playwright
```

## Development Mode

For development with hot reload:

```bash
docker compose down
docker compose run --rm -p 3000:3000 \
  -v $(pwd)/src:/app/src \
  career-ops node --watch src/server.js
```

## Backup and Restore

```bash
# Backup data
docker compose run --rm -v $(pwd)/backup:/backup \
  career-ops tar czf /backup/career-ops-data.tar.gz /app/data /app/reports /app/output

# Restore data
docker compose down
rm -rf data/* reports/* output/*
tar xzf backup/career-ops-data.tar.gz -C /
docker compose up -d
```

## Security Notes

1. **Never commit `.env` file** - It contains your API keys
2. **Use environment variables** - Don't hardcode secrets in docker-compose.yml
3. **Rotate API keys** - If accidentally exposed
4. **Non-root user** - Container runs as `career-ops` user for security
5. **Network isolation** - Services communicate via Docker network

## Performance Tuning

### Increase Batch Parallelism

```env
# In .env
BATCH_PARALLEL=4
```

### Adjust Rate Limiting

```env
# In .env (requests per minute)
RATE_LIMIT_RPM=100
```

### Use Faster Model

```env
# In .env (faster but less capable)
OPENAI_MODEL=gpt-4o-mini
```

## Migration from Claude Code

If you're migrating from the original Claude Code setup:

1. Copy your `cv.md` to the project root
2. Copy `config/profile.yml` from your Claude Code setup
3. Copy `portals.yml` if customized
4. Start with Docker - all data is compatible

## Multi-Host Deployment

For production deployment, consider:

- Using Docker Swarm or Kubernetes for orchestration
- Adding a reverse proxy (nginx/traefik) for TLS
- Using external volumes (NFS/EBS) for persistence
- Setting up monitoring (Prometheus/Grafana)