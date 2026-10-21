# RR Piloto

Plataforma web para pilotos de Rubus Racing: ficha del piloto y contacto de emergencia, vehículos, registro de sesiones y entradas a pista, estadísticas por circuito, logros, imágenes para compartir en redes y material educativo. Sirve para varios deportes motor (motociclismo de pista, motocross, enduro, supermoto, karting y automovilismo): el piloto elige los suyos y cambia entre ellos desde la pantalla principal. Se puede instalar como app en el teléfono.

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

## Administradores

Se gestionan en `/admin → Administradores`. Pueden tener nombre de usuario, correo o ambos, y entran con cualquiera de los dos. Un administrador no puede eliminarse a sí mismo y siempre debe quedar al menos uno. El administrador inicial se crea desde `ADMIN_EMAIL` y `ADMIN_PASSWORD` en el `.env`.

## Circuitos

Los pilotos eligen el circuito desde un catálogo que se administra en `/admin → Pistas` (nombre, ubicación, deportes, trazados y longitud). Si falta uno, el piloto lo propone desde la sesión y lo usa de inmediato como provisorio; el administrador lo aprueba (corrigiendo los datos), lo fusiona con uno existente o lo rechaza. Al aprobar o fusionar, todas las sesiones que lo usaban quedan consolidadas con el nombre oficial. Los nombres que se escribieron a mano antes del catálogo aparecen en la misma pestaña para sumarlos o asignarlos.

Cada circuito admite hasta 5 fotos: la principal es la vista aérea, que el piloto ve al elegirlo, aparece en miniatura en cada sesión y es el fondo por defecto de las imágenes para redes. Las fotos se sirven desde `/api/img/circuito/:id` con caché larga.

## Medallas, copas y recompensas

El piloto suma 1 punto por minuto en pista y 30 por cada récord personal (mejorar su mejor vuelta en un circuito). Gana medallas por récords y copas por tiempo en pista, y sube de nivel (de Novato a Leyenda). El módulo Premios muestra su progreso; los premios y descuentos por nivel, creados en `/admin → Recompensas`, son solo para cuentas Plus y Pro, y el servidor solo entrega el código cuando el nivel calculado lo desbloquea. Los umbrales están en `web/campos.js` (PREMIOS) y `api/src/lib/logros.js`, que deben coincidir.

## Publicidad

Los pilotos Gratis y Plus ven anuncios de sponsors en Inicio, Sesiones y Datos. Los Pro no los ven, salvo que los activen en Datos → Anuncios de sponsors. Los anuncios se crean en `/admin → Anuncios`, con lugares, deportes, vigencia y peso, y miden impresiones y clics.

## Panel de administración

`/admin` abre en un dashboard con indicadores de pilotos, planes y actividad, filtrable por deporte y período: quiénes corren más y quiénes menos (para campañas de fidelización), circuitos más corridos, ranking de mejores vueltas por pista y por trazado, y métricas de publicidad. La lista de pilotos se exporta a CSV; antes de escribirles por correo, respeta la columna de mailing.

## Estructura

- `web/`: la app del piloto (`index.html`), el panel de administración (`admin.html`), las definiciones de campos y deportes que usan ambos (`campos.js`), los íconos (`iconos.js`) y la instalación como app (`manifest.webmanifest`, `sw.js`, `icons/`). nginx los sirve y reenvía `/api` a la API.
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
