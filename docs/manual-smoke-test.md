# Manual smoke test — UI improvements

Run the backend: `cd src && python netrouting.py`. Open http://127.0.0.1:8000/ in a browser.

## Golden path

1. **SPA loads** with the default topology (sample.yaml). Designer is interactive: drag nodes, see edges.
2. **Click ▶ Start** → button label switches to ■ Stop with pulsing green halo. State indicator shows `running`.
3. **Within ~10s**, routing-flood dots animate on edges (subtle grey, semi-transparent).
4. **Double-click h1** → terminal opens with phosphor green styling. Blinking block cursor.
5. **In terminal:** type `ifconfig` → output lists the host's interface.
6. **In terminal:** type `route` → shows gateway summary.
7. **In terminal:** type `ping h2 -W 1.0` → ping_request (amber) and ping_reply (light amber) dots animate; RTT printed in terminal.
8. **In terminal:** type `send h2 hello` → green dot animates h1 → lan1 → h2.
9. **Click ⏸ Pause** → packet animations stop within ~1s, button label becomes ▶ Resume with amber halo. State `paused`.
10. **In Pause state**, drag a new Host onto the canvas in lan1. Fill its address (e.g. `10.0.0.99`). Pause button label now shows "Resume (1 edits)".
11. **Click ▶ Resume** → patch is sent, button returns to Pause, state `running`. Routing reconverges within ~10s; the new host is reachable by `ping` from other hosts on the same network.
12. **Select a router in the canvas** → inspector right pane shows "Routing table — r1" with the current rules.
13. **Click ■ Stop** → state returns to idle; designer mode is interactive again.
14. **Click ↺ Reset** → topology re-clones from source; SPA reloads it via `GET /topology`.

## Failure modes to verify

- **Backend offline at load:** start SPA without backend. Top of page shows red banner "connection lost — retrying".
- **Backend goes down mid-session:** kill backend mid-flow. Banner appears within ~1s. After backend restart, banner disappears once WS reconnects.
- **Invalid YAML on Start:** edit a network to have a bad CIDR, click Start → error toast appears, sim stays idle.
- **Ping to unreachable address:** in terminal, `ping 192.168.99.99 -W 1.0` → "timeout after 1.00 s" in output.
- **Idle terminal:** when sim is idle, double-clicking a host shows a toast saying "Start the simulation to use device terminals" (and the terminal does NOT open).

## Routing chatter

- The toolbar Chatter toggle button mutes routing-flood visuals (keeps user_datagram/ping animations).
- The 200ms throttle per (src device, network) prevents storm-scale visual noise even when un-muted.

## Performance check

With the default 3-router/3-host sample running for ~1 minute:
- CPU should be low.
- WS event rate is bounded; the bus drops oldest events on overflow (visible only via `EventBus.overflow_count` server-side).
- No memory leaks observed in DevTools.

## Quick stop

`Ctrl+C` in the terminal running `python netrouting.py` stops the server. The SPA's connection-lost banner appears within a second.
