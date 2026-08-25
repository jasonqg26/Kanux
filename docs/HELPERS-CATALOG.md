# Catálogo de utilidades compartidas

Este documento registra las utilidades públicas que ya existen en `src/helpers.js`. Consúltalo antes de crear una función auxiliar para evitar lógica duplicada entre vistas, modales y el plugin.

## Regla de uso y mantenimiento

- Importa una utilidad existente cuando su responsabilidad coincida con la necesidad nueva.
- Extiende una utilidad solo si conserva una responsabilidad clara y el cambio es compatible con sus consumidores.
- Mantén las transformaciones de datos puras siempre que sea posible.
- Al agregar, renombrar o cambiar una utilidad exportada, actualiza este catálogo y `tests/helpers.test.js`.
- Las funciones internas no exportadas son detalles de implementación de `helpers.js`; no deben copiarse en otros módulos.

## Constantes y datos iniciales

- `VIEW_TYPE`: identificador de la vista Kanux en Obsidian.
- `LEGACY_CARD_FOLDER`: nombre de la antigua carpeta global de tarjetas.
- `LEGACY_BOARD_INDEX_SUFFIX`: sufijo de índices de boards heredados.
- `BOARD_INDEX_MARKER`: marcador que identifica un índice generado por Kanux.
- `KANUX_ICON` y `KANUX_ICON_SVG`: nombre y dibujo SVG del icono del plugin.
- `LIST_DRAG_TYPE`: tipo MIME usado al arrastrar listas.
- `IMAGE_EXTENSIONS`: extensiones reconocidas como imágenes.
- `DEFAULT_LABEL_COLOR`, `LABEL_COLORS` y `LIST_COLORS`: colores compartidos para etiquetas y listas.
- `DEFAULT_APPEARANCE`: configuración visual inicial.
- `DEFAULT_DATA`: estructura mínima de datos persistidos del plugin.

## Valores, texto e identidad

- `clone(value)`: crea una copia profunda de datos serializables como JSON.
- `uid(prefix)`: genera un identificador temporal con un prefijo legible.
- `textLine(value)`: convierte un valor en una sola línea de texto limpia.
- `parseBoolean(value)`: interpreta los valores booleanos admitidos en Markdown.
- `cardFileBaseName(value)`: convierte un título en un nombre de archivo seguro y legible.

## Fechas

- `cleanDate(value)`: acepta únicamente fechas persistidas como `YYYY-MM-DD`.
- `dateFromISO(value)`: convierte una fecha válida en `Date` local o devuelve `null`.
- `isoFromDate(date)`: convierte un `Date` local al formato `YYYY-MM-DD`.
- `addMonths(date, amount)`: obtiene el primer día de un mes desplazado.
- `shortDateLabel(value)`: crea la etiqueta corta localizada usada en las tarjetas.
- `fieldDateLabel(value)`: crea la etiqueta `DD.MM.YYYY` usada en campos de fecha.
- `dateRangeLabel(startDate, dueDate)`: resume una fecha o un intervalo para la interfaz.

## Colores, etiquetas y miembros

- `cleanColor(value)`: valida y normaliza colores hexadecimales de seis dígitos.
- `labelKey(label)`: genera la clave comparable de una etiqueta.
- `cleanLabelName(label)`: limpia un nombre y descarta líneas reservadas de metadatos.
- `parseLabels(raw)` y `labelsToFrontmatter(labels)`: leen y escriben etiquetas en frontmatter.
- `parseAssignees(raw)` y `assigneesToFrontmatter(assignees)`: leen y escriben miembros asignados.
- `initials(nameOrEmail)`: obtiene hasta dos iniciales para el avatar de respaldo.

## Rutas, etiquetas de Obsidian e imágenes

- `kanuxListTag(boardName, listTitle)`: crea la etiqueta jerárquica de una lista.
- `imageTarget(raw)`: extrae el destino limpio de un embed o enlace de imagen.
- `isImagePath(value)`: indica si una ruta tiene una extensión de imagen compatible.
- `imageRefsFromMarkdown(markdown)`: encuentra embeds wiki e imágenes Markdown.
- `stripImageEmbeds(markdown)`: elimina los embeds de imagen conservando el resto del contenido.
- `imageSizeFromMarkup(markup)`: lee el ancho guardado en la sintaxis de imagen de Obsidian.
- `imageMarkupWithSize(markup, width)`: agrega, cambia o elimina el ancho de un embed.

## DOM, iconos y arrastre

- `createElement(tag, className, text)`: crea elementos DOM con clase y texto opcionales.
- `hasDragType(event, type)`: comprueba de forma compatible un tipo en `dataTransfer`.
- `iconButton(icon, label, onClick)`: crea un botón accesible con un icono registrado en Obsidian.
- `textButton(icon, label, onClick, className)`: crea un botón de texto con un icono registrado en Obsidian.
- `addButtonIcon(button, icon)`: agrega a un botón existente un icono registrado, con alias compatibles y un respaldo genérico.

## Secciones Markdown y tarjetas

- `getSection(markdown, heading, boundaries)`: obtiene el cuerpo de una sección H2 respetando bloques de código.
- `getSectionAny(markdown, headings)`: obtiene la primera sección disponible entre varios nombres compatibles.
- `parseCardMarkdown(markdown)`: convierte una nota Markdown de tarjeta en los campos usados en memoria.
- `encodeListMeta(lists, deleted)` y `decodeListMeta(markdown)`: serializan y recuperan la estructura de listas guardada en el índice del board.

## Checklists

- `parseChecklist(text)`: convierte líneas Markdown en elementos de checklist.
- `checklistItemNoteBody(markdown)`: obtiene el contenido editable de una nota de elemento enlazado.
- `parseChecklists(text)`: lee grupos de checklist actuales y el formato plano heredado.
- `normalizeChecklists(checklists, legacyItems)`: normaliza grupos, elementos, colores y miembros.
- `checklistToText(items)`: serializa elementos sin viñeta Markdown.
- `checklistToMarkdown(items)`: serializa elementos con tareas Markdown y metadatos de miembro.
- `checklistsToMarkdown(checklists)`: serializa grupos completos con título y color.
- `checklistItems(checklists)`: aplana los elementos de todos los grupos.
- `checklistStats(items)`: calcula elementos completados, total y porcentaje.

## Ejemplo de reutilización

```js
const { cleanDate, textLine, checklistStats } = require("./helpers");

const title = textLine(input.value);
const dueDate = cleanDate(rawDueDate);
const progress = checklistStats(card.checklists);
```

Si una necesidad no aparece aquí, revisa primero las funciones privadas de `src/helpers.js`. Puede ser más limpio promover una de ellas con pruebas que implementar otra versión en un módulo diferente.
