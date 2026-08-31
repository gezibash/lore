/** A wasm file imported with `type: "file"` gives back its path, not its
 *  contents: the path on disk in a source checkout, and the path inside the
 *  executable in a compiled binary. Bun resolves these imports; TypeScript
 *  needs the shape declared. */
declare module "*.wasm" {
  const path: string;
  export default path;
}
