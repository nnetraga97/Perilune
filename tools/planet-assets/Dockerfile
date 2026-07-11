FROM node:22.23.1-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

WORKDIR /workspace
ENV NODE_ENV=development
ENV KTX_ARCHIVE_SHA256=a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245
ENV KTX_ARCHIVE_URL=https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-x86_64.tar.bz2

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 \
  && curl --fail --location "$KTX_ARCHIVE_URL" --output /tmp/ktx.tar.bz2 \
  && echo "$KTX_ARCHIVE_SHA256  /tmp/ktx.tar.bz2" | sha256sum --check --strict \
  && mkdir -p /opt/ktx \
  && tar --extract --bzip2 --file /tmp/ktx.tar.bz2 --directory /opt/ktx --strip-components=1 \
  && rm -f /tmp/ktx.tar.bz2 \
  && rm -rf /var/lib/apt/lists/*

ENV PATH=/opt/ktx/bin:$PATH
ENV LD_LIBRARY_PATH=/opt/ktx/lib

RUN test "$(uname -m)" = "x86_64" && ktx --version

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
CMD ["npm", "run", "compile:planet-assets"]
