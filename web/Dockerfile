# La app del piloto y el panel de administración son archivos estáticos;
# nginx los sirve y reenvía /api al contenedor de la API.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=644 index.html admin.html campos.js iconos.js sw.js manifest.webmanifest /usr/share/nginx/html/
COPY --chmod=755 icons /usr/share/nginx/html/icons
