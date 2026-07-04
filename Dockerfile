FROM python:3.13-slim

WORKDIR /app

# Install deps first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code + static assets (index.html, react/babel bundles, etc.)
COPY server.py index.html ./
COPY *.js ./

# Bind to all interfaces inside the container so the host port mapping works.
# Keys are supplied at run time (env -e INFOBLOX_API_KEY, or the in-app encrypted
# vault), never baked in.
# Version string shown in the UI footer; CI passes 1.0.<git-commit-count>.
ARG APP_VERSION=dev
ENV HOST=0.0.0.0 \
    PORT=8080 \
    VAULT_DIR=/vault \
    APP_VERSION=${APP_VERSION}

# Encrypted vault lives here; mount a named volume (-v noc-vault:/vault) so tenant
# keys survive container restarts and image updates.
VOLUME /vault

EXPOSE 8080

CMD ["python", "server.py"]
