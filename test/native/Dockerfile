FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash zsh fish dbus gnome-keyring ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN printf '#!/bin/sh\nexec node /project/dist/bin.js "$@"\n' > /usr/local/bin/harness \
    && chmod +x /usr/local/bin/harness
WORKDIR /project
CMD ["bash", "test/native/run.sh"]
