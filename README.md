# RR Piloto

Plataforma web para pilotos de Rubus Racing: ficha del piloto y contacto de emergencia, motos, registro de sesiones y entradas a pista, estadísticas por circuito, logros, imágenes para compartir en redes y material educativo. Se puede instalar como app en el teléfono.

Desarrollado por Rubus Racing. Todos los derechos reservados.

## Estado

Fase beta. Cada cuenta nueva queda pendiente hasta que un administrador la aprueba en `/admin`. Los planes de pago son simulados: no se cobra nada.

| Plan | Precio | Incluye |
|---|---|---|
| Gratis | $0 | Perfil, ficha de emergencia y tiempos en una sola pista |
| Plus | $1 al mes | Pistas ilimitadas, motos, piñón y catalina, trazado, sensaciones, rendimiento, estadísticas e imágenes para compartir |
| Pro | $5 al mes | Todo lo anterior, descuentos en marcas y material educativo |

El piloto cambia de plan cuando quiere. El administrador también puede cambiárselo, o asignarle un plan de cortesía (por ejemplo, a los alumnos de las clases) con o sin fecha de término. El plan vigente es el mayor entre el elegido y la cortesía vigente.

Bajar de plan no borra datos: lo que el plan ya no permite editar queda congelado y se conserva.

## Estructura

- `web/`: la app del piloto (`index.html`), el panel de administración (`admin.html`), las definiciones de campos que usan ambos (`campos.js`) y la instalación como app (`manifest.webmanifest`, `sw.js`, `icons/`). nginx los sirve y reenvía `/api` a la API.
- `api/`: Node 22, Express 5, Prisma y PostgreSQL 16. El servidor valida las reglas de cada plan, no solo la app.
- `docker-compose.yml`: base de datos, respaldo diario, migración del esquema, API y web.

La ficha de cada piloto se guarda como un documento JSON (`Ficha.datos`) con versión, para que dos dispositivos no se pisen los cambios.

## Notificaciones

La app ya pide permiso para enviar notificaciones y el service worker sabe mostrarlas (evento `push`, con un JSON `{ title, body, url }`). Falta configurar el envío desde el servidor: claves VAPID, guardar la suscripción de cada dispositivo y enviar desde el panel.

## Despliegue

Publicado en https://rrpiloto.asdf123.cl, en el VPS 159.195.7.134, detrás del Nginx Proxy Manager. El stack vive en `/opt/stacks/rr-piloto`; el Proxy Manager reenvía al contenedor `rr-piloto`, puerto 80. El archivo `.env` solo existe en el servidor (ver `.env.example`).

Para publicar cambios, haz push a `main` y luego:

```bash
ssh gym-dev-server '/opt/stacks/rr-piloto/deploy.sh'
```

Los respaldos diarios de la base quedan en `/opt/stacks/rr-piloto/backups` (se guardan 14 días).
