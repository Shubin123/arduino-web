// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs one invocation of an Emscripten-built tool (fresh instance per call,
// reusing the compiled WebAssembly module) with an in-memory file system.

export function createToolRunner({ loadFactory, loadModule }) {
  return async function runTool(name, args, inputs, outputPath) {
    const [factory, wasmModule] = await Promise.all([loadFactory(name), loadModule(name)]);
    const stdout = [];
    const stderr = [];
    const mod = await factory({
      noInitialRun: true,
      print: (line) => stdout.push(line),
      printErr: (line) => stderr.push(line),
      instantiateWasm(imports, done) {
        WebAssembly.instantiate(wasmModule, imports).then((instance) => done(instance, wasmModule));
        return {};
      },
    });
    const made = new Set(['/']);
    const entries = [...inputs];
    if (outputPath) entries.push([outputPath, null]);
    for (const [file, bytes] of entries) {
      const parts = file.split('/').filter(Boolean);
      let dir = '';
      for (const part of parts.slice(0, -1)) {
        dir += '/' + part;
        if (!made.has(dir)) {
          try { mod.FS.mkdir(dir); } catch {}
          made.add(dir);
        }
      }
      if (bytes) mod.FS.writeFile(file, bytes);
    }
    let status = 0;
    try {
      status = mod.callMain(args) ?? 0;
    } catch (error) {
      if (typeof error?.status === 'number') status = error.status;
      else if (/exit\((\d+)\)/.test(String(error?.message))) status = Number(String(error.message).match(/exit\((\d+)\)/)[1]);
      else throw error;
    }
    let output = null;
    try { output = outputPath ? mod.FS.readFile(outputPath) : null; } catch {}
    return { status, stdout, stderr, output };
  };
}
