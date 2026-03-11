FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xdotool x11-utils ffmpeg wget gnupg ca-certificates fonts-liberation \
    x11-xserver-utils unclutter-xfixes \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome
RUN wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY container-server.js package.json ./
RUN npm install --production

HEALTHCHECK --interval=2s --timeout=3s CMD node -e "const http=require('http');const r=http.get({socketPath:'/sockets/preview.sock',path:'/health'},s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(2000,()=>process.exit(1))" || exit 1

VOLUME /sockets

CMD ["node", "container-server.js"]
