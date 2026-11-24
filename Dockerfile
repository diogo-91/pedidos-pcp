# Serviço "Pedidos em aberto" (nomus-local) para rodar ao lado da intranet (EasyPanel/Docker).
# node:sqlite (embutido) exige Node >= 22.13. Sem dependências npm.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# O dia "de hoje" (vencido, atraso, janela das 6h às 20h da atualização) usa o relógio local.
RUN apk add --no-cache tzdata
ENV TZ=America/Sao_Paulo

COPY package.json ./
COPY src ./src
COPY public ./public
COPY config ./config

# Banco e log ficam no volume /data (monte um volume persistente aqui; sem ele os dados somem a cada deploy).
ENV NOMUS_LOCAL_DB=/data/nomus-local.sqlite
ENV PEDIDOS_HOST=0.0.0.0
ENV PEDIDOS_PORTA=3300
# Exigido por padrão: PEDIDOS_TOKEN (mesmo valor de PEDIDOS_PCP_TOKEN na intranet), NOMUS_BASE_URL, NOMUS_TOKEN,
# PEDIDOS_HOSTS_PERMITIDOS (nome interno do serviço, ex.: pedidos-pcp) e, para o assistente, GROK_API_KEY/GROK_MODELO.
VOLUME ["/data"]
EXPOSE 3300

# Roda sem root: o volume precisa ser gravável pelo usuário "node" (uid 1000).
RUN mkdir -p /data && chown node:node /data
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null --header="X-Pedidos-Token: $PEDIDOS_TOKEN" --header="Host: localhost" http://127.0.0.1:3300/api/atualizacao || exit 1

CMD ["node", "--no-warnings", "src/servidor.mjs"]
