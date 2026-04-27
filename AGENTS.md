# Jellyfin Web

Frontend web principal de Jellyfin. Tambien funciona como insumo para otros clientes, especialmente `jellyfin-tizen`.

## Rol

- UI principal para navegador y varios clientes basados en web.
- Implementa login, Quick Connect, navigation, dashboard, playback y administracion.
- Produce `dist/`, que puede ser hosteado por `jellyfin` o empaquetado por otros repos.

## Stack

- Node `24`
- npm `11`
- Webpack
- React 18
- MUI 6
- SCSS
- Vitest
- ESLint + Stylelint

## Setup local

### Prerequisitos

- `source ~/.nvm/nvm.sh && nvm use 24`

### Comandos utiles

```bash
npm ci --no-audit
npm start
npm run build:development
npm run build:production
npm run build:check
npm test
npm run lint
npm run stylelint
```

### Devcontainer

Hay devcontainer Node 24 en `.devcontainer/devcontainer.json`.

## Archivos para orientarse rapido

- `package.json`
- `src/index.jsx`
- `src/lib/jellyfin-apiclient/ServerConnections.js`
- `src/lib/jellyfin-apiclient/connectionManager.js`
- `src/controllers/session/login/index.js`
- `src/themes/`
- `src/elements/`
- `.github/workflows/__quality_checks.yml`

## Arquitectura real

No es un frontend puro y limpio en una sola arquitectura. Hoy conviven:

- React + hooks + TypeScript
- MUI y tema moderno
- custom elements `emby-*`
- controllers JS heredados
- SCSS legado y tema historico

La mezcla funciona, pero hay deuda de consistencia. Si vas a tocar UI, primero ubica si el flujo vive en React moderno o en legacy JS.

## Auth y conexion

- `ServerConnections` es la fachada principal del cliente.
- `connectionManager.js` maneja descubrimiento, reconexion, storage de credenciales y handshake.
- Hay login manual, auto-login y Quick Connect.
- El cliente inicializa websocket despues de establecer sesion.

## Design system y estilos

- Hay assets compartidos via `@jellyfin/ux-web`.
- Hay tema MUI en `src/themes/`.
- Tambien sobrevive una capa legacy de `emby-*` custom elements y SCSS.
- No tomar decisiones de UI asumiendo un unico design system centralizado.

## Integracion con otros repos

- `jellyfin` puede hostear el `dist/`.
- `jellyfin-tizen` depende directamente de `dist/`.
- `jellyfin-webos` no usa este build adentro del paquete, pero si depende del web UI hosteado por el server.

## CI/CD

- `__quality_checks.yml`: corre `build:es-check`, `lint`, `stylelint`, `build:check`, `test`.
- `__package.yml`: genera artefacto `dist/`.
- `__deploy.yml`: publica previews y produccion en Cloudflare Pages.
- `pull_request.yml`: orquesta build, quality checks, CodeQL y sugerencias ESLint.

## Packaging y deployment manual

- El artefacto importante es `dist/`.
- Se puede usar para:
  - hostearlo desde `jellyfin`
  - alimentar `jellyfin-tizen`
  - probar la UI separada del server

## Calidad y tests

- ESLint flat config fuerte, con reglas de TS, React, Sonar y estilo.
- Stylelint para `src/**/*.{css,scss}`.
- Vitest con `jsdom`.
- Hay mezcla de tests unitarios modernos y bastante codigo legacy sin cobertura equivalente.

## Smoke checks realizados en este host

Con `nvm use 24`:

- `npm ci --no-audit`: OK
- `npm run build:check`: OK
- `npm test`: OK, `13` test files y `167` tests pasados
- `npm run build:production`: OK

Observacion del build:

- Webpack reporto warnings de asset y entrypoint size, no errores.

## Riesgos y notas

- La arquitectura hibrida aumenta el costo de cambio.
- Hay warnings de bundle size en produccion.
- Si el cambio toca auth, playback o session bootstrap, revisar tambien `jellyfin` y `jellyfin-tizen`.
