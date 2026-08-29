# Arquitectura de `src/`

Mapa de módulos para mantener la responsabilidad única al escalar. Antes de crear un archivo nuevo, revisa si la responsabilidad ya tiene módulo.

## Distribución de carpetas

```
src/
  plugin.js          Entrada del bundler: ciclo de vida, comandos, undo y refresco de vistas.
  board-view.js      Barrel → src/board/board-view.js (los tests y consumidores importan aquí).
  modals.js          Barrel → src/modals/ (una sola ruta de import para los modales).
  helpers.js         Constantes y utilidades puras compartidas (ver HELPERS-CATALOG.md).
  core/              Lógica del plugin: datos, persistencia y sync.
  board/             Vista de tablero/tabla (BoardView).
  modals/            Modales y sus campos.
  editor/            Integración del editor Markdown embebido de Obsidian.
  settings/          Pestaña de ajustes del plugin.
```

`helpers.js`, `modals.js` y `board-view.js` permanecen en la raíz porque son la superficie pública que importan los tests, el catálogo y el resto de módulos.

## Convención de mixins

`KanuxPlugin` y `BoardView` son clases grandes por diseño (una API única para vistas, modales y tests). Cada responsabilidad vive en un módulo que exporta un objeto de métodos (`xxxMethods`), y la clase los mezcla con `Object.assign(Class.prototype, ...)`:

- Los cuerpos de los métodos usan `this` y llaman a otros métodos vía `this.metodo(...)`, así el despacho sigue siendo dinámico (los tests hacen stub de métodos de instancia y debe seguir funcionando).
- Un método vive en exactamente un módulo; no dupliques nombres entre mixins (el último `Object.assign` ganaría en silencio).
- Las constantes de un dominio viven en su módulo, no en el shell.

## Núcleo del plugin (`src/core/`)

Mezclados en `KanuxPlugin.prototype` desde `plugin.js`:

| Módulo | Responsabilidad |
| --- | --- |
| `plugin-data.js` | Carga y normalización de data.json: boards, cards, labels, assignees y migraciones. |
| `appearance.js` | Apariencia: normalización, overrides por board, presets integrados/custom y fondos importados. |
| `board-ops.js` | Búsquedas (`getBoard`/`findList`…) y CRUD de boards y listas orientado al usuario. |
| `card-dependencies.js` | Dependencias de card y de checklist: resolución del gate, descripción de la card referenciada y la confirmación previa a la acción. |
| `card-ops.js` | CRUD de cards, completado, borrado de labels y los snapshots de undo. |
| `card-files.js` | Persistencia de notas de card: rutas, frontmatter/tags, escritura con concurrencia optimista y notas de checklist items. |
| `board-index.js` | Índices generados por board: escritura/adopción, restauración de boards y limpieza. |
| `vault-sync.js` | Reconciliación con el vault: import de notas, eventos, poda de boards/cards, dedupe y migración de media. |
| `sync-deck.js` | Integración Sync Deck: bridge, presencia, locks de card, miembros y límite de boards. |
| `vault-decorations.js` | Colores de listas en el explorador de archivos y grupos de color del grafo. |
| `completion-sound.js` | Sonido de completado embebido (token que `build.js` reemplaza). |

`plugin.js` conserva solo el ciclo de vida (onload/onunload), los comandos, la pila de undo, `savePluginData`, `refreshViews` y `activateView`.

## Vista de tablero (`src/board/`)

Mezclados en `BoardView.prototype` desde `board/board-view.js`:

| Módulo | Responsabilidad |
| --- | --- |
| `board-view.js` | Shell de la vista: ciclo de vida, orquestación del render, toolbar, home de boards y selector de modo. |
| `board-appearance.js` | Aplicación de la apariencia activa al root (variables CSS, clases, fondo). |
| `list-cards.js` | Render del modo tablero: columnas, cards, composers, badges, avatares y menús contextuales. |
| `card-drag.js` | Drag & drop de cards: placeholder, auto-scroll, animación de reflow y commit del drop. |
| `table-view.js` | Vista de tabla: columnas configurables, filas, celdas editables inline y composer. |
| `table-filters.js` | Filtros de tabla: estado por board, controles, búsqueda/orden y el popover anclado compartido. |
| `presence.js` | Cursores en vivo (SyncDeck) e insignias de lock por card. |

## Modales (`src/modals/`)

`src/modals.js` es solo un barrel: re-exporta la superficie pública para que los consumidores mantengan una única ruta de import (`require("./modals")`).

| Módulo | Responsabilidad |
| --- | --- |
| `card-modal.js` | Shell del editor de card: estado local, lock colaborativo, ciclo de guardado y cableado de campos. |
| `card-details-field.js` | Campo de descripción de card: WYSIWYG, autoformato y adjuntos. |
| `card-detail-images.js` | Imágenes del campo de detalles: tamaño, resize interactivo, portapapeles e inserción de archivos. |
| `card-checklist-field.js` | Campo de checklists: grupos con descripción, drag & drop, notas por item y miembros. |
| `card-dependencies-field.js` | Editor de dependencias compartido por la card y cada grupo de checklist. |
| `dependency-level-picker.js` | Los tres niveles de bloqueo: cómo se presentan y el popover que los intercambia. |
| `card-picker-modal.js` | Selector de una card del vault, con búsqueda por título y ubicación. |
| `card-pdf-export.js` | Export de la card a PDF seguro para el vault. |
| `card-dates-modal.js` | Selector de fechas de inicio/vencimiento. |
| `label-picker-modal.js` | Selección y edición de etiquetas. |
| `list-color-modal.js` | Selector de color compartido por listas y checklists. |
| `board-appearance-modal.js` | Ajustes de apariencia del tablero. |
| `prompt-modals.js` | Prompts de texto y confirmaciones reutilizables. |
| `vault-suggest-modals.js` | Pickers difusos sobre archivos del vault. |
| `about-modal.js` | Panel de créditos. |
| `details-markdown.js` | Conversión Markdown ↔ HTML del subconjunto WYSIWYG, autoformato y segmentación de detalles (funciones puras). |
| `modal-ui.js` | Utilidades pequeñas de DOM/imagen y constantes de timing compartidas por los modales. |

## Reglas al escalar

- Un archivo nuevo por responsabilidad nueva; no dejar crecer un módulo por conveniencia.
- Los constructores de campos pesados de `CardModal` viven fuera de la clase como funciones `build*(modal, ...)`; la clase solo conserva delegados de una línea.
- Lógica pura y reutilizable va a `helpers.js` (con entrada en el catálogo y pruebas); lógica pura exclusiva de los modales va a `src/modals/details-markdown.js` o `modal-ui.js`.
- Nuevos métodos de `KanuxPlugin`/`BoardView` van al mixin de su responsabilidad (o a uno nuevo), nunca de vuelta al shell.
