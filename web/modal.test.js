import { describe, it, expect, beforeEach } from 'vitest';
import { confirmModal } from './modal.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('confirmModal', () => {
  it('mounts a modal carrying the title and body text', () => {
    confirmModal({ title: 'New topology', body: 'Clear it?' });
    const modal = document.querySelector('.modal-bg .modal-confirm');
    expect(modal).not.toBeNull();
    expect(modal.querySelector('.ttl').textContent).toBe('New topology');
    expect(modal.querySelector('.modal-msg').textContent).toBe('Clear it?');
  });

  it('resolves true and removes itself when the confirm button is clicked', async () => {
    const p = confirmModal({ title: 't', body: 'b' });
    document.querySelector('.modal-bg .confirm').click();
    await expect(p).resolves.toBe(true);
    expect(document.querySelector('.modal-bg')).toBeNull();
  });

  it('resolves false when the cancel button is clicked', async () => {
    const p = confirmModal({ title: 't', body: 'b' });
    document.querySelector('.modal-bg .cancel').click();
    await expect(p).resolves.toBe(false);
    expect(document.querySelector('.modal-bg')).toBeNull();
  });

  it('resolves false when the backdrop is clicked', async () => {
    const p = confirmModal({ title: 't', body: 'b' });
    document.querySelector('.modal-bg').click();
    await expect(p).resolves.toBe(false);
  });

  it('resolves false on Escape and true on Enter', async () => {
    const pEsc = confirmModal({ title: 't', body: 'b' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(pEsc).resolves.toBe(false);

    const pEnter = confirmModal({ title: 't', body: 'b' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await expect(pEnter).resolves.toBe(true);
  });

  it('uses the danger style for the confirm button when danger is set', () => {
    confirmModal({ title: 't', body: 'b', danger: true, confirmLabel: 'Clear' });
    const btn = document.querySelector('.modal-bg .confirm');
    expect(btn.classList.contains('danger')).toBe(true);
    expect(btn.textContent).toBe('Clear');
  });
});
