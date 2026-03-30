# ╔══════════════════════════════════════════════════════════════════════╗
# ║  Dockerfile — Student Prompt Hub AI v4.0                          ║
# ║  Hugging Face Docker Spaces | Node 18                             ║
# ║  By Propeak Digital Academy | Founder: Peculiar                   ║
# ╚══════════════════════════════════════════════════════════════════════╝

FROM node:18-slim

# ── System labels ──────────────────────────────────────────────────────
LABEL maintainer="Peculiar — Propeak Digital Academy"
LABEL description="Student Prompt Hub AI — Telegram Bot"
LABEL version="4.0.0"

# ── Install system dependencies ────────────────────────────────────────
# poppler-utils  → required by pdf2pic (pdftoppm binary)
# ffmpeg         → audio processing for voice notes
# python3        → required by some native Node addons
# make / g++     → required to build native npm packages (sharp, canvas)
# ghostscript    → required by pdf2pic as rendering backend
# ca-certificates → HTTPS requests from container
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    ghostscript \
    ffmpeg \
    python3 \
    python3-pip \
    make \
    g++ \
    ca-certificates \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ── Set working directory ──────────────────────────────────────────────
WORKDIR /app

# ── Copy dependency manifests first (layer caching) ───────────────────
COPY package*.json ./

# ── Install Node.js dependencies ──────────────────────────────────────
# --ignore-scripts=false ensures native modules (sharp) compile correctly
RUN npm install --omit=dev

# ── Copy application source ────────────────────────────────────────────
COPY . .

# ── Create tmp directory for TTS/PDF temp files ───────────────────────
RUN mkdir -p /tmp/sphai && chmod 777 /tmp/sphai

# ── Hugging Face Spaces runs as non-root user (uid 1000) ──────────────
RUN useradd -m -u 1000 botuser && chown -R botuser:botuser /app /tmp/sphai
USER 1000

# ── Expose port ────────────────────────────────────────────────────────
EXPOSE 8080

# ── Health check ──────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# ── Start the bot ─────────────────────────────────────────────────────
CMD ["node", "bot.js"]
