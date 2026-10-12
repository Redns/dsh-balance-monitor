/**
 * Load the browser half (lib/client.js) into this Node process, the way the
 * shell's client-module loader does.
 *
 * Tests that only need facts *about the plugin* — the icon collection, the
 * symbol-placement options, the roll helpers — should read them from here
 * rather than re-parsing the bundle source. Source parsing is fragile: the file
 * is reformatted by tooling (quote style, line breaks, indentation), the icon
 * entries carry nested arrays and objects so a naive "up to the next `];`"
 * stops inside the first icon, and a hand-rolled bracket scanner has to model
 * strings and escapes correctly to stand any chance. Evaluating the bundle also
 * exercises it: a syntax error here fails the same way it would in the browser.
 *
 * `require` answers from a small stub table, since only `react`,
 * `react/jsx-runtime` and the shell primitives are needed at module scope.
 */

import { readFile } from 'node:fs/promises'

/** A fake DOM: enough for the bundle's one guarded `document` use (a style tag). */
function fakeDocument() {
  return {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  }
}

/** Minimal React surface: the factory only defines functions at load time. */
function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useId: () => 'test-id',
    useContext: () => undefined,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

/**
 * Evaluate the browser half.
 * @returns the bundle's exports (apply, ICONS, SYMBOL_OPTIONS, roll helpers).
 * @throws when the bundle is missing, malformed, or throws while loading.
 */
export async function loadClientBundle(bundlePath) {
  // This helper lives in test/lib/, so the bundle is two levels up.
  const path = bundlePath ?? new URL('../../lib/client.js', import.meta.url)
  const source = await readFile(path, 'utf8')

  let registration = null
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }

  // eslint-disable-next-line no-new-func -- the bundle is a plain CJS factory body
  new Function('window', 'document', 'fetch', source)(window, fakeDocument(), () => Promise.reject(new Error('no network in tests')))

  if (registration === null) throw new Error('client bundle did not call window.__ModuleLoader__.load')
  if (typeof registration.factory !== 'function') throw new Error('client bundle has no factory')

  const react = fakeReact()
  const primitives = new Proxy({}, { get: (_target, key) => (key === 'Modal' || key === 'Tooltip' ? () => null : undefined) })
  const table = {
    react,
    'react/jsx-runtime': { jsx: react.createElement, jsxs: react.createElement },
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }

  const exportsObject = registration.factory((specifier) => {
    if (!(specifier in table)) throw new Error(`client bundle required an unexpected module: ${specifier}`)
    return table[specifier]
  })

  return { id: registration.id, exports: exportsObject }
}
