FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    GAME_AUDIO_HOST=0.0.0.0 \
    GAME_AUDIO_PORT=4178 \
    GAME_AUDIO_DATA_DIR=/data \
    GAME_AUDIO_CONCURRENCY=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown node:node /data \
    && chmod -R a+rX /ms-playwright

COPY . .
USER node
RUN npm run doctor \
    && node --input-type=module -e "import {chromium} from 'playwright'; const browser=await chromium.launch({headless:true,args:['--no-sandbox']}); await browser.close();"

EXPOSE 4178
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=20s --start-period=30s --retries=3 \
  CMD node -e "const token=process.env.GAME_AUDIO_API_TOKEN||Object.values(JSON.parse(process.env.GAME_AUDIO_API_TOKENS_JSON||'{}'))[0];fetch('http://127.0.0.1:'+(process.env.GAME_AUDIO_PORT||4178)+'/v1/audio/health',{headers:token?{Authorization:'Bearer '+token}:{}}).then(async r=>{if(!r.ok||(await r.json()).renderer?.ready!==true)process.exitCode=1}).catch(()=>{process.exitCode=1})"

# A non-loopback service intentionally refuses startup without an injected token.
CMD ["node", "scripts/server.mjs"]
