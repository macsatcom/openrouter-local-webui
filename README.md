# Family Chat

A self-hosted, multi-user AI chat web interface for the [OpenRouter API](https://openrouter.ai/). Chat with hundreds of LLMs, generate images, and manage users — all through a clean, minimal web UI.

## Features

- **Multi-user** with role-based access (admin / regular users)
- **Chat with any LLM** on OpenRouter — streaming responses, conversation history, model search
- **Image generation** with aspect ratio support + gallery + lightbox
- **Per-user model restrictions** — admins control which models each user can access
- **Spending limits** — set daily/monthly caps per user (in cents)
- **Skills** — admin-defined system prompts that override the AI's persona (homework helper, creative writer, etc.)
- **Chat & image logging** — optional logging with paginated history and user filtering
- **Dark theme** — near-black, minimal UI with warm brass accents

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/)

### Run

```bash
# Clone the repo
git clone https://github.com/macsatcom/family-chat.git
cd family-chat

# Start the server
docker compose up -d
```

Open **http://localhost:3000** in your browser.

### Set your API key

1. Register the first account — it automatically becomes **admin**
2. Go to the **Admin** panel → **Settings**
3. Enter your [OpenRouter API key](https://openrouter.ai/keys)
4. Select which models to enable for web search (optional)

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | `change-this-in-production` | Secret used to sign session cookies. **Change this in production.** |

### Persistent data

Two Docker volumes store your data:

- `family-chat-data` — SQLite database (users, conversations, logs, settings)
- `family-chat-images` — Generated image files

They persist across container restarts and updates.

## Run without cloning (pre-built image)

```bash
docker run -d \
  --name family-chat \
  -p 3000:3000 \
  -v family-chat-data:/app/data \
  -v family-chat-images:/app/generated-images \
  ghcr.io/macsatcom/family-chat:latest
```

Or use the `docker-compose.yml` from this repo:

```bash
curl -O https://raw.githubusercontent.com/macsatcom/family-chat/main/docker-compose.yml
docker compose up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
```

## Tech stack

- **Backend**: Node.js, Express 4
- **Database**: SQLite (better-sqlite3)
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Auth**: bcrypt + session cookies
- **API**: OpenRouter API (chat completions + image generation)

## License

MIT
