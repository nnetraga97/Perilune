FROM node:22.23.1-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

WORKDIR /workspace
ENV NODE_ENV=development
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 \
  && case "$TARGETARCH" in \
    amd64) KTX_ARCHIVE_ARCH=x86_64; KTX_ARCHIVE_SHA256=a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245 ;; \
    arm64) KTX_ARCHIVE_ARCH=arm64; KTX_ARCHIVE_SHA256=60382e7b842177b8048bd58ccdc770383f8ef65b94452a25d3afdb55f2405c5a ;; \
    *) echo "Unsupported planet compiler architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && KTX_ARCHIVE_URL="https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-${KTX_ARCHIVE_ARCH}.tar.bz2" \
  && curl --fail --location "$KTX_ARCHIVE_URL" --output /tmp/ktx.tar.bz2 \
  && echo "$KTX_ARCHIVE_SHA256  /tmp/ktx.tar.bz2" | sha256sum --check --strict \
  && mkdir -p /opt/ktx \
  && tar --extract --bzip2 --file /tmp/ktx.tar.bz2 --directory /opt/ktx --strip-components=1 \
  && rm -f /tmp/ktx.tar.bz2 \
  && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/ktx/bin:$PATH
ENV LD_LIBRARY_PATH=/opt/ktx/lib

RUN case "$TARGETARCH:$(uname -m)" in amd64:x86_64|arm64:aarch64) ;; *) exit 1 ;; esac \
  && ktx --version

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN test "$(./node_modules/.bin/gltf-transform --version)" = "4.3.0"
RUN node -e "if (require('./node_modules/@gltf-transform/functions/package.json').version !== '4.3.0') process.exit(1)"

COPY . .
CMD ["npm", "run", "compile:planet-assets"]
