// vitest setup — installs js-yaml on globalThis so web/yaml-io.js can use it
// the same way it does in the browser (where the CDN-loaded js-yaml sets
// window.jsyaml). Avoids needing a bare-specifier import in yaml-io.js.
import jsyaml from 'js-yaml';

globalThis.jsyaml = jsyaml;
