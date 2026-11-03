// vitest setup — installs js-yaml on globalThis so web/yaml-io.js can use it
// the same way it does in the browser (where the CDN-loaded js-yaml sets
// window.jsyaml). Avoids needing a bare-specifier import in yaml-io.js.
import jsyaml from 'js-yaml';
import { afterEach, vi } from 'vitest';
import { PacketStore } from './packetstore.js';

globalThis.jsyaml = jsyaml;

// PacketStore._scheduleEmit() arms a 50ms debounce timer. Tests that
// dispatch sim:packet without waiting for the timer to flush will leave it
// armed; once happy-dom tears down, the timer fires against a stripped-out
// global and throws "CustomEvent is not defined". Reset after every test so
// the final test in a file can't leak its timer past teardown.
afterEach(() => {
  PacketStore._reset();
  vi.unstubAllGlobals();
});
