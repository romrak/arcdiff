/**
 * ELK, run off the main thread.
 *
 * Two things here are not obvious and both are load-bearing.
 *
 * **The `document` shim.** `elkjs/lib/elk.bundled.js` embeds
 * `elk-worker.min.js`, which decides at load time what it is:
 *
 *     if (typeof document === 'undefined' && typeof self !== 'undefined') {
 *       self.onmessage = ...          // "I am the layout worker"
 *     } else if (module && module.exports) {
 *       module.exports = { default: j, Worker: j }
 *     }
 *
 * Inside a web worker the first branch wins, so it installs its own
 * `self.onmessage` — clobbering ours — and exports nothing. ELK's constructor
 * then reaches for the in-process Worker it expects on that module and dies
 * with `o is not a constructor`, which is how this file presents as a canvas
 * that never lays out. Defining `document` sends it down the other branch,
 * where it hands over the in-process implementation. The layout is still off
 * the main thread: this file IS the other thread.
 *
 * **The dynamic import.** A static `import` is hoisted above the assignment,
 * so the shim would run too late to matter.
 */
// A dynamic import does not make this a module, and top-level `await` needs
// one.
export {}

const ctx = self as unknown as {
  document?: unknown
  onmessage: ((event: MessageEvent) => void) | null
  postMessage: (message: unknown) => void
}

/**
 * A layout request, and the structural key it was asked for.
 *
 * The key is echoed back untouched. The canvas can post a second request
 * before the first has finished, and it has no other way to tell a reply for
 * the graph it is waiting on from a reply for one it has already moved past.
 */
interface LayoutRequest { key: string; graph: unknown }

// Requests that arrive while ELK is still loading. A worker's first message
// is the one that draws the canvas, so dropping it is not an option.
const pending: LayoutRequest[] = []
let handle = (request: LayoutRequest): void => { pending.push(request) }
ctx.onmessage = (event: MessageEvent) => { handle(event.data as LayoutRequest) }

ctx.document = {}
const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
const elk = new ELK()

handle = ({ key, graph }: LayoutRequest): void => {
  void elk
    .layout(graph as Parameters<typeof elk.layout>[0], {
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'DOWN',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.spacing.nodeNode': '24',
        'elk.layered.spacing.nodeNodeBetweenLayers': '48',
      },
    })
    .then(
      layout => { ctx.postMessage({ key, layout }) },
      // Reporting the failure beats leaving the canvas on "laying out…".
      (error: Error) => { ctx.postMessage({ key, error: error.message }) },
    )
}
for (const request of pending.splice(0)) handle(request)
