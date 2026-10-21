# --- Etapa base: dependencias completas y cliente de Prisma generado. --------
# El CLI de Prisma vive solo aquí; la etapa `build` también la usa el servicio
# `migrate` del compose para sincronizar el esquema.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src

# --- Etapa final: solo dependencias de producción. ---------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# El cliente generado se copia desde la etapa anterior porque `npm ci` acaba de
# rehacer node_modules y se habría perdido.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
