// web/preflight.js
//
// Client-side topology validation run before Start. The editor lets you create
// a LAN, host, or router and leave its CIDR/address blank, so a fresh topology
// is often incomplete. Rather than hand that to the server and surface its
// wire-level parser message ("missing netmask"), we check for the obvious
// "you forgot to fill this in" cases first and report a plain-English problem
// that points at the offending entity.

const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

// True when a CIDR is blank or not a well-formed a.b.c.d/m string.
function badCidr(cidr) {
  if (!cidr) return true;
  return !CIDR_RE.test(cidr.trim());
}

function maskOf(cidr) {
  return parseInt(cidr.trim().split('/')[1], 10);
}

function invalid(message, selection) {
  return { ok: false, message, selection };
}

/** Validate a topology for the blanks the editor allows. Returns `{ ok: true }`
 *  or `{ ok: false, message, selection }` for the FIRST problem found, where
 *  `selection` is `{ kind, name }` (or null) so the caller can surface the
 *  offending entity. */
export function validateTopology(state) {
  const networks = state.networks || {};
  const links = state.links || {};
  const hosts = state.hosts || {};
  const routers = state.routers || {};

  const empty = !Object.keys(networks).length && !Object.keys(links).length &&
    !Object.keys(hosts).length && !Object.keys(routers).length;
  if (empty) {
    return invalid('Nothing to start yet — add a LAN, then hosts and routers.', null);
  }

  // Networks need a CIDR.
  for (const [name, net] of Object.entries(networks)) {
    if (badCidr(net.cidr)) {
      return invalid(`${name} needs a network range — set a CIDR like 192.168.0.0/24.`,
        { kind: 'network', name });
    }
  }

  // Links carry point-to-point CIDRs, which must be /30 or /31.
  for (const [name, link] of Object.entries(links)) {
    if (badCidr(link.cidr)) {
      return invalid(`${name} needs a CIDR like 10.0.0.0/30.`, { kind: 'link', name });
    }
    const mask = maskOf(link.cidr);
    if (mask !== 30 && mask !== 31) {
      return invalid(`${name} must be a /30 or /31 link, not /${mask}.`, { kind: 'link', name });
    }
  }

  // Hosts must be attached to a LAN or link and carry an address.
  for (const [name, host] of Object.entries(hosts)) {
    if (!host.network && !host.link) {
      return invalid(`${name} isn't on a LAN or link — drag it onto one.`, { kind: 'host', name });
    }
    if (!host.address) {
      return invalid(`${name} needs an address.`, { kind: 'host', name });
    }
  }

  // Every router interface needs an address.
  for (const [name, router] of Object.entries(routers)) {
    for (const [ifn, iff] of Object.entries(router.interfaces || {})) {
      if (!iff.address) {
        return invalid(`${name} · ${ifn} needs an address.`, { kind: 'router', name });
      }
    }
  }

  return { ok: true };
}
