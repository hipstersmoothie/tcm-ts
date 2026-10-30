# tcm's server: `tcm serve` of tcm's codebase, kept on a volume at /data, and tcm's docs site. It runs the tcm
# verify last passed (dist/known-good, packed as tcm-ts.tgz beside this file by `pnpm server:deploy`, which builds
# the site into site/ too).
FROM node:24-slim
WORKDIR /app
COPY tcm-ts.tgz start.sh ./
COPY site ./site
RUN npm init -y > /dev/null && npm install ./tcm-ts.tgz --omit=dev --no-audit --no-fund --loglevel=error
CMD ["sh", "/app/start.sh"]
