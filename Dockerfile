FROM python:3.13-slim

WORKDIR /app

# Install deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code + static assets (index.html, react/babel bundles, etc.)
COPY server.py index.html ./
# babel.min.js is .dockerignore'd on purpose (build-time only) — don't add it here.
COPY app.bundle.js ./
# Vendored ESM bundles, Astryx stylesheet and Geist fonts all live under assets/.
COPY assets/ ./assets/
# Seed/provision templates are third-party (ccmarris/uddi_automation_toolkit) —
# not committed to this repo; fetched at build. Mount a volume over /app/templates
# to supply customer templates instead.
COPY scripts/fetch_templates.py ./scripts/
RUN python scripts/fetch_templates.py

# Bind to all interfaces inside the container so the host port mapping works.
# Keys are supplied at run time (env -e INFOBLOX_API_KEY, or the in-app encrypted
# vault), never baked in.
# Version string shown in the UI footer; CI passes 1.0.<git-commit-count>.
ARG APP_VERSION=dev
ENV HOST=0.0.0.0 \
    PORT=8080 \
    VAULT_DIR=/vault \
    TEMPLATES_DIR=/app/templates \
    APP_VERSION=${APP_VERSION}

# Encrypted vault lives here; mount a named volume (-v noc-vault:/vault) so tenant
# keys survive container restarts and image updates.
VOLUME /vault

EXPOSE 8080

CMD ["python", "server.py"]
