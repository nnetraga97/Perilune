/**
 * Game shell — under construction (M1 vertical slice).
 */
export async function startGame(): Promise<void> {
  const status = document.getElementById('boot-status');
  if (status) status.textContent = 'vertical slice under construction — try ?proto=terrain';
}
