/* Protocol popover — hello / lsa-refresh inputs, derived dead / max-age. */

export function computeDerived({ hello, refresh }) {
  return {
    dead: hello * 3,
    maxAge: refresh * 2,
  };
}

function fmt(seconds) {
  if (Number.isInteger(seconds)) return `${seconds}s`;
  return `${seconds.toFixed(1)}s`;
}

export function wireProtocolPopover({ onApply }) {
  const popover = document.getElementById('protocol-popover');
  const btn = document.getElementById('tb-protocol');
  const close = document.getElementById('protocol-popover-close');
  const helloInput = document.getElementById('proto-hello');
  const refreshInput = document.getElementById('proto-refresh');
  const deadOut = document.getElementById('proto-dead');
  const maxageOut = document.getElementById('proto-maxage');
  const cancel = document.getElementById('proto-cancel');
  const apply = document.getElementById('proto-apply');

  function updateDerived() {
    const hello = Number(helloInput.value);
    const refresh = Number(refreshInput.value);
    if (!Number.isFinite(hello) || !Number.isFinite(refresh)) return;
    const { dead, maxAge } = computeDerived({ hello, refresh });
    deadOut.innerHTML = `${fmt(dead)} <em>(3 × hello)</em>`;
    maxageOut.innerHTML = `${fmt(maxAge)} <em>(2 × refresh)</em>`;
  }

  function open() {
    popover.hidden = false;
    updateDerived();
  }
  function hide() { popover.hidden = true; }
  function toggle() { popover.hidden ? open() : hide(); }

  btn.addEventListener('click', toggle);
  close.addEventListener('click', hide);
  cancel.addEventListener('click', hide);

  helloInput.addEventListener('input', updateDerived);
  refreshInput.addEventListener('input', updateDerived);

  apply.addEventListener('click', async () => {
    const hello = Number(helloInput.value);
    const refresh = Number(refreshInput.value);
    if (!Number.isFinite(hello) || hello <= 0) return;
    if (!Number.isFinite(refresh) || refresh <= 0) return;
    try {
      await onApply({ hello, refresh });
      hide();
    } catch (err) {
      // Stay open; surface error via toast if available.
      console.error('protocol-config apply failed:', err);
    }
  });

  updateDerived();
}
