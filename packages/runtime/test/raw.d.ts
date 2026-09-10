// Vite serves `?raw` imports as strings. Declaring it here lets the golden
// conformance test load its fixture the same way in Node and in a browser,
// which is the point: the harness must not take a different code path on the
// engines it is comparing.
declare module "*?raw" {
  const contents: string;
  export default contents;
}
