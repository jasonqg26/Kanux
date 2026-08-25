# Reglas y Directrices para Asistentes de IA (AGENTS)

Este documento define el comportamiento, funcionalidades y reglas que cualquier asistente de IA debe seguir obligatoriamente al trabajar en el proyecto **Kanux** (plugin comunitario de Obsidian).

## 1. Reglas Principales y Flujo de Trabajo

- **Uso Obligatorio de Clean Code**: Siempre que se escriba, revise o modifique código, la IA debe aplicar la skill `/clean-code`. El código debe ser auto-explicativo, limpio, con nombres intencionales y funciones con una sola responsabilidad.
- **Flujo inicial obligatorio**: Al empezar cualquier tarea, lee este archivo y ejecuta `git status --short`, `git branch --show-current` y `git log -5 --oneline`. Revisa el estado antes de editar.
- **Catálogo de utilidades obligatorio**: Antes de crear lógica auxiliar, consulta [`docs/HELPERS-CATALOG.md`](docs/HELPERS-CATALOG.md) y `src/helpers.js`. Reutiliza o extiende una utilidad existente cuando cubra la misma responsabilidad. Toda utilidad pública nueva o modificada debe actualizarse en el catálogo y contar con pruebas.
- **Artefactos y Compilación**: **NUNCA edites `main.js` directamente**. El código fuente se modifica únicamente dentro de `src/`; la documentación y las reglas pueden actualizarse en `docs/` y `AGENTS.md` cuando la tarea lo requiera. Después de cualquier modificación de código, debes ejecutar `node build.js` para generar el nuevo `main.js`.

## 2. Implementación y APIs

- **APIs de Obsidian**: Usa **exclusivamente** las APIs públicas de Obsidian (como `Vault` y `FileManager`) para manipular el sistema de archivos. **Prohibido** usar directamente APIs de Node.js como `fs`, `path` o `os`.
- **Persistencia Segura**: Las tarjetas son notas Markdown reales del usuario. Nunca sobrescribas notas desde un estado en memoria obsoleto. Las eliminaciones deben usar `vault.trash()` para que sean recuperables.
- **Rutas**: Usa `vault.configDir`; no codifiques `.obsidian` como ruta fija.
- **Compatibilidad**: Conserva la compatibilidad móvil (`isDesktopOnly` = `false`). Valida la disponibilidad en tiempo de ejecución de las funciones basadas en Electron (solo escritorio).

## 3. Estilos y CSS (`styles.css`)

- **Prohibido**: No uses `!important`, `:has()`, `clip-path` ni propiedades con soporte parcial sin un fallback estable.
- **Aislamiento**: Todos los selectores deben estar estrictamente limitados a las clases de Kanux para no afectar otras vistas ni plugins globales de Obsidian. Respeta el modo oscuro/claro.

## 4. Validación Obligatoria

Después de cambios relevantes, la IA está obligada a ejecutar y validar el código con:
```powershell
node build.js
node tests\helpers.test.js
node --check main.js
Get-ChildItem src -Filter *.js | ForEach-Object { node --check $_.FullName }
git diff --check
git status --short
```
Verifica también con `rg` que no se hayan introducido llamadas a `fs`, `os` o `path`, ni reglas CSS prohibidas.

## 5. Licencias e Identidad

- El proyecto deriva de `ismailivanov/task-deck`. No elimines ni alteres las atribuciones, créditos ni avisos de copyright ubicados en `README.md`, `NOTICE`, y archivos de licencias.
- No cambies el ID `kanux` después de publicado y asegúrate de que toda nueva feature respete la privacidad local (sin dependencias externas dinámicas o telemetría).
