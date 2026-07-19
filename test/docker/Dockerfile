# End-to-end harness for ctx. Runs entirely inside the container against a
# throwaway $HOME, so it never touches the host's real ~/.claude* dirs.
# Build from the repo root:  docker build -f test/docker/Dockerfile -t ctx-e2e .
# Run:                       docker run --rm ctx-e2e
FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY test/docker/e2e.sh /usr/local/bin/e2e.sh
RUN chmod +x /usr/local/bin/e2e.sh

ENV HOME=/root
CMD ["/usr/local/bin/e2e.sh"]
