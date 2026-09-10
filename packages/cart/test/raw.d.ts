// Vite serves `?raw` imports as strings. Declared here so a test can load a
// real on-disk fixture the same way in Node and in a browser, instead of
// branching on the platform or keeping a copy that drifts from the original.
declare module "*?raw" {
  const contents: string;
  export default contents;
}
