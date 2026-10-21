# RR Piloto

App web para pilotos de Rubus Racing: ficha del piloto y contacto de emergencia, motos, registro de sesiones y entradas a pista, estadísticas por circuito, logros e imágenes para compartir en redes.

Desarrollado por Rubus Racing. Todos los derechos reservados.

## Contenido

- `index.html`: la app completa en un solo archivo (HTML, CSS y JavaScript, sin dependencias).

## Estado

Prototipo. Los datos se guardan en el dispositivo de cada piloto (localStorage). Pendiente: registro central de alumnos con servidor y base de datos.

## Uso

Abrir `index.html` en el navegador o publicarlo en cualquier hosting estático.

## Despliegue

Publicado en https://rrpiloto.asdf123.cl, en el VPS 159.195.7.134, detrás del Nginx Proxy Manager. El stack vive en `/opt/stacks/rr-piloto` y el Proxy Manager reenvía al contenedor `rr-piloto`, puerto 80.

Para publicar cambios, haz push a `main` y luego:

```bash
ssh root@159.195.7.134 '/opt/stacks/rr-piloto/deploy.sh'
```
