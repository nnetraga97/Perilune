FROM --platform=linux/amd64 node:22.23.1-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

WORKDIR /workspace
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
CMD ["npm", "run", "compile:planet-assets"]
