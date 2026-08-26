const { Scope } = require("obsidian");

// Real Obsidian Live Preview editing for description fields: embeds the same
// CodeMirror 6 markdown editor Obsidian uses, so syntax hides/reveals around
// the caret exactly like in a note. Based on the MIT-licensed pattern from
// mgmeyers/obsidian-kanban (MarkdownEditor.tsx) and Fevol's embeddable-editor
// gist. Everything here touches UNDOCUMENTED internals, so every access is
// feature-detected and wrapped: on any failure createEmbeddedMarkdownEditor
// returns null and callers fall back to Kanux's own block editor.

let cachedEditorClass = null;
let embeddedEditorBroken = false;
// Options for the instance currently inside `super()`, where `this.options`
// is not assigned yet but the base class already builds the CM extensions.
let constructingOptions = null;

function requireCodeMirror() {
  // Obsidian exposes the CodeMirror packages to plugins at runtime.
  return {
    cmState: require("@codemirror/state"),
    cmView: require("@codemirror/view"),
  };
}

// Obsidian does not export its markdown editor class; recover it from a
// throwaway widget editor the same way Kanban does.
function resolveEditorPrototype(app) {
  const registry = app.embedRegistry;
  const createMarkdownEmbed = registry && registry.embedByExtension && registry.embedByExtension.md;
  if (typeof createMarkdownEmbed !== "function") return null;
  const widgetEditorView = createMarkdownEmbed({ app, containerEl: document.createElement("div") }, null, "");
  if (!widgetEditorView || typeof widgetEditorView.showEditor !== "function" || typeof widgetEditorView.unload !== "function") return null;
  widgetEditorView.editable = true;
  widgetEditorView.showEditor();
  const editMode = widgetEditorView.editMode;
  const prototype = editMode && Object.getPrototypeOf(Object.getPrototypeOf(editMode));
  widgetEditorView.unload();
  return prototype && typeof prototype.constructor === "function" ? prototype.constructor : null;
}

function patchMethod(target, methodName, wrap) {
  const original = target[methodName];
  const patched = wrap(original);
  target[methodName] = patched;
  return () => {
    if (target[methodName] === patched) target[methodName] = original;
  };
}

function buildEditorClass(app) {
  const BaseEditor = resolveEditorPrototype(app);
  if (!BaseEditor) return null;
  const { cmState, cmView } = requireCodeMirror();
  const { EditorSelection, Prec } = cmState;
  const { EditorView, keymap, placeholder } = cmView;

  class EmbeddedMarkdownEditor extends BaseEditor {
    constructor(appInstance, container, options) {
      super(appInstance, container, {
        app: appInstance,
        // Mocks the owning MarkdownView, required for scrolling and commands.
        onMarkdownScroll: () => {},
        getMode: () => "source",
      });
      this.options = options;
      this.scope = new Scope(appInstance.scope);
      // Mod+Enter is bound to "open link in new leaf" and Mod+S to Obsidian's
      // "save file"; the scope swallows both hotkeys so the CM keymap below
      // can treat them as "save this field" instead.
      this.scope.register(["Mod"], "Enter", () => true);
      this.scope.register(["Mod"], "S", () => true);
      // Editor commands expect a MarkdownView with editMode/editor set.
      this.owner.editMode = this;
      this.owner.editor = this.editor;
      this.set(options.value || "");
      // While this editor has focus, the workspace must not steal it for a leaf.
      this.register(patchMethod(appInstance.workspace, "setActiveLeaf", (original) => (leaf, ...args) => {
        if (!this.activeCM || !this.activeCM.hasFocus) original.call(appInstance.workspace, leaf, ...args);
      }));
      this.editor.cm.contentDOM.addEventListener("blur", () => {
        appInstance.keymap.popScope(this.scope);
      });
      this.editor.cm.contentDOM.addEventListener("focusin", () => {
        appInstance.keymap.pushScope(this.scope);
        appInstance.workspace.activeEditor = this.owner;
      });
      if (options.cls) this.editorEl.classList.add(options.cls);
      if (options.cursorLocation) {
        this.editor.cm.dispatch({
          selection: EditorSelection.range(options.cursorLocation.anchor, options.cursorLocation.head),
        });
      }
    }

    get value() {
      return this.editor.cm.state.doc.toString();
    }

    currentOptions() {
      return this.options || constructingOptions || {};
    }

    get selectionText() {
      const range = this.editor.cm.state.selection.main;
      return this.editor.cm.state.sliceDoc(range.from, range.to);
    }

    insertAtCursor(text) {
      const cm = this.editor.cm;
      const range = cm.state.selection.main;
      cm.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
      });
      cm.focus();
    }

    // Wraps the selection in markers ("**", "*", "`", ...); with no selection
    // the markers are inserted and the caret lands between them.
    wrapSelection(before, after = before) {
      const cm = this.editor.cm;
      const range = cm.state.selection.main;
      const selected = cm.state.sliceDoc(range.from, range.to);
      cm.dispatch({
        changes: { from: range.from, to: range.to, insert: `${before}${selected}${after}` },
        selection: selected
          ? EditorSelection.range(range.from + before.length, range.to + before.length)
          : EditorSelection.cursor(range.from + before.length),
      });
      cm.focus();
    }

    // Rewrites every line touched by the selection through makeLine(text, index)
    // — the primitive behind the heading/list/quote toolbar buttons.
    setLinePrefix(makeLine) {
      const cm = this.editor.cm;
      const range = cm.state.selection.main;
      const firstLine = cm.state.doc.lineAt(range.from).number;
      const lastLine = cm.state.doc.lineAt(range.to).number;
      const changes = [];
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
        const line = cm.state.doc.line(lineNumber);
        const next = makeLine(line.text, lineNumber - firstLine);
        if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
      }
      if (changes.length) cm.dispatch({ changes });
      cm.focus();
    }

    focusEditor() {
      this.editor.cm.focus();
    }

    onUpdate(update, changed) {
      super.onUpdate(update, changed);
      const { onChange } = this.currentOptions();
      if (changed && onChange) onChange(this.value);
    }

    buildLocalExtensions() {
      const extensions = super.buildLocalExtensions();
      const placeholderText = this.currentOptions().placeholder;
      if (placeholderText) extensions.push(placeholder(placeholderText));
      extensions.push(EditorView.domEventHandlers({
        paste: (event) => {
          const { onPaste } = this.currentOptions();
          return onPaste ? !!onPaste(event) : false;
        },
      }));
      const runOption = (name) => {
        const handler = this.currentOptions()[name];
        if (!handler) return false;
        handler();
        return true;
      };
      extensions.push(Prec.highest(keymap.of([
        { key: "Mod-Enter", run: () => runOption("onSubmit") },
        { key: "Mod-s", run: () => runOption("onSubmit") },
        { key: "Escape", run: () => runOption("onEscape"), preventDefault: true },
      ])));
      return extensions;
    }

    destroy() {
      if (this._loaded) this.unload();
      this.app.keymap.popScope(this.scope);
      if (this.app.workspace.activeEditor === this.owner) this.app.workspace.activeEditor = null;
      if (this.containerEl && typeof this.containerEl.empty === "function") this.containerEl.empty();
      super.destroy();
    }

    onunload() {
      super.onunload();
      this.destroy();
    }
  }

  return EmbeddedMarkdownEditor;
}

/**
 * Creates Obsidian's own Live Preview markdown editor inside `container`, or
 * returns null when the internal APIs it relies on are unavailable — callers
 * must then fall back to the plain block editor. After the first failure the
 * embedded editor stays disabled for the session.
 *
 * options: { value, placeholder, cls, cursorLocation, onChange(value),
 *            onSubmit(), onEscape(), onPaste(event) -> handled }
 */
function createEmbeddedMarkdownEditor(app, container, options = {}) {
  if (embeddedEditorBroken) return null;
  try {
    if (!cachedEditorClass) cachedEditorClass = buildEditorClass(app);
    if (!cachedEditorClass) {
      embeddedEditorBroken = true;
      return null;
    }
    constructingOptions = options;
    try {
      return new cachedEditorClass(app, container, options);
    } finally {
      constructingOptions = null;
    }
  } catch (error) {
    console.error("Kanux: embedded Obsidian editor unavailable, using the fallback editor.", error);
    embeddedEditorBroken = true;
    return null;
  }
}

module.exports = { createEmbeddedMarkdownEditor };
