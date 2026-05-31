import { describe, it, expect, beforeEach } from 'vitest';
import { wireProtocolPopover, computeDerived } from './protocolpopover.js';

describe('computeDerived', () => {
  it('returns dead = 3·hello, maxAge = 2·refresh', () => {
    expect(computeDerived({ hello: 10, refresh: 30 })).toEqual({
      dead: 30, maxAge: 60,
    });
    expect(computeDerived({ hello: 5, refresh: 12 })).toEqual({
      dead: 15, maxAge: 24,
    });
  });

  it('handles fractional inputs', () => {
    expect(computeDerived({ hello: 2.5, refresh: 7.5 })).toEqual({
      dead: 7.5, maxAge: 15,
    });
  });
});

describe('wireProtocolPopover', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="tb-protocol"></button>
      <div id="protocol-popover" hidden>
        <button id="protocol-popover-close"></button>
        <input id="proto-hello" type="number" value="10">
        <input id="proto-refresh" type="number" value="30">
        <span id="proto-dead"></span>
        <span id="proto-maxage"></span>
        <button id="proto-cancel" type="button"></button>
        <button id="proto-apply" type="button"></button>
      </div>
    `;
  });

  it('clicking the toolbar button toggles the popover', () => {
    wireProtocolPopover({ onApply: () => {} });
    const popover = document.getElementById('protocol-popover');
    const btn = document.getElementById('tb-protocol');
    expect(popover.hidden).toBe(true);
    btn.click();
    expect(popover.hidden).toBe(false);
    btn.click();
    expect(popover.hidden).toBe(true);
  });

  it('typing in hello input updates derived dead', () => {
    wireProtocolPopover({ onApply: () => {} });
    const helloInput = document.getElementById('proto-hello');
    const dead = document.getElementById('proto-dead');
    helloInput.value = '5';
    helloInput.dispatchEvent(new Event('input'));
    expect(dead.textContent).toContain('15');
  });

  it('typing in refresh input updates derived max-age', () => {
    wireProtocolPopover({ onApply: () => {} });
    const refreshInput = document.getElementById('proto-refresh');
    const maxage = document.getElementById('proto-maxage');
    refreshInput.value = '20';
    refreshInput.dispatchEvent(new Event('input'));
    expect(maxage.textContent).toContain('40');
  });

  it('clicking apply calls onApply with current values then hides popover', async () => {
    let called = null;
    wireProtocolPopover({
      onApply: (vals) => { called = vals; return Promise.resolve(); },
    });
    const btn = document.getElementById('tb-protocol');
    btn.click();
    document.getElementById('proto-hello').value = '7';
    document.getElementById('proto-refresh').value = '21';
    document.getElementById('proto-apply').click();
    await Promise.resolve();
    expect(called).toEqual({ hello: 7, refresh: 21 });
  });

  it('clicking cancel hides the popover without calling onApply', () => {
    let called = false;
    wireProtocolPopover({ onApply: () => { called = true; } });
    const btn = document.getElementById('tb-protocol');
    btn.click();
    document.getElementById('proto-cancel').click();
    expect(called).toBe(false);
    expect(document.getElementById('protocol-popover').hidden).toBe(true);
  });

  it('apply blocked when hello <= 0', async () => {
    let called = false;
    wireProtocolPopover({ onApply: () => { called = true; } });
    document.getElementById('tb-protocol').click();
    document.getElementById('proto-hello').value = '0';
    document.getElementById('proto-apply').click();
    expect(called).toBe(false);
  });
});
