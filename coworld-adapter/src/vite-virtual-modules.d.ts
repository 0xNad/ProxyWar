// Ambient shims for Vite virtual-module import suffixes used by the main ProxyWar
// repo (pulled in transitively by the type-only `../../src/...` imports). The
// adapter never bundles these via Vite — the declarations exist only so the
// adapter's standalone `tsc --noEmit` can resolve the imports.
declare module "*?worker&inline" {
  const workerConstructor: { new (): Worker };
  export default workerConstructor;
}
declare module "*?worker" {
  const workerConstructor: { new (): Worker };
  export default workerConstructor;
}
